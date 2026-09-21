package tests

import (
	"context"
	"net"
	"testing"
	"time"

	"asterkv/internal/client"
	"asterkv/internal/raft"
	"asterkv/internal/server"
	pb "asterkv/proto/asterkv/v1"
)

func TestGRPCCluster(t *testing.T) {
	ids := []string{"a", "b", "c"}
	listeners := map[string]net.Listener{}
	endpoints := map[string]string{}
	for _, id := range ids {
		l, e := net.Listen("tcp", "127.0.0.1:0")
		if e != nil {
			t.Fatal(e)
		}
		listeners[id] = l
		endpoints[id] = l.Addr().String()
	}
	nodes := map[string]*server.Runtime{}
	for _, id := range ids {
		peers := map[string]string{}
		for p, a := range endpoints {
			if p != id {
				peers[p] = a
			}
		}
		r, e := server.Start(raft.Config{ID: id, SnapshotThreshold: 5}, listeners[id], t.TempDir(), peers)
		if e != nil {
			t.Fatal(e)
		}
		nodes[id] = r
		defer r.Close()
	}
	c, e := client.New(endpoints)
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	r, e := c.Do(ctx, "put", &pb.Command{Key: "x", Value: "5", ClientId: "c", RequestId: "1"})
	if e != nil || !r.Success {
		t.Fatal(r, e)
	}
	r, e = c.Do(ctx, "get", &pb.Command{Key: "x"})
	if e != nil || r.Value != "5" {
		t.Fatal(r, e)
	}
	for _, n := range nodes {
		if n.Node.Status().Role == raft.Leader {
			n.Close()
			break
		}
	}
	r, e = c.Do(ctx, "cas", &pb.Command{Key: "x", Expected: "5", Value: "6", ClientId: "c", RequestId: "2"})
	if e != nil || !r.Success {
		t.Fatal(r, e)
	}
	retry, e := c.Do(ctx, "cas", &pb.Command{Key: "x", Expected: "5", Value: "6", ClientId: "c", RequestId: "2"})
	if e != nil || retry.Success != r.Success {
		t.Fatal(retry, e)
	}
}
