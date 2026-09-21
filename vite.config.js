import { defineConfig } from 'vite';

// Fully static build: no dev proxies or runtime backends. `worker.format: 'es'`
// keeps the module workers (src/sim/node-worker.js, src/insider/worker.js)
// as ES modules in the production bundle.
export default defineConfig({
  server: { port: 5173 },
  worker: { format: 'es' },
});
