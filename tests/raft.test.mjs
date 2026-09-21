import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from './sim-harness.mjs';
import { KVMachine, RaftNode, mulberry32 } from '../src/sim/raft-core.js';

const put = (key, value) => ({ op: 'put', key, value });
const get = (key) => ({ op: 'get', key });
const cas = (key, expected, value) => ({ op: 'cas', key, expected, value });
const del = (key) => ({ op: 'delete', key });

const TIMING = { heartbeat: 300, electionMin: 1500, electionMax: 3000 };

test('state machine mirrors internal/state/machine.go', () => {
  const m = new KVMachine();
  const id = (n) => ({ clientId: 'c', requestId: `r${n}` });
  assert.deepEqual(m.apply({ op: 'get', key: 'k' }), { value: '', found: false, success: true });
  assert.equal(m.apply({ op: 'put', key: 'k', value: 'a', ...id(1) }).success, true);
  assert.deepEqual(m.apply({ op: 'cas', key: 'k', expected: 'x', value: 'b', ...id(2) }), { value: 'a', found: true, success: false });
  assert.equal(m.apply({ op: 'cas', key: 'k', expected: 'a', value: 'b', ...id(3) }).success, true);
  // Retrying request 3 returns the cached success instead of re-evaluating (which would now fail).
  const retry = m.apply({ op: 'cas', key: 'k', expected: 'a', value: 'b', ...id(3) });
  assert.equal(retry.success, true);
  assert.equal(retry.deduplicated, true);
  assert.equal(m.apply({ op: 'put', key: 'k', value: 'different', ...id(3) }).error, 'request_id_reused');
  assert.deepEqual(m.apply({ op: 'cas', key: 'missing', expected: '', value: 'v', ...id(4) }).success, false);
  assert.equal(m.apply({ op: 'delete', key: 'k', ...id(5) }).found, true);
  assert.equal(m.kv.size, 0);
});

test('a node refuses to vote for a candidate with a less up-to-date log', () => {
  const node = new RaftNode({
    id: 'node1', peers: ['node2', 'node3'], timing: TIMING, random: mulberry32(1),
    durable: { term: 2, vote: '', commit: 0, log: [{ index: 1, term: 1, command: null }, { index: 2, term: 2, command: null }] },
  });
  node.receive({ type: 'vote', from: 'node2', to: 'node1', term: 3, candidate: 'node2', lastLogIndex: 5, lastLogTerm: 1 }, 0);
  let out = node.drain();
  assert.equal(out.messages[0].granted, false, 'higher index but older last term is not up to date');
  assert.equal(out.durable.term, 3, 'the higher term is still adopted and persisted');

  node.receive({ type: 'vote', from: 'node3', to: 'node1', term: 3, candidate: 'node3', lastLogIndex: 2, lastLogTerm: 2 }, 0);
  out = node.drain();
  assert.equal(out.messages[0].granted, true);
  assert.equal(out.durable.vote, 'node3', 'vote persisted in the same drain that sends the grant');

  node.receive({ type: 'vote', from: 'node2', to: 'node1', term: 3, candidate: 'node2', lastLogIndex: 9, lastLogTerm: 3 }, 0);
  assert.equal(node.drain().messages[0].granted, false, 'one vote per term');
});

test('a follower never overwrites committed entries but replaces a conflicting uncommitted suffix', () => {
  const node = new RaftNode({
    id: 'node1', peers: ['node2', 'node3'], timing: TIMING, random: mulberry32(1),
    durable: {
      term: 2, vote: '', commit: 1,
      log: [{ index: 1, term: 1, command: null }, { index: 2, term: 2, command: { op: 'put', key: 'k', value: 'stale', expected: '', clientId: 'c', requestId: 'x' } }],
    },
  });
  node.receive({ type: 'append', from: 'node2', to: 'node1', term: 3, leader: 'node2', prevLogIndex: 1, prevLogTerm: 1, leaderCommit: 2,
    entries: [{ index: 2, term: 3, command: null }] }, 0);
  const out = node.drain();
  assert.equal(out.messages[0].success, true);
  assert.deepEqual(node.status().log.map((e) => e.term), [1, 3]);
  assert.equal(node.status().commit, 2);
  assert.ok(out.events.some((e) => e.kind === 'truncate'));
  assert.deepEqual(node.status().kv, {}, 'the stale uncommitted PUT was never applied');

  node.receive({ type: 'append', from: 'node3', to: 'node1', term: 4, leader: 'node3', prevLogIndex: 0, prevLogTerm: 0, leaderCommit: 0,
    entries: [{ index: 1, term: 4, command: null }] }, 0);
  assert.equal(node.drain().messages.length, 0, 'an attempt to overwrite a committed entry gets no reply');
  assert.deepEqual(node.status().log.map((e) => e.term), [1, 3]);
});

test('elects one leader and commits PUT, GET, CAS and DELETE through the log', async () => {
  const sim = simulate({ seed: 7 });
  const leader = sim.stableLeader();
  assert.ok(leader.term >= 1);

  let r = await sim.exec(put('greeting', 'hello'));
  assert.equal(r.status, 'committed');
  assert.equal(r.node, leader.id);

  r = await sim.exec(get('greeting'));
  assert.equal(r.status, 'committed');
  assert.deepEqual([r.result.found, r.result.value], [true, 'hello']);

  r = await sim.exec(cas('greeting', 'hello', 'hi'));
  assert.equal(r.result.success, true, 'CAS succeeds when the expected value matches');
  r = await sim.exec(cas('greeting', 'hello', 'nope'));
  assert.equal(r.result.success, false, 'CAS fails when it does not');
  assert.equal(r.result.value, 'hi', 'and reports the actual value');

  r = await sim.exec(del('greeting'));
  assert.equal(r.result.found, true);
  r = await sim.exec(get('greeting'));
  assert.equal(r.result.found, false);

  // Followers apply once the leader's next heartbeat carries the commit index.
  sim.until(() => sim.states().every((s) => s.applied === leader.lastIndex + 6 && Object.keys(s.kv).length === 0));
  sim.checkCommittedPrefixes();
  assert.deepEqual(sim.violations, []);
  sim.cluster.destroy();
});

test('writes commit with one follower down, and the follower catches up after restart', async () => {
  const sim = simulate({ seed: 11 });
  const leader = sim.stableLeader();
  const follower = ['node1', 'node2', 'node3'].find((id) => id !== leader.id);

  sim.cluster.stop(follower);
  for (let i = 0; i < 5; i++) assert.equal((await sim.exec(put(`k${i}`, `v${i}`))).status, 'committed');
  const leaderState = sim.leaders()[0];
  assert.equal(leaderState.commit, leaderState.lastIndex);

  sim.cluster.restart(follower);
  sim.until(() => {
    const f = sim.states().find((s) => s.id === follower);
    return f && f.applied === leaderState.lastIndex;
  });
  const caughtUp = sim.states().find((s) => s.id === follower);
  assert.deepEqual(caughtUp.kv, { k0: 'v0', k1: 'v1', k2: 'v2', k3: 'v3', k4: 'v4' });
  sim.checkCommittedPrefixes();
  assert.deepEqual(sim.violations, []);
  sim.cluster.destroy();
});

test('a restarted node reloads its own persisted term, vote and log', async () => {
  const sim = simulate({ seed: 5 });
  const leader = sim.stableLeader();
  await sim.exec(put('a', '1'));
  const follower = ['node1', 'node2', 'node3'].find((id) => id !== leader.id);
  sim.until(() => sim.states().find((s) => s.id === follower).applied >= 2);
  const before = sim.cluster.disk(follower);
  sim.cluster.stop(follower);
  sim.cluster.restart(follower);
  sim.run(100);
  const after = sim.states().find((s) => s.id === follower);
  assert.equal(after.term, before.term);
  assert.equal(after.lastIndex, before.log.length);
  assert.equal(after.kv.a, '1', 'committed entries are replayed from its own log on boot');
  sim.cluster.destroy();
});

test('stopping the leader elects a replacement that keeps every acknowledged write', async () => {
  const sim = simulate({ seed: 3 });
  const first = sim.stableLeader();
  for (const v of ['x', 'y']) assert.equal((await sim.exec(put(v, v))).status, 'committed');

  sim.cluster.stop(first.id);
  const second = sim.stableLeader();
  assert.notEqual(second.id, first.id);
  assert.ok(second.term > first.term);
  assert.deepEqual(second.kv, { x: 'x', y: 'y' });

  const r = await sim.exec(put('z', 'z'));
  assert.equal(r.status, 'committed');
  assert.equal(r.node, second.id, 'the client found the new leader');
  sim.checkCommittedPrefixes();
  assert.deepEqual(sim.violations, []);
  sim.cluster.destroy();
});

test('without a majority, writes are never acknowledged; restoring a node recovers the cluster', async () => {
  const sim = simulate({ seed: 21 });
  const leader = sim.stableLeader();
  assert.equal((await sim.exec(put('safe', 'before'))).status, 'committed');

  const others = ['node1', 'node2', 'node3'].filter((id) => id !== leader.id);
  sim.cluster.stop(others[0]);
  sim.cluster.stop(others[1]);

  const r = await sim.exec(put('lonely', 'value'));
  assert.equal(r.status, 'timeout', 'a lone leader cannot confirm a write');
  const alone = sim.states()[0];
  assert.equal(alone.kv.lonely, undefined, 'and never applies it');
  assert.ok(alone.lastIndex > alone.commit, 'the entry sits uncommitted in its log');

  sim.cluster.restart(others[0]);
  sim.stableLeader();
  const after = await sim.exec(put('safe2', 'after'));
  assert.equal(after.status, 'committed');
  const check = await sim.exec(get('safe'));
  assert.equal(check.result.value, 'before', 'the acknowledged write survived');
  sim.checkCommittedPrefixes();
  assert.deepEqual(sim.violations, []);
  sim.cluster.destroy();
});

test('an isolated old leader cannot acknowledge writes; on reconnect it steps down and discards them', async () => {
  const sim = simulate({ seed: 9 });
  const old = sim.stableLeader();
  assert.equal((await sim.exec(put('k', 'committed'))).status, 'committed');

  sim.cluster.setIsolated(old.id, true);
  // The client insists on the old leader, which still believes it leads.
  const stale = await sim.exec(put('k', 'lost'), { target: old.id });
  assert.equal(stale.status, 'timeout');

  const replacement = sim.stableLeader(20000, [old.id]);
  assert.notEqual(replacement.id, old.id);
  const oldView = sim.states().find((s) => s.id === old.id);
  assert.equal(oldView.role, 'leader', 'the isolated node still believes it leads...');
  assert.ok(oldView.term < replacement.term, '...but only an older term');
  const fresh = await sim.exec(put('k', 'fresh'));
  assert.equal(fresh.status, 'committed');
  assert.equal(fresh.node, replacement.id);

  sim.cluster.setIsolated(old.id, false);
  sim.until(() => {
    const s = sim.states().find((n) => n.id === old.id);
    const current = sim.leaders().find((l) => l.id === replacement.id);
    return s.role === 'follower' && s.kv.k === 'fresh' && current && s.commit === current.commit;
  });
  assert.ok(sim.cluster.events().some((e) => e.source === old.id && e.kind === 'truncate'), 'conflicting entry discarded');
  assert.ok(sim.states().every((s) => s.kv.k === 'fresh'));
  sim.checkCommittedPrefixes();
  assert.deepEqual(sim.violations, []);
  sim.cluster.destroy();
});

test('a pinned request to a follower is rejected with a leader hint', async () => {
  const sim = simulate({ seed: 4 });
  const leader = sim.stableLeader();
  const follower = ['node1', 'node2', 'node3'].find((id) => id !== leader.id);
  sim.until(() => sim.states().find((s) => s.id === follower).leader === leader.id);
  const r = await sim.exec(put('a', 'b'), { target: follower });
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'not_leader');
  assert.equal(r.leader, leader.id);
  sim.cluster.destroy();
});

test('retrying the same request ID never applies a CAS twice', async () => {
  const sim = simulate({ seed: 12 });
  sim.stableLeader();
  await sim.exec(put('n', '1'));
  const first = await sim.exec(cas('n', '1', '2'), { requestId: 'fixed-id' });
  assert.equal(first.result.success, true);
  const again = await sim.exec(cas('n', '1', '2'), { requestId: 'fixed-id' });
  assert.equal(again.result.success, true, 'cached outcome, not a re-evaluation against "2"');
  assert.equal(again.result.deduplicated, true);
  assert.equal((await sim.exec(get('n'))).result.value, '2');
  sim.cluster.destroy();
});

test('randomised faults preserve election safety, committed prefixes and acknowledged writes', async () => {
  for (const seed of [101, 202, 303, 404, 505, 606]) {
    const sim = simulate({ seed, delayMs: 60 });
    const rand = mulberry32(seed);
    const ids = ['node1', 'node2', 'node3'];
    const acknowledged = [];

    sim.stableLeader();
    for (let step = 0; step < 14; step++) {
      const id = ids[Math.floor(rand() * 3)];
      const action = rand();
      const view = sim.cluster.view().nodes.find((n) => n.id === id);
      if (action < 0.25) view.up ? sim.cluster.stop(id) : sim.cluster.restart(id);
      else if (action < 0.45) sim.cluster.setIsolated(id, !view.isolated);
      else if (action < 0.55) sim.cluster.setDelay(Math.floor(rand() * 300));

      const key = `k${step % 4}`;
      const value = `s${seed}-${step}`;
      const r = await sim.exec(put(key, value));
      if (r.status === 'committed') acknowledged.push([key, { value, index: r.index }]);
      sim.run(Math.floor(rand() * 2000));
    }

    // Heal everything and let the cluster settle.
    for (const id of ids) {
      sim.cluster.setIsolated(id, false);
      sim.cluster.restart(id);
    }
    sim.cluster.setDelay(60);
    const leader = sim.stableLeader(30000);
    // A write in the current term commits everything before it (§5.4.2).
    assert.equal((await sim.exec(put('final', String(seed)))).status, 'committed');
    sim.until(() => sim.states().length === 3 && sim.states().every((s) => s.applied === sim.leaders()[0].commit), 30000);

    sim.checkCommittedPrefixes();
    assert.deepEqual(sim.violations, [], `seed ${seed}`);
    // Every acknowledged write is in every node's committed log at the index
    // it was acknowledged at.
    for (const s of sim.states()) {
      for (const [key, { value, index }] of acknowledged) {
        const entry = s.log[index - 1];
        assert.equal(entry.command?.key, key, `seed ${seed}: ${s.id} lost index ${index}`);
        assert.equal(entry.command?.value, value);
        assert.ok(s.commit >= index);
      }
    }
    assert.ok(leader);
    sim.cluster.destroy();
  }
});

test('destroy terminates every worker and cancels every timer', async () => {
  const sim = simulate({ seed: 2 });
  sim.stableLeader();
  let settled = null;
  sim.cluster.submit(put('a', 'b')).then((o) => { settled = o; });
  sim.cluster.stop('node1');
  sim.cluster.restart('node1');
  sim.cluster.destroy();
  await Promise.resolve();
  assert.equal(settled?.status, 'cancelled');
  assert.equal(sim.live.size, 0, 'no fake workers remain');
  assert.equal(sim.cluster.activeTimers(), 0);
  sim.run(10000);
  // Only the fake workers' own already-cleared intervals could remain; none do.
  assert.equal(sim.clock.timers.size, 0);
});

test('reset clears state and boots a fresh cluster', async () => {
  const sim = simulate({ seed: 8 });
  sim.stableLeader();
  await sim.exec(put('a', '1'));
  sim.cluster.reset();
  assert.equal(sim.live.size, 3);
  const leader = sim.stableLeader();
  assert.equal(leader.term >= 1, true);
  assert.equal((await sim.exec(get('a'))).result.found, false);
  sim.cluster.destroy();
});
