// bench measures a local disk-backed cluster; it does not estimate production capacity.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"os"
	"runtime"
	"sort"
	"time"

	"asterkv/internal/client"
	"asterkv/internal/raft"
	"asterkv/internal/server"
	"asterkv/internal/sim"
	"asterkv/internal/state"
	pb "asterkv/proto/asterkv/v1"
)

type distribution struct {
	P50MS float64 `json:"p50_ms"`
	P95MS float64 `json:"p95_ms"`
	P99MS float64 `json:"p99_ms"`
}
type report struct {
	Scenario, Transport, Go, OS, Arch string
	Operations                        int
	ElapsedSeconds, ThroughputOpsSec  float64
	Put, Get                          distribution
	RecoveryMS, FollowerCatchupMS     float64
	FailureModel                      string
}

func stats(d []time.Duration) distribution {
	sort.Slice(d, func(i, j int) bool { return d[i] < d[j] })
	q := func(p float64) float64 {
		return float64(d[int(math.Ceil(float64(len(d))*p))-1]) / float64(time.Millisecond)
	}
	return distribution{q(.50), q(.95), q(.99)}
}
func main() {
	count := flag.Int("n", 100, "PUT/GET pairs per scenario")
	scenario := flag.String("scenario", "all", "normal, leader-failure, dropped, or all")
	flag.Parse()
	if *scenario != "all" && *scenario != "normal" && *scenario != "leader-failure" && *scenario != "dropped" {
		fatal(fmt.Errorf("unknown scenario %q", *scenario))
	}
	if *count < 2 {
		fatal(fmt.Errorf("n must be at least 2"))
	}
	for _, s := range []string{"normal", "leader-failure", "dropped"} {
		if *scenario != "all" && *scenario != s {
			continue
		}
		r, e := run(s, *count)
		if e != nil {
			fatal(e)
		}
		json.NewEncoder(os.Stdout).Encode(r)
	}
}
func fatal(e error) { fmt.Fprintln(os.Stderr, e); os.Exit(1) }
func run(scenario string, count int) (report, error) {
	r := report{Scenario: scenario, Go: runtime.Version(), OS: runtime.GOOS, Arch: runtime.GOARCH, Operations: 2 * count}
	dir, e := os.MkdirTemp("", "asterkv-bench-")
	if e != nil {
		return r, e
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	var do func(string, *pb.Command) error
	var crash func() error
	var catchup func() (float64, error)
	if scenario == "dropped" {
		c, e := sim.New(dir, 3, 20)
		if e != nil {
			return r, e
		}
		defer c.Close()
		if _, e = c.Leader(ctx, nil); e != nil {
			return r, e
		}
		c.Net.Faults(5, 3*time.Millisecond, true)
		r.Transport = "in-process fault transport + durable files"
		r.FailureModel = "every fifth RPC selected for request/reply loss; 3ms delay; duplicate deliveries"
		do = func(op string, p *pb.Command) error {
			_, e := c.Do(ctx, state.Command{Op: op, Key: p.Key, Value: p.Value, ClientID: p.ClientId, RequestID: p.RequestId})
			return e
		}
		catchup = func() (float64, error) {
			c.Net.Faults(0, 0, false)
			leader, e := c.Leader(ctx, nil)
			if e != nil {
				return 0, e
			}
			follower := ""
			for _, id := range c.IDs {
				if id != leader {
					follower = id
					break
				}
			}
			c.Crash(follower)
			for i := 0; i < 25; i++ {
				if e = do("put", &pb.Command{Key: "catchup", Value: fmt.Sprint(i), ClientId: "catchup", RequestId: fmt.Sprint(i)}); e != nil {
					return 0, e
				}
			}
			start := time.Now()
			if e = c.Restart(follower); e != nil {
				return 0, e
			}
			for {
				m, e := c.AppliedState(follower)
				if e != nil {
					return 0, e
				}
				if m.KV["catchup"] == "24" {
					return float64(time.Since(start)) / float64(time.Millisecond), nil
				}
				select {
				case <-ctx.Done():
					return 0, ctx.Err()
				case <-time.After(5 * time.Millisecond):
				}
			}
		}
	} else {
		r.Transport = "gRPC over loopback TCP + durable files"
		ids := []string{"node1", "node2", "node3"}
		listeners := map[string]net.Listener{}
		endpoints := map[string]string{}
		nodes := map[string]*server.Runtime{}
		defer func() {
			for _, n := range nodes {
				n.Close()
			}
			for _, l := range listeners {
				l.Close()
			}
		}()
		for _, id := range ids {
			l, e := net.Listen("tcp", "127.0.0.1:0")
			if e != nil {
				return r, e
			}
			listeners[id] = l
			endpoints[id] = l.Addr().String()
		}
		for _, id := range ids {
			peers := map[string]string{}
			for p, a := range endpoints {
				if p != id {
					peers[p] = a
				}
			}
			n, e := server.Start(raft.Config{ID: id, SnapshotThreshold: 20, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, listeners[id], dir+"/"+id, peers)
			if e != nil {
				return r, e
			}
			nodes[id] = n
		}
		c, e := client.New(endpoints)
		if e != nil {
			return r, e
		}
		defer c.Close()
		do = func(op string, p *pb.Command) error { _, e := c.Do(ctx, op, p); return e }
		crash = func() error {
			for _, id := range ids {
				if nodes[id].Node.Status().Role == raft.Leader {
					start := time.Now()
					nodes[id].Close()
					e := do("put", &pb.Command{Key: "recovery", Value: "ready", ClientId: "recovery", RequestId: "1"})
					r.RecoveryMS = float64(time.Since(start)) / float64(time.Millisecond)
					return e
				}
			}
			return fmt.Errorf("no leader to stop")
		}
		r.FailureModel = "none"
		if scenario == "leader-failure" {
			r.FailureModel = "stop leader runtime midway; recovery includes election and client retry"
		}
	}
	if e = do("put", &pb.Command{Key: "warmup", Value: "ready", ClientId: "warmup", RequestId: "1"}); e != nil {
		return r, e
	}
	puts, gets := []time.Duration{}, []time.Duration{}
	start := time.Now()
	for i := 0; i < count; i++ {
		if scenario == "leader-failure" && i == count/2 {
			if e = crash(); e != nil {
				return r, e
			}
		}
		p := &pb.Command{Key: "x", Value: fmt.Sprint(i), ClientId: "bench", RequestId: fmt.Sprint(i)}
		at := time.Now()
		if e = do("put", p); e != nil {
			return r, e
		}
		puts = append(puts, time.Since(at))
		at = time.Now()
		if e = do("get", &pb.Command{Key: "x"}); e != nil {
			return r, e
		}
		gets = append(gets, time.Since(at))
	}
	r.ElapsedSeconds = time.Since(start).Seconds()
	r.ThroughputOpsSec = float64(r.Operations) / r.ElapsedSeconds
	r.Put = stats(puts)
	r.Get = stats(gets)
	if catchup != nil {
		r.FollowerCatchupMS, e = catchup()
	}
	return r, e
}
