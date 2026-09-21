package sim

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"path/filepath"
	"time"

	"asterkv/internal/raft"
	"asterkv/internal/state"
	"asterkv/internal/storage"
)

// Lifecycle methods are called by the test/controller, never concurrently with one another.
type Cluster struct {
	Net       *Network
	IDs       []string
	Nodes     map[string]*raft.Node
	stores    map[string]*storage.File
	root      string
	threshold uint64
}

func New(root string, size int, threshold uint64) (*Cluster, error) {
	c := &Cluster{Net: &Network{nodes: map[string]*raft.Node{}, blocked: map[string]bool{}}, Nodes: map[string]*raft.Node{}, stores: map[string]*storage.File{}, root: root, threshold: threshold}
	for i := 0; i < size; i++ {
		c.IDs = append(c.IDs, fmt.Sprintf("n%d", i+1))
	}
	for _, id := range c.IDs {
		if e := c.Restart(id); e != nil {
			c.Close()
			return nil, e
		}
	}
	return c, nil
}
func (c *Cluster) Restart(id string) error {
	if c.Nodes[id] != nil {
		return fmt.Errorf("node %s already running", id)
	}
	s, e := storage.Open(filepath.Join(c.root, id))
	if e != nil {
		return e
	}
	peers := []string{}
	for _, p := range c.IDs {
		if p != id {
			peers = append(peers, p)
		}
	}
	n, e := raft.New(raft.Config{ID: id, Peers: peers, Machine: state.New(), SnapshotThreshold: c.threshold, Heartbeat: 20 * time.Millisecond, ElectionMin: 140 * time.Millisecond, ElectionMax: 280 * time.Millisecond, RPCTimeout: 80 * time.Millisecond, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, s, transport{c.Net, id})
	if e != nil {
		s.Close()
		return e
	}
	c.Nodes[id] = n
	c.stores[id] = s
	c.Net.mu.Lock()
	c.Net.nodes[id] = n
	c.Net.mu.Unlock()
	n.Start()
	return nil
}
func (c *Cluster) Crash(id string) {
	if n := c.Nodes[id]; n != nil {
		c.Net.mu.Lock()
		delete(c.Net.nodes, id)
		c.Net.mu.Unlock()
		n.Stop()
		c.stores[id].Close()
		delete(c.Nodes, id)
		delete(c.stores, id)
	}
}
func (c *Cluster) Close() {
	for _, id := range c.IDs {
		c.Crash(id)
	}
}
func (c *Cluster) Leader(ctx context.Context, allowed []string) (string, error) {
	if allowed == nil {
		allowed = c.IDs
	}
	for {
		for _, id := range allowed {
			if n := c.Nodes[id]; n != nil && n.Status().Role == raft.Leader {
				return id, nil
			}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
}
func (c *Cluster) Do(ctx context.Context, cmd state.Command) (state.Result, error) {
	b, _ := json.Marshal(cmd)
	for {
		for _, id := range c.IDs {
			n := c.Nodes[id]
			if n == nil || n.Status().Role != raft.Leader {
				continue
			}
			attempt, cancel := context.WithTimeout(ctx, 400*time.Millisecond)
			out, e := n.Propose(attempt, b)
			cancel()
			if e == nil {
				var r state.Result
				e = json.Unmarshal(out, &r)
				return r, e
			}
		}
		select {
		case <-ctx.Done():
			return state.Result{}, ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
}
func (c *Cluster) AppliedState(id string) (*state.Machine, error) {
	// Stop-free inspection uses a snapshot of durable state through the Node's mutex.
	d := c.Nodes[id].DurableCopy()
	m := state.New()
	if len(d.Snapshot) > 0 {
		if e := m.Restore(d.Snapshot); e != nil {
			return nil, e
		}
	}
	for _, entry := range d.Log {
		if entry.Index > d.Commit {
			break
		}
		if len(entry.Command) > 0 {
			if _, e := m.ApplyBytes(entry.Command); e != nil {
				return nil, e
			}
		}
	}
	return m, nil
}
