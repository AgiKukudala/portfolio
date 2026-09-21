package tests

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"asterkv/internal/sim"
	"asterkv/internal/state"
)

func cluster(t *testing.T, size int, snap uint64) (*sim.Cluster, context.Context) {
	t.Helper()
	c, e := sim.New(t.TempDir(), size, snap)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(c.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	t.Cleanup(cancel)
	return c, ctx
}
func mustDo(t *testing.T, c *sim.Cluster, ctx context.Context, cmd state.Command) state.Result {
	t.Helper()
	r, e := c.Do(ctx, cmd)
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func converge(t *testing.T, c *sim.Cluster, key, value string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ok := true
		for id := range c.Nodes {
			m, e := c.AppliedState(id)
			if e != nil {
				t.Fatal(e)
			}
			if m.KV[key] != value {
				ok = false
			}
		}
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	for id, n := range c.Nodes {
		t.Log(id, n.Status())
	}
	t.Fatal("replicas did not converge")
}
func TestHeartbeatAndFiveNodes(t *testing.T) {
	c, ctx := cluster(t, 5, 0)
	leader, e := c.Leader(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	term := c.Nodes[leader].Status().Term
	mustDo(t, c, ctx, state.Command{Op: "put", Key: "x", Value: "5"})
	time.Sleep(650 * time.Millisecond)
	for id, n := range c.Nodes {
		if n.Status().Term != term {
			t.Fatal("unnecessary election", id, n.Status())
		}
	}
	converge(t, c, "x", "5")
}
func TestPartitionReconcilesOldLeader(t *testing.T) {
	c, ctx := cluster(t, 3, 0)
	old, e := c.Leader(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	mustDo(t, c, ctx, state.Command{Op: "put", Key: "x", Value: "base"})
	others := []string{}
	for _, id := range c.IDs {
		if id != old {
			others = append(others, id)
		}
	}
	c.Net.Partition([]string{old}, others)
	for _, op := range []string{"put", "get"} {
		b, _ := json.Marshal(state.Command{Op: op, Key: "x", Value: "orphan"})
		short, cancel := context.WithTimeout(ctx, 180*time.Millisecond)
		_, e = c.Nodes[old].Propose(short, b)
		cancel()
		if e == nil {
			t.Fatal("isolated leader served", op)
		}
	}
	if _, e = c.Leader(ctx, others); e != nil {
		t.Fatal(e)
	}
	mustDo(t, c, ctx, state.Command{Op: "put", Key: "x", Value: "majority"})
	c.Net.Heal()
	converge(t, c, "x", "majority")
}
func TestFaultsAndSnapshotCatchup(t *testing.T) {
	c, ctx := cluster(t, 3, 5)
	leader, e := c.Leader(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	follower := ""
	for _, id := range c.IDs {
		if id != leader {
			follower = id
			break
		}
	}
	c.Crash(follower)
	c.Net.Faults(5, 3*time.Millisecond, true)
	for i := 0; i < 18; i++ {
		mustDo(t, c, ctx, state.Command{Op: "put", Key: "x", Value: fmt.Sprint(i), ClientID: "writer", RequestID: fmt.Sprint(i)})
	}
	c.Net.Faults(0, 0, false)
	if e = c.Restart(follower); e != nil {
		t.Fatal(e)
	}
	converge(t, c, "x", "17")
	if c.Nodes[follower].DurableCopy().SnapshotIndex == 0 {
		t.Fatal("lagging follower did not install snapshot")
	}
	c.Crash(follower)
	if e = c.Restart(follower); e != nil {
		t.Fatal(e)
	}
	converge(t, c, "x", "17")
}
func TestLostCASResponseLeaderCrash(t *testing.T) {
	c, ctx := cluster(t, 3, 3)
	mustDo(t, c, ctx, state.Command{Op: "put", Key: "x", Value: "5", ClientID: "seed", RequestID: "1"})
	cmd := state.Command{Op: "cas", Key: "x", Expected: "5", Value: "6", ClientID: "client", RequestID: "91"}
	original := mustDo(t, c, ctx, cmd)
	if !original.Success {
		t.Fatal(original)
	}
	// The harness discards the applied result, modelling a lost client response.
	old, e := c.Leader(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	c.Crash(old)
	retry := mustDo(t, c, ctx, cmd)
	if retry != original {
		t.Fatal("CAS re-evaluated", original, retry)
	}
	if e = c.Restart(old); e != nil {
		t.Fatal(e)
	}
	converge(t, c, "x", "6")
}
func TestConcurrentCAS(t *testing.T) {
	c, ctx := cluster(t, 3, 4)
	mustDo(t, c, ctx, state.Command{Op: "put", Key: "x", Value: "5"})
	var wg sync.WaitGroup
	results := make(chan state.Result, 2)
	errs := make(chan error, 2)
	for i := 6; i <= 7; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, e := c.Do(ctx, state.Command{Op: "cas", Key: "x", Expected: "5", Value: fmt.Sprint(i), ClientID: fmt.Sprint(i), RequestID: "1"})
			results <- r
			errs <- e
		}(i)
	}
	wg.Wait()
	close(results)
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	success := 0
	for r := range results {
		if r.Success {
			success++
		}
	}
	if success != 1 {
		t.Fatal("CAS successes", success)
	}
	r := mustDo(t, c, ctx, state.Command{Op: "get", Key: "x"})
	converge(t, c, "x", r.Value)
}
func TestEntireClusterRestart(t *testing.T) {
	c, ctx := cluster(t, 3, 4)
	for i := 0; i < 8; i++ {
		mustDo(t, c, ctx, state.Command{Op: "put", Key: "x", Value: fmt.Sprint(i), ClientID: "c", RequestID: fmt.Sprint(i)})
	}
	c.Close()
	for _, id := range c.IDs {
		if e := c.Restart(id); e != nil {
			t.Fatal(e)
		}
	}
	r := mustDo(t, c, ctx, state.Command{Op: "get", Key: "x"})
	if r.Value != "7" {
		t.Fatal(r)
	}
	converge(t, c, "x", "7")
}
