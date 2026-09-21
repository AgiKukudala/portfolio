package raft

import (
	"context"
	"errors"
	"testing"

	pb "asterkv/proto/asterkv/v1"
)

type failedStore struct{ memory }

func (f *failedStore) Save(Durable) error { return errors.New("disk unavailable") }
func TestStorageFailureCannotGrantVote(t *testing.T) {
	n, e := New(Config{ID: "a"}, &failedStore{}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer n.Stop()
	r, e := n.RequestVote(context.Background(), &pb.VoteRequest{Term: 1, CandidateId: "b"})
	if e == nil || r != nil {
		t.Fatal("acknowledged failed persistence")
	}
	if _, e = n.RequestVote(context.Background(), &pb.VoteRequest{Term: 2, CandidateId: "c"}); e == nil {
		t.Fatal("failed node continued")
	}
}

type delayed struct {
	Transport
	started, release chan struct{}
}

func (d delayed) AppendEntries(ctx context.Context, id string, r *pb.AppendRequest) (*pb.AppendResponse, error) {
	close(d.started)
	<-d.release
	return &pb.AppendResponse{Term: r.Term, Success: true}, nil
}
func TestDelayedAcknowledgementAfterTermChange(t *testing.T) {
	tr := delayed{started: make(chan struct{}), release: make(chan struct{})}
	n, _ := New(Config{ID: "a", Peers: []string{"b", "c"}}, &memory{d: Durable{Term: 1, Log: []Entry{{Index: 1, Term: 1}}}}, tr)
	defer n.Stop()
	n.role = Leader
	n.next["b"] = 1
	done := make(chan struct{})
	go func() { n.replicate("b"); close(done) }()
	<-tr.started
	n.RequestVote(context.Background(), &pb.VoteRequest{Term: 2, CandidateId: "b", LastLogIndex: 1, LastLogTerm: 1})
	close(tr.release)
	<-done
	if n.Status().CommitIndex != 0 || n.Status().Role != Follower {
		t.Fatal("stale reply committed", n.Status())
	}
}
func TestCommittedSuffixProtected(t *testing.T) {
	n, _ := New(Config{ID: "a"}, &memory{d: Durable{Term: 2, Commit: 1, Log: []Entry{{Index: 1, Term: 1}}}}, nil)
	defer n.Stop()
	_, e := n.AppendEntries(context.Background(), &pb.AppendRequest{Term: 2, Entries: []*pb.Entry{{Index: 1, Term: 2}}})
	if e == nil || n.termAt(1) != 1 {
		t.Fatal("committed entry replaced")
	}
}

func TestMalformedBatchDoesNotPartiallyAppend(t *testing.T) {
	n, _ := New(Config{ID: "a"}, &memory{}, nil)
	defer n.Stop()
	_, e := n.AppendEntries(context.Background(), &pb.AppendRequest{Term: 1, Entries: []*pb.Entry{{Index: 1, Term: 1}, {Index: 3, Term: 1}}})
	if e == nil || n.lastIndex() != 0 {
		t.Fatal("partial malformed batch accepted")
	}
}
func TestMembershipCannotChangeOnRestart(t *testing.T) {
	s := &memory{}
	n, _ := New(Config{ID: "a", Peers: []string{"b", "c"}}, s, nil)
	n.RequestVote(context.Background(), &pb.VoteRequest{Term: 1, CandidateId: "b"})
	n.Stop()
	if _, e := New(Config{ID: "a", Peers: []string{"b", "d"}}, s, nil); e == nil {
		t.Fatal("silent membership change")
	}
}
