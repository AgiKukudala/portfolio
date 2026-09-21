package raft

import (
	"context"
	"fmt"

	pb "asterkv/proto/asterkv/v1"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

const MaxMessageSize = 64 << 20

type GRPCTransport struct {
	clients map[string]pb.RaftClient
	conns   []*grpc.ClientConn
}

func NewGRPCTransport(peers map[string]string) (*GRPCTransport, error) {
	t := &GRPCTransport{clients: map[string]pb.RaftClient{}}
	for id, addr := range peers {
		c, e := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(MaxMessageSize), grpc.MaxCallSendMsgSize(MaxMessageSize)))
		if e != nil {
			t.Close()
			return nil, e
		}
		t.conns = append(t.conns, c)
		t.clients[id] = pb.NewRaftClient(c)
	}
	return t, nil
}
func (t *GRPCTransport) Close() {
	for _, c := range t.conns {
		c.Close()
	}
}
func (t *GRPCTransport) RequestVote(ctx context.Context, id string, r *pb.VoteRequest) (*pb.VoteResponse, error) {
	c, ok := t.clients[id]
	if !ok {
		return nil, fmt.Errorf("unknown peer %s", id)
	}
	return c.RequestVote(ctx, r)
}
func (t *GRPCTransport) AppendEntries(ctx context.Context, id string, r *pb.AppendRequest) (*pb.AppendResponse, error) {
	c, ok := t.clients[id]
	if !ok {
		return nil, fmt.Errorf("unknown peer %s", id)
	}
	return c.AppendEntries(ctx, r)
}
func (t *GRPCTransport) InstallSnapshot(ctx context.Context, id string, r *pb.SnapshotRequest) (*pb.SnapshotResponse, error) {
	c, ok := t.clients[id]
	if !ok {
		return nil, fmt.Errorf("unknown peer %s", id)
	}
	return c.InstallSnapshot(ctx, r)
}
