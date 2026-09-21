package tests

import (
	"context"
	"net"
	"os"
	"os/exec"
	"testing"
	"time"

	"asterkv/internal/client"
	"asterkv/internal/raft"
	"asterkv/internal/server"
	pb "asterkv/proto/asterkv/v1"
)

// The helper inherits a bound socket; the parent uses SIGKILL with no shutdown flush.
func TestNodeProcess(t *testing.T) {
	if os.Getenv("ASTERKV_CHILD") != "1" {
		return
	}
	f := os.NewFile(3, "listener")
	l, e := net.FileListener(f)
	f.Close()
	if e != nil {
		t.Fatal(e)
	}
	peers, e := client.ParsePeers(os.Getenv("ASTERKV_PEERS"))
	if e != nil {
		t.Fatal(e)
	}
	r, e := server.Start(raft.Config{ID: os.Getenv("ASTERKV_ID"), SnapshotThreshold: 3}, l, os.Getenv("ASTERKV_DATA"), peers)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	select {}
}
func TestProcessKillAndRecovery(t *testing.T) {
	exe, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	ids := []string{"a", "b", "c"}
	endpoints := map[string]string{}
	listeners := map[string]*net.TCPListener{}
	dirs := map[string]string{}
	commands := map[string]*exec.Cmd{}
	for _, id := range ids {
		l, e := net.Listen("tcp", "127.0.0.1:0")
		if e != nil {
			t.Fatal(e)
		}
		listeners[id] = l.(*net.TCPListener)
		endpoints[id] = l.Addr().String()
		dirs[id] = t.TempDir()
	}
	start := func(id string, l *net.TCPListener) {
		t.Helper()
		file, e := l.File()
		if e != nil {
			t.Fatal(e)
		}
		defer file.Close()
		peers := ""
		for _, p := range ids {
			if p != id {
				if peers != "" {
					peers += ","
				}
				peers += p + "=" + endpoints[p]
			}
		}
		cmd := exec.Command(exe, "-test.run=^TestNodeProcess$")
		cmd.Env = append(os.Environ(), "ASTERKV_CHILD=1", "ASTERKV_ID="+id, "ASTERKV_DATA="+dirs[id], "ASTERKV_PEERS="+peers)
		cmd.ExtraFiles = []*os.File{file}
		if e = cmd.Start(); e != nil {
			t.Fatal(e)
		}
		l.Close()
		commands[id] = cmd
	}
	t.Cleanup(func() {
		for _, cmd := range commands {
			cmd.Process.Kill()
			cmd.Wait()
		}
	})
	for _, id := range ids {
		start(id, listeners[id])
	}
	c, e := client.New(endpoints)
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := &pb.Command{Key: "x", Value: "5", ClientId: "process", RequestId: "1"}
	if _, e = c.Do(ctx, "put", cmd); e != nil {
		t.Fatal(e)
	}
	// Kill every process; only already-synced storage can survive this failure.
	for id, p := range commands {
		p.Process.Kill()
		p.Wait()
		delete(commands, id)
	}
	for _, id := range ids {
		l, e := net.Listen("tcp", endpoints[id])
		if e != nil {
			t.Fatal(e)
		}
		start(id, l.(*net.TCPListener))
	}
	r, e := c.Do(ctx, "get", &pb.Command{Key: "x"})
	if e != nil || r.Value != "5" {
		t.Fatal("lost committed write after SIGKILL", r, e)
	}
	r, e = c.Do(ctx, "put", cmd)
	if e != nil || r.Found {
		t.Fatal("retry did not preserve original result", r, e)
	}
}
