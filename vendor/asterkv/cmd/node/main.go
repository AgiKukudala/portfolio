package main

import (
	"flag"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"asterkv/internal/client"
	"asterkv/internal/raft"
	"asterkv/internal/server"
)

func main() {
	id := flag.String("id", "node1", "unique node ID")
	addr := flag.String("addr", "127.0.0.1:5001", "listen address")
	peers := flag.String("peers", "", "comma-separated id=host:port, excluding self")
	data := flag.String("data", "data/node1", "exclusive data directory")
	snap := flag.Uint64("snapshot-threshold", 1000, "applied entries between snapshots (0 disables)")
	hb := flag.Duration("heartbeat", 50*time.Millisecond, "heartbeat interval")
	emin := flag.Duration("election-min", 250*time.Millisecond, "minimum election timeout")
	emax := flag.Duration("election-max", 500*time.Millisecond, "maximum election timeout")
	rpc := flag.Duration("rpc-timeout", 150*time.Millisecond, "peer RPC deadline")
	debug := flag.Bool("debug", false, "include commit and replication diagnostics")
	flag.Parse()
	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)
	p, e := client.ParsePeers(*peers)
	if e != nil {
		slog.Error("configuration", "error", e)
		os.Exit(1)
	}
	l, e := net.Listen("tcp", *addr)
	if e != nil {
		slog.Error("listen", "error", e)
		os.Exit(1)
	}
	r, e := server.Start(raft.Config{ID: *id, SnapshotThreshold: *snap, Heartbeat: *hb, ElectionMin: *emin, ElectionMax: *emax, RPCTimeout: *rpc, Logger: logger}, l, *data, p)
	if e != nil {
		l.Close()
		slog.Error("startup", "error", e)
		os.Exit(1)
	}
	slog.Info("node ready", "node", *id, "address", l.Addr())
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	<-ch
	signal.Stop(ch)
	r.Close()
}
