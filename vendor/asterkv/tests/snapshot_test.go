package tests

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"asterkv/internal/raft"
	"asterkv/internal/state"
	"asterkv/internal/storage"
	pb "asterkv/proto/asterkv/v1"
)

func TestSnapshotRecoveryAndInstall(t *testing.T) {
	dir := t.TempDir()
	s, _ := storage.Open(dir)
	m := state.New()
	cfg := raft.Config{ID: "a", Machine: m, SnapshotThreshold: 2, Heartbeat: time.Millisecond, ElectionMin: 5 * time.Millisecond, ElectionMax: 10 * time.Millisecond}
	n, e := raft.New(cfg, s, nil)
	if e != nil {
		t.Fatal(e)
	}
	n.Start()
	deadline := time.Now().Add(time.Second)
	for n.Status().Role != raft.Leader {
		if time.Now().After(deadline) {
			n.Stop()
			s.Close()
			t.Fatal("election timeout")
		}
		time.Sleep(time.Millisecond)
	}
	c := state.Command{Op: "put", Key: "x", Value: "5", ClientID: "c", RequestID: "91"}
	b, _ := json.Marshal(c)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	first, e := n.Propose(ctx, b)
	if e != nil {
		t.Fatal(e)
	}
	n.Stop()
	d, e := s.Load()
	if e != nil || d.SnapshotIndex == 0 || len(d.Log) != 0 {
		t.Fatal("not compacted", d, e)
	}
	s.Close()
	s, _ = storage.Open(dir)
	defer s.Close()
	m = state.New()
	cfg.Machine = m
	n, e = raft.New(cfg, s, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer n.Stop()
	if m.KV["x"] != "5" {
		t.Fatal("snapshot recovery failed")
	}
	retry, _ := m.ApplyBytes(b)
	if string(first) != string(retry) {
		t.Fatal("cached result lost")
	}
	fs, _ := storage.Open(t.TempDir())
	defer fs.Close()
	fm := state.New()
	f, _ := raft.New(raft.Config{ID: "f", Machine: fm}, fs, nil)
	defer f.Stop()
	_, e = f.InstallSnapshot(ctx, &pb.SnapshotRequest{Term: d.Term, LeaderId: "a", LastIncludedIndex: d.SnapshotIndex, LastIncludedTerm: d.SnapshotTerm, Data: d.Snapshot})
	if e != nil || fm.KV["x"] != "5" {
		t.Fatal("install failed", e)
	}
}
