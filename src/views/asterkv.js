import { api } from '../api.js';
import { escapeHTML as esc } from '../data.js';
import { labs } from '../content/site.js';
import { explainer } from '../components/explainer.js';

const lab = labs.find((l) => l.id === 'asterkv');
const $ = (sel) => document.querySelector(sel);

// Module-local state. Reset by destroy() so a revisit starts clean.
let pendingCommand = null;
let alive = false;

// One row per operation drives the picker, the field visibility, the button
// label and the hint text, so adding an operation touches exactly one place.
const OPERATIONS = {
  put: {
    label: 'Save',
    blurb: 'Store a value under a key',
    action: 'Save value',
    needs: ['key', 'value'],
    hint: 'Writes the value to all three nodes. They must agree before you get a reply.',
  },
  get: {
    label: 'Read',
    blurb: 'Look up what a key holds',
    action: 'Read value',
    needs: ['key'],
    hint: 'Reads go through the same agreement process as writes, so you never see a stale value.',
  },
  cas: {
    label: 'Swap',
    blurb: 'Change it only if it still matches',
    action: 'Swap if it matches',
    needs: ['key', 'value', 'expected'],
    hint: 'Changes the value only if it currently equals what you expected. Safe when two people edit at once.',
  },
  delete: {
    label: 'Delete',
    blurb: 'Remove a key entirely',
    action: 'Delete key',
    needs: ['key'],
    hint: 'Removes the key from all three nodes.',
  },
};

// The "What happened" diagram. One glyph per operation, shown inside each node
// once the cluster has answered. It is a schematic of a command's round trip:
// the engine returns a single result for the cluster, so nothing here is
// per-node telemetry and no node is singled out as leader.
const FLOW_GLYPH = { put: '&#8595;', get: '&#8593;', cas: '&#8644;', delete: '&#215;' };
const FLOW_UNCHANGED = '&#8211;';   // shown when the cluster declined to change anything

const FLOW_SVG = `
  <svg class="flow-svg" viewBox="0 0 340 112" role="img"
       aria-label="Diagram of a command travelling from the browser through the gateway to three nodes">
    <path class="flow-wire" d="M62,56 H100" pathLength="100"/>
    <path class="flow-wire" d="M174,56 C208,56 216,17 250,17" pathLength="100"/>
    <path class="flow-wire" d="M174,56 H250" pathLength="100"/>
    <path class="flow-wire" d="M174,56 C208,56 216,95 250,95" pathLength="100"/>

    <path class="flow-pulse" d="M62,56 H100" pathLength="100"/>
    <path class="flow-pulse" d="M174,56 C208,56 216,17 250,17" pathLength="100"/>
    <path class="flow-pulse" d="M174,56 H250" pathLength="100"/>
    <path class="flow-pulse" d="M174,56 C208,56 216,95 250,95" pathLength="100"/>

    <g class="flow-chip">
      <rect x="4" y="43" width="58" height="26" rx="5"/>
      <text x="33" y="60">YOU</text>
    </g>
    <g class="flow-chip">
      <rect x="100" y="43" width="74" height="26" rx="5"/>
      <text x="137" y="60">GATEWAY</text>
    </g>

    ${[17, 56, 95]
      .map(
        (cy, i) => `
    <g class="flow-node">
      <rect x="250" y="${cy - 13}" width="86" height="26" rx="5"/>
      <text class="flow-name" x="262" y="${cy + 4}">node${i + 1}</text>
      <text class="flow-glyph" x="326" y="${cy + 4}"></text>
    </g>`,
      )
      .join('')}
  </svg>`;

const STEPS = [
  { do: 'Save a value, then read the same key back.', why: 'Shows a write surviving the trip through all three machines.' },
  { do: 'Swap it, using the current value as what you expect.', why: 'Succeeds, because your expectation matches reality.' },
  { do: 'Swap again, but expect something wrong.', why: 'Refuses, and tells you the real value. This is how conflicts are prevented.' },
  { do: 'Delete the key, then read it.', why: 'Comes back empty. The deletion replicated too.' },
];

export const asterkv = {
  render: () => `
    <section class="lab-heading">
      <div class="eyebrow"><span class="dot"></span> PROJECT 01 <span class="divider">/</span> INTERACTIVE LAB</div>
      <h1>Aster<span class="accent">KV</span></h1>
      <a class="source-link" href="${lab.source}" target="_blank" rel="noopener">SOURCE &#8599;</a>
    </section>

    ${explainer(lab)}

    <div class="lab-status-bar">
      <div id="aster-status" class="lab-status" role="status">
        <span class="state-dot pending"></span> Checking the cluster&hellip;
      </div>
      <button id="cluster-refresh" class="small-button" title="Re-check whether each node is accepting connections">
        &#8635; Re-check
      </button>
    </div>

    <div class="cluster-stage">
      <div class="client-node"><span>YOU</span><b>Browser</b></div>
      <div class="connection-line">&#8594;</div>
      <div class="client-node"><span>ENTRY POINT</span><b>Go gateway</b></div>
      <div class="connection-line">&#8594;</div>
      <div id="nodes" class="nodes">
        <div><span class="tiny-dot"></span><b>node1</b><small>checking</small></div>
        <div><span class="tiny-dot"></span><b>node2</b><small>checking</small></div>
        <div><span class="tiny-dot"></span><b>node3</b><small>checking</small></div>
      </div>
    </div>
    <details class="stage-note">
      <summary>The three nodes each keep their own copy of the data. What does this diagram show?</summary>
      <p>Which nodes are accepting connections &mdash; nothing more. It does not show which node is currently leader, or how far replication has progressed, because the engine does not report either.</p>
    </details>

    <div class="aster-workspace">
      <section class="command-panel">
        <h2>Try it</h2>
        <p class="panel-sub">Pick an action, fill in the blanks, and send it to the real cluster.</p>

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
              <input id="value" value="hello world" maxlength="512" autocomplete="off">
            </label>

            <label class="field" id="expected-field" for="expected">
              Only if it currently equals
              <span class="field-note">the swap is refused if it does not match</span>
              <input id="expected" value="hello world" maxlength="512" autocomplete="off">
            </label>
          </div>

          <p class="op-hint" id="op-hint"></p>

          <button class="button primary block" type="submit" id="submit">
            <span id="submit-label">Save value</span> <span>&#8594;</span>
          </button>
          <button type="button" class="small-button block" id="retry" hidden
                  title="Re-sends the exact same request, including its ID, so the cluster can recognise a duplicate">
            Retry the same request
          </button>
        </form>

        <p class="muted panel-foot">
          Your keys are kept in a private space for this browser tab, separate from other visitors.
        </p>
      </section>

      <section class="response-panel">
        <h2>What happened</h2>
        <div id="flow" class="flow idle">
          ${FLOW_SVG}
          <p class="flow-caption">
            A schematic of one command's round trip. The engine reports a single result
            for the cluster, so this is not per-node timing and no node is shown as leader.
          </p>
        </div>
        <div id="outcome" class="outcome idle" role="status" aria-live="polite">
          <div class="outcome-head">
            <span class="state-dot"></span>
            <b>Nothing sent yet</b>
          </div>
          <p class="outcome-text">Choose an action on the left and send it.</p>
        </div>
        <div id="raw-wrap" hidden>
          <details>
            <summary>Raw response</summary>
            <pre id="result"></pre>
          </details>
        </div>
      </section>
    </div>

    <section class="walkthrough">
      <div>
        <div class="eyebrow">A FOUR-STEP TOUR</div>
        <h2>See it hold together.</h2>
        <p>Run these in order. Each one shows something the previous one could not.</p>
      </div>
      <div>
        <ol class="tour-list">
          ${STEPS.map((s) => `<li><b>${s.do}</b><span>${s.why}</span></li>`).join('')}
        </ol>
        <details>
          <summary>What this lab can and cannot show you</summary>
          <p>The gateway talks to three separately running Raft nodes. The original engine exposes command results only &mdash; not which node is leader, the current term, the log index, or replication progress &mdash; so none of those are displayed. The node diagram reports whether each node is accepting connections, nothing more. The round-trip diagram beside the result is a schematic of what the operation did, drawn from the single result the cluster returns &mdash; it is not a per-node trace, and the order its pulses move in is fixed, not measured. Reads go through consensus like writes. No leader is simulated and no metric is invented.</p>
          <p>A timed-out request is genuinely ambiguous: the write may still have committed. Retrying reuses the same request ID, and the nodes deduplicate it, so a retry cannot apply the same write twice. Nodes keep durable data across restarts. The gateway caps requests per minute. Failure injection is operator-only; visitors cannot stop processes or run commands on the host.</p>
        </details>
      </div>
    </section>
  `,

  mount() {
    alive = true;
    pendingCommand = null;

    $('#command-form').onsubmit = (event) => {
      event.preventDefault();
      if (!$('#key').checkValidity()) {
        $('#key-error').hidden = false;
        $('#key').focus();
        return;
      }
      $('#key-error').hidden = true;
      sendCommand(false);
    };
    $('#retry').onclick = () => sendCommand(true);
    $('#cluster-refresh').onclick = checkCluster;
    document
      .querySelectorAll('input[name=operation]')
      .forEach((radio) => radio.addEventListener('change', syncOperation));
    $('#key').addEventListener('input', () => {
      $('#key-error').hidden = $('#key').checkValidity();
    });

    syncOperation();
    setFlow('idle');
    checkCluster();
  },

  destroy() {
    alive = false;
    pendingCommand = null;
  },
};

const currentOp = () => document.querySelector('input[name=operation]:checked').value;

/** Show only the fields the chosen operation uses, and label the button for it. */
function syncOperation() {
  const op = OPERATIONS[currentOp()];
  $('#value-field').hidden = !op.needs.includes('value');
  $('#expected-field').hidden = !op.needs.includes('expected');
  $('#submit-label').textContent = op.action;
  $('#op-hint').textContent = op.hint;
}

// -- cluster reachability ---------------------------------------------------

async function checkCluster() {
  const status = $('#aster-status');
  if (!status) return;
  status.innerHTML = '<span class="state-dot pending"></span> Checking the cluster&hellip;';

  try {
    const data = await api('/aster-api/api/status');
    if (!alive || !$('#aster-status')) return;

    const up = data.nodes.filter((n) => n.reachable).length;
    const all = data.nodes.length;
    $('#aster-status').innerHTML = `
      <span class="state-dot ${up === all ? 'ok' : 'warn'}"></span>
      <b>${up === all ? 'Connected' : 'Partly reachable'}</b>
      <span class="status-detail">${up} of ${all} nodes responding</span>`;

    $('#nodes').innerHTML = data.nodes
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(
        (node) => `
        <div class="${node.reachable ? 'reachable' : ''}">
          <span class="tiny-dot"></span><b>${esc(node.id)}</b>
          <small>${node.reachable ? 'responding' : 'unreachable'}</small>
        </div>`,
      )
      .join('');
  } catch (error) {
    if (!alive || !$('#aster-status')) return;
    $('#aster-status').innerHTML = `
      <span class="state-dot error"></span>
      <b>Cluster offline</b>
      <span class="status-detail">${esc(error.message)}</span>`;
    $('#nodes').querySelectorAll('div').forEach((row) => {
      row.classList.remove('reachable');
      row.querySelector('small').textContent = 'unreachable';
    });
  }
}

// -- sending a command ------------------------------------------------------

async function sendCommand(retry) {
  if (!retry) {
    let session = sessionStorage.getItem('aster-session');
    if (!session) {
      session = crypto.randomUUID();
      sessionStorage.setItem('aster-session', session);
    }
    pendingCommand = {
      op: currentOp(),
      key: $('#key').value,
      value: $('#value').value,
      expected: $('#expected').value,
      session,
      request: crypto.randomUUID(),
    };
  }
  if (!pendingCommand) return;

  const submit = $('#submit');
  submit.disabled = true;
  $('#retry').hidden = true;
  setOutcome('pending', 'Sending&hellip;', 'Waiting for all three nodes to agree.');
  setFlow('sending', pendingCommand.op);

  try {
    const data = await api('/aster-api/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingCommand),
    });
    if (!alive) return;
    showResult(pendingCommand, data);
    pendingCommand = null;
  } catch (error) {
    if (!alive) return;
    setOutcome(
      'error',
      'That did not go through',
      `${esc(error.message)} If this timed out, the write may still have been saved &mdash; retrying is safe, because the cluster recognises the repeated request ID.`,
    );
    setFlow('settled', pendingCommand.op, 'error');
    showRaw(`${error.message}\nRequest ID: ${pendingCommand.request}`);
    if ($('#retry')) $('#retry').hidden = false;
  } finally {
    if (alive && $('#submit')) submit.disabled = false;
  }
}


/**
 * Turn the engine's {success, found, value} into a sentence.
 * `found` and `value` describe the state before the command for writes, and
 * the current state for reads, which is why each operation reads them itself.
 */
function showResult(command, data) {
  const { success, found, value } = data.result;
  const key = esc(command.key);
  const ms = Math.round(data.elapsed_ms);

  let tone = 'ok';
  let title = 'Done';
  let text = '';

  if (command.op === 'put') {
    title = 'Saved';
    text = `<code>${key}</code> now holds <code>${esc(command.value)}</code> on every node.`;
  } else if (command.op === 'get') {
    if (found) {
      title = 'Found it';
      text = `<code>${key}</code> holds <code>${esc(value)}</code>.`;
    } else {
      tone = 'neutral';
      title = 'Nothing there';
      text = `<code>${key}</code> is not set. That is not an error &mdash; the cluster is certain it has no value.`;
    }
  } else if (command.op === 'cas') {
    if (success) {
      title = 'Swapped';
      text = `It did equal <code>${esc(command.expected)}</code>, so <code>${key}</code> is now <code>${esc(command.value)}</code>.`;
    } else {
      tone = 'neutral';
      title = 'Left unchanged';
      text = `You expected <code>${esc(command.expected)}</code>, but <code>${key}</code> actually holds <code>${esc(value)}</code>. Nothing was overwritten &mdash; this is the protection working.`;
    }
  } else if (command.op === 'delete') {
    if (found) {
      title = 'Deleted';
      text = `<code>${key}</code> held <code>${esc(value)}</code> and is now removed everywhere.`;
    } else {
      tone = 'neutral';
      title = 'Nothing to delete';
      text = `<code>${key}</code> was not set to begin with.`;
    }
  }

  setFlow('settled', command.op, tone);
  setOutcome(tone, title, `${text} <span class="outcome-timing">Agreed in ${ms} ms.</span>`);
  showRaw(JSON.stringify(data, null, 2));
}

/**
 * Drive the round-trip diagram. `sending` animates the request outward;
 * `settled` stops it and marks each node with what the operation did. A
 * `neutral` tone means the cluster declined to change anything (a refused
 * swap, a key that was not there), so the nodes show unchanged rather than
 * the operation's glyph.
 */
function setFlow(state, op, tone = '') {
  const flow = $('#flow');
  if (!flow) return;
  flow.className = `flow ${state}${tone ? ` ${tone}` : ''}`;

  let glyph = '';
  if (state === 'settled' && tone !== 'error') {
    glyph = tone === 'neutral' ? FLOW_UNCHANGED : FLOW_GLYPH[op] ?? '';
  }
  flow.querySelectorAll('.flow-glyph').forEach((cell) => {
    cell.innerHTML = glyph;
  });
}

function setOutcome(tone, title, html) {
  const node = $('#outcome');
  if (!node) return;
  node.className = `outcome ${tone}`;
  node.innerHTML = `
    <div class="outcome-head"><span class="state-dot"></span><b>${title}</b></div>
    <p class="outcome-text">${html}</p>`;
}

function showRaw(text) {
  const wrap = $('#raw-wrap');
  if (!wrap) return;
  wrap.hidden = false;
  $('#result').textContent = text;
}
