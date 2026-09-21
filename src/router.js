// Minimal hash router.
//
// A view is { render(): string } plus optional mount()/destroy() hooks.
// destroy() lets a view cancel in-flight requests and stop animation loops
// before the next view takes over the same mount node.

export function createRouter({ root, routes, fallback, onNavigate }) {
  let current = null;

  function resolve() {
    const raw = location.hash.slice(1);
    const [name, ...rest] = raw.split('/');
    return { name: routes[name] ? name : fallback, anchor: rest[0] || null, raw };
  }

  function navigate() {
    const { name, anchor } = resolve();
    const view = routes[name];

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
