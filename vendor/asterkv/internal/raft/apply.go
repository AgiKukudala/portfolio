package raft

import "context"

// Propose returns only after this particular log position has been applied.
// A deadline is ambiguous: its entry might still commit after this function returns.
func (n *Node) Propose(ctx context.Context, data []byte) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	n.mu.Lock()
	if err := n.available(); err != nil {
		n.mu.Unlock()
		return nil, err
	}
	if n.role != Leader {
		n.mu.Unlock()
		return nil, ErrNotLeader
	}
	i := n.lastIndex() + 1
	ch := make(chan outcome, 1)
	n.waiters[i] = ch
	n.d.Log = append(n.d.Log, Entry{Index: i, Term: n.d.Term, Command: append([]byte(nil), data...)})
	if err := n.persist(); err != nil {
		delete(n.waiters, i)
		n.mu.Unlock()
		return nil, err
	}
	n.advanceCommit()
	n.mu.Unlock()
	defer func() {
		n.mu.Lock()
		if n.waiters[i] == ch {
			delete(n.waiters, i)
		}
		n.mu.Unlock()
	}()
	select {
	case o := <-ch:
		return o.data, o.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-n.ctx.Done():
		return nil, ErrStopped
	}
}
func (n *Node) failWaiters(err error) {
	for i, ch := range n.waiters {
		ch <- outcome{err: err}
		delete(n.waiters, i)
	}
}
func (n *Node) applyCommitted() {
	if n.d.Commit != n.commit {
		n.d.Commit = n.commit
		if n.persist() != nil {
			return
		}
	}
	for n.applied < n.commit {
		i := n.applied + 1
		e := n.entryAt(i)
		var o outcome
		if len(e.Command) > 0 && n.cfg.Machine != nil {
			o.data, o.err = n.cfg.Machine.ApplyBytes(e.Command)
		}
		if o.err != nil {
			n.fatal = o.err
			n.stopped = true
			n.cancel()
			n.failWaiters(o.err)
			return
		}
		// Only this loop advances lastApplied, once per committed position.
		n.applied = i
		if ch, ok := n.waiters[i]; ok {
			ch <- o
			delete(n.waiters, i)
		}
	}
	n.maybeSnapshot()
}
