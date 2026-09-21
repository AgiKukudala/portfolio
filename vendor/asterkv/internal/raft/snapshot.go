package raft

import (
	"context"
	"errors"

	pb "asterkv/proto/asterkv/v1"
)

func (n *Node) maybeSnapshot() {
	if n.cfg.Machine == nil || n.cfg.SnapshotThreshold == 0 || n.applied-n.d.SnapshotIndex < n.cfg.SnapshotThreshold {
		return
	}
	b, err := n.cfg.Machine.Snapshot()
	if err != nil {
		n.fatal = err
		n.stopped = true
		n.cancel()
		return
	}
	i := n.applied
	term := n.termAt(i)
	n.d.Log = append([]Entry(nil), n.d.Log[i-n.d.SnapshotIndex:]...)
	n.d.Snapshot = b
	n.d.SnapshotIndex = i
	n.d.SnapshotTerm = term
	// Snapshot, commit position, and compacted suffix are one atomic storage update.
	if n.persist() == nil {
		n.cfg.Logger.Info("snapshot created", "node", n.cfg.ID, "index", i, "term", term)
	}
}
func (n *Node) InstallSnapshot(ctx context.Context, r *pb.SnapshotRequest) (*pb.SnapshotResponse, error) {
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
	out := &pb.SnapshotResponse{Term: n.d.Term}
	if r.Term < n.d.Term {
		return out, nil
	}
	if r.LastIncludedTerm > r.Term || r.LastIncludedTerm == 0 || r.LastIncludedIndex == 0 || len(r.Data) == 0 {
		return nil, errors.New("invalid snapshot metadata")
	}
	n.role = Follower
	n.leader = r.LeaderId
	n.resetDeadline()
	// Never roll back applied state, including when a delayed snapshot arrives.
	if r.LastIncludedIndex <= n.commit {
		return out, nil
	}
	if r.LastIncludedIndex <= n.lastIndex() && n.termAt(r.LastIncludedIndex) == r.LastIncludedTerm {
		n.d.Log = append([]Entry(nil), n.d.Log[r.LastIncludedIndex-n.d.SnapshotIndex:]...)
	} else {
		n.d.Log = nil
	}
	n.d.SnapshotIndex = r.LastIncludedIndex
	n.d.SnapshotTerm = r.LastIncludedTerm
	n.d.Snapshot = append([]byte(nil), r.Data...)
	n.d.Commit = r.LastIncludedIndex
	if err := n.persist(); err != nil {
		return nil, err
	}
	if n.cfg.Machine != nil {
		if err := n.cfg.Machine.Restore(r.Data); err != nil {
			n.fatal = err
			n.stopped = true
			n.cancel()
			return nil, err
		}
	}
	n.commit = r.LastIncludedIndex
	n.applied = n.commit
	n.failWaiters(ErrNotLeader)
	n.cfg.Logger.Info("snapshot installed", "node", n.cfg.ID, "index", n.commit)
	return out, nil
}

// Called with mu held; returns with mu released, like the ordinary replication path.
func (n *Node) sendSnapshot(peer string) {
	r := &pb.SnapshotRequest{Term: n.d.Term, LeaderId: n.cfg.ID, LastIncludedIndex: n.d.SnapshotIndex, LastIncludedTerm: n.d.SnapshotTerm, Data: append([]byte(nil), n.d.Snapshot...)}
	n.mu.Unlock()
	ctx, cancel := context.WithTimeout(n.ctx, n.cfg.RPCTimeout)
	defer cancel()
	out, err := n.transport.InstallSnapshot(ctx, peer, r)
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.stopped || err != nil {
		return
	}
	if out.Term > n.d.Term {
		_ = n.stepDown(out.Term)
		return
	}
	if n.role != Leader || n.d.Term != r.Term || out.Term != r.Term {
		return
	}
	n.match[peer] = r.LastIncludedIndex
	n.next[peer] = r.LastIncludedIndex + 1
	n.advanceCommit()
}
