// Minimal hash router.
//
// A view is { render(): string } plus optional mount()/destroy() hooks.
// destroy() lets a view cancel in-flight work, terminate workers and stop
// animation loops before the next view takes over the same mount node.
//
// A route may instead be a function returning a promise of a view, so heavy
// views (the two labs) are fetched only when first visited.

export function createRouter({ root, routes, fallback, onNavigate }) {
  let current = null;
  let token = 0;
  const loaded = new Map();

  function resolve() {
    const raw = location.hash.slice(1);
    const [name, ...rest] = raw.split('/');
    return { name: routes[name] ? name : fallback, anchor: rest[0] || null, raw };
  }

  function load(name) {
    const route = routes[name];
    if (typeof route !== 'function') return route;
    if (!loaded.has(name)) {
      loaded.set(name, route().catch((error) => {
        loaded.delete(name); // allow a retry on the next navigation
        throw error;
      }));
    }
    return loaded.get(name);
  }

  async function navigate() {
    const mine = ++token;
    const { name, anchor } = resolve();

    let view;
    try {
      view = await load(name);
    } catch {
      view = {
        render: () => `<section class="lab-heading"><h1>Could not load this page</h1>
          <p class="muted">A file failed to download. Check your connection and <a href="">reload</a>.</p></section>`,
      };
    }
    // A later navigation started while this one was loading: let it win.
    if (mine !== token) return;

    current?.destroy?.();
    root.innerHTML = view.render();
    current = view;
    view.mount?.(root);

    onNavigate?.(name);

    if (anchor) {
      requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView());
    } else {
      window.scrollTo(0, 0);
    }
  }

  window.addEventListener('hashchange', navigate);
  return { navigate, activeRoute: () => resolve().name };
}
