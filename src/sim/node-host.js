// Runs one RaftNode on behalf of a host: the real Web Worker (node-worker.js)
// or the in-process fake used by the deterministic tests.
//
// Inbound:  { type: 'boot', id, peers, durable, timing, seed, tickMs }
//           { type: 'deliver', msg }
// Outbound: { type: 'persist', durable }   always before the messages it covers
//           { type: 'send', msg }
//           { type: 'events', events }
//           { type: 'state', state }       only when something visible changed

import { RaftNode, mulberry32 } from './raft-core.js';

export function createNodeHost({ post, clock }) {
  let node = null;
  let interval = null;
  let lastState = '';

  function flush() {
    const { durable, messages, events } = node.drain();
    if (durable) post({ type: 'persist', durable });
    for (const msg of messages) post({ type: 'send', msg });
    if (events.length) post({ type: 'events', events });
    const state = node.status();
    const serialized = JSON.stringify(state);
    if (serialized !== lastState) {
      lastState = serialized;
      post({ type: 'state', state });
    }
  }

  return {
    handle(message) {
      if (message.type === 'boot') {
        node = new RaftNode({
          id: message.id,
          peers: message.peers,
          durable: message.durable,
          timing: message.timing,
          random: mulberry32(message.seed),
          now: clock.now(),
        });
        interval = clock.setInterval(() => {
          node.tick(clock.now());
          flush();
        }, message.tickMs);
        flush();
      } else if (message.type === 'deliver' && node) {
        node.receive(message.msg, clock.now());
        flush();
      }
    },
    stop() {
      clock.clearInterval(interval);
      node = null;
    },
  };
}
