import { api } from '../api.js';
import { filterRows, displayNumber as num, filingURL, escapeHTML as esc } from '../data.js';
import { labs } from '../content/site.js';
import { explainer } from '../components/explainer.js';

const lab = labs.find((l) => l.id === 'insiderpulse');
const $ = (sel) => document.querySelector(sel);

const FILTER_FIELDS = ['search', 'start', 'end', 'code'];
const PAGE_SIZE = 60;

// The walkthrough beside the lab. One entry per panel the reader moves through,
// in the order the page lays them out. Written to be followed while clicking,
// so each one says what to do first and what to notice second.
const STEPS = [
  {
    do: 'Pick a filing',
    why: 'Search a company on the left, then click any row. The panel on the right fills in with that one filing. “SEC filing ↗” opens the original document on sec.gov.',
    code: 'sec_client → parser.parse_form4_xml → database',
  },
  {
    do: 'See what was traded',
    why: 'How many shares, at what price, and what kind of transaction it was. “Not reported” or $0.00 means the filing itself left that blank — not that the shares were free.',
    code: 'parser.parse_transaction_row → models.Transaction',
  },
  {
    do: 'Check the two dates',
    why: 'Insiders trade on one date and tell the public on another. The gap between them is normal, and it is why this is a research tool rather than a live feed.',
    code: 'models.Transaction.transaction_date / filing_date',
  },
  {
    do: 'See who else was buying',
    why: 'Other insiders at the same company who bought around the same time are listed here. Several rows from one person is still one person, not a crowd.',
    code: 'filters → clusters.find_cluster_insiders',
  },
  {
    do: 'See how it scored, and how it did',
    why: 'A plain-rules score with every point explained, then a stored comparison against the S&P 500 where one exists. Check the sample size before reading much into a return. Neither is advice.',
    code: 'scoring.score_purchase → prices.PriceLoader → backtester.run_backtest',
  },
];

const TRANSACTION_CODES = [
  ['', 'All transactions'],
  ['P', 'P · Purchase'],
  ['S', 'S · Sale'],
  ['A', 'A · Grant / award'],
  ['M', 'M · Exercise'],
  ['X', 'X · Exercise'],
  ['F', 'F · Tax withholding'],
  ['G', 'G · Gift'],
  ['J', 'J · Other'],
];

const CODE_NOTES = {
  P: 'Code P reports an open-market or private purchase. It does not by itself tell you why the insider bought.',
  S: 'Code S reports an open-market or private sale. A sale does not by itself explain the insider’s motivation.',
  A: 'A grant or award reports compensation or another award of securities; it is not treated as an open-market purchase.',
  M: 'An exercise converts an existing option or right into securities. The engine excludes it from purchase signals.',
  X: 'An exercise is not treated as an open-market purchase.',
  F: 'Shares were delivered or withheld to meet a tax or exercise-price obligation.',
  G: 'A gift transfers securities without an ordinary market purchase.',
};

// Module-local state.
let dataset = null;
let selected = null;
let mode = 'cached';
let visible = PAGE_SIZE;
// Monotonic token: every load stamps its version, and a stale response whose
// version no longer matches is discarded instead of overwriting fresher data.
let requestVersion = 0;
let filterTimer = null;

const rowKey = (row) => (row ? `${row.source_filing}:${row.line_number}` : null);
const pct = (v) => (v == null ? 'Not available' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);

export const insiderpulse = {
  render: () => `
    <section class="lab-heading">
      <div class="eyebrow"><span class="dot"></span> PROJECT 02 <span class="divider">/</span> INTERACTIVE LAB</div>
      <h1>Insider<span class="accent">Pulse</span></h1>
      <a class="source-link" href="${lab.source}" target="_blank" rel="noopener">SOURCE &#8599;</a>
    </section>

    ${explainer(lab)}

    <div class="lab-toolbar">
      <div class="segmented" aria-label="Where the data comes from">
        <button data-mode="cached" class="active"
                title="Real SEC filings already downloaded and stored. Works with no backend running.">Saved filings</button>
        <button data-mode="live"
                title="Queries the running InsiderPulse service directly.">Live service</button>
        <button data-mode="sample"
                title="A small made-up example used by the project's tests. Not a real filing.">Example data</button>
      </div>
      <button id="refresh" class="small-button" title="Reload the current data source">&#8635; Refresh</button>
    </div>

    <div class="lab-status-bar">
      <div id="data-status" class="lab-status" role="status" aria-live="polite">
        <span class="state-dot pending"></span> Loading&hellip;
      </div>
    </div>
    <details class="stage-note" id="data-provenance" hidden>
      <summary>Where this data came from</summary>
      <div id="provenance-body"></div>
    </details>

    <div class="pipeline" aria-label="Analysis pipeline">
      <span><b>01</b> SEC disclosure</span><i>&#8594;</i>
      <span><b>02</b> Parsed transaction</span><i>&#8594;</i>
      <span><b>03</b> Qualifying purchase</span><i>&#8594;</i>
      <span><b>04</b> Cluster &amp; score</span><i>&#8594;</i>
      <span><b>05</b> Historical evaluation</span>
    </div>

    <div class="workspace">
      <aside class="feed">
        <div class="panel-title"><h2>Filing explorer</h2><span id="count">&mdash;</span></div>
        <label class="search">Company or ticker<input id="search" placeholder="Search UNH, Intel, Nike&hellip;" autocomplete="off" maxlength="80"></label>
        <div class="filters">
          <label>Filed from<input type="date" id="start"></label>
          <label>Filed through<input type="date" id="end"></label>
        </div>
        <label class="type-filter">Transaction code
          <select id="code">${TRANSACTION_CODES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        </label>
        <div id="filing-list" class="filing-list"></div>
        <button id="more" class="small-button" hidden>Show more records</button>
      </aside>
      <section class="detail" id="detail"><p>Choose a filing to inspect its reported data.</p></section>
    </div>

    <section class="walkthrough">
      <div>
        <div class="eyebrow">A FIVE-MINUTE WALKTHROUGH</div>
        <h2>From filing to finding.</h2>
        <p>No finance background needed.</p>
      </div>
      <div class="walkthrough-content">
        <ol class="tour-list">
          ${STEPS.map((s) => `<li><b>${s.do}</b><span>${s.why}</span></li>`).join('')}
        </ol>
        <details class="step-code">
          <summary>Where each step happens in the code</summary>
          <ol>
            ${STEPS.map((s) => `<li><b>${s.do}</b><code>${s.code}</code></li>`).join('')}
          </ol>
        </details>
      </div>
    </section>

    <p class="disclaimer">Research, not a recommendation. SEC disclosures report past transactions; this is not a real-time trade feed.</p>
  `,

  mount() {
    document.querySelectorAll('[data-mode]').forEach((button) => {
      button.onclick = () => {
        mode = button.dataset.mode;
        for (const id of FILTER_FIELDS) document.getElementById(id).value = '';
        load();
      };
    });
    $('#refresh').onclick = () => load();

    FILTER_FIELDS.forEach((id) => {
      document.getElementById(id).oninput = () => {
        clearTimeout(filterTimer);
        // Live mode filters server-side, so debounce. Cached and sample data
        // are already in memory and filter synchronously.
        if (mode === 'live') filterTimer = setTimeout(() => load(), 300);
        else renderFeed();
      };
    });

    if (mode === 'cached') {
      $('#search').value = 'UNH';
      $('#start').value = '2025-05-01';
      $('#end').value = '2025-05-31';
    }
    load();
  },

  destroy() {
    requestVersion += 1; // invalidate anything in flight
    clearTimeout(filterTimer);
    dataset = null;
    selected = null;
  },
};

// -- data loading ----------------------------------------------------------

async function load(append = false) {
  const version = ++requestVersion;
  const previous = append ? dataset : null;

  dataset = null;
  if (!append) selected = null;
  visible = append ? visible + 200 : PAGE_SIZE;

  document
    .querySelectorAll('[data-mode]')
    .forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));

  const status = $('#data-status');
  status.innerHTML = `<span class="state-dot pending"></span> Loading ${MODE_LABELS[mode].toLowerCase()}…`;
  $('#filing-list').innerHTML = '';
  $('#detail').innerHTML = '<p>Waiting for data…</p>';

  try {
    const data = mode === 'live' ? await loadLive(previous) : await loadStatic();
    if (version !== requestVersion || !$('#data-status')) return;

    dataset = data;
    status.innerHTML = describeSource(data);
    const provenance = $('#data-provenance');
    if (provenance) {
      provenance.hidden = false;
      $('#provenance-body').innerHTML = describeProvenance(data);
    }
    renderFeed();
    if (mode === 'live') observeJob(version);
  } catch (error) {
    if (version !== requestVersion || !$('#data-status')) return;
    const label =
      error.status === 429 ? 'Rate-limited' : error.status === 400 ? 'Request rejected' : 'Service offline';
    status.innerHTML = `
      <span class="state-dot error"></span><b>${label}</b>
      <span class="status-detail">${esc(error.message)}</span>`;
    const provenance = $('#data-provenance');
    if (provenance) provenance.hidden = true;
    $('#detail').innerHTML =
      '<div class="empty-state">Nothing loaded.<br>Switch to <b>Saved filings</b> to browse without the service running.</div>';
    $('#count').textContent = '—';
  }
}

const loadStatic = () => api(mode === 'cached' ? '/insider-cache.json' : '/insider-sample.json');

async function loadLive(previous) {
  const query = new URLSearchParams({
    limit: '200',
    offset: String(previous?.transactions.length || 0),
  });
  for (const [id, param] of [['search', 'q'], ['start', 'start'], ['end', 'end'], ['code', 'code']]) {
    const value = document.getElementById(id).value;
    if (value) query.set(param, value);
  }

  const data = await api(`/insider-api/api/filings?${query}`);
  data.backendConnected = true;
  if (!previous) return data;

  // Paging appends transactions; signals and backtests are de-duplicated by
  // their natural keys because a later page can restate an earlier one.
  data.transactions = [...previous.transactions, ...data.transactions];
  data.signals = dedupe([...previous.signals, ...data.signals], (s) => s.source_filing);
  data.backtests = dedupe(
    [...previous.backtests, ...data.backtests],
    (b) => `${b.source_filing}:${b.holding_period_days}`,
  );
  return data;
}

const dedupe = (items, key) => [...new Map(items.map((i) => [key(i), i])).values()];

const MODE_LABELS = {
  cached: 'Saved filings',
  live: 'Live service',
  sample: 'Example data',
};

/** One short line for the status bar: state, source name, record count. */
function describeSource(data) {
  const shown = data.transactions.length;
  const count = data.total > shown ? `${shown} of ${data.total} records` : `${shown} records`;
  const tone = mode === 'sample' ? 'warn' : 'ok';
  const detail =
    mode === 'sample'
      ? 'Made-up example, not a real filing'
      : `${count}${data.backendConnected ? ' \u00B7 service connected' : ''}`;

  return `<span class="state-dot ${tone}"></span><b>${MODE_LABELS[mode]}</b>
    <span class="status-detail">${detail}</span>`;
}

/** The provenance caveats, moved out of the status line into a disclosure. */
function describeProvenance(data) {
  if (mode === 'sample') {
    return `<p>A small synthetic fixture from the project's own tests (<code>${esc(data.source)}</code>).
      The company and the insider are invented. Nothing here is a real SEC filing.</p>`;
  }
  return `<p>Source: <code>${esc(data.source)}</code></p>
    <p>These are historical records, not a live feed. Most recent record retrieved
      ${esc(data.latest_record_retrieval || 'unknown')}; last successful refresh from the SEC
      ${esc(data.last_successful_refresh || 'not recorded')}.</p>
    ${
      data.total > data.transactions.length
        ? `<p>Showing ${data.transactions.length} of ${data.total} rows. Use <b>Show more records</b> to load the rest.</p>`
        : ''
    }`;
}

async function observeJob(version) {
  try {
    const status = await api('/insider-api/api/status');
    if (version !== requestVersion || !$('#data-status')) return;

    let node = $('#job-progress');
    if (!node) {
      node = document.createElement('span');
      node.id = 'job-progress';
      node.className = 'status-meta';
      $('#data-status').append(node);
    }

    const job = status.job;
    node.textContent =
      job.state === 'idle'
        ? 'Upstream ingestion idle · operator-triggered only.'
        : `Ingestion ${job.state}: ${job.completed}${job.total != null ? `/${job.total}` : ''} filings processed${
            job.truncated ? ' · 20-filing cap reached' : ''
          }${job.error ? ` · ${job.error}` : ''}`;

    if (job.state === 'running') setTimeout(() => observeJob(version), 2500);
  } catch {
    if (version !== requestVersion || !$('#data-status')) return;
    const node = document.createElement('span');
    node.className = 'status-meta';
    node.textContent = 'Job status unavailable; displayed cached records remain unchanged.';
    $('#data-status').append(node);
  }
}

// -- feed ------------------------------------------------------------------

function renderFeed() {
  if (!dataset) return;

  const filters = {
    q: $('#search').value,
    start: $('#start').value,
    end: $('#end').value,
    code: $('#code').value,
  };
  const list = $('#filing-list');

  if (filters.start && filters.end && filters.start > filters.end) {
    list.innerHTML = '<p role="alert">The start date must be on or before the end date.</p>';
    return;
  }

  const rows = filterRows(dataset.transactions, filters);
  $('#count').textContent = `${dataset.backendConnected ? dataset.total : rows.length} ROWS`;

  if (!rows.some((r) => rowKey(r) === selected)) {
    // Default to a known illustrative filing when it is in range, else the top row.
    const preferred = rows.find(
      (r) => r.insider_name === 'HEMSLEY STEPHEN J' && r.filing_date === '2025-05-16',
    );
    selected = rowKey(preferred || rows[0]);
  }

  list.innerHTML =
    rows.slice(0, visible).map(filingRow).join('') ||
    '<div class="empty-state">No filings match these filters.</div>';
  list.querySelectorAll('button').forEach((button) => {
    button.onclick = () => {
      selected = button.dataset.key;
      renderFeed();
    };
  });

  const more = $('#more');
  const hasMoreOnServer = dataset.backendConnected && dataset.total > dataset.transactions.length;
  more.hidden = rows.length <= visible && !hasMoreOnServer;
  more.onclick = () => {
    if (dataset.backendConnected && visible >= rows.length) load(true);
    else {
      visible += PAGE_SIZE;
      renderFeed();
    }
  };

  renderDetail(rows.find((r) => rowKey(r) === selected));
}

function filingRow(row) {
  const isSelected = rowKey(row) === selected;
  return `
    <button class="filing-row ${isSelected ? 'selected' : ''}" data-key="${esc(rowKey(row))}" aria-pressed="${isSelected}">
      <span class="row-top">
        <b>${esc(row.ticker)}</b>
        <span class="code code-${esc(row.transaction_code)}">${esc(row.transaction_code)} &middot; ${esc(row.transaction_type)}</span>
      </span>
      <span class="insider-name">${esc(row.insider_name)}</span>
      <span class="row-bottom">
        <span>${esc(row.insider_role)} &middot; filed ${row.filing_date}</span>
        <b>${num(row.transaction_value, true)}</b>
      </span>
    </button>`;
}

// -- detail ----------------------------------------------------------------

function renderDetail(row) {
  const panel = $('#detail');
  if (!row) {
    panel.innerHTML =
      '<div class="empty-state">Select another search or date range to explore available records.</div>';
    return;
  }

  const signal = dataset.signals.find((s) => s.source_filing === row.source_filing);
  const related = signal
    ? dataset.signals.filter((s) => signal.related_filings?.includes(s.source_filing))
    : [];
  const backtests = dataset.backtests.filter((b) => b.source_filing === row.source_filing);
  const link = filingURL(row.document_url);

  panel.innerHTML = `
    <div class="detail-heading">
      <div>
        <div class="eyebrow">${esc(row.ticker)} <span class="divider">/</span> CIK ${esc(row.cik)}</div>
        <h2>${esc(row.company_name)}</h2>
      </div>
      ${
        link
          ? `<a class="small-button" href="${esc(link)}" target="_blank" rel="noopener">SEC filing &#8599;</a>`
          : '<span class="badge sample">No real filing link</span>'
      }
    </div>

    <div class="transaction-summary">
      <span class="big-code code-${esc(row.transaction_code)}">${esc(row.transaction_code)}</span>
      <div>
        <div class="eyebrow">REPORTED TRANSACTION</div>
        <h3>${esc(row.transaction_type)}</h3>
        <p>${esc(row.insider_name)} <span> / ${esc(row.insider_role)}</span></p>
      </div>
    </div>

    <div class="metrics">
      <div><span>Shares</span><strong>${num(row.shares)}</strong></div>
      <div><span>Reported price / share</span><strong>${num(row.price_per_share, true)}</strong></div>
      <div><span>Reported value</span><strong>${num(row.transaction_value, true)}</strong></div>
    </div>

    <div class="dates">
      <div><span class="tiny-dot"></span><b>${esc(row.transaction_date)}</b><small>Transaction date</small></div>
      <span class="date-line"></span>
      <div><span class="tiny-dot hollow"></span><b>${esc(row.filing_date)}</b><small>Disclosure date</small></div>
    </div>

    <p class="explanation">${codeExplanation(row)}</p>

    <details>
      <summary>Original data &amp; parser limitations</summary>
      <dl>
        <dt>Security</dt><dd>${esc(row.security_title)} &middot; ${row.is_derivative ? 'Derivative' : 'Non-derivative'}</dd>
        <dt>Acquired / disposed</dt><dd>${esc(row.acquired_or_disposed)}</dd>
        <dt>Accession / row</dt><dd>${esc(row.source_filing)} / ${row.line_number}</dd>
        <dt>Retrieved</dt><dd>${esc(row.retrieved_at)} (legacy timezone not recorded)</dd>
      </dl>
      <p>Role is normalized by the parser, not the original officer title. Form 4/A amendments are skipped. Ownership type and footnotes are not retained; consult the SEC document for those details. Missing values remain “Not reported.”</p>
    </details>

    ${renderSignal(signal, related)}
    ${renderBacktests(backtests)}
  `;
}

function renderSignal(signal, related) {
  return `
    <div class="analysis-heading">
      <h3>Related insider activity</h3>
      <span class="badge">${
        signal
          ? `${signal.cluster_size} DISTINCT NAME${signal.cluster_size === 1 ? '' : 'S'}`
          : 'NO QUALIFYING SIGNAL'
      }</span>
    </div>
    ${
      signal
        ? `
      <p class="muted">${signal.cluster_size >= 2 ? 'Qualifying cluster' : 'Isolated qualifying purchase'} &middot; within 14 days of this purchase, disclosed on or before ${signal.filing_date}.</p>
      <div class="timeline">
        ${related
          .map(
            (s) => `
          <div>
            <span class="timeline-dot"></span>
            <time>${s.transaction_date}</time>
            <b>${esc(s.insider_name)}</b>
            <span>${num(s.total_value, true)}</span>
            <small>Disclosed ${s.filing_date}${s.source_filing === signal.source_filing ? ' &middot; selected filing' : ''}</small>
          </div>`,
          )
          .join('')}
      </div>
      <div class="signal">
        <div><span class="eyebrow">IMPLEMENTED RULE SCORE</span><strong>${signal.score}<small> points</small></strong></div>
        <ul>${signal.score_breakdown.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>`
        : '<p class="muted">This filing produced no qualifying purchase signal. A signal requires code P, non-derivative shares acquired, positive shares and price, and a known transaction date.</p>'
    }
    <details>
      <summary>How the original cluster and score work</summary>
      <p>Purchase rows are combined per filing. A cluster requires at least two distinct insider names within ±14 calendar days of the selected purchase; only filings disclosed on or before its filing date count. Repeated purchases by one exact name count once. Same-day disclosure order and changes in name spelling are not resolved. Related activity may fall outside your explorer filters. Counts cover only available cached disclosures; incomplete or bounded ingestion can omit qualifying insiders.</p>
      <p>Code path: filters.filter_open_market_purchases → combine_purchases_into_signals → clusters.assign_cluster_sizes → scoring.score_signals. Points are research rules, not probabilities or recommendations. Minimum purchase value: $0, after requiring positive shares and price.</p>
    </details>`;
}

function renderBacktests(backtests) {
  return `
    <div class="analysis-heading">
      <h3>Historical backtest</h3>
      <span class="badge">${backtests.length ? 'CACHED RESULTS' : 'UNAVAILABLE'}</span>
    </div>
    ${
      backtests.length
        ? `
      <p class="muted">${new Set(backtests.map((b) => b.source_filing)).size} signal &middot; ${backtests.length} holding periods &middot; ${backtests.map((b) => b.entry_date).sort()[0]} to ${backtests.map((b) => b.exit_date).sort().at(-1)} &middot; benchmark SPY</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Hold</th><th>Entry &#8594; exit</th><th>Stock</th><th>SPY</th><th>Excess</th></tr></thead>
          <tbody>
            ${backtests
              .map(
                (b) => `
              <tr>
                <td>${b.holding_period_days}d</td>
                <td>${b.entry_date}<br>${b.exit_date}</td>
                <td>${pct(b.stock_return)}</td>
                <td>${pct(b.benchmark_return)}</td>
                <td>${pct(b.benchmark_adjusted_return)}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>`
        : '<p class="muted">No historical evaluation is stored for this filing. Missing market data or a non-qualifying transaction does not mean a 0% return.</p>'
    }
    <button disabled class="small-button">Execution disabled · operator CLI only</button>
    <details>
      <summary>Entry assumptions, data &amp; research limitations</summary>
      <p>Yahoo Finance adjusted closes, cached by the original PriceLoader. Entry uses the first available trading day after disclosure; exit rolls forward from entry + 7, 30, or 90 calendar days. Prices roll forward at most seven days. Missing and future prices are skipped. The benchmark lookup can independently roll forward when a same-day SPY price is absent.</p>
      <p>No commissions, spread, slippage, taxes, significance testing, or portfolio sizing. Hand-selected companies create selection bias; missing delisted prices create survivorship bias. Overlapping signals are not independent. Clusters use disclosure dates, but cannot resolve intraday publication order. Historical returns do not predict future returns.</p>
      <p>Market provider: yfinance / Yahoo Finance. No paid credential required by the original code; provider availability and usage terms still apply. New backtests require an explicit operator CLI command. Cached results were not generated by this browser.</p>
    </details>`;
}

function codeExplanation(row) {
  const note =
    CODE_NOTES[row.transaction_code] ||
    'The parser preserves this SEC transaction code and its reported amounts; consult the filing for context.';
  return `${note} The transaction date and the date the filing became public are different events.`;
}
