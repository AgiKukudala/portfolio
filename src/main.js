import './style.css';
import { navLinks, profile } from './content/site.js';
import { createNav } from './nav.js';
import { createRouter } from './router.js';
import { createWater } from './fx/index.js';
import { home } from './views/home.js';
import { projects } from './views/projects.js';
import { fluid } from './views/fluid.js';
import { resume } from './views/resume.js';
import { contact } from './views/contact.js';

document.querySelector('#github-footer').href = profile.github;

// The water field runs behind every page except the two interactive labs,
// where it would compete with the lab's own visuals. It survives navigation
// between pages that keep it, and is torn down on the labs. Each start gets a
// fresh canvas because a WebGL context cannot be reinitialised after teardown.
const NO_WATER = new Set(['asterkv', 'insiderpulse']);
let water = null;
let waterCanvas = null;

function syncWater(route) {
  if (NO_WATER.has(route)) {
    water?.destroy();
    waterCanvas?.remove();
    water = waterCanvas = null;
  } else if (!water) {
    // Fixed, viewport-sized and click-through: pointer events are read from the document.
    const canvas = document.createElement('canvas');
    canvas.id = 'water';
    canvas.className = 'page-water';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
    water = createWater(canvas, { surface: document });
    waterCanvas = canvas;
    canvas.dataset.backend = water.backend;
  }
  if (import.meta.env.DEV) window.__water = water;   // dev-only probe hook
}

const nav = createNav({
  nav: document.querySelector('#nav'),
  menuButton: document.querySelector('#menu'),
  links: navLinks,
});

const router = createRouter({
  root: document.querySelector('#app'),
  fallback: 'home',
  routes: {
    home,
    projects,
    // The labs carry their own workers and data; load them on first visit.
    asterkv: () => import('./views/asterkv.js').then((m) => m.asterkv),
    insiderpulse: () => import('./views/insiderpulse.js').then((m) => m.insiderpulse),
    fluid,
    resume,
    contact,
  },
  onNavigate(name) {
    nav.closeAll();
    nav.closeMobileMenu();
    nav.setActive(name);
    syncWater(name);
  },
});

router.navigate();
