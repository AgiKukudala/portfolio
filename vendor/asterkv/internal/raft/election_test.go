package raft

import (
	"context"
	"testing"
	"time"

	pb "asterkv/proto/asterkv/v1"
)

type memory struct{ d Durable }

func (m *memory) Load() (Durable, error) { return m.d, nil }
func (m *memory) Save(d Durable) error   { m.d = d; return nil }
func TestVoteAndTerms(t *testing.T) {
	n, e := New(Config{ID: "a"}, &memory{}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer n.Stop()
	vote := func(term uint64, id string) bool {
		r, e := n.RequestVote(context.Background(), &pb.VoteRequest{Term: term, CandidateId: id})
		if e != nil {
			t.Fatal(e)
		}
		return r.Granted
	}
	if !vote(1, "b") || vote(1, "c") || vote(0, "b") || !vote(2, "c") {
		t.Fatal("vote invariant")
	}
	n.mu.Lock()
	n.role = Candidate
	n.mu.Unlock()
	vote(3, "b")
	if n.Status().Role != Follower {
		t.Fatal("higher term did not step down")
	}
	n.mu.Lock()
	n.d.Log = []Entry{{Index: 1, Term: 3}}
	n.mu.Unlock()
	if vote(4, "c") {
		t.Fatal("outdated candidate won vote")
	}
}
func TestSingleElection(t *testing.T) {
	n, e := New(Config{ID: "a", Heartbeat: time.Millisecond, ElectionMin: 4 * time.Millisecond, ElectionMax: 8 * time.Millisecond}, &memory{}, nil)
	if e != nil {
		t.Fatal(e)
	}
	n.Start()
	defer n.Stop()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if n.Status().Role == Leader {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("no leader")
}
