package state

import "testing"

func TestOperations(t *testing.T) {
	m := New()
	m.Apply(Command{Op: "put", Key: "x", Value: "5"})
	if r := m.Apply(Command{Op: "get", Key: "x"}); !r.Found || r.Value != "5" {
		t.Fatal(r)
	}
	if !m.Apply(Command{Op: "cas", Key: "x", Expected: "5", Value: "6"}).Success {
		t.Fatal("CAS failed")
	}
	if m.Apply(Command{Op: "cas", Key: "x", Expected: "5", Value: "7"}).Success {
		t.Fatal("CAS incorrectly succeeded")
	}
	m.Apply(Command{Op: "delete", Key: "x"})
	if m.Apply(Command{Op: "get", Key: "x"}).Found {
		t.Fatal("delete failed")
	}
	if m.Apply(Command{Op: "cas", Key: "missing", Expected: "", Value: "v"}).Success {
		t.Fatal("missing is distinct from empty")
	}
}

func TestDeduplication(t *testing.T) {
	m := New()
	m.Apply(Command{Op: "put", Key: "x", Value: "5"})
	c := Command{Op: "cas", Key: "x", Expected: "5", Value: "6", ClientID: "c", RequestID: "91"}
	first := m.Apply(c)
	if !first.Success {
		t.Fatal(first)
	}
	m.Apply(Command{Op: "put", Key: "x", Value: "9"})
	if retry := m.Apply(c); retry != first || m.KV["x"] != "9" {
		t.Fatal("retry re-executed", retry)
	}
	c.Value = "7"
	if m.Apply(c).Error != "request_id_reused" {
		t.Fatal("ID reuse silently accepted")
	}
}

func TestSnapshotDedup(t *testing.T) {
	m := New()
	c := Command{Op: "put", Key: "k", Value: "v", ClientID: "c", RequestID: "1"}
	first := m.Apply(c)
	b, e := m.Snapshot()
	if e != nil {
		t.Fatal(e)
	}
	restored := New()
	if e = restored.Restore(b); e != nil {
		t.Fatal(e)
	}
	if restored.KV["k"] != "v" || restored.Apply(c) != first {
		t.Fatal("snapshot lost data or result")
	}
}
