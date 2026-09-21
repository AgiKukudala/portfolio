import { escapeHTML as esc } from '../data.js';
import { labs } from '../content/site.js';
import { explainer, localNote } from '../components/explainer.js';
import { createCluster, NODE_IDS, MAX_DELAY_MS, TIMING } from '../sim/cluster.js';

const lab = labs.find((l) => l.id === 'asterkv');
const $ = (sel) => document.querySelector(sel);

// One row per operation drives the picker, the field visibility, the button
// label and the hint text, so adding an operation touches exactly one place.
const OPERATIONS = {
  put: {
    label: 'Save',
    blurb: 'Store a value under a key',
    action: 'Save value',
    needs: ['key', 'value'],
    hint: 'The leader writes it down and copies it to the others. You get a “saved” only once at least two computers have it.',
  },
  get: {
    label: 'Read',
    blurb: 'Look up what a key holds',
    action: 'Read value',
    needs: ['key'],
    hint: 'Reads also need two computers to agree, so you always get the latest saved value.',
  },
  cas: {
    label: 'Swap',
    blurb: 'Change it only if it still matches',
    action: 'Swap if it matches',
    needs: ['key', 'value', 'expected'],
    hint: 'Only changes the value if it still holds what you expect, so two people can’t overwrite each other.',
  },
  delete: {
    label: 'Delete',
    blurb: 'Remove a key entirely',
    action: 'Delete key',
    needs: ['key'],
    hint: 'Deleting is copied to the others just like saving.',
  },
};

const STEPS = [
  { do: 'Wait a few seconds for a leader.', why: 'The computers vote, and the winner is marked “leader”. It is the one in charge of saving things.' },
  { do: 'Save a value, then read it back.', why: 'Watch it appear on the leader, get copied to the others, and turn solid once two have it.' },
  { do: 'Stop the leader, then save again.', why: 'The other two notice, pick a new leader, and saving still works. Nothing saved earlier is lost.' },
  { do: 'Restart the stopped computer.', why: 'It comes back and copies whatever it missed.' },
  { do: 'Stop two computers and try to save.', why: 'One computer on its own can’t save anything. The request gives up instead of pretending it worked.' },
  { do: 'Isolate the leader and send only to it.', why: 'Cut off, it still thinks it’s in charge but can’t save. When reconnected, it steps down and drops what never got agreed.' },
];

// Where each participant sits in the diagram (SVG user units).
const POS = { node1: [180, 44], node2: [52, 232], node3: [308, 232], client: [180, 162] };
const LINKS = [['node1', 'node2'], ['node1', 'node3'], ['node2', 'node3']];

// Module-local state. destroy() releases all of it.
let cluster = null;
let frame = 0;
let renderQueued = false;
let lastOp = null;
let busy = false;
let reducedMotion = null;
let unmounted = true;

export const asterkv = {
  render: () => `
    <section class="lab-heading">
      <div class="eyebrow"><span class="dot"></span> PROJECT 01 <span class="divider">/</span> INTERACTIVE LAB</div>
      <h1>Aster<span class="accent">KV</span></h1>
      <a class="source-link" href="${lab.source}" target="_blank" rel="noopener">GO SOURCE &#8599;</a>
    </section>

    ${localNote(lab)}
    ${explainer(lab)}

    <div class="lab-status-bar">
      <div id="aster-status" class="lab-status" role="status">
        <span class="badge sample">Browser simulation</span>
        <span class="status-detail">The three “computers” below are pretend ones running inside this browser tab.</span>
      </div>
      <button id="cluster-reset" class="small-button" title="Terminate all three workers and start a fresh cluster">&#8635; Reset</button>
    </div>
    <details class="stage-note">
      <summary>How this compares with the real thing</summary>
      <p>The same rules as the Go project, rewritten in JavaScript: how the computers vote for a leader, how changes get copied, and when a change counts as saved. Each pretend computer keeps its own copy of the data, and every number on screen comes straight from it.</p>
      <p>The real <a href="${lab.source}" target="_blank" rel="noopener">AsterKV</a> runs as separate Go programs that talk over a network and save to disk. Here the messages stay inside your browser, nothing is saved to disk (Reset or reloading the page starts over), and everything is slowed down so you can watch it. It shows how the system works; it is not a real backup of anything.</p>
    </details>

    <div class="sim-stage">
      <div class="sim-diagram">
        <svg id="sim-svg" viewBox="0 0 360 290" role="img" aria-labelledby="sim-svg-title">
          <title id="sim-svg-title">Three nodes connected to each other and to your browser client, with messages in flight</title>
          <g id="sim-links">
            ${LINKS.map(([a, b]) => `<line class="sim-link" data-a="${a}" data-b="${b}" x1="${POS[a][0]}" y1="${POS[a][1]}" x2="${POS[b][0]}" y2="${POS[b][1]}"/>`).join('')}
            ${NODE_IDS.map((id) => `<line class="sim-client-link" x1="${POS.client[0]}" y1="${POS.client[1]}" x2="${POS[id][0]}" y2="${POS[id][1]}"/>`).join('')}
          </g>
          <g id="sim-packets"></g>
          <g class="sim-client">
            <rect x="${POS.client[0] - 30}" y="${POS.client[1] - 14}" width="60" height="28" rx="6"/>
            <text x="${POS.client[0]}" y="${POS.client[1] + 4}">YOU</text>
          </g>
          ${NODE_IDS.map(
            (id) => `
          <g class="sim-node" data-node="${id}">
            <circle cx="${POS[id][0]}" cy="${POS[id][1]}" r="34"/>
            <text class="sim-node-name" x="${POS[id][0]}" y="${POS[id][1] - 6}">${id}</text>
            <text class="sim-node-role" x="${POS[id][0]}" y="${POS[id][1] + 9}">&hellip;</text>
            <text class="sim-node-term" x="${POS[id][0]}" y="${POS[id][1] + 21}"></text>
          </g>`,
          ).join('')}
        </svg>
        <div class="sim-legend" aria-hidden="true">
          <span><i class="pk-append"></i>append / heartbeat</span>
          <span><i class="pk-vote"></i>vote</span>
          <span><i class="pk-client"></i>client</span>
        </div>
        <div class="sim-network">
          <label for="delay">Message delay <output id="delay-out">150 ms</output></label>
          <input id="delay" type="range" min="0" max="${MAX_DELAY_MS}" step="10" value="150">
          <p class="sim-stats" id="sim-stats"></p>
        </div>
      </div>

      <div class="sim-nodes" id="sim-nodes">
        ${NODE_IDS.map(
          (id) => `
        <article class="sim-card" data-node="${id}">
          <header>
            <b>${id}</b>
            <span class="sim-role">&hellip;</span>
          </header>
          <dl class="sim-facts">
            <div><dt>Term</dt><dd data-f="term">&ndash;</dd></div>
            <div><dt>Voted for</dt><dd data-f="vote">&ndash;</dd></div>
            <div><dt>Last entry</dt><dd data-f="last">&ndash;</dd></div>
            <div><dt>Committed</dt><dd data-f="commit">&ndash;</dd></div>
            <div><dt>Applied</dt><dd data-f="applied">&ndash;</dd></div>
          </dl>
          <div class="sim-log" data-f="log" aria-label="${id} log, most recent entries"></div>
          <div class="sim-kv" data-f="kv"></div>
          <div class="sim-controls">
            <button class="small-button" data-action="power" data-node="${id}">Stop</button>
            <button class="small-button" data-action="isolate" data-node="${id}" aria-pressed="false">Isolate</button>
          </div>
        </article>`,
        ).join('')}
      </div>
    </div>

    <div class="aster-workspace">
      <section class="command-panel">
        <h2>Try it</h2>
        <p class="panel-sub">Pick an action and send it to the three computers.</p>

        <form id="command-form">
          <fieldset class="op-picker">
            <legend>1 &middot; What do you want to do?</legend>
            <div class="op-grid">
              ${Object.entries(OPERATIONS)
                .map(
                  ([value, op], i) => `
                <label class="op-card">
                  <input type="radio" name="operation" value="${value}" ${i === 0 ? 'checked' : ''}>
                  <span class="op-body">
                    <b>${op.label}</b>
                    <small>${op.blurb}</small>
                  </span>
                </label>`,
                )
                .join('')}
            </div>
          </fieldset>

          <div class="field-group">
            <span class="field-step">2 &middot; Details</span>

            <label class="field" for="key">
              Key
              <span class="field-note">the name you file the value under</span>
              <input id="key" value="greeting" required maxlength="64"
                     pattern="[a-zA-Z0-9_\\-]+" autocomplete="off"
                     title="Letters, numbers, hyphen and underscore only.">
              <small class="field-error" id="key-error" hidden>Use letters, numbers, - and _ only.</small>
            </label>

            <label class="field" id="value-field" for="value">
              Value
              <span class="field-note">what you want stored</span>
              <input id="value" value="hello world" maxlength="64" autocomplete="off">
            </label>

            <label class="field" id="expected-field" for="expected">
              Only if it currently equals
              <span class="field-note">the swap is refused if it does not match</span>
              <input id="expected" value="hello world" maxlength="64" autocomplete="off">
            </label>

            <label class="field" for="target">
              Send to
              <span class="field-note">automatic finds the leader for you</span>
              <select id="target">
                <option value="auto">Automatic</option>
                ${NODE_IDS.map((id) => `<option value="${id}">${id} only</option>`).join('')}
              </select>
            </label>
          </div>

          <p class="op-hint" id="op-hint"></p>

          <button class="button primary block" type="submit" id="submit">
            <span id="submit-label">Save value</span> <span>&#8594;</span>
          </button>
          <button type="button" class="small-button block" id="retry" hidden
                  title="Re-sends the same request ID, so the cluster can recognise a duplicate">
            Retry the same request
          </button>
        </form>
      </section>

      <section class="response-panel">
        <h2>What happened</h2>
        <div id="outcome" class="outcome idle" role="status" aria-live="polite">
          <div class="outcome-head">
            <span class="state-dot"></span>
            <b>Nothing sent yet</b>
          </div>
          <p class="outcome-text">Wait for a node to show <b>leader</b>, then send an operation.</p>
        </div>

        <div class="event-log-head">
          <h3>Event log</h3>
          <span class="muted">newest first &middot; heartbeats omitted</span>
        </div>
        <ol class="event-log" id="event-log" aria-live="off"></ol>
      </section>
    </div>

    <section class="walkthrough">
      <div>
        <div class="eyebrow">A SIX-STEP TOUR</div>
        <h2>Break it on purpose.</h2>
        <p>Each step shows how the system copes when something goes wrong.</p>
      </div>
      <div>
        <ol class="tour-list">
          ${STEPS.map((s) => `<li><b>${s.do}</b><span>${s.why}</span></li>`).join('')}
        </ol>
        <details>
          <summary>Reading the node cards</summary>
          <p><b>Term</b> is the node's election round. <b>Last entry</b>, <b>Committed</b> and <b>Applied</b> are the newest log index it holds, the newest it knows a majority stored, and the newest it has executed. Solid log chips are committed; outlined ones are not yet. The key-value list is that node's own applied state, which is why a follower can briefly lag the leader.</p>
          <p>A request that times out is genuinely ambiguous: its entry may still commit later. Retrying reuses the same request ID, and the state machine remembers IDs it has applied, so a retry cannot apply the same write twice.</p>
        </details>
      </div>
    </section>
  `,

  mount() {
    unmounted = false;
    lastOp = null;
    busy = false;
    reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

    cluster = createCluster({
      spawn: (id) => new Worker(new URL('../sim/node-worker.js', import.meta.url), { type: 'module', name: `asterkv-${id}` }),
      clock: {
        now: () => performance.now(),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle),
      },
      delayMs: Number($('#delay').value),
      onUpdate: queueRender,
    });
    if (import.meta.env.DEV) window.__aster = cluster; // dev-only probe hook

    $('#command-form').onsubmit = (event) => {
      event.preventDefault();
      if (!$('#key').checkValidity()) {
        $('#key-error').hidden = false;
        $('#key').focus();
        return;
      }
      $('#key-error').hidden = true;
      send();
    };
    $('#retry').onclick = () => send(lastOp);
    $('#cluster-reset').onclick = () => {
      lastOp = null;
      $('#retry').hidden = true;
      cluster.reset();
      setOutcome('idle', 'Cluster reset', 'All three workers were terminated and replaced. Saved state was cleared.');
    };
    $('#delay').oninput = () => {
      cluster.setDelay(Number($('#delay').value));
      $('#delay-out').textContent = `${$('#delay').value} ms`;
    };
    $('#sim-nodes').onclick = (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const id = button.dataset.node;
      const node = cluster.view().nodes.find((n) => n.id === id);
      if (button.dataset.action === 'power') node.up ? cluster.stop(id) : cluster.restart(id);
      else cluster.setIsolated(id, !node.isolated);
    };
    document.querySelectorAll('input[name=operation]').forEach((radio) => radio.addEventListener('change', syncOperation));
    $('#key').addEventListener('input', () => {
      $('#key-error').hidden = $('#key').checkValidity();
    });

    syncOperation();
    render();
    frame = requestAnimationFrame(drawPackets);
  },

  destroy() {
    unmounted = true;
    cancelAnimationFrame(frame);
    frame = 0;
    cluster?.destroy();
    cluster = null;
    lastOp = null;
    busy = false;
    renderQueued = false;
    if (import.meta.env.DEV) delete window.__aster;
  },
};

const currentOp = () => document.querySelector('input[name=operation]:checked').value;

function syncOperation() {
  const op = OPERATIONS[currentOp()];
  $('#value-field').hidden = !op.needs.includes('value');
  $('#expected-field').hidden = !op.needs.includes('expected');
  $('#submit-label').textContent = op.action;
  $('#op-hint').textContent = op.hint;
}

// -- rendering ----------------------------------------------------------------

function queueRender() {
  if (renderQueued || unmounted) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!unmounted) render();
  });
}

const ROLE_LABEL = { leader: 'leader', follower: 'follower', candidate: 'candidate' };

function describeCommand(c) {
  if (!c) return 'no-op';
  if (c.op === 'put') return `PUT ${c.key}=${c.value}`;
  if (c.op === 'cas') return `CAS ${c.key}:${c.expected}→${c.value}`;
  return `${c.op.toUpperCase()} ${c.key}`;
}

function render() {
  if (!cluster || !$('#sim-nodes')) return;
  const view = cluster.view();

  for (const node of view.nodes) {
    const s = node.state;
    const role = !node.up ? 'stopped' : s ? s.role : 'booting';

    const g = document.querySelector(`.sim-node[data-node="${node.id}"]`);
    g.setAttribute('class', `sim-node ${role}${node.isolated ? ' isolated' : ''}`);
    g.querySelector('.sim-node-role').textContent = role;
    g.querySelector('.sim-node-term').textContent = s ? `term ${s.term}` : '';

    const card = document.querySelector(`.sim-card[data-node="${node.id}"]`);
    card.className = `sim-card ${role}${node.isolated ? ' isolated' : ''}`;
    card.querySelector('.sim-role').textContent = `${role}${node.isolated ? ' · isolated' : ''}`;
    const field = (name) => card.querySelector(`[data-f="${name}"]`);

    if (s) {
      field('term').textContent = s.term;
      field('vote').textContent = s.vote || '–';
      field('last').textContent = s.lastIndex;
      field('commit').textContent = s.commit;
      field('applied').textContent = s.applied;
      const tail = s.log.slice(-8);
      field('log').innerHTML =
        (s.log.length > tail.length ? `<span class="sim-more">+${s.log.length - tail.length}</span>` : '') +
        (tail
          .map(
            (e) => `<span class="sim-entry ${e.index <= s.commit ? 'committed' : 'pending'}" title="index ${e.index}, term ${e.term}: ${esc(describeCommand(e.command))}${e.index <= s.commit ? ', committed' : ', not committed'}">
              <small>${e.index}·t${e.term}</small>${esc(describeCommand(e.command))}</span>`,
          )
          .join('') || '<span class="muted">empty log</span>');
      const entries = Object.entries(s.kv);
      field('kv').innerHTML = entries.length
        ? entries.map(([k, v]) => `<span><code>${esc(k)}</code> = <code>${esc(v)}</code></span>`).join('')
        : '<span class="muted">no keys applied</span>';
    } else {
      for (const name of ['term', 'vote', 'last', 'commit', 'applied']) field(name).textContent = '–';
      const disk = cluster.disk(node.id);
      field('log').innerHTML = node.up
        ? '<span class="muted">starting…</span>'
        : `<span class="muted">worker stopped${disk ? ` &middot; saved: term ${disk.term}, ${disk.log.length} entries, commit ${disk.commit}` : ''}</span>`;
      field('kv').innerHTML = '';
    }

    const power = card.querySelector('[data-action="power"]');
    power.textContent = node.up ? 'Stop' : 'Restart';
    const isolate = card.querySelector('[data-action="isolate"]');
    isolate.textContent = node.isolated ? 'Reconnect' : 'Isolate';
    isolate.setAttribute('aria-pressed', String(node.isolated));
  }

  document.querySelectorAll('.sim-link').forEach((line) => {
    const cut = view.nodes.some((n) => (n.id === line.dataset.a || n.id === line.dataset.b) && n.isolated);
    line.classList.toggle('cut', cut);
  });

  const up = view.nodes.filter((n) => n.up).length;
  $('#sim-stats').textContent = `${up} of 3 nodes running · ${view.stats.sent} messages sent · ${view.stats.delivered} delivered · ${view.stats.dropped} dropped`;

  renderEvents();
}

function renderEvents() {
  const list = $('#event-log');
  const items = cluster.events().slice(-60).reverse();
  list.innerHTML = items
    .map(
      (e) => `<li class="ev-${esc(e.kind)}"><time>${(e.t / 1000).toFixed(1)}s</time><b>${esc(e.source)}</b><span>${esc(e.text)}</span></li>`,
    )
    .join('');
}

// In-flight messages, drawn from the transport's own list of undelivered
// messages. With reduced motion the dots are not animated; the counters and
// event log carry the same information.
function drawPackets() {
  frame = 0;
  if (unmounted || !cluster) return;
  const layer = $('#sim-packets');
  if (layer) {
    if (reducedMotion.matches) {
      layer.innerHTML = '';
    } else {
      const now = performance.now();
      layer.innerHTML = cluster
        .inflight()
        .map((m) => {
          const [x1, y1] = POS[m.from];
          const [x2, y2] = POS[m.to];
          const span = Math.max(1, m.deliverAt - m.sentAt);
          const p = Math.min(1, Math.max(0, (now - m.sentAt) / span));
          const kind = m.type.startsWith('vote') ? 'vote' : m.type.startsWith('client') ? 'client' : 'append';
          return `<circle class="packet pk-${kind}" r="4" cx="${(x1 + (x2 - x1) * p).toFixed(1)}" cy="${(y1 + (y2 - y1) * p).toFixed(1)}"/>`;
        })
        .join('');
    }
  }
  frame = requestAnimationFrame(drawPackets);
}

// -- sending a command ----------------------------------------------------------

async function send(retryOf = null) {
  if (busy || !cluster) return;
  const command = retryOf
    ? retryOf.command
    : {
        op: currentOp(),
        key: $('#key').value,
        value: $('#value').value,
        expected: $('#expected').value,
      };
  const target = retryOf ? retryOf.target : $('#target').value;

  busy = true;
  $('#submit').disabled = true;
  $('#retry').hidden = true;
  setOutcome(
    'pending',
    retryOf ? 'Retrying the same request…' : 'Waiting for a majority…',
    `${esc(describeCommand(command))} is on its way${target === 'auto' ? '' : ` to ${esc(target)}`}. Watch the event log.`,
  );

  const clusterAtSend = cluster;
  const outcome = await cluster.submit(command, { target, requestId: retryOf?.requestId });
  if (unmounted || cluster !== clusterAtSend) return;
  busy = false;
  $('#submit').disabled = false;

  lastOp = { command, target, requestId: outcome.command.requestId };
  showOutcome(outcome);
}

function showOutcome(outcome) {
  const c = outcome.command;
  const key = `<code>${esc(c.key)}</code>`;
  const route = outcome.attempts?.length ? `Tried ${outcome.attempts.map(esc).join(' → ')}.` : '';
  const timing = `<span class="outcome-timing">${route} ${Math.round(outcome.elapsed)} ms · request ${esc(c.requestId)}</span>`;

  if (outcome.status === 'timeout') {
    $('#retry').hidden = false;
    return setOutcome(
      'error',
      'No confirmation: outcome unknown',
      `No node confirmed this ${esc(c.op.toUpperCase())} within 8 seconds, usually because no majority of nodes could reach each other. It was <b>not</b> reported as saved. If it reached a leader's log, it may still commit once a majority returns; retrying reuses the same request ID, so it cannot apply twice.${timing}`,
    );
  }
  if (outcome.status === 'rejected') {
    const text =
      outcome.reason === 'not_leader'
        ? `${esc(outcome.node)} is not the leader${outcome.leader ? `; it says ${esc(outcome.leader)} is` : ' and does not know who is'}. Only the leader accepts requests. Choose <b>Automatic</b> to follow the hint.`
        : `${esc(outcome.node)} refused the request: ${esc(outcome.reason)}.`;
    return setOutcome('neutral', 'Refused', `${text}${timing}`);
  }
  if (outcome.status === 'cancelled') return setOutcome('idle', 'Cancelled', 'The cluster was reset before the request finished.');

  const { result } = outcome;
  const where = `Committed at log index ${outcome.index} in term ${outcome.term} by ${esc(outcome.node)}.`;
  const dup = result.deduplicated ? ' The cluster had already applied this request ID, so it returned the original result instead of running it again.' : '';
  let tone = 'ok';
  let title = 'Done';
  let text = '';
  if (c.op === 'put') {
    title = 'Saved';
    text = `${key} now holds <code>${esc(c.value)}</code>.`;
  } else if (c.op === 'get') {
    if (result.found) {
      title = 'Found it';
      text = `${key} holds <code>${esc(result.value)}</code>.`;
    } else {
      tone = 'neutral';
      title = 'Nothing there';
      text = `${key} is not set. That is a definite answer, not an error.`;
    }
  } else if (c.op === 'cas') {
    if (result.success) {
      title = 'Swapped';
      text = `It equalled <code>${esc(c.expected)}</code>, so ${key} is now <code>${esc(c.value)}</code>.`;
    } else {
      tone = 'neutral';
      title = 'Left unchanged';
      text = result.found
        ? `You expected <code>${esc(c.expected)}</code>, but ${key} holds <code>${esc(result.value)}</code>. Nothing was overwritten.`
        : `${key} does not exist, so there was nothing to compare against.`;
    }
  } else if (c.op === 'delete') {
    if (result.found) {
      title = 'Deleted';
      text = `${key} held <code>${esc(result.value)}</code> and is now removed.`;
    } else {
      tone = 'neutral';
      title = 'Nothing to delete';
      text = `${key} was not set.`;
    }
  }
  setOutcome(tone, title, `${text} ${where}${dup}${timing}`);
}

function setOutcome(tone, title, html) {
  const node = $('#outcome');
  if (!node) return;
  node.className = `outcome ${tone}`;
  node.innerHTML = `
    <div class="outcome-head"><span class="state-dot"></span><b>${title}</b></div>
    <p class="outcome-text">${html}</p>`;
}
