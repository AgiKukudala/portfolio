import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  analyze, compareSignals, summarizePeriod, pythonSum, formatWholeDollars, isOpenMarketPurchase, DEFAULT_RULES,
} from '../src/insider/analysis.js';

const load = (name) => JSON.parse(fs.readFileSync(new URL(`../public/${name}`, import.meta.url)));
const cache = load('insider-cache.json');
const sample = load('insider-sample.json');

// Some tests pin reference values from the dataset committed on 2026-09-20.
// After a re-export they are skipped; the engine-equivalence test still runs.
const PINNED = cache.provenance?.sha256?.startsWith('72158ec86999f91f');
const pinned = PINNED ? {} : { skip: 'dataset was re-exported; pinned reference values no longer apply' };

test('browser analysis reproduces every signal the Python engine exported', () => {
  const signals = analyze(cache.transactions, cache.rules);
  const check = compareSignals(signals, cache.signals);
  assert.deepEqual(check.mismatches, []);
  assert.equal(check.matched, cache.signals.length);
  assert.equal(signals.length, cache.signals.length);
  if (PINNED) assert.equal(signals.length, 47);
});

test('the exported rules are the ones in config.py', pinned, () => {
  assert.deepEqual(cache.rules, DEFAULT_RULES);
});

test('row order in the file does not matter', () => {
  const shuffled = [...cache.transactions].reverse();
  assert.deepEqual(compareSignals(analyze(shuffled, cache.rules), cache.signals).mismatches, []);
});

test('synthetic sample: one signal, missing price row excluded', () => {
  const signals = analyze(sample.transactions);
  assert.deepEqual(compareSignals(signals, sample.signals).mismatches, []);
  assert.equal(signals[0].shares, 1000, 'the 500-share row without a price does not qualify');
});

test('clusters depend on the whole dataset, which is why filters never feed the analysis', pinned, () => {
  const full = analyze(cache.transactions).find((s) => s.insider_name === 'HEMSLEY STEPHEN J' && s.filing_date === '2025-05-16');
  assert.equal(full.cluster_size, 5);
  assert.equal(full.score, 9);
  assert.deepEqual(full.score_breakdown, ['CEO purchase: +3', '$25,019,019 purchase: +3', '5 insiders buying within 14 days: +3']);
  // What a filtered analysis would wrongly report:
  const onlyHim = cache.transactions.filter((t) => t.insider_name === 'HEMSLEY STEPHEN J');
  assert.equal(analyze(onlyHim).find((s) => s.source_filing === full.source_filing).cluster_size, 1);
});

test('eligibility rules match filters.is_open_market_purchase', () => {
  const base = { transaction_code: 'P', is_derivative: false, acquired_or_disposed: 'A', shares: 10, price_per_share: 5, transaction_date: '2025-01-01' };
  assert.equal(isOpenMarketPurchase(base), true);
  for (const change of [
    { transaction_code: 'A' }, { is_derivative: true }, { acquired_or_disposed: 'D' }, { shares: 0 }, { shares: null },
    { price_per_share: 0 }, { price_per_share: null }, { transaction_date: null },
  ]) assert.equal(isOpenMarketPurchase({ ...base, ...change }), false, JSON.stringify(change));
});

test('cluster window: disclosed later never counts; ±14 calendar days inclusive', () => {
  const row = (name, tdate, fdate, filing) => ({
    company_name: 'X', ticker: 'X', insider_name: name, insider_role: 'Director', transaction_date: tdate, filing_date: fdate,
    transaction_code: 'P', is_derivative: false, acquired_or_disposed: 'A', shares: 1, price_per_share: 1, source_filing: filing, line_number: 0,
  });
  const signals = analyze([
    row('A', '2025-01-15', '2025-01-16', 'f1'),
    row('B', '2025-01-01', '2025-01-02', 'f2'), // exactly 14 days before
    row('C', '2024-12-31', '2025-01-02', 'f3'), // 15 days before
    row('D', '2025-01-15', '2025-01-17', 'f4'), // disclosed after A
  ]);
  const a = signals.find((s) => s.source_filing === 'f1');
  assert.deepEqual(a.cluster_insiders, ['A', 'B']);
  const d = signals.find((s) => s.source_filing === 'f4');
  assert.deepEqual(d.cluster_insiders, ['A', 'B', 'D']);
});

test('Python numeric semantics: compensated sum and round-half-even formatting', () => {
  // Real rows from filing 0001001250-24-000235; a naive reduce gives 10045534.099999998.
  assert.equal(pythonSum([51680 * 63.18, 27320 * 63.71, 58771 * 64.49, 19229 * 64.99]), 10045534.1);
  assert.equal(formatWholeDollars(2.5), '2');
  assert.equal(formatWholeDollars(3.5), '4');
  assert.equal(formatWholeDollars(1234567.5), '1,234,568');
  assert.equal(formatWholeDollars(130082.99999999999), '130,083');
});

test('summary statistics match analytics.summarize_period on the stored results', pinned, () => {
  // Reference values printed by the original pandas code for the same file.
  const python = {
    7: { count: 47, average_excess_return: -0.0015853116314395496, median_excess_return: -0.00038314218337535955, win_rate_vs_benchmark: 0.48936170212765956 },
    30: { count: 46, average_excess_return: -0.01070166804723049, median_excess_return: -0.009204905030992189, win_rate_vs_benchmark: 0.4782608695652174 },
    90: { count: 42, average_excess_return: -0.05948724349040373, median_excess_return: -0.07180766129302726, win_rate_vs_benchmark: 0.2619047619047619 },
  };
  for (const [days, expected] of Object.entries(python)) {
    const got = summarizePeriod(cache.backtests.filter((b) => b.holding_period_days === Number(days)));
    assert.equal(got.count, expected.count);
    for (const key of ['average_excess_return', 'median_excess_return', 'win_rate_vs_benchmark']) {
      assert.ok(Math.abs(got[key] - expected[key]) < 1e-12, `${days}d ${key}`);
    }
  }
});

test('dataset carries provenance and no machine-specific paths', () => {
  assert.equal(cache.provenance.synthetic, false);
  assert.match(cache.latest_record_retrieval, /^\d{4}-\d{2}-\d{2}T/);
  const raw = fs.readFileSync(new URL('../public/insider-cache.json', import.meta.url), 'utf8');
  assert.doesNotMatch(raw, /\/Users\/|\/home\/|C:\\\\/);
});
