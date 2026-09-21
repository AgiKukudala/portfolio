package server

import (
	"net"
	"sync"
	"time"

	"asterkv/internal/raft"
	"asterkv/internal/state"
	"asterkv/internal/storage"
	pb "asterkv/proto/asterkv/v1"

	"google.golang.org/grpc"
)

type Runtime struct {
	Node      *raft.Node
	grpc      *grpc.Server
	store     *storage.File
	transport *raft.GRPCTransport
	done      chan struct{}
	once      sync.Once
}

func Start(cfg raft.Config, listener net.Listener, dir string, peers map[string]string) (*Runtime, error) {
	s, e := storage.Open(dir)
	if e != nil {
		return nil, e
	}
	tr, e := raft.NewGRPCTransport(peers)
	if e != nil {
		s.Close()
		return nil, e
	}
	cfg.Peers = nil
	for p := range peers {
		cfg.Peers = append(cfg.Peers, p)
	}
	cfg.Machine = state.New()
	n, e := raft.New(cfg, s, tr)
	if e != nil {
		tr.Close()
		s.Close()
		return nil, e
	}
	g := grpc.NewServer(grpc.MaxRecvMsgSize(raft.MaxMessageSize), grpc.MaxSendMsgSize(raft.MaxMessageSize))
	srv := &Server{Node: n}
	pb.RegisterKVServer(g, srv)
	pb.RegisterRaftServer(g, srv)
	r := &Runtime{Node: n, grpc: g, store: s, transport: tr, done: make(chan struct{})}
	go func() { defer close(r.done); _ = g.Serve(listener) }()
	n.Start()
	return r, nil
}
func (r *Runtime) Close() {
	r.once.Do(func() {
		r.Node.Stop()
		done := make(chan struct{})
		go func() { r.grpc.GracefulStop(); close(done) }()
		select {
		case <-done:
		case <-time.After(time.Second):
			r.grpc.Stop()
			<-done
		}
		<-r.done
		r.transport.Close()
		r.store.Close()
	})
}
