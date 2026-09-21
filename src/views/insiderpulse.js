import { filterRows, sortRows, displayNumber as num, filingURL, escapeHTML as esc } from '../data.js';
import { labs } from '../content/site.js';
import { explainer, localNote } from '../components/explainer.js';
import { isOpenMarketPurchase } from '../insider/analysis.js';

const lab = labs.find((l) => l.id === 'insiderpulse');
const $ = (sel) => document.querySelector(sel);

const FILTER_FIELDS = ['search', 'start', 'end', 'code', 'show', 'sort'];

// Static files in public/. Resolved against the page, not the worker script.
const DATASETS = {
  cached: 'insider-cache.json',
  sample: 'insider-sample.json',
};

const SHOW_OPTIONS = [
  ['all', 'Every reported transaction'],
  ['qualifying', 'Qualifying purchases only'],
  ['cluster', 'Cluster purchases (2+ insiders)'],
];
const SORT_OPTIONS = [
  ['newest', 'Newest filing first'],
  ['oldest', 'Oldest filing first'],
  ['value', 'Largest reported value'],
  ['score', 'Highest rule score'],
];
const PAGE_SIZE = 60;

// The walkthrough beside the lab. One entry per panel the reader moves through,
// in the order the page lays them out. Written to be followed while clicking,
// so each one says what to do first and what to notice second.
const STEPS = [
  {
    do: 'Pick a filing',
    why: 'Search for a company on the left and click a row. The right side shows that filing. “SEC filing ↗” opens the original on sec.gov.',
    code: 'sec_client → parser.parse_form4_xml → database',
  },
  {
    do: 'See what was traded',
    why: 'How many shares, at what price, and what kind of trade. “Not reported” or $0.00 means the filing left it blank, not that the shares were free.',
    code: 'parser.parse_transaction_row → models.Transaction',
  },
  {
    do: 'Check the two dates',
    why: 'Insiders trade on one day and report it a few days later. That delay is normal.',
    code: 'models.Transaction.transaction_date / filing_date',
  },
  {
    do: 'See who else was buying',
    why: 'Other insiders at the same company who bought within two weeks show up here. Several buys from one person still count as one person.',
    code: 'filters → clusters.find_cluster_insiders',
  },
  {
    do: 'See how it scored, and how it did',
    why: 'A simple score with every point explained, then how the stock did against the S&P 500. It is a small sample and not investment advice.',
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

// Module-local state. destroy() clears all of it.
let dataset = null;       // { ...file, signals: browser-computed signals }
let analysis = null;      // { verification, summaries, rules } from the worker
let signalByFiling = new Map();
let selected = null;
let mode = 'cached';
let visible = PAGE_SIZE;
let worker = null;
// Monotonic token: every load stamps its version, and a stale response whose
// version no longer matches is discarded instead of overwriting fresher data.
let requestVersion = 0;

const rowKey = (row) => (row ? `${row.source_filing}:${row.line_number}` : null);
const pct = (v) => (v == null ? 'Not available' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);

export const insiderpulse = {
  render: () => `
    <section class="lab-heading">
      <div class="eyebrow"><span class="dot"></span> PROJECT 02 <span class="divider">/</span> INTERACTIVE LAB</div>
      <h1>Insider<span class="accent">Pulse</span></h1>
      <a class="source-link" href="${lab.source}" target="_blank" rel="noopener">SOURCE &#8599;</a>
    </section>

    ${localNote(lab)}
    ${explainer(lab)}

    <div class="lab-toolbar">
      <div class="segmented" aria-label="Which dataset to explore">
        <button data-mode="cached" class="active"
                title="Real filings downloaded earlier and saved with this site.">Real filings</button>
        <button data-mode="sample"
                title="A small made-up example used by the project's tests. Not a real filing.">Made-up example</button>
      </div>
      <span class="runs-in" title="No server is involved: the data is a file and the math runs in your browser.">Runs in your browser</span>
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
        <div class="filters view-filters">
          <label>Show
            <select id="show">${SHOW_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
          </label>
          <label>Sort
            <select id="sort">${SORT_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
          </label>
        </div>
        <div id="filing-list" class="filing-list"></div>
        <button id="more" class="small-button" hidden>Show more records</button>
      </aside>
      <section class="detail" id="detail"><p>Choose a filing to inspect its reported data.</p></section>
    </div>

    <section class="results-summary" id="results-summary" hidden></section>

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
        if (mode === button.dataset.mode) return;
        mode = button.dataset.mode;
        resetFilters();
        load();
      };
    });

    FILTER_FIELDS.forEach((id) => {
      // Everything is in memory, so filtering is synchronous. It only changes
      // which rows are listed; the analysis always covers the full dataset.
      document.getElementById(id).oninput = () => {
        visible = PAGE_SIZE;
        renderFeed();
      };
    });

    resetFilters();
    load();
  },

  destroy() {
    requestVersion += 1; // invalidate anything in flight
    worker?.terminate();
    worker = null;
    dataset = null;
    analysis = null;
    signalByFiling = new Map();
    selected = null;
  },
};

function resetFilters() {
  for (const id of FILTER_FIELDS) {
    const field = document.getElementById(id);
    field.value = field.tagName === 'SELECT' ? field.options[0].value : '';
  }
  if (mode === 'cached') {
    // A known multi-insider cluster makes a useful first view.
    $('#search').value = 'UNH';
    $('#start').value = '2025-05-01';
    $('#end').value = '2025-05-31';
  }
}

// -- data loading ----------------------------------------------------------

/** Ask the analysis worker to load and analyse one static dataset. */
function runWorker(url) {
  worker?.terminate();
  worker = new Worker(new URL('../insider/worker.js', import.meta.url), { type: 'module' });
  const id = requestVersion;
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.id !== id) return;
      worker?.terminate();
      worker = null;
      data.ok ? resolve(data) : reject(Error(data.error));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      reject(Error(event.message || 'Analysis worker failed to start'));
    };
    worker.postMessage({ id, url });
  });
}

async function load() {
  const version = ++requestVersion;
  dataset = null;
  analysis = null;
  selected = null;
  visible = PAGE_SIZE;

  document
    .querySelectorAll('[data-mode]')
    .forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));

  $('#data-status').innerHTML = `<span class="state-dot pending"></span> Loading and analysing the ${MODE_LABELS[mode].toLowerCase()}&hellip;`;
  $('#filing-list').innerHTML = '';
  $('#detail').innerHTML = '<p>Waiting for data…</p>';
  $('#results-summary').hidden = true;

  try {
    const url = new URL(DATASETS[mode], new URL(import.meta.env.BASE_URL, location.href)).href;
    const result = await runWorker(url);
    if (version !== requestVersion || !$('#data-status')) return;

    dataset = result.dataset;
    analysis = result;
    signalByFiling = new Map(dataset.signals.map((s) => [s.source_filing, s]));

    $('#data-status').innerHTML = describeSource();
    $('#data-provenance').hidden = false;
    $('#provenance-body').innerHTML = describeProvenance();
    renderSummary();
    renderFeed();
  } catch (error) {
    if (version !== requestVersion || !$('#data-status')) return;
    $('#data-status').innerHTML = `
      <span class="state-dot error"></span><b>Could not load the dataset</b>
      <span class="status-detail">${esc(error.message)}</span>`;
    $('#data-provenance').hidden = true;
    $('#detail').innerHTML = '<div class="empty-state">Nothing loaded. Reload the page to try again.</div>';
    $('#count').textContent = '—';
  }
}

const MODE_LABELS = {
  cached: 'Real filings',
  sample: 'Made-up example',
};

const dateRange = (values) => {
  const sorted = values.filter(Boolean).sort();
  return sorted.length ? [sorted[0], sorted.at(-1)] : null;
};
const day = (timestamp) => (timestamp ? String(timestamp).slice(0, 10) : 'not recorded');

/** One short line for the status bar: which data, how much, and the analysis check. */
function describeSource() {
  const { verification } = analysis;
  if (mode === 'sample') {
    return `<span class="state-dot warn"></span><b>Made-up example</b>
      <span class="status-detail">Invented for testing &middot; not a real filing</span>`;
  }
  const filed = dateRange(dataset.transactions.map((t) => t.filing_date));
  const agree = verification.matched === verification.total && !verification.mismatches.length;
  return `<span class="state-dot ${agree ? 'ok' : 'warn'}"></span><b>Real filings</b>
    <span class="status-detail">${dataset.transactions.length.toLocaleString('en-US')} insider filings from
      ${filed[0]} to ${filed[1]} &middot; last downloaded ${day(dataset.latest_record_retrieval)}</span>
    <span class="status-meta">${
      agree
        ? `Scores recalculated in your browser &middot; all ${verification.total} match the original Python program`
        : `Your browser's scores differ from the Python program for ${verification.total - verification.matched} of ${verification.total} purchases`
    }</span>`;
}

/** Provenance and limitations, kept out of the status line. */
function describeProvenance() {
  if (mode === 'sample') {
    return `<p>A tiny made-up example from the project's tests. The company and the person are invented,
      so there is no real filing to link to and no past performance to show.</p>`;
  }
  const p = dataset.provenance ?? {};
  const prices = (dataset.price_downloads ?? [])
    .map((d) => `${esc(d.ticker)} ${esc(d.start_date)}&ndash;${esc(d.end_date)}`)
    .join(', ');
  const downloaded = dateRange((dataset.price_downloads ?? []).map((d) => day(d.downloaded_at)));
  return `
    <p><b>Where it's from.</b> Real SEC filings, downloaded with the original Python program and saved
      with this site on ${esc(day(p.exported_at))}. Nothing newer than ${esc(day(dataset.latest_record_retrieval))} is included.</p>
    <p><b>What your browser does.</b> It loads the saved filings and recalculates every purchase, group and score itself
      (the same rules as the Python program). The filters on the left only change what you see, not the results.</p>
    <p><b>What it doesn't do.</b> It never contacts the SEC or a stock-price service. The "how did it do afterwards"
      numbers (${dataset.backtests.length} of them, using prices downloaded ${downloaded ? `${downloaded[0]} to ${downloaded[1]}` : 'earlier'})
      were worked out ahead of time by the Python program. To get fresh data, run the project from GitHub.</p>
    <p><b>Fine print.</b> ${(dataset.limitations ?? []).map(esc).join('; ')}. Source database fingerprint
      <code class="hash">${esc((p.sha256 ?? 'not recorded').slice(0, 16))}&hellip;</code>${prices ? `; prices: ${prices}` : ''}.</p>`;
}

/** Aggregate view of every stored backtest result, per holding period. */
function renderSummary() {
  const node = $('#results-summary');
  if (!analysis.summaries.length) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.innerHTML = `
    <div class="analysis-heading">
      <h3>How these purchases did afterwards, overall</h3>
      <span class="badge">${dataset.backtests.length} RESULTS &middot; ${new Set(dataset.backtests.map((b) => b.source_filing)).size} PURCHASES</span>
    </div>
    <p class="muted">The stock's price change after each purchase became public, compared with the S&amp;P 500 (SPY)
      over the same days. A small sample, so treat it as a curiosity, not a prediction.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Held for</th><th>Purchases</th><th>Avg stock</th><th>Avg S&amp;P 500</th><th>Avg difference</th><th>Typical difference</th><th>Beat the market</th></tr></thead>
        <tbody>
          ${analysis.summaries
            .map(
              (s) => `
            <tr>
              <td>${s.days}d</td>
              <td>${s.count}</td>
              <td>${pct(s.average_stock_return)}</td>
              <td>${pct(s.average_benchmark_return)}</td>
              <td>${pct(s.average_excess_return)}</td>
              <td>${pct(s.median_excess_return)}</td>
              <td>${Math.round(s.win_rate_vs_benchmark * 100)}%</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

// -- feed ------------------------------------------------------------------

function currentFilters() {
  return {
    q: $('#search').value,
    start: $('#start').value,
    end: $('#end').value,
    code: $('#code').value,
    show: $('#show').value,
    sort: $('#sort').value,
  };
}

function renderFeed() {
  if (!dataset) return;

  const filters = currentFilters();
  const list = $('#filing-list');

  if (filters.start && filters.end && filters.start > filters.end) {
    list.innerHTML = '<p role="alert">The start date must be on or before the end date.</p>';
    $('#count').textContent = '—';
    return;
  }

  let rows = filterRows(dataset.transactions, filters);
  if (filters.show !== 'all') {
    rows = rows.filter((r) => {
      const signal = signalByFiling.get(r.source_filing);
      // A signal exists per filing; only the rows that passed the filter qualify.
      if (!signal || !isOpenMarketPurchase(r)) return false;
      return filters.show === 'qualifying' || signal.cluster_size >= analysis.rules.minimum_insiders;
    });
  }
  rows = sortRows(rows, filters.sort, (r) => signalByFiling.get(r.source_filing)?.score ?? -1);
  $('#count').textContent = `${rows.length.toLocaleString('en-US')} ROWS`;

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
  more.hidden = rows.length <= visible;
  more.onclick = () => {
    visible += PAGE_SIZE;
    renderFeed();
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
      ${rowSignal(row)}
    </button>`;
}

function rowSignal(row) {
  const signal = signalByFiling.get(row.source_filing);
  if (!signal || !isOpenMarketPurchase(row)) return '';
  const cluster = signal.cluster_size >= analysis.rules.minimum_insiders ? ` &middot; ${signal.cluster_size}-insider cluster` : '';
  return `<span class="row-signal">Qualifying &middot; score ${signal.score}${cluster}</span>`;
}

// -- detail ----------------------------------------------------------------

function renderDetail(row) {
  const panel = $('#detail');
  if (!row) {
    panel.innerHTML =
      '<div class="empty-state">Select another search or date range to explore available records.</div>';
    return;
  }

  const signal = signalByFiling.get(row.source_filing);
  const related = signal ? signal.related_filings.map((id) => signalByFiling.get(id)).filter(Boolean) : [];
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
      <h3>Who else was buying</h3>
      <span class="badge">${
        signal
          ? `${signal.cluster_size} DISTINCT NAME${signal.cluster_size === 1 ? '' : 'S'}`
          : 'NO QUALIFYING SIGNAL'
      }</span>
    </div>
    ${
      signal
        ? `
      <p class="muted">${signal.cluster_size >= analysis.rules.minimum_insiders ? 'Qualifying cluster' : 'Isolated qualifying purchase'} &middot; within ${analysis.rules.window_days} days of this purchase, disclosed on or before ${signal.filing_date}. Computed in your browser over the whole dataset.</p>
      <p class="muted">Insiders counted: ${signal.cluster_insiders.map(esc).join(', ')}</p>
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
        <div><span class="eyebrow">SIMPLE RULE SCORE</span><strong>${signal.score}<small> points</small></strong></div>
        <ul>${signal.score_breakdown.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>`
        : '<p class="muted">This filing produced no qualifying purchase signal. A signal requires code P, non-derivative shares acquired, positive shares and price, and a known transaction date.</p>'
    }
    <details>
      <summary>How the original cluster and score work</summary>
      <p>Purchase rows are combined per filing. A cluster requires at least two distinct insider names within ±14 calendar days of the selected purchase; only filings disclosed on or before its filing date count. Repeated purchases by one exact name count once. Same-day disclosure order and changes in name spelling are not resolved. Related activity may fall outside your explorer filters. Counts cover only the filings in this dataset; companies and dates that were not collected are invisible to it.</p>
      <p>Code path: filters.filter_open_market_purchases → combine_purchases_into_signals → clusters.assign_cluster_sizes → scoring.score_signals, ported to <code>src/insider/analysis.js</code> and run in a Web Worker. Points are research rules, not probabilities or recommendations. Minimum purchase value: $0, after requiring positive shares and price.</p>
    </details>`;
}

function renderBacktests(backtests) {
  return `
    <div class="analysis-heading">
      <h3>How the stock did afterwards</h3>
      <span class="badge">${backtests.length ? 'STORED RESULTS' : 'UNAVAILABLE'}</span>
    </div>
    ${
      backtests.length
        ? `
      <p class="muted">${new Set(backtests.map((b) => b.source_filing)).size} signal &middot; ${backtests.length} holding periods &middot; ${backtests.map((b) => b.entry_date).sort()[0]} to ${backtests.map((b) => b.exit_date).sort().at(-1)} &middot; benchmark SPY</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Held for</th><th>Bought &#8594; sold</th><th>Stock</th><th>S&amp;P 500</th><th>Difference</th></tr></thead>
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
    <p class="muted small">Worked out ahead of time by the Python program. To calculate new ones, run the project from GitHub.</p>
    <details>
      <summary>Entry assumptions, data &amp; research limitations</summary>
      <p>Yahoo Finance adjusted closes, cached by the original PriceLoader. Entry uses the first available trading day after disclosure; exit rolls forward from entry + 7, 30, or 90 calendar days. Prices roll forward at most seven days. Missing and future prices are skipped. The benchmark lookup can independently roll forward when a same-day SPY price is absent.</p>
      <p>No commissions, spread, slippage, taxes, significance testing, or portfolio sizing. Hand-selected companies create selection bias; missing delisted prices create survivorship bias. Overlapping signals are not independent. Clusters use disclosure dates, but cannot resolve intraday publication order. Historical returns do not predict future returns.</p>
      <p>Market provider: yfinance / Yahoo Finance, used offline by the original CLI. These stored results were computed by the Python engine, not by this browser; your browser never requests market data.</p>
    </details>`;
}

function codeExplanation(row) {
  const note =
    CODE_NOTES[row.transaction_code] ||
    'The parser preserves this SEC transaction code and its reported amounts; consult the filing for context.';
  return `${note} The transaction date and the date the filing became public are different events.`;
}
