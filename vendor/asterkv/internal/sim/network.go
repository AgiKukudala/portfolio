// Package sim injects transport faults around the real Raft node and durable store.
package sim

import (
	"context"
	"errors"
	"sync"
	"time"

	"asterkv/internal/raft"
	pb "asterkv/proto/asterkv/v1"
)

var ErrDropped = errors.New("simulated RPC loss")

type Network struct {
	mu        sync.Mutex
	nodes     map[string]*raft.Node
	blocked   map[string]bool
	calls     uint64
	dropEvery uint64
	delay     time.Duration
	duplicate bool
}
type transport struct {
	net  *Network
	from string
}

func (n *Network) Faults(dropEvery uint64, delay time.Duration, duplicate bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.dropEvery = dropEvery
	n.delay = delay
	n.duplicate = duplicate
}
func (n *Network) Partition(left, right []string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, a := range left {
		for _, b := range right {
			n.blocked[a+"/"+b] = true
			n.blocked[b+"/"+a] = true
		}
	}
}
func (n *Network) Heal() { n.mu.Lock(); defer n.mu.Unlock(); n.blocked = map[string]bool{} }
func (t transport) route(ctx context.Context, to string) (*raft.Node, bool, bool, error) {
	n := t.net
	n.mu.Lock()
	n.calls++
	node := n.nodes[to]
	blocked := n.blocked[t.from+"/"+to]
	drop := n.dropEvery > 0 && n.calls%n.dropEvery == 0
	delay, dup := n.delay, n.duplicate
	n.mu.Unlock()
	if blocked || node == nil {
		return nil, false, false, ErrDropped
	}
	if delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return nil, false, false, ctx.Err()
		case <-timer.C:
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, false, false, err
	}
	// Alternate request loss with response loss (delivery occurred, acknowledgement did not).
	if drop {
		n.mu.Lock()
		requestLoss := n.calls%2 == 0
		n.mu.Unlock()
		if requestLoss {
			return nil, false, false, ErrDropped
		}
	}
	return node, dup, drop, nil
}
func (t transport) RequestVote(ctx context.Context, to string, r *pb.VoteRequest) (*pb.VoteResponse, error) {
	n, dup, drop, e := t.route(ctx, to)
	if e != nil {
		return nil, e
	}
	out, e := n.RequestVote(ctx, r)
	if dup && e == nil {
		out, e = n.RequestVote(ctx, r)
	}
	if drop {
		return nil, ErrDropped
	}
	return out, e
}
func (t transport) AppendEntries(ctx context.Context, to string, r *pb.AppendRequest) (*pb.AppendResponse, error) {
	n, dup, drop, e := t.route(ctx, to)
	if e != nil {
		return nil, e
	}
	out, e := n.AppendEntries(ctx, r)
	if dup && e == nil {
		out, e = n.AppendEntries(ctx, r)
	}
	if drop {
		return nil, ErrDropped
	}
	return out, e
}
func (t transport) InstallSnapshot(ctx context.Context, to string, r *pb.SnapshotRequest) (*pb.SnapshotResponse, error) {
	n, dup, drop, e := t.route(ctx, to)
	if e != nil {
		return nil, e
	}
	out, e := n.InstallSnapshot(ctx, r)
	if dup && e == nil {
		out, e = n.InstallSnapshot(ctx, r)
	}
	if drop {
		return nil, ErrDropped
	}
	return out, e
}
