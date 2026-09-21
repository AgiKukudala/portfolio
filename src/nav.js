// Header navigation, including the Projects dropdown.
//
// The dropdown is a disclosure: a real <button aria-expanded> controlling a
// list of links. That keeps it operable by keyboard and screen reader without
// any ARIA menu bookkeeping, and it degrades to a plain inline list on mobile,
// where the whole header nav is already an expanded panel.

const isExternal = (link) => Boolean(link.external);

export function createNav({ nav, menuButton, links }) {
  const groups = [];

  nav.innerHTML = links.map(renderLink).join('');

  // Wire each dropdown group.
  nav.querySelectorAll('[data-group]').forEach((wrapper) => {
    const trigger = wrapper.querySelector('.nav-trigger');
    const panel = wrapper.querySelector('.nav-menu');
    const items = [...panel.querySelectorAll('a')];

    const open = (focusFirst = false) => {
      closeAll(wrapper);
      wrapper.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
      if (focusFirst) items[0]?.focus();
    };
    const close = (returnFocus = false) => {
      wrapper.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');
      panel.hidden = true;
      if (returnFocus) trigger.focus();
    };
    const toggle = () => (trigger.getAttribute('aria-expanded') === 'true' ? close() : open());

    trigger.addEventListener('click', toggle);

    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        open(true);
      } else if (event.key === 'Escape') {
        close();
      }
    });

    panel.addEventListener('keydown', (event) => {
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[Math.min(index + 1, items.length - 1)]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (index <= 0) trigger.focus();
        else items[index - 1].focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        items.at(-1)?.focus();
      }
    });

    // Moving focus out of the group closes it, which also handles Tab-away.
    wrapper.addEventListener('focusout', (event) => {
      if (!wrapper.contains(event.relatedTarget)) close();
    });

    groups.push({ wrapper, close });
  });

  function closeAll(except = null) {
    for (const group of groups) if (group.wrapper !== except) group.close();
  }

  // A click anywhere else dismisses an open dropdown.
  document.addEventListener('pointerdown', (event) => {
    if (!nav.contains(event.target)) closeAll();
  });

  function closeMobileMenu() {
    nav.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
  }

  menuButton.addEventListener('click', () => {
    const opened = nav.classList.toggle('open');
    menuButton.setAttribute('aria-expanded', String(opened));
    if (!opened) closeAll();
  });

  // Following any link closes both the dropdown and the mobile panel.
  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) {
      closeAll();
      closeMobileMenu();
    }
  });

  return {
    closeMobileMenu,
    closeAll,

    /** Mark the item matching this route as current. */
    setActive(routeName) {
      nav.querySelectorAll('[data-routes]').forEach((element) => {
        const routes = element.dataset.routes.split(' ');
        const active = routes.includes(routeName);
        element.classList.toggle('active', active);
        if (element.tagName === 'A') {
          if (active) element.setAttribute('aria-current', 'page');
          else element.removeAttribute('aria-current');
        }
      });
    },
  };
}

function renderLink(link, index) {
  if (link.children) {
    const id = `nav-group-${index}`;
    return `
      <div class="nav-group" data-group>
        <button type="button" class="nav-trigger" data-routes="${link.routes.join(' ')}"
                aria-expanded="false" aria-controls="${id}">
          ${link.label}<span class="nav-caret" aria-hidden="true"></span>
        </button>
        <ul class="nav-menu" id="${id}" hidden>
          ${link.children
            .map(
              (child) => `
            <li>
              <a href="${child.href}" data-routes="${child.href.slice(1)}">
                <b>${child.label}</b>
                ${child.note ? `<small>${child.note}</small>` : ''}
              </a>
            </li>`,
            )
            .join('')}
        </ul>
      </div>`;
  }

  if (isExternal(link)) {
    return `<a href="${link.href}" target="_blank" rel="noopener">${link.label} &#8599;</a>`;
  }
  return `<a href="${link.href}" data-routes="${link.href.slice(1)}">${link.label}</a>`;
}
