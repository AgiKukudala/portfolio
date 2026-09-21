// JavaScript port of the InsiderPulse analysis pipeline.
//
// Mirrors, function for function, the original Python engine in
// vendor/insiderpulse/insiderpulse/:
//
//   filters.is_open_market_purchase      -> isOpenMarketPurchase
//   filters.combine_purchases_into_signals -> combinePurchasesIntoSignals
//   clusters.find_cluster_insiders       -> findClusterInsiders
//   clusters.assign_cluster_sizes        -> assignClusterSizes
//   scoring.score_purchase               -> scorePurchase
//   lab_api.snapshot (enrichment)        -> analyze
//
// The rules come from the dataset's own `rules` block (exported from
// config.py), so a re-export with changed rules is honoured without editing
// this file. Pure functions only: no DOM, no fetch, safe inside a Worker and
// under node --test.
//
// Always call analyze() with the FULL transaction list. Cluster sizes depend
// on every other purchase of the same ticker, so running it on a filtered
// subset would silently change scores.

export const DEFAULT_RULES = {
  window_days: 14,
  minimum_insiders: 2,
  minimum_value: 0,
  role_points: { CEO: 3, CFO: 2, Officer: 2, Director: 1, '10% Owner': 0, Other: 0 },
  size_points: [[1_000_000, 3], [500_000, 2], [100_000, 1]],
  cluster_bonus: 3,
};

const DAY_MS = 86_400_000;

/** ISO date string (YYYY-MM-DD) -> whole days since the epoch, in UTC. */
export function dayNumber(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** filters.is_open_market_purchase: every rule must pass. */
export function isOpenMarketPurchase(t) {
  if (t.transaction_code !== 'P') return false;
  if (t.is_derivative) return false;
  if (t.acquired_or_disposed !== 'A') return false;
  if (t.shares == null || !(t.shares > 0)) return false;
  if (t.price_per_share == null || !(t.price_per_share > 0)) return false;
  if (t.transaction_date == null) return false;
  return true;
}

/** Group purchase rows by filing; one signal per filing, sorted like the original. */
export function combinePurchasesIntoSignals(purchases) {
  const rowsByFiling = new Map();
  for (const p of purchases) {
    if (!rowsByFiling.has(p.source_filing)) rowsByFiling.set(p.source_filing, []);
    rowsByFiling.get(p.source_filing).push(p);
  }

  const signals = [];
  for (const [filingId, rows] of rowsByFiling) {
    const totalShares = pythonSum(rows.map((r) => r.shares));
    const totalValue = pythonSum(rows.map((r) => r.shares * r.price_per_share));
    const first = rows[0];
    signals.push({
      ticker: first.ticker,
      company_name: first.company_name,
      insider_name: first.insider_name,
      insider_role: first.insider_role,
      transaction_date: rows.reduce((a, r) => (r.transaction_date > a ? r.transaction_date : a), rows[0].transaction_date),
      filing_date: first.filing_date,
      shares: totalShares,
      average_price: totalValue / totalShares,
      total_value: totalValue,
      source_filing: filingId,
      cluster_size: 1,
      score: 0,
      score_breakdown: [],
    });
  }

  // Array.prototype.sort is stable, matching Python's list.sort.
  signals.sort((a, b) =>
    cmp(a.filing_date, b.filing_date) || cmp(a.ticker, b.ticker) || cmp(a.source_filing, b.source_filing),
  );
  return signals;
}

/**
 * Python's built-in sum() over floats. Since CPython 3.12 it uses Neumaier
 * compensated summation, so a naive left-to-right reduce can differ in the
 * last bit (10045534.1 vs 10045534.099999998 in the real dataset). Porting
 * the exact algorithm keeps totals, averages and score text bit-identical.
 */
export function pythonSum(values) {
  let total = 0;
  let compensation = 0;
  for (const x of values) {
    const t = total + x;
    if (Math.abs(total) >= Math.abs(x)) compensation += total - t + x;
    else compensation += x - t + total;
    total = t;
  }
  return compensation !== 0 && Number.isFinite(compensation) ? total + compensation : total;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Peers of `signal` that count toward its cluster: same ticker, already public
 * on its filing date, and traded within ±windowDays of it.
 */
function clusterPeers(signal, sameTicker, windowDays) {
  const day = dayNumber(signal.transaction_date);
  return sameTicker.filter(
    (other) =>
      other.filing_date <= signal.filing_date &&
      Math.abs(dayNumber(other.transaction_date) - day) <= windowDays,
  );
}

/** clusters.find_cluster_insiders: distinct names, including the signal's own. */
export function findClusterInsiders(signal, sameTicker, windowDays) {
  const names = new Set([signal.insider_name]);
  for (const other of clusterPeers(signal, sameTicker, windowDays)) names.add(other.insider_name);
  return names;
}

function groupByTicker(signals) {
  const byTicker = new Map();
  for (const s of signals) {
    if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, []);
    byTicker.get(s.ticker).push(s);
  }
  return byTicker;
}

export function assignClusterSizes(signals, windowDays) {
  const byTicker = groupByTicker(signals);
  for (const s of signals) s.cluster_size = findClusterInsiders(s, byTicker.get(s.ticker), windowDays).size;
}

/**
 * Python's f"{value:,.0f}". Python rounds the exact binary value and breaks
 * exact .5 ties to even; Number#toFixed breaks them upward. Only exact ties
 * differ, so handle those explicitly.
 */
export function formatWholeDollars(value) {
  const floor = Math.floor(value);
  const frac = value - floor;
  const rounded = frac > 0.5 ? floor + 1 : frac < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
  const sign = rounded < 0 ? '-' : '';
  return sign + String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** scoring.score_purchase: role + size + cluster bonus, one explanation line per rule. */
export function scorePurchase(signal, clusterSize, rules = DEFAULT_RULES) {
  const breakdown = [];

  const rolePoints = rules.role_points[signal.insider_role] ?? 0;
  breakdown.push(`${signal.insider_role} purchase: +${rolePoints}`);

  let sizePoints = 0;
  for (const [threshold, points] of rules.size_points) {
    if (signal.total_value >= threshold) {
      sizePoints = points;
      break;
    }
  }
  breakdown.push(`$${formatWholeDollars(signal.total_value)} purchase: +${sizePoints}`);

  const clusterPoints = clusterSize >= rules.minimum_insiders ? rules.cluster_bonus : 0;
  if (clusterPoints > 0) {
    breakdown.push(`${clusterSize} insiders buying within ${rules.window_days} days: +${clusterPoints}`);
  }

  return { total: rolePoints + sizePoints + clusterPoints, breakdown };
}

/**
 * The whole pipeline, as lab_api.analyze + lab_api.snapshot run it:
 * filter -> combine -> cluster -> score, then attach the cluster's insider
 * names and the related filings shown in the UI.
 *
 * `transactions` must be the full dataset. Rows are put back into
 * database.load_transactions order (filing_date, source_filing, line_number)
 * first, because "first row of the filing" and summation order depend on it.
 */
export function analyze(transactions, rules = DEFAULT_RULES) {
  const ordered = [...transactions].sort(
    (a, b) =>
      cmp(a.filing_date, b.filing_date) || cmp(a.source_filing, b.source_filing) || a.line_number - b.line_number,
  );
  const purchases = ordered.filter(isOpenMarketPurchase);
  let signals = combinePurchasesIntoSignals(purchases);
  if (rules.minimum_value > 0) signals = signals.filter((s) => s.total_value >= rules.minimum_value);

  assignClusterSizes(signals, rules.window_days);
  for (const s of signals) {
    const result = scorePurchase(s, s.cluster_size, rules);
    s.score = result.total;
    s.score_breakdown = result.breakdown;
  }

  const byTicker = groupByTicker(signals);
  return signals.map((s) => {
    const peers = byTicker.get(s.ticker);
    return {
      ...s,
      cluster_insiders: [...findClusterInsiders(s, peers, rules.window_days)].sort(),
      related_filings: clusterPeers(s, peers, rules.window_days).map((p) => p.source_filing),
    };
  });
}

/**
 * Compare browser-computed signals with the ones the Python engine exported.
 * Returns { matched, total, mismatches: [{source_filing, field}] }.
 */
export function compareSignals(computed, reference) {
  const FIELDS = [
    'ticker', 'insider_name', 'insider_role', 'transaction_date', 'filing_date', 'shares',
    'average_price', 'total_value', 'cluster_size', 'score', 'score_breakdown',
    'cluster_insiders', 'related_filings',
  ];
  const mismatches = [];
  const byId = new Map(reference.map((s) => [s.source_filing, s]));
  const seen = new Set();
  computed.forEach((c, i) => {
    const r = byId.get(c.source_filing);
    if (!r) return mismatches.push({ source_filing: c.source_filing, field: 'missing from reference' });
    seen.add(c.source_filing);
    if (reference[i]?.source_filing !== c.source_filing) mismatches.push({ source_filing: c.source_filing, field: 'order' });
    for (const f of FIELDS) {
      if (!(f in r)) continue; // older exports omit the enrichment fields
      if (JSON.stringify(c[f]) !== JSON.stringify(r[f])) mismatches.push({ source_filing: c.source_filing, field: f });
    }
  });
  for (const r of reference) {
    if (!seen.has(r.source_filing)) mismatches.push({ source_filing: r.source_filing, field: 'missing from browser result' });
  }
  const bad = new Set(mismatches.map((m) => m.source_filing));
  return { matched: reference.filter((r) => !bad.has(r.source_filing)).length, total: reference.length, mismatches };
}

/**
 * Descriptive summary of stored backtest rows for one holding period, the
 * same statistics analytics.summarize_period reports. No significance claims.
 */
export function summarizePeriod(rows) {
  if (!rows.length) return null;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const stock = rows.map((r) => r.stock_return);
  const excess = rows.map((r) => r.benchmark_adjusted_return);
  return {
    count: rows.length,
    average_stock_return: mean(stock),
    average_benchmark_return: mean(rows.map((r) => r.benchmark_return)),
    average_excess_return: mean(excess),
    median_stock_return: median(stock),
    median_excess_return: median(excess),
    win_rate_vs_benchmark: excess.filter((x) => x > 0).length / rows.length,
    positive_return_rate: stock.filter((x) => x > 0).length / rows.length,
  };
}
