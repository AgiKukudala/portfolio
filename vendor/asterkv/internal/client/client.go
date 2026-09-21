// Package client retries ambiguous RPCs using the same logical request identity.
package client

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	pb "asterkv/proto/asterkv/v1"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

type Client struct {
	clients        map[string]pb.KVClient
	ids            []string
	conns          []*grpc.ClientConn
	ID             string
	AttemptTimeout time.Duration
}

func ID() string {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(b[:])
}
func ParsePeers(s string) (map[string]string, error) {
	out := map[string]string{}
	if s == "" {
		return out, nil
	}
	for _, part := range strings.Split(s, ",") {
		id, addr, ok := strings.Cut(part, "=")
		if !ok || id == "" || addr == "" || out[id] != "" {
			return nil, fmt.Errorf("invalid peer %q; use id=host:port", part)
		}
		out[id] = addr
	}
	return out, nil
}
func New(peers map[string]string) (*Client, error) {
	if len(peers) == 0 {
		return nil, errors.New("no endpoints")
	}
	c := &Client{clients: map[string]pb.KVClient{}, ID: ID(), AttemptTimeout: 700 * time.Millisecond}
	for id, addr := range peers {
		conn, e := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if e != nil {
			c.Close()
			return nil, e
		}
		c.conns = append(c.conns, conn)
		c.clients[id] = pb.NewKVClient(conn)
		c.ids = append(c.ids, id)
	}
	sort.Strings(c.ids)
	return c, nil
}
func (c *Client) Close() {
	for _, conn := range c.conns {
		conn.Close()
	}
}
func (c *Client) Do(ctx context.Context, op string, input *pb.Command) (*pb.Result, error) {
	if op != "get" && op != "put" && op != "delete" && op != "cas" {
		return nil, errors.New("unknown operation")
	}
	r := proto.Clone(input).(*pb.Command)
	// IDs are assigned ONCE outside the retry loop. Explicit IDs also survive CLI restarts.
	if r.ClientId == "" {
		r.ClientId = c.ID
	}
	if r.RequestId == "" {
		r.RequestId = ID()
	}
	target := c.ids[0]
	attempt := 0
	for {
		if e := ctx.Err(); e != nil {
			return nil, e
		}
		callCtx, cancel := context.WithTimeout(ctx, c.AttemptTimeout)
		cl := c.clients[target]
		var out *pb.Result
		var e error
		switch op {
		case "get":
			out, e = cl.Get(callCtx, r)
		case "put":
			out, e = cl.Put(callCtx, r)
		case "delete":
			out, e = cl.Delete(callCtx, r)
		case "cas":
			out, e = cl.CompareAndSwap(callCtx, r)
		}
		cancel()
		if e == nil && out.Error != "not_leader" {
			if out.Error != "" {
				return nil, errors.New(out.Error)
			}
			return out, nil
		}
		if e != nil && (status.Code(e) == codes.InvalidArgument || status.Code(e) == codes.PermissionDenied) {
			return nil, e
		}
		attempt++
		target = c.ids[attempt%len(c.ids)]
		if e == nil && c.clients[out.Leader] != nil {
			target = out.Leader
		}
		timer := time.NewTimer(20 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
