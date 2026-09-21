// InsiderPulse analysis worker.
//
// Downloads a static dataset, re-runs the ported analysis over the FULL
// transaction list, checks the result against the signals the Python engine
// exported, and summarises the stored backtest rows. Parsing ~2 MB of JSON and
// clustering happen here so the page stays responsive while it loads.

import { analyze, compareSignals, summarizePeriod, DEFAULT_RULES } from './analysis.js';

self.onmessage = async ({ data: { id, url } }) => {
  try {
    const response = await fetch(url);
    if (!response.ok) throw Error(`Dataset request failed (${response.status})`);
    const dataset = await response.json();

    const rules = dataset.rules ?? DEFAULT_RULES;
    const signals = analyze(dataset.transactions, rules);
    const verification = compareSignals(signals, dataset.signals ?? []);

    const periods = [...new Set((dataset.backtests ?? []).map((b) => b.holding_period_days))].sort((a, b) => a - b);
    const summaries = periods.map((days) => ({
      days,
      ...summarizePeriod(dataset.backtests.filter((b) => b.holding_period_days === days)),
    }));

    // The browser-computed signals replace the exported ones for display;
    // `verification` records whether the two agreed.
    postMessage({ id, ok: true, dataset: { ...dataset, signals }, verification, summaries, rules });
  } catch (error) {
    postMessage({ id, ok: false, error: error.message });
  }
};
