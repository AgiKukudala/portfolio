package storage

import (
	"os"
	"path/filepath"
	"testing"

	"asterkv/internal/raft"
)

func TestDurabilityAndCorruption(t *testing.T) {
	dir := t.TempDir()
	f, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	if other, e := Open(dir); e == nil {
		other.Close()
		t.Fatal("double open")
	}
	d := raft.Durable{Term: 4, Vote: "a", Log: []raft.Entry{{Index: 1, Term: 4, Command: []byte("hello")}}}
	if e = f.Save(d); e != nil {
		t.Fatal(e)
	}
	f.Close()
	f, e = Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	r, e := f.Load()
	if e != nil || r.Term != 4 || r.Vote != "a" || string(r.Log[0].Command) != "hello" {
		t.Fatal(r, e)
	}
	os.WriteFile(filepath.Join(dir, "raft.json"), []byte("partial"), 0600)
	if _, e = f.Load(); e == nil {
		t.Fatal("corruption accepted")
	}
}
