// Page-side controller for the AsterKV browser simulation.
//
// Owns everything that sits BETWEEN nodes, never the nodes' own state:
//   - three workers, one per node (spawned through `spawn`)
//   - the network: per-message delay, dropped links, stopped nodes
//   - each node's stable storage, holding only what that node asked to persist
//     and handed back only to that same node when it restarts
//   - a client that retries like internal/client.Client.Do
//
// Replication happens only through messages the nodes exchange. Displayed
// node state is whatever each worker last reported about itself.
//
// `spawn(id)` returns a Worker-like object ({ postMessage, terminate,
// onmessage, onerror }); `clock` supplies now/setTimeout/clearTimeout. Tests
// inject a virtual clock and in-process workers to make runs deterministic.

import { mulberry32 } from './raft-core.js';

export const NODE_IDS = ['node1', 'node2', 'node3'];

// Go's defaults are 50 ms heartbeats and 250–500 ms election timeouts. The
// simulation keeps the same ratios, slowed down about 6x so it can be watched.
export const TIMING = { heartbeat: 300, electionMin: 1500, electionMax: 3000 };
export const TICK_MS = 25;
export const MAX_DELAY_MS = 500;
const CLIENT_DEADLINE_MS = 8000;
const RETRY_PAUSE_MS = 100;
const MAX_EVENTS = 200;

export function createCluster({ spawn, clock, seed = Date.now(), delayMs = 150, onUpdate = () => {} }) {
  const random = mulberry32(seed);
  const timers = new Set();
  let nodes = {};
  let disks = {};
  let events = [];
  let inflight = new Map();
  let stats = { sent: 0, delivered: 0, dropped: 0 };
  let pending = new Map(); // requestId -> client operation
  let startedAt = clock.now();
  let messageSeq = 0;
  let attemptSeq = 0;
  let requestSeq = 0;
  let generation = 0;
  let clientId = '';
  let leaderHint = '';
  let destroyed = false;

  // -- timers ----------------------------------------------------------------

  function later(fn, ms) {
    const handle = clock.setTimeout(() => {
      timers.delete(handle);
      if (!destroyed) fn();
    }, ms);
    timers.add(handle);
    return handle;
  }
  function cancel(handle) {
    if (handle == null) return;
    clock.clearTimeout(handle);
    timers.delete(handle);
  }
  function clearAllTimers() {
    for (const handle of timers) clock.clearTimeout(handle);
    timers.clear();
  }

  // -- events ----------------------------------------------------------------

  function log(source, kind, text) {
    events.push({ t: clock.now() - startedAt, source, kind, text });
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    onUpdate('events');
  }

  // -- nodes -----------------------------------------------------------------

  function boot(id) {
    const worker = spawn(id);
    const node = nodes[id];
    node.worker = worker;
    node.up = true;
    node.state = null;
    worker.onmessage = ({ data }) => {
      // A terminated worker's queued messages must not leak into the cluster.
      if (destroyed || node.worker !== worker) return;
      fromNode(id, data);
    };
    worker.onerror = (event) => {
      event?.preventDefault?.();
      if (node.worker !== worker) return;
      log(id, 'error', `worker failed: ${event?.message ?? 'unknown error'}`);
      stop(id, { quiet: true });
    };
    worker.postMessage({
      type: 'boot',
      id,
      peers: NODE_IDS.filter((p) => p !== id),
      durable: disks[id] ?? null,
      timing: TIMING,
      tickMs: TICK_MS,
      seed: Math.floor(random() * 2 ** 32),
    });
  }

  function fromNode(id, data) {
    switch (data.type) {
      case 'persist':
        disks[id] = data.durable;
        break;
      case 'send':
        transmit(data.msg);
        break;
      case 'events':
        for (const e of data.events) log(e.node, e.kind, e.text);
        break;
      case 'state':
        nodes[id].state = data.state;
        onUpdate('state');
        break;
      default:
    }
  }

  function stop(id, { quiet = false } = {}) {
    const node = nodes[id];
    if (!node.up) return;
    // Terminating the worker is a crash: volatile state (role, match/next
    // indexes, the applied key-value map) is gone. Only the durable record the
    // node already persisted survives.
    node.worker.terminate();
    node.worker = null;
    node.up = false;
    node.state = null;
    if (!quiet) log(id, 'stopped', 'stopped (worker terminated). Its saved term, vote, log and commit index are kept for restart');
    onUpdate('state');
  }

  function restart(id) {
    const node = nodes[id];
    if (node.up) return;
    const disk = disks[id];
    log(id, 'restarted', disk
      ? `restarted in a new worker from its saved record: term ${disk.term}, ${disk.log.length} log entries, commit index ${disk.commit}`
      : 'restarted with no saved state');
    boot(id);
    onUpdate('state');
  }

  function setIsolated(id, isolated) {
    if (nodes[id].isolated === isolated) return;
    nodes[id].isolated = isolated;
    log(id, isolated ? 'isolated' : 'reconnected', isolated
      ? 'cut off from the other nodes (the browser client can still reach it)'
      : 'reconnected to the other nodes');
    onUpdate('state');
  }

  // -- network ---------------------------------------------------------------

  const isNode = (name) => NODE_IDS.includes(name);
  const linkCut = (a, b) => isNode(a) && isNode(b) && (nodes[a].isolated || nodes[b].isolated);

  function transmit(msg) {
    stats.sent += 1;
    if (linkCut(msg.from, msg.to)) {
      stats.dropped += 1;
      return;
    }
    const id = ++messageSeq;
    const sentAt = clock.now();
    inflight.set(id, { id, from: msg.from, to: msg.to, type: msg.type, sentAt, deliverAt: sentAt + delayMs });
    later(() => {
      inflight.delete(id);
      // Conditions are checked again on arrival: a node can stop, or a link
      // can be cut, while the message is on the wire.
      if (linkCut(msg.from, msg.to) || (isNode(msg.to) && !nodes[msg.to].up)) {
        stats.dropped += 1;
        return;
      }
      stats.delivered += 1;
      if (msg.to === 'client') onClientReply(msg);
      else nodes[msg.to].worker.postMessage({ type: 'deliver', msg });
    }, delayMs);
  }

  // -- client ----------------------------------------------------------------

  /**
   * Submit one operation, retrying like client.Do: the request ID is fixed
   * before the first attempt, so a retry can never apply a write twice.
   *
   * target: 'auto' follows leader hints; a node id sends only to that node.
   * Resolves with { status: 'committed' | 'rejected' | 'timeout' | 'cancelled', ... }.
   */
  function submit(command, { target = 'auto', requestId } = {}) {
    const full = {
      op: command.op,
      key: command.key,
      value: command.value ?? '',
      expected: command.expected ?? '',
      clientId,
      requestId: requestId ?? `${clientId}-r${++requestSeq}`,
    };
    if (pending.has(full.requestId)) return Promise.reject(Error('That request is already in progress'));

    return new Promise((resolve) => {
      const op = {
        command: full,
        target,
        startedAt: clock.now(),
        deadline: clock.now() + CLIENT_DEADLINE_MS,
        attempts: [],
        rotation: 0,
        attempt: null,
        timer: null,
        resolve,
      };
      pending.set(full.requestId, op);
      log('client', 'request', `sent ${describe(full)}${target === 'auto' ? '' : ` to ${target} only`} (request ${full.requestId})`);
      tryOnce(op);
    });
  }

  function describe(c) {
    if (c.op === 'put') return `PUT ${c.key} = "${c.value}"`;
    if (c.op === 'cas') return `CAS ${c.key}: "${c.expected}" → "${c.value}"`;
    return `${c.op.toUpperCase()} ${c.key}`;
  }

  function attemptTimeout() {
    return 1500 + 4 * delayMs;
  }

  function tryOnce(op) {
    if (clock.now() >= op.deadline) return finish(op, timeoutOutcome(op));
    let to;
    if (op.target !== 'auto') to = op.target;
    else if (op.hint) to = op.hint;
    else if (op.attempts.length === 0 && leaderHint) to = leaderHint;
    else to = NODE_IDS[op.rotation++ % NODE_IDS.length];
    op.hint = '';
    op.attempt = ++attemptSeq;
    op.attempts.push(to);
    transmit({ type: 'client', from: 'client', to, attempt: op.attempt, command: op.command });
    op.timer = later(() => {
      op.timer = null;
      log('client', 'attempt-timeout', `no answer from ${to} yet; trying ${op.target === 'auto' ? 'the next node' : 'again'}`);
      // Automatic routing rotates to the next node; a pinned request keeps
      // asking the same node. Either way the overall deadline still applies.
      later(() => tryOnce(op), RETRY_PAUSE_MS);
    }, Math.min(attemptTimeout(), Math.max(0, op.deadline - clock.now())));
  }

  function timeoutOutcome(op) {
    return {
      status: 'timeout',
      command: op.command,
      attempts: op.attempts,
      elapsed: clock.now() - op.startedAt,
    };
  }

  function onClientReply(msg) {
    const op = pending.get(msg.requestId);
    if (!op) return; // already settled; a late duplicate answer
    if (msg.error === 'not_leader') {
      if (msg.attempt !== op.attempt) return; // answer to an attempt we gave up on
      cancel(op.timer);
      if (op.target !== 'auto') {
        return finish(op, {
          status: 'rejected',
          reason: 'not_leader',
          node: msg.from,
          leader: msg.leader,
          command: op.command,
          attempts: op.attempts,
          elapsed: clock.now() - op.startedAt,
        });
      }
      log('client', 'redirect', `${msg.from} is not the leader${msg.leader ? `; it points to ${msg.leader}` : ' and knows of none'}`);
      op.hint = msg.leader && msg.leader !== msg.from ? msg.leader : '';
      return later(() => tryOnce(op), RETRY_PAUSE_MS);
    }
    cancel(op.timer);
    if (msg.error) {
      return finish(op, { status: 'rejected', reason: msg.error, node: msg.from, command: op.command, attempts: op.attempts, elapsed: clock.now() - op.startedAt });
    }
    // Any committed answer for this request ID is final, even one that
    // arrives for an earlier attempt: it is the same logical request.
    leaderHint = msg.from;
    return finish(op, {
      status: 'committed',
      result: msg.result,
      node: msg.from,
      index: msg.index,
      term: msg.term,
      command: op.command,
      attempts: op.attempts,
      elapsed: clock.now() - op.startedAt,
    });
  }

  function finish(op, outcome) {
    if (!pending.has(op.command.requestId)) return;
    pending.delete(op.command.requestId);
    cancel(op.timer);
    const summary = {
      committed: `committed at index ${outcome.index} by ${outcome.node} (term ${outcome.term})${outcome.result?.deduplicated ? '; duplicate request, original result returned' : ''}`,
      rejected: `rejected by ${outcome.node}: ${outcome.reason}`,
      timeout: `no confirmation within ${CLIENT_DEADLINE_MS / 1000} s. Outcome unknown: the entry may still commit later`,
      cancelled: 'cancelled by reset',
    }[outcome.status];
    log('client', outcome.status, `${describe(op.command)}: ${summary}`);
    op.resolve(outcome);
  }

  // -- lifecycle -------------------------------------------------------------

  function teardown() {
    clearAllTimers();
    for (const node of Object.values(nodes)) node.worker?.terminate();
    for (const op of pending.values()) op.resolve({ status: 'cancelled', command: op.command, attempts: op.attempts, elapsed: 0 });
    pending = new Map();
    inflight = new Map();
  }

  function start() {
    generation += 1;
    clientId = `c${generation}-${Math.floor(random() * 0xffffff).toString(16).padStart(6, '0')}`;
    leaderHint = '';
    requestSeq = 0;
    startedAt = clock.now();
    nodes = Object.fromEntries(NODE_IDS.map((id) => [id, { id, up: false, isolated: false, state: null, worker: null }]));
    disks = {};
    events = [];
    stats = { sent: 0, delivered: 0, dropped: 0 };
    log('network', 'start', 'started three nodes, each in its own worker; waiting for an election timeout');
    for (const id of NODE_IDS) boot(id);
  }

  start();

  return {
    stop,
    restart,
    setIsolated,
    submit,
    setDelay(ms) {
      delayMs = Math.max(0, Math.min(MAX_DELAY_MS, Math.round(ms)));
      onUpdate('network');
    },
    reset() {
      teardown();
      start();
      onUpdate('state');
    },
    destroy() {
      if (destroyed) return;
      teardown();
      destroyed = true;
      nodes = {};
      disks = {};
      events = [];
    },
    // Read-only views for the UI and tests.
    view: () => ({
      nodes: NODE_IDS.map((id) => ({ id, up: nodes[id]?.up ?? false, isolated: nodes[id]?.isolated ?? false, state: nodes[id]?.state ?? null })),
      delayMs,
      stats: { ...stats },
      pending: pending.size,
      elapsed: clock.now() - startedAt,
    }),
    events: () => events,
    inflight: () => [...inflight.values()],
    disk: (id) => disks[id] ?? null,
    activeTimers: () => timers.size,
    clientId: () => clientId,
  };
}
