// gateway exposes a narrow browser API over the original gRPC client.
package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"

	"asterkv/internal/client"
	pb "asterkv/proto/asterkv/v1"
)

var safe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
var sem = make(chan struct{}, 4)
var mu sync.Mutex
var requests int
var window = time.Now()
var admitted int

func env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
func reply(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(value)
}
func main() {
	peers, err := client.ParsePeers(env("ASTERKV_ENDPOINTS", "node1=127.0.0.1:5101,node2=127.0.0.1:5102,node3=127.0.0.1:5103"))
	if err != nil {
		log.Fatal(err)
	}
	c, err := client.New(peers)
	if err != nil {
		log.Fatal(err)
	}
	defer c.Close()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		reply(w, 200, map[string]any{"service": "AsterKV gateway", "state": "ready"})
	})
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		nodes := []map[string]any{}
		for id, addr := range peers {
			conn, e := net.DialTimeout("tcp", addr, 150*time.Millisecond)
			reachable := e == nil
			if reachable {
				conn.Close()
			}
			nodes = append(nodes, map[string]any{"id": id, "reachable": reachable})
		}
		reply(w, 200, map[string]any{"mode": "live", "nodes": nodes, "observed_at": time.Now().UTC(), "note": "TCP reachability only. Role, term, commit and replication telemetry are not exposed by the engine."})
	})
	mux.HandleFunc("/api/command", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			reply(w, 405, map[string]string{"error": "POST required"})
			return
		}
		mu.Lock()
		if time.Since(window) > time.Minute {
			requests = 0
			window = time.Now()
		}
		requests++
		ok := requests <= 60 && admitted < 2000
		mu.Unlock()
		if !ok {
			w.Header().Set("Retry-After", "60")
			reply(w, 429, map[string]string{"error": "Gateway operation budget reached"})
			return
		}
		select {
		case sem <- struct{}{}:
			defer func() { <-sem }()
		default:
			reply(w, 429, map[string]string{"error": "Gateway busy"})
			return
		}
		var input struct {
			Op       string `json:"op"`
			Key      string `json:"key"`
			Value    string `json:"value"`
			Expected string `json:"expected"`
			Session  string `json:"session"`
			Request  string `json:"request"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
		decoder.DisallowUnknownFields()
		if e := decoder.Decode(&input); e != nil {
			reply(w, 400, map[string]string{"error": "Invalid JSON"})
			return
		}
		if decoder.Decode(&struct{}{}) != io.EOF || !safe.MatchString(input.Session) || !safe.MatchString(input.Request) || !safe.MatchString(input.Key) || len(input.Value) > 512 || len(input.Expected) > 512 {
			reply(w, 400, map[string]string{"error": "Invalid identifier or value too large"})
			return
		}
		if input.Op != "get" && input.Op != "put" && input.Op != "delete" && input.Op != "cas" {
			reply(w, 400, map[string]string{"error": "Unknown operation"})
			return
		}
		mu.Lock()
		admitted++
		mu.Unlock()
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		start := time.Now()
		result, e := c.Do(ctx, input.Op, &pb.Command{Key: "lab/" + input.Session + "/" + input.Key, Value: input.Value, Expected: input.Expected, ClientId: input.Session, RequestId: input.Request})
		if e != nil {
			reply(w, 503, map[string]any{"state": "unavailable", "error": "No confirmed response. A timed-out mutation may have committed; retry with the same request identity.", "request": input.Request})
			return
		}
		reply(w, 200, map[string]any{"mode": "live", "state": "applied", "result": map[string]any{"value": result.Value, "found": result.Found, "success": result.Success}, "elapsed_ms": float64(time.Since(start).Microseconds()) / 1000, "request": input.Request, "observed_at": time.Now().UTC()})
	})
	s := http.Server{Addr: env("ASTERKV_GATEWAY_ADDR", "127.0.0.1:8010"), Handler: mux, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	log.Fatal(s.ListenAndServe())
}
