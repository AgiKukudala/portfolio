package raft

import (
	"context"
	"errors"
	"time"

	pb "asterkv/proto/asterkv/v1"
)

func (n *Node) AppendEntries(ctx context.Context, r *pb.AppendRequest) (*pb.AppendResponse, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.available(); err != nil {
		return nil, err
	}
	if r.Term > n.d.Term {
		if err := n.stepDown(r.Term); err != nil {
			return nil, err
		}
	}
	out := &pb.AppendResponse{Term: n.d.Term, NextIndex: n.lastIndex() + 1}
	if r.Term < n.d.Term {
		return out, nil
	}
	n.role = Follower
	n.leader = r.LeaderId
	n.resetDeadline()
	if r.PrevLogIndex < n.d.SnapshotIndex {
		out.NextIndex = n.d.SnapshotIndex + 1
		return out, nil
	}
	if r.PrevLogIndex > n.lastIndex() {
		return out, nil
	}
	if n.termAt(r.PrevLogIndex) != r.PrevLogTerm {
		out.NextIndex = r.PrevLogIndex
		return out, nil
	}
	// Validate the entire batch before changing a suffix.
	previousTerm := r.PrevLogTerm
	for j, e := range r.Entries {
		if e == nil || e.Index != r.PrevLogIndex+1+uint64(j) || e.Term == 0 || e.Term > r.Term || e.Term < previousTerm {
			return nil, errors.New("invalid entry sequence")
		}
		previousTerm = e.Term
	}
	changed := false
	for j, e := range r.Entries {
		i := r.PrevLogIndex + 1 + uint64(j)
		if e.Index != i || e.Term > r.Term {
			return nil, errors.New("invalid entry sequence")
		}
		if i <= n.lastIndex() && n.termAt(i) != e.Term {
			// Only an uncommitted divergent suffix may be replaced.
			if i <= n.commit {
				return nil, errors.New("attempt to overwrite committed entry")
			}
			n.d.Log = n.d.Log[:i-n.d.SnapshotIndex-1]
			changed = true
		}
		if i > n.lastIndex() {
			n.d.Log = append(n.d.Log, Entry{Index: i, Term: e.Term, Command: append([]byte(nil), e.Command...)})
			changed = true
		}
	}
	if changed {
		if err := n.persist(); err != nil {
			return nil, err
		}
	}
	// Bound by the prefix actually validated in this RPC, not a local divergent suffix.
	verified := r.PrevLogIndex + uint64(len(r.Entries))
	if c := min(r.LeaderCommit, verified); c > n.commit {
		n.commit = c
		n.applyCommitted()
	}
	if err := n.available(); err != nil {
		return nil, err
	}
	out.Success = true
	out.NextIndex = verified + 1
	return out, nil
}
func (n *Node) advanceCommit() {
	for i := n.lastIndex(); i > n.commit; i-- {
		// A current-term quorum also commits its entire preceding prefix (Raft §5.4.2).
		if n.termAt(i) != n.d.Term {
			continue
		}
		count := 1
		for _, p := range n.cfg.Peers {
			if n.match[p] >= i {
				count++
			}
		}
		if count > (len(n.cfg.Peers)+1)/2 {
			n.commit = i
			n.cfg.Logger.Debug("commit advanced", "node", n.cfg.ID, "term", n.d.Term, "commit_index", i)
			n.applyCommitted()
			break
		}
	}
}

func (n *Node) replicator(peer string) {
	defer n.wg.Done()
	ticker := time.NewTicker(n.cfg.Heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-ticker.C:
			n.replicate(peer)
		}
	}
}
func (n *Node) replicate(peer string) {
	n.mu.Lock()
	if n.stopped || n.role != Leader {
		n.mu.Unlock()
		return
	}
	if n.next[peer] <= n.d.SnapshotIndex {
		n.sendSnapshot(peer)
		return
	}
	term := n.d.Term
	next := max(uint64(1), n.next[peer])
	last := n.lastIndex()
	end := min(last, next+63)
	r := &pb.AppendRequest{Term: term, LeaderId: n.cfg.ID, PrevLogIndex: next - 1, PrevLogTerm: n.termAt(next - 1), LeaderCommit: n.commit}
	batchBytes := 0
	for i := next; i <= end; i++ {
		e := n.entryAt(i)
		if batchBytes+len(e.Command) > 16<<20 && len(r.Entries) > 0 {
			break
		}
		batchBytes += len(e.Command)
		r.Entries = append(r.Entries, &pb.Entry{Index: i, Term: e.Term, Command: append([]byte(nil), e.Command...)})
	}
	n.mu.Unlock()
	ctx, cancel := context.WithTimeout(n.ctx, n.cfg.RPCTimeout)
	defer cancel()
	out, err := n.transport.AppendEntries(ctx, peer, r)
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.stopped {
		return
	}
	if err != nil {
		n.cfg.Logger.Debug("replication failed", "peer", peer, "error", err)
		return
	}
	if out.Term > n.d.Term {
		_ = n.stepDown(out.Term)
		return
	}
	if n.role != Leader || n.d.Term != term || out.Term != term {
		return
	}
	if out.Success {
		matched := r.PrevLogIndex + uint64(len(r.Entries))
		n.match[peer] = matched
		n.next[peer] = matched + 1
		n.advanceCommit()
	} else {
		n.next[peer] = max(uint64(1), min(next-1, out.NextIndex))
	}
}
