package raft

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"asterkv/internal/state"
)

func TestCommittedApplication(t *testing.T) {
	m := state.New()
	n, _ := New(Config{ID: "a", Machine: m}, &memory{}, nil)
	defer n.Stop()
	n.mu.Lock()
	n.elect()
	n.mu.Unlock()
	b, _ := json.Marshal(state.Command{Op: "put", Key: "x", Value: "5"})
	if _, e := n.Propose(context.Background(), b); e != nil {
		t.Fatal(e)
	}
	if m.KV["x"] != "5" || n.Status().LastApplied != 2 {
		t.Fatal(n.Status())
	}
}
func TestMinorityDoesNotApply(t *testing.T) {
	m := state.New()
	n, _ := New(Config{ID: "a", Peers: []string{"b", "c"}, Machine: m}, &memory{}, nil)
	defer n.Stop()
	n.role = Leader
	n.d.Term = 1
	b, _ := json.Marshal(state.Command{Op: "put", Key: "x", Value: "5"})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, e := n.Propose(ctx, b); e == nil {
		t.Fatal("minority success")
	}
	if len(m.KV) != 0 || n.Status().CommitIndex != 0 {
		t.Fatal("uncommitted applied")
	}
}
