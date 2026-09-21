// Deterministic harness for the AsterKV simulation: a virtual clock and
// in-process stand-ins for Web Workers that run the real node host.
//
// Messages between the "page" and a fake worker are structured-cloned and
// delivered asynchronously (a 0 ms virtual timer), like postMessage. A
// terminated fake worker drops everything still queued, like terminate().

import { createNodeHost } from '../src/sim/node-host.js';
import { createCluster } from '../src/sim/cluster.js';

export class VirtualClock {
  constructor() {
    this.t = 0;
    this.seq = 0;
    this.timers = new Map();
  }
  now() {
    return this.t;
  }
  setTimeout(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn, every: 0 });
    return id;
  }
  setInterval(fn, ms) {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  }
  clearTimeout(id) {
    this.timers.delete(id);
  }
  clearInterval(id) {
    this.timers.delete(id);
  }
  /** Run every timer due within the next `ms`, in time order (ties: creation order). */
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      let nextId = null;
      let next = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && (!next || timer.at < next.at || (timer.at === next.at && id < nextId))) {
          next = timer;
          nextId = id;
        }
      }
      if (!next) break;
      this.t = next.at;
      if (next.every) next.at += next.every;
      else this.timers.delete(nextId);
      next.fn();
    }
    this.t = end;
  }
}

export function fakeSpawn(clock, live) {
  return (id) => {
    const worker = { id, dead: false, onmessage: null, onerror: null };
    const host = createNodeHost({
      clock,
      post: (message) => {
        const copy = structuredClone(message);
        clock.setTimeout(() => {
          if (!worker.dead) worker.onmessage?.({ data: copy });
        }, 0);
      },
    });
    worker.postMessage = (message) => {
      const copy = structuredClone(message);
      clock.setTimeout(() => {
        if (!worker.dead) host.handle(copy);
      }, 0);
    };
    worker.terminate = () => {
      worker.dead = true;
      host.stop();
      live.delete(worker);
    };
    live.add(worker);
    return worker;
  };
}

/**
 * A cluster on a virtual clock, plus invariant tracking. Every state report
 * is checked for election safety (one leader per term) as it arrives.
 */
export function simulate({ seed = 1, delayMs = 100 } = {}) {
  const clock = new VirtualClock();
  const live = new Set();
  const leadersByTerm = new Map();
  const violations = [];
  let cluster;
  cluster = createCluster({
    spawn: fakeSpawn(clock, live),
    clock,
    seed,
    delayMs,
    onUpdate(kind) {
      if (kind !== 'state' || !cluster) return;
      for (const { state } of cluster.view().nodes) {
        if (state?.role !== 'leader') continue;
        const seen = leadersByTerm.get(state.term);
        if (seen && seen !== state.id) violations.push(`two leaders in term ${state.term}: ${seen} and ${state.id}`);
        leadersByTerm.set(state.term, state.id);
      }
    },
  });

  const run = (ms) => clock.advance(ms);
  const states = () => cluster.view().nodes.filter((n) => n.up && n.state).map((n) => n.state);
  const leaders = () => states().filter((s) => s.role === 'leader');

  /** Run until `predicate()` holds, failing after `limit` ms of virtual time. */
  function until(predicate, limit = 20000, step = 25) {
    for (let waited = 0; waited <= limit; waited += step) {
      if (predicate()) return waited;
      run(step);
    }
    throw Error(`condition not met within ${limit} ms`);
  }

  /** Submit and advance the clock until the operation settles. */
  function exec(command, options) {
    let outcome = null;
    cluster.submit(command, options).then((o) => {
      outcome = o;
    });
    // Promise callbacks are microtasks; the virtual clock is synchronous, so
    // settle by polling between small advances.
    return (async () => {
      for (let waited = 0; waited < 20000 && !outcome; waited += 25) {
        await Promise.resolve();
        await Promise.resolve();
        if (!outcome) run(25);
      }
      await Promise.resolve();
      if (!outcome) throw Error('operation never settled');
      return outcome;
    })();
  }

  /**
   * The single leader that a majority agrees on. `exclude` skips nodes (e.g.
   * an isolated former leader that still believes it leads an older term).
   */
  function stableLeader(limit = 20000, exclude = []) {
    const candidates = () => leaders().filter((s) => !exclude.includes(s.id));
    until(() => {
      const l = candidates();
      if (l.length !== 1) return false;
      const agree = states().filter((s) => s.term === l[0].term && s.leader === l[0].id).length;
      return agree >= 2;
    }, limit);
    return candidates()[0];
  }

  /** Log Matching + State Machine Safety across every running node. */
  function checkCommittedPrefixes() {
    const s = states();
    for (const a of s) {
      for (const b of s) {
        const upto = Math.min(a.commit, b.commit);
        for (let i = 0; i < upto; i++) {
          if (JSON.stringify(a.log[i]) !== JSON.stringify(b.log[i])) {
            violations.push(`${a.id} and ${b.id} disagree on committed index ${i + 1}`);
          }
        }
      }
    }
  }

  return { clock, cluster, live, run, until, exec, states, leaders, stableLeader, checkCommittedPrefixes, violations, leadersByTerm };
}
