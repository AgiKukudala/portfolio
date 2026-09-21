package tests

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"asterkv/internal/raft"
	"asterkv/internal/state"
	"asterkv/internal/storage"
)

func TestRestart(t *testing.T) {
	dir := t.TempDir()
	for run := 0; run < 2; run++ {
		s, e := storage.Open(dir)
		if e != nil {
			t.Fatal(e)
		}
		m := state.New()
		n, e := raft.New(raft.Config{ID: "a", Machine: m, Heartbeat: time.Millisecond, ElectionMin: 5 * time.Millisecond, ElectionMax: 10 * time.Millisecond}, s, nil)
		if e != nil {
			t.Fatal(e)
		}
		if run == 1 && m.KV["x"] != "5" {
			t.Fatal("committed data missing after restart")
		}
		n.Start()
		deadline := time.Now().Add(time.Second)
		for n.Status().Role != raft.Leader && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		b, _ := json.Marshal(state.Command{Op: "put", Key: "x", Value: "5"})
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_, e = n.Propose(ctx, b)
		cancel()
		n.Stop()
		s.Close()
		if e != nil {
			t.Fatal(e)
		}
	}
}
