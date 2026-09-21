// Package raft implements static-membership Raft. All protocol state belongs to mu.
package raft

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"slices"
	"sync"
	"time"

	pb "asterkv/proto/asterkv/v1"
)

type Role string

const (
	Follower  Role = "follower"
	Candidate Role = "candidate"
	Leader    Role = "leader"
)

var ErrNotLeader = errors.New("not leader")
var ErrStopped = errors.New("node stopped")

type Transport interface {
	RequestVote(context.Context, string, *pb.VoteRequest) (*pb.VoteResponse, error)
	AppendEntries(context.Context, string, *pb.AppendRequest) (*pb.AppendResponse, error)
	InstallSnapshot(context.Context, string, *pb.SnapshotRequest) (*pb.SnapshotResponse, error)
}
type Entry struct {
	Index, Term uint64
	Command     []byte
}
type Durable struct {
	NodeID                      string
	Members                     []string
	SnapshotIndex, SnapshotTerm uint64
	Snapshot                    []byte
	Commit                      uint64
	Term                        uint64
	Vote                        string
	Log                         []Entry
}
type Store interface {
	Load() (Durable, error)
	Save(Durable) error
}
type Machine interface {
	ApplyBytes([]byte) ([]byte, error)
	Snapshot() ([]byte, error)
	Restore([]byte) error
}
type outcome struct {
	data []byte
	err  error
}
type Config struct {
	SnapshotThreshold                               uint64
	Machine                                         Machine
	ID                                              string
	Peers                                           []string
	Heartbeat, ElectionMin, ElectionMax, RPCTimeout time.Duration
	Logger                                          *slog.Logger
}
type Status struct {
	ID, Leader                                string
	Role                                      Role
	Term, LastIndex, CommitIndex, LastApplied uint64
}
type Node struct {
	waiters         map[uint64]chan outcome
	mu              sync.Mutex
	cfg             Config
	store           Store
	transport       Transport
	d               Durable
	role            Role
	leader          string
	commit, applied uint64
	next, match     map[string]uint64
	deadline        time.Time
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
	stopped         bool
	started         bool
	fatal           error
}

func New(cfg Config, s Store, t Transport) (*Node, error) {
	if cfg.ID == "" {
		return nil, errors.New("empty node ID")
	}
	cfg.Peers = append([]string(nil), cfg.Peers...)
	seen := map[string]bool{cfg.ID: true}
	for _, p := range cfg.Peers {
		if p == "" || seen[p] {
			return nil, errors.New("invalid or duplicate peer")
		}
		seen[p] = true
	}
	if cfg.Heartbeat == 0 {
		cfg.Heartbeat = 50 * time.Millisecond
	}
	if cfg.ElectionMin == 0 {
		cfg.ElectionMin = 250 * time.Millisecond
	}
	if cfg.ElectionMax == 0 {
		cfg.ElectionMax = 500 * time.Millisecond
	}
	if cfg.RPCTimeout == 0 {
		cfg.RPCTimeout = 150 * time.Millisecond
	}
	if cfg.Heartbeat <= 0 || cfg.ElectionMin < 3*cfg.Heartbeat || cfg.ElectionMax <= cfg.ElectionMin || cfg.RPCTimeout <= 0 {
		return nil, errors.New("invalid timing configuration")
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	d, err := s.Load()
	if err != nil {
		return nil, err
	}
	members := append(append([]string(nil), cfg.Peers...), cfg.ID)
	slices.Sort(members)
	if d.NodeID != "" && (d.NodeID != cfg.ID || !slices.Equal(d.Members, members)) {
		return nil, errors.New("data directory belongs to a different node or membership")
	}
	d.NodeID = cfg.ID
	d.Members = members
	ctx, cancel := context.WithCancel(context.Background())
	n := &Node{cfg: cfg, store: s, transport: t, d: d, role: Follower, next: map[string]uint64{}, match: map[string]uint64{}, ctx: ctx, cancel: cancel}
	n.waiters = make(map[uint64]chan outcome)
	if d.Commit > n.lastIndex() {
		cancel()
		return nil, errors.New("commit index exceeds log")
	}
	for i, e := range d.Log {
		if e.Index != d.SnapshotIndex+uint64(i)+1 || e.Term > d.Term || e.Term == 0 || (i > 0 && e.Term < d.Log[i-1].Term) || e.Term < d.SnapshotTerm {
			cancel()
			return nil, errors.New("invalid durable log")
		}
	}
	if d.SnapshotIndex > d.Commit || d.SnapshotTerm > d.Term || (d.SnapshotIndex > 0 && (len(d.Snapshot) == 0 || d.SnapshotTerm == 0)) || (d.SnapshotIndex == 0 && (len(d.Snapshot) > 0 || d.SnapshotTerm != 0)) {
		cancel()
		return nil, errors.New("invalid snapshot boundary")
	}
	if len(d.Snapshot) > 0 {
		if cfg.Machine == nil {
			cancel()
			return nil, errors.New("snapshot requires state machine")
		}
		if err := cfg.Machine.Restore(d.Snapshot); err != nil {
			cancel()
			return nil, err
		}
	}
	n.applied = d.SnapshotIndex
	n.commit = d.Commit
	n.applyCommitted()
	if n.fatal != nil {
		cancel()
		return nil, n.fatal
	}
	n.resetDeadline()
	return n, nil
}
func (n *Node) Start() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.started || n.stopped {
		return
	}
	n.started = true
	n.wg.Add(1)
	go n.run()
	for _, p := range n.cfg.Peers {
		n.wg.Add(1)
		go n.replicator(p)
	}
}
func (n *Node) Stop() { n.mu.Lock(); n.stopped = true; n.cancel(); n.mu.Unlock(); n.wg.Wait() }
func (n *Node) Status() Status {
	n.mu.Lock()
	defer n.mu.Unlock()
	return Status{n.cfg.ID, n.leader, n.role, n.d.Term, n.lastIndex(), n.commit, n.applied}
}
func (n *Node) lastIndex() uint64 { return n.d.SnapshotIndex + uint64(len(n.d.Log)) }
func (n *Node) termAt(i uint64) uint64 {
	if i == n.d.SnapshotIndex {
		return n.d.SnapshotTerm
	}
	return n.entryAt(i).Term
}
func (n *Node) resetDeadline() {
	n.deadline = time.Now().Add(n.cfg.ElectionMin + time.Duration(rand.Int64N(int64(n.cfg.ElectionMax-n.cfg.ElectionMin))))
}
func (n *Node) persist() error {
	if err := n.store.Save(n.d); err != nil {
		n.fatal = err
		n.stopped = true
		n.cancel()
		n.cfg.Logger.Error("storage failure; node stopped", "node", n.cfg.ID, "error", err)
		return err
	}
	return nil
}
func (n *Node) available() error {
	if n.fatal != nil {
		return n.fatal
	}
	if n.stopped {
		return ErrStopped
	}
	return nil
}
func (n *Node) stepDown(term uint64) error {
	if term > n.d.Term {
		n.d.Term = term
		n.d.Vote = ""
		if err := n.persist(); err != nil {
			return err
		}
	}
	n.failWaiters(ErrNotLeader)
	n.cfg.Logger.Debug("stepping down", "node", n.cfg.ID, "term", n.d.Term)
	n.role = Follower
	n.leader = ""
	return nil
}
func (n *Node) run() {
	defer n.wg.Done()
	ticker := time.NewTicker(n.cfg.Heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-ticker.C:
			n.mu.Lock()
			if !n.stopped && n.role != Leader && time.Now().After(n.deadline) {
				n.elect()
			}
			n.mu.Unlock()
		}
	}
}

// elect is called with mu held; requests capture immutable state, never hold mu over network I/O.
func (n *Node) elect() {
	n.d.Term++
	n.d.Vote = n.cfg.ID
	n.role = Candidate
	n.leader = ""
	n.resetDeadline()
	if n.persist() != nil {
		return
	}
	term := n.d.Term
	votes := 1
	n.cfg.Logger.Info("election", "node", n.cfg.ID, "term", term)
	win := func() {
		if votes > (len(n.cfg.Peers)+1)/2 && n.role == Candidate && n.d.Term == term {
			n.role = Leader
			n.leader = n.cfg.ID
			for _, p := range n.cfg.Peers {
				n.next[p] = n.lastIndex() + 1
				n.match[p] = 0
			}
			n.d.Log = append(n.d.Log, Entry{Index: n.lastIndex() + 1, Term: n.d.Term})
			if n.persist() != nil {
				return
			}
			n.advanceCommit()
			n.cfg.Logger.Info("leader elected", "node", n.cfg.ID, "term", term)
		}
	}
	win()
	req := &pb.VoteRequest{Term: term, CandidateId: n.cfg.ID, LastLogIndex: n.lastIndex(), LastLogTerm: n.termAt(n.lastIndex())}
	for _, p := range n.cfg.Peers {
		n.wg.Add(1)
		go func(peer string) {
			defer n.wg.Done()
			ctx, cancel := context.WithTimeout(n.ctx, n.cfg.RPCTimeout)
			defer cancel()
			r, err := n.transport.RequestVote(ctx, peer, req)
			if err != nil {
				return
			}
			n.mu.Lock()
			defer n.mu.Unlock()
			if n.stopped {
				return
			}
			if r.Term > n.d.Term {
				_ = n.stepDown(r.Term)
				return
			}
			if n.role == Candidate && n.d.Term == term && r.Term == term && r.Granted {
				votes++
				win()
			}
		}(p)
	}
}
func (n *Node) RequestVote(ctx context.Context, r *pb.VoteRequest) (*pb.VoteResponse, error) {
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
	out := &pb.VoteResponse{Term: n.d.Term}
	if r.Term < n.d.Term {
		return out, nil
	}
	last := n.lastIndex()
	upToDate := r.LastLogTerm > n.termAt(last) || (r.LastLogTerm == n.termAt(last) && r.LastLogIndex >= last)
	// Persist the vote BEFORE granting it, so a crash cannot permit a second vote.
	if upToDate && (n.d.Vote == "" || n.d.Vote == r.CandidateId) {
		n.d.Vote = r.CandidateId
		if err := n.persist(); err != nil {
			return nil, err
		}
		n.resetDeadline()
		out.Granted = true
	}
	return out, nil
}

func (n *Node) entryAt(i uint64) Entry { return n.d.Log[i-n.d.SnapshotIndex-1] }

// DurableCopy is a detached diagnostic view, useful for invariant checks.
func (n *Node) DurableCopy() Durable {
	n.mu.Lock()
	defer n.mu.Unlock()
	d := n.d
	d.Members = append([]string(nil), d.Members...)
	d.Snapshot = append([]byte(nil), d.Snapshot...)
	d.Log = append([]Entry(nil), d.Log...)
	for i := range d.Log {
		d.Log[i].Command = append([]byte(nil), d.Log[i].Command...)
	}
	return d
}
