// Package server translates gRPC into consensus commands. No mutation executes here.
package server

import (
	"context"
	"encoding/json"
	"errors"

	"asterkv/internal/raft"
	"asterkv/internal/state"
	pb "asterkv/proto/asterkv/v1"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type Server struct {
	pb.UnimplementedKVServer
	pb.UnimplementedRaftServer
	Node *raft.Node
}

func (s *Server) execute(ctx context.Context, c *pb.Command, op string) (*pb.Result, error) {
	if len(c.ClientId) > 256 || len(c.RequestId) > 256 {
		return nil, status.Error(codes.InvalidArgument, "request identity too large")
	}
	if len(c.Key) > 4096 || len(c.Value) > 1024*1024 || len(c.Expected) > 1024*1024 {
		return nil, status.Error(codes.InvalidArgument, "key/value too large")
	}
	if op != "get" && (c.ClientId == "" || c.RequestId == "") {
		return nil, status.Error(codes.InvalidArgument, "client_id and request_id required")
	}
	b, _ := json.Marshal(state.Command{Op: op, Key: c.Key, Value: c.Value, Expected: c.Expected, ClientID: c.ClientId, RequestID: c.RequestId})
	out, err := s.Node.Propose(ctx, b)
	if errors.Is(err, raft.ErrNotLeader) {
		return &pb.Result{Error: "not_leader", Leader: s.Node.Status().Leader}, nil
	}
	if err != nil {
		if ctx.Err() != nil {
			return nil, status.FromContextError(ctx.Err()).Err()
		}
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	var r state.Result
	if err = json.Unmarshal(out, &r); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &pb.Result{Value: r.Value, Found: r.Found, Success: r.Success, Error: r.Error}, nil
}
func (s *Server) Get(c context.Context, r *pb.Command) (*pb.Result, error) {
	return s.execute(c, r, "get")
}
func (s *Server) Put(c context.Context, r *pb.Command) (*pb.Result, error) {
	return s.execute(c, r, "put")
}
func (s *Server) Delete(c context.Context, r *pb.Command) (*pb.Result, error) {
	return s.execute(c, r, "delete")
}
func (s *Server) CompareAndSwap(c context.Context, r *pb.Command) (*pb.Result, error) {
	return s.execute(c, r, "cas")
}
func (s *Server) RequestVote(c context.Context, r *pb.VoteRequest) (*pb.VoteResponse, error) {
	return s.Node.RequestVote(c, r)
}
func (s *Server) AppendEntries(c context.Context, r *pb.AppendRequest) (*pb.AppendResponse, error) {
	return s.Node.AppendEntries(c, r)
}
func (s *Server) InstallSnapshot(c context.Context, r *pb.SnapshotRequest) (*pb.SnapshotResponse, error) {
	return s.Node.InstallSnapshot(c, r)
}
