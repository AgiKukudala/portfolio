import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Fully static build: no dev proxies or runtime backends. `worker.format: 'es'`
// keeps the module workers (src/sim/node-worker.js, src/insider/worker.js)
// as ES modules in the production bundle.
// Content hash of public/Resume.pdf, appended to its URL so replacing the file
// changes the link and browsers can't keep showing a cached older copy.
const resumeVersion = createHash('sha256')
  .update(readFileSync('public/Resume.pdf'))
  .digest('hex')
  .slice(0, 10);

export default defineConfig({
  define: { __RESUME_VERSION__: JSON.stringify(resumeVersion) },
  server: { port: 5173 },
  worker: { format: 'es' },
});
