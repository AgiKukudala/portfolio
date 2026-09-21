package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"asterkv/internal/client"
	pb "asterkv/proto/asterkv/v1"
)

func main() {
	endpoints := flag.String("endpoints", "node1=127.0.0.1:5001,node2=127.0.0.1:5002,node3=127.0.0.1:5003", "cluster endpoints")
	cid := flag.String("client-id", "", "stable client identity")
	rid := flag.String("request-id", "", "reuse for retrying this exact mutation")
	timeout := flag.Duration("timeout", 5*time.Second, "total request deadline")
	flag.Parse()
	a := flag.Args()
	if len(a) < 2 {
		fail("usage: asterkv-client [flags] get|put|delete|cas key [values]")
	}
	op := a[0]
	r := &pb.Command{Key: a[1], ClientId: *cid, RequestId: *rid}
	switch {
	case op == "get" && len(a) == 2:
	case op == "delete" && len(a) == 2:
	case op == "put" && len(a) == 3:
		r.Value = a[2]
	case op == "cas" && len(a) == 4:
		r.Expected = a[2]
		r.Value = a[3]
	default:
		fail("invalid operation or arguments")
	}
	if r.ClientId == "" {
		r.ClientId = client.ID()
	}
	if r.RequestId == "" {
		r.RequestId = client.ID()
	}
	if op != "get" {
		fmt.Fprintf(os.Stderr, "retry identity: --client-id=%s --request-id=%s\n", r.ClientId, r.RequestId)
	}
	peers, e := client.ParsePeers(*endpoints)
	if e != nil {
		fail(e)
	}
	c, e := client.New(peers)
	if e != nil {
		fail(e)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	out, e := c.Do(ctx, op, r)
	if e != nil {
		fail(e)
	}
	json.NewEncoder(os.Stdout).Encode(out)
}
func fail(e any) { fmt.Fprintln(os.Stderr, e); os.Exit(1) }
