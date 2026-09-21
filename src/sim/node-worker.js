// One simulated AsterKV node. Each node runs in its own Web Worker and owns its
// Raft state; the page only routes messages between workers and keeps each
// node's saved (durable) record so a restarted worker can load it.

import { createNodeHost } from './node-host.js';

const clock = {
  now: () => performance.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

const host = createNodeHost({ post: (message) => postMessage(message), clock });
self.onmessage = ({ data }) => host.handle(data);
