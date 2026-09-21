// Raft node for the AsterKV browser simulation.
//
// A JavaScript re-implementation of the protocol in vendor/asterkv/internal/raft
// (node.go, replication.go, apply.go) and the state machine in
// internal/state/machine.go. It is not the Go code compiled to the browser:
// it follows the same rules, names and decisions so the simulation behaves
// like the real engine, minus gRPC, disk I/O and snapshots.
//
// The node is a pure, single-threaded state machine. It never touches timers,
// the network or storage directly:
//
//   tick(now)          advance election / heartbeat timers
//   receive(msg, now)  handle one message from a peer or the client
//   drain()            collect what happened: outgoing messages, a copy of
//                      durable state if it changed, and human-readable events
//
// The host (a Web Worker in the page, a virtual clock in tests) owns time and
// delivery. A host must hand `durable` to stable storage BEFORE sending the
// messages from the same drain(), which is how Go's "persist before reply"
// rule (e.g. a vote is saved before it is granted) is preserved.

export const FOLLOWER = 'follower';
export const CANDIDATE = 'candidate';
export const LEADER = 'leader';

// Mirrors replication.go: at most 64 entries per AppendEntries.
const MAX_BATCH = 64;

export const emptyDurable = () => ({ term: 0, vote: '', log: [], commit: 0 });

const clone = (value) => JSON.parse(JSON.stringify(value));

/** internal/state/machine.go: deterministic KV commands with request dedup. */
export class KVMachine {
  constructor() {
    this.kv = new Map();
    this.dedup = new Map(); // clientId -> Map(requestId -> {command, result})
  }

  apply(c) {
    const mutation = c.op === 'put' || c.op === 'delete' || c.op === 'cas';
    const tracked = mutation && c.clientId && c.requestId;
    if (tracked) {
      const cached = this.dedup.get(c.clientId)?.get(c.requestId);
      if (cached) {
        if (JSON.stringify(cached.command) !== JSON.stringify(commandKey(c))) return { error: 'request_id_reused' };
        // Same logical request applied again (a client retry): return the
        // first outcome instead of executing twice. `deduplicated` is a
        // display-only addition; the Go engine returns the cached result as-is.
        return { ...cached.result, deduplicated: true };
      }
    }
    const result = this.execute(c);
    if (tracked) {
      if (!this.dedup.has(c.clientId)) this.dedup.set(c.clientId, new Map());
      this.dedup.get(c.clientId).set(c.requestId, { command: commandKey(c), result });
    }
    return result;
  }

  execute(c) {
    const found = this.kv.has(c.key);
    const value = found ? this.kv.get(c.key) : '';
    const r = { value, found, success: false };
    switch (c.op) {
      case 'get':
        r.success = true;
        break;
      case 'put':
        this.kv.set(c.key, c.value);
        r.success = true;
        break;
      case 'delete':
        this.kv.delete(c.key);
        r.success = true;
        break;
      case 'cas':
        // Evaluated here, in replicated log order, never when the request arrives.
        if (found && value === c.expected) {
          this.kv.set(c.key, c.value);
          r.success = true;
        }
        break;
      default:
        r.error = 'unknown operation';
    }
    return r;
  }
}

const commandKey = (c) => ({
  op: c.op, key: c.key, value: c.value ?? '', expected: c.expected ?? '', clientId: c.clientId, requestId: c.requestId,
});

export class RaftNode {
  /**
   * @param {object} o
   * @param {string} o.id
   * @param {string[]} o.peers   the other members
   * @param {object} [o.durable] state loaded from this node's own storage
   * @param {{heartbeat:number, electionMin:number, electionMax:number}} o.timing  milliseconds
   * @param {() => number} [o.random]
   * @param {number} [o.now]
   */
  constructor({ id, peers, durable, timing, random = Math.random, now = 0 }) {
    if (!(timing.electionMin >= 3 * timing.heartbeat && timing.electionMax > timing.electionMin)) {
      throw Error('invalid timing configuration'); // same guard as raft.New
    }
    this.id = id;
    this.peers = [...peers].sort();
    this.timing = timing;
    this.random = random;

    // Durable: term, vote, log, commit. Everything else is volatile and is
    // lost when the worker is terminated.
    this.d = clone(durable ?? emptyDurable());
    this.role = FOLLOWER;
    this.leader = '';
    this.commit = this.d.commit;
    this.applied = 0;
    this.machine = new KVMachine();
    this.next = {};
    this.match = {};
    this.votes = new Set();
    this.waiters = new Map(); // log index -> { attempt, requestId }

    this.outbox = [];
    this.events = [];
    this.dirty = false;
    this.nextHeartbeat = 0;
    this.deadline = 0;

    if (this.d.commit > this.lastIndex()) throw Error('commit index exceeds log');
    // raft.New: replay the committed prefix into a fresh state machine.
    const replay = this.d.commit;
    this.applyCommitted();
    if (replay > 0) this.event('recover', `rebuilt its key-value state by replaying ${replay} committed log entr${replay === 1 ? 'y' : 'ies'}`);
    this.resetDeadline(now);
  }

  // -- helpers ---------------------------------------------------------------

  lastIndex() {
    return this.d.log.length;
  }
  termAt(i) {
    return i === 0 ? 0 : this.d.log[i - 1].term;
  }
  majority() {
    return Math.floor((this.peers.length + 1) / 2);
  }
  resetDeadline(now) {
    const { electionMin, electionMax } = this.timing;
    this.deadline = now + electionMin + this.random() * (electionMax - electionMin);
  }
  persist() {
    this.dirty = true;
  }
  send(to, message) {
    this.outbox.push({ ...message, from: this.id, to });
  }
  event(kind, text) {
    this.events.push({ node: this.id, kind, text, term: this.d.term });
  }

  /** Everything produced since the last drain. See the host contract above. */
  drain() {
    const out = {
      durable: this.dirty ? clone(this.d) : null,
      messages: this.outbox,
      events: this.events,
    };
    this.dirty = false;
    this.outbox = [];
    this.events = [];
    return out;
  }

  stepDown(term) {
    if (term > this.d.term) {
      this.d.term = term;
      this.d.vote = '';
      this.persist();
    }
    if (this.role === LEADER) this.event('step-down', `stepped down: saw term ${term}`);
    this.failWaiters();
    this.role = FOLLOWER;
    this.leader = '';
  }

  // -- timers ----------------------------------------------------------------

  tick(now) {
    if (this.role !== LEADER && now >= this.deadline) this.elect(now);
    if (this.role === LEADER && now >= this.nextHeartbeat) this.broadcast(now);
  }

  elect(now) {
    this.d.term += 1;
    this.d.vote = this.id;
    this.role = CANDIDATE;
    this.leader = '';
    this.resetDeadline(now);
    this.persist();
    this.votes = new Set([this.id]);
    this.event('election', `election timeout: became candidate for term ${this.d.term} and voted for itself`);
    this.maybeWin(now);
    const last = this.lastIndex();
    for (const peer of this.peers) {
      this.send(peer, { type: 'vote', term: this.d.term, candidate: this.id, lastLogIndex: last, lastLogTerm: this.termAt(last) });
    }
  }

  maybeWin(now) {
    if (this.role !== CANDIDATE || this.votes.size <= this.majority()) return;
    this.role = LEADER;
    this.leader = this.id;
    for (const peer of this.peers) {
      this.next[peer] = this.lastIndex() + 1;
      this.match[peer] = 0;
    }
    // Like node.go: a new leader appends an empty entry for its own term, so
    // it can commit (and learn the commit point of) earlier entries.
    this.d.log.push({ index: this.lastIndex() + 1, term: this.d.term, command: null });
    this.persist();
    this.event('leader', `won term ${this.d.term} with ${this.votes.size} of ${this.peers.length + 1} votes; appended a no-op entry at index ${this.lastIndex()}`);
    this.advanceCommit();
    this.broadcast(now);
  }

  broadcast(now) {
    this.nextHeartbeat = now + this.timing.heartbeat;
    for (const peer of this.peers) this.replicate(peer);
  }

  // -- messages --------------------------------------------------------------

  receive(msg, now) {
    switch (msg.type) {
      case 'vote':
        return this.onVote(msg, now);
      case 'voteReply':
        return this.onVoteReply(msg, now);
      case 'append':
        return this.onAppend(msg, now);
      case 'appendReply':
        return this.onAppendReply(msg);
      case 'client':
        return this.onClient(msg, now);
      default:
        return undefined;
    }
  }

  onVote(r, now) {
    if (r.term > this.d.term) this.stepDown(r.term);
    const reply = { type: 'voteReply', term: this.d.term, granted: false, electionTerm: r.term };
    if (r.term >= this.d.term) {
      const last = this.lastIndex();
      const upToDate = r.lastLogTerm > this.termAt(last) || (r.lastLogTerm === this.termAt(last) && r.lastLogIndex >= last);
      if (upToDate && (this.d.vote === '' || this.d.vote === r.candidate)) {
        // Persisted before the reply leaves (see the host contract), so a
        // crash cannot let this node vote twice in one term.
        this.d.vote = r.candidate;
        this.persist();
        this.resetDeadline(now);
        reply.granted = true;
        this.event('vote', `voted for ${r.candidate} in term ${r.term}`);
      } else if (!upToDate) {
        this.event('vote-refused', `refused ${r.candidate} for term ${r.term}: its log is behind this node's`);
      }
    }
    this.send(r.from, reply);
  }

  onVoteReply(r, now) {
    if (r.term > this.d.term) return this.stepDown(r.term);
    if (this.role === CANDIDATE && r.electionTerm === this.d.term && r.term === this.d.term && r.granted) {
      this.votes.add(r.from);
      this.maybeWin(now);
    }
    return undefined;
  }

  onAppend(r, now) {
    if (r.term > this.d.term) this.stepDown(r.term);
    const reply = {
      type: 'appendReply', term: this.d.term, success: false, nextIndex: this.lastIndex() + 1,
      requestTerm: r.term, prevLogIndex: r.prevLogIndex, count: r.entries.length,
    };
    if (r.term < this.d.term) return this.send(r.from, reply);

    if (this.leader !== r.leader) this.event('follow', `following ${r.leader} in term ${r.term}`);
    this.role = FOLLOWER;
    this.leader = r.leader;
    this.resetDeadline(now);

    if (r.prevLogIndex > this.lastIndex()) return this.send(r.from, reply);
    if (this.termAt(r.prevLogIndex) !== r.prevLogTerm) {
      reply.nextIndex = r.prevLogIndex;
      return this.send(r.from, reply);
    }

    // Validate the whole batch before changing anything (replication.go).
    let previousTerm = r.prevLogTerm;
    for (const [j, e] of r.entries.entries()) {
      if (e.index !== r.prevLogIndex + 1 + j || e.term === 0 || e.term > r.term || e.term < previousTerm) {
        this.event('reject', 'rejected an invalid entry sequence');
        return undefined; // Go returns an error: no reply
      }
      previousTerm = e.term;
    }

    for (const [j, e] of r.entries.entries()) {
      const i = r.prevLogIndex + 1 + j;
      if (i <= this.lastIndex() && this.termAt(i) !== e.term) {
        // Only an uncommitted, divergent suffix may be replaced.
        if (i <= this.commit) {
          this.event('reject', `refused to overwrite committed entry ${i}`);
          return undefined;
        }
        const dropped = this.lastIndex() - i + 1;
        this.d.log.length = i - 1;
        this.persist();
        this.event('truncate', `discarded ${dropped} uncommitted entr${dropped === 1 ? 'y' : 'ies'} from index ${i} that conflicted with ${r.leader}'s log`);
      }
      if (i > this.lastIndex()) {
        this.d.log.push({ index: i, term: e.term, command: e.command });
        this.persist();
      }
    }

    // Commit only up to the prefix this request actually verified.
    const verified = r.prevLogIndex + r.entries.length;
    const c = Math.min(r.leaderCommit, verified);
    if (c > this.commit) {
      this.commit = c;
      this.applyCommitted();
    }
    reply.success = true;
    reply.nextIndex = verified + 1;
    return this.send(r.from, reply);
  }

  onAppendReply(out) {
    if (out.term > this.d.term) return this.stepDown(out.term);
    if (this.role !== LEADER || this.d.term !== out.requestTerm || out.term !== out.requestTerm) return undefined;
    if (out.success) {
      const matched = out.prevLogIndex + out.count;
      // Several requests can be in flight at once here (Go sends one per
      // peer at a time), so never let an older reply move match backwards.
      this.match[out.from] = Math.max(this.match[out.from], matched);
      this.next[out.from] = Math.max(this.next[out.from], matched + 1);
      this.advanceCommit();
    } else {
      this.next[out.from] = Math.max(1, Math.min(out.prevLogIndex, out.nextIndex));
    }
    return undefined;
  }

  replicate(peer) {
    const next = Math.max(1, this.next[peer]);
    const end = Math.min(this.lastIndex(), next + MAX_BATCH - 1);
    this.send(peer, {
      type: 'append',
      term: this.d.term,
      leader: this.id,
      prevLogIndex: next - 1,
      prevLogTerm: this.termAt(next - 1),
      leaderCommit: this.commit,
      entries: this.d.log.slice(next - 1, end).map((e) => ({ ...e })),
    });
  }

  advanceCommit() {
    for (let i = this.lastIndex(); i > this.commit; i--) {
      // Only an entry from the current term is committed by counting replicas;
      // earlier entries commit with it (Raft §5.4.2).
      if (this.termAt(i) !== this.d.term) continue;
      let count = 1;
      for (const peer of this.peers) if (this.match[peer] >= i) count++;
      if (count > this.majority()) {
        const from = this.commit + 1;
        this.commit = i;
        this.event('commit', `committed ${from === i ? `index ${i}` : `indexes ${from}–${i}`}: stored on ${count} of ${this.peers.length + 1} nodes`);
        this.applyCommitted();
        break;
      }
    }
  }

  applyCommitted() {
    if (this.d.commit !== this.commit) {
      this.d.commit = this.commit;
      this.persist();
    }
    while (this.applied < this.commit) {
      const i = this.applied + 1;
      const entry = this.d.log[i - 1];
      const result = entry.command ? this.machine.apply(entry.command) : null;
      this.applied = i;
      const waiter = this.waiters.get(i);
      if (waiter) {
        this.waiters.delete(i);
        this.send('client', { type: 'clientReply', attempt: waiter.attempt, requestId: waiter.requestId, result, index: i, term: entry.term });
      }
    }
  }

  failWaiters() {
    for (const [, waiter] of this.waiters) {
      this.send('client', { type: 'clientReply', attempt: waiter.attempt, requestId: waiter.requestId, error: 'not_leader', leader: '' });
    }
    this.waiters.clear();
  }

  // -- client ----------------------------------------------------------------

  /** server.execute + Node.Propose: every operation, reads included, goes through the log. */
  onClient(msg) {
    const c = msg.command;
    if (!['get', 'put', 'delete', 'cas'].includes(c.op)) {
      return this.send('client', { type: 'clientReply', attempt: msg.attempt, requestId: c.requestId, error: 'unknown operation' });
    }
    if (c.op !== 'get' && (!c.clientId || !c.requestId)) {
      return this.send('client', { type: 'clientReply', attempt: msg.attempt, requestId: c.requestId, error: 'client_id and request_id required' });
    }
    if (this.role !== LEADER) {
      return this.send('client', { type: 'clientReply', attempt: msg.attempt, requestId: c.requestId, error: 'not_leader', leader: this.leader });
    }
    const index = this.lastIndex() + 1;
    this.d.log.push({ index, term: this.d.term, command: commandKey(c) });
    this.persist();
    this.waiters.set(index, { attempt: msg.attempt, requestId: c.requestId });
    this.event('propose', `appended ${c.op.toUpperCase()} ${c.key} at index ${index}; waiting for a majority`);
    this.advanceCommit();
    // Replicate now rather than on the next heartbeat.
    for (const peer of this.peers) this.replicate(peer);
    return undefined;
  }

  // -- inspection ------------------------------------------------------------

  status() {
    return {
      id: this.id,
      role: this.role,
      term: this.d.term,
      vote: this.d.vote,
      leader: this.leader,
      lastIndex: this.lastIndex(),
      commit: this.commit,
      applied: this.applied,
      log: this.d.log.map((e) => ({ index: e.index, term: e.term, command: e.command })),
      kv: Object.fromEntries([...this.machine.kv].sort(([a], [b]) => (a < b ? -1 : 1))),
      match: this.role === LEADER ? { ...this.match } : null,
    };
  }
}

/** Small seeded PRNG so tests and the host can be deterministic. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
