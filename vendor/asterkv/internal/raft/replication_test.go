package raft

import (
	"context"
	"testing"

	pb "asterkv/proto/asterkv/v1"
)

func TestLogMatching(t *testing.T) {
	n, _ := New(Config{ID: "b"}, &memory{d: Durable{Term: 2, Log: []Entry{{Index: 1, Term: 1}, {Index: 2, Term: 2}}}}, nil)
	defer n.Stop()
	call := func(r *pb.AppendRequest) *pb.AppendResponse {
		o, e := n.AppendEntries(context.Background(), r)
		if e != nil {
			t.Fatal(e)
		}
		return o
	}
	if call(&pb.AppendRequest{Term: 1}).Success {
		t.Fatal("stale leader")
	}
	if call(&pb.AppendRequest{Term: 3, PrevLogIndex: 2, PrevLogTerm: 1}).Success {
		t.Fatal("mismatch accepted")
	}
	r := &pb.AppendRequest{Term: 3, PrevLogIndex: 1, PrevLogTerm: 1, Entries: []*pb.Entry{{Index: 2, Term: 3}}, LeaderCommit: 2}
	if !call(r).Success || !call(r).Success {
		t.Fatal("append or duplicate failed")
	}
	if n.Status().CommitIndex != 2 || n.termAt(2) != 3 {
		t.Fatal(n.Status())
	}
}
func TestCurrentTermCommit(t *testing.T) {
	n, _ := New(Config{ID: "a", Peers: []string{"b", "c"}}, &memory{d: Durable{Term: 2, Log: []Entry{{Index: 1, Term: 1}}}}, nil)
	defer n.Stop()
	n.role = Leader
	n.match["b"] = 1
	n.advanceCommit()
	if n.commit != 0 {
		t.Fatal("old term committed by counting")
	}
	n.d.Log = append(n.d.Log, Entry{Index: 2, Term: 2})
	n.advanceCommit()
	if n.commit != 0 {
		t.Fatal("minority committed")
	}
	n.match["b"] = 2
	n.advanceCommit()
	if n.commit != 2 {
		t.Fatal("quorum did not commit")
	}
}
