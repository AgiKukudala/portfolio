// End-to-end check of the STATIC production build.
//
//   npm run build
//   python3 -m http.server 4173 --bind 127.0.0.1 --directory dist   # any static server
//   node scripts/browser-check.mjs [http://127.0.0.1:4173]
//
// No Python or Go service is needed; the script fails if the page requests
// one. Uses Playwright's Chromium (npx playwright install chromium) or, if
// CHROME_PATH is set, that browser. Screenshots go to docs/screenshots/.
// A few assertions pin values from the committed dataset (3,390 rows, the
// UNH May 2025 cluster); update them after re-exporting InsiderPulse data.

import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const BASE = process.argv[2] || 'http://127.0.0.1:4173';
const origin = new URL(BASE).origin;
const report = [];
const problems = [];
const ok = (line) => {
  report.push(line);
  console.log(`  ✓ ${line}`);
};

const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
await fs.mkdir('docs/screenshots', { recursive: true });

const requests = [];
page.on('request', (r) => requests.push(r.url()));
page.on('response', (r) => {
  if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`);
});
page.on('requestfailed', (r) => {
  // Google Fonts may be unreachable in a sandbox; that is cosmetic.
  if (!r.url().includes('fonts.g')) problems.push(`request failed ${r.url()}: ${r.failure()?.errorText}`);
});
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('fonts.g')) problems.push(`console error: ${m.text()}`);
});

const text = (sel) => page.locator(sel).innerText();
const workers = () => page.workers().length;
async function waitFor(fn, timeout = 20000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeout) throw Error(`timed out waiting for ${what}`);
    await page.waitForTimeout(100);
  }
}

try {
  // -- portfolio pages ------------------------------------------------------
  console.log('Portfolio');
  await page.goto(`${BASE}/`);
  await page.locator('#app h1, #app h2').first().waitFor();
  const backend = await page.locator('canvas#water').getAttribute('data-backend');
  ok(`home renders; water canvas present (${backend})`);
  await page.mouse.move(400, 400);
  await page.mouse.move(900, 500, { steps: 12 });
  await page.screenshot({ path: 'docs/screenshots/home-desktop.png' });

  for (const [label, route, marker] of [
    ['Fluid Dynamics', 'fluid', 'h1'],
    ['Resume', 'resume', 'h1'],
    ['Contact', 'contact', 'h1'],
  ]) {
    await page.locator('#nav').getByRole('link', { name: label, exact: true }).click();
    await page.waitForURL(`**/#${route}`);
    await page.locator(`#app ${marker}`).first().waitFor();
    assert.equal(await page.locator('canvas#water').count(), 1, `${route} keeps the water canvas`);
  }
  ok('nav links reach Fluid Dynamics, Resume and Contact; water persists on them');
  const photo = await page.evaluate(async () => (await fetch('/headshot.jpg')).ok);
  assert.ok(photo);
  ok('static assets (headshot) are served');

  // -- InsiderPulse ---------------------------------------------------------
  console.log('InsiderPulse');
  await page.goto(`${BASE}/#insiderpulse`);
  await page.reload(); // a direct link / reload must work without in-app navigation
  await page.locator('#data-status').filter({ hasText: 'Scores recalculated' }).waitFor();
  assert.equal(await page.locator('canvas#water').count(), 0, 'water is torn down on the lab');
  const status = await text('#data-status');
  assert.match(status, /3,390 insider filings from 2024-01-02 to 2026-09-11/);
  assert.match(status, /last downloaded 2026-09-15/);
  assert.match(status, /Scores recalculated in your browser · all 47 match/);
  ok('historical dataset loaded in a worker; 47/47 browser-computed signals match the Python export');

  await page.locator('#code').selectOption('P');
  await page.getByRole('button').filter({ hasText: 'HEMSLEY STEPHEN J' }).first().click();
  const detail = await text('#detail');
  assert.match(detail, /25,019,019/);
  assert.match(detail, /5 DISTINCT NAMES/);
  assert.match(detail, /How the stock did afterwards/);
  assert.match(detail, /STORED RESULTS/);
  const secLink = await page.getByRole('link', { name: /SEC filing/ }).getAttribute('href');
  assert.match(secLink, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//);
  ok('UNH May 2025 purchases: Hemsley filing shows $25,019,019, a 5-insider cluster, stored backtests, SEC link');

  await page.locator('#search').fill('');
  await page.locator('#start').fill('');
  await page.locator('#end').fill('');
  await page.locator('#code').selectOption('');
  await page.locator('#show').selectOption('qualifying');
  const qualifying = await text('#count');
  await page.locator('#show').selectOption('cluster');
  const clustered = await text('#count');
  assert.ok(parseInt(qualifying.replace(/,/g, ''), 10) >= 47);
  assert.ok(parseInt(clustered, 10) > 0 && parseInt(clustered, 10) < parseInt(qualifying, 10));
  await page.locator('#sort').selectOption('score');
  const firstRow = await page.locator('.filing-row').first().innerText();
  assert.match(firstRow, /Qualifying · score \d+ · \d-insider cluster/);
  ok(`explorer views: ${qualifying} qualifying rows, ${clustered} in clusters; score sort works`);

  const summary = await text('#results-summary');
  assert.match(summary, /135 RESULTS · 47 PURCHASES/);
  ok('aggregate table of all 135 stored historical results');

  await page.locator('#show').selectOption('all');
  await page.locator('#search').fill('no-such-company');
  assert.match(await text('#filing-list'), /No filings match/);
  ok('empty state');

  await page.locator('[data-mode=sample]').click();
  await page.locator('#data-status').filter({ hasText: 'Invented for testing' }).waitFor();
  await page.locator('.filing-row').nth(1).click();
  assert.match(await text('#detail'), /Not reported/);
  assert.equal(await page.getByRole('link', { name: /SEC filing/ }).count(), 0);
  ok('synthetic sample is labelled, keeps missing values, and has no SEC link');
  await page.locator('[data-mode=cached]').click();
  await page.locator('#data-status').filter({ hasText: 'Scores recalculated' }).waitFor();
  await page.screenshot({ path: 'docs/screenshots/insiderpulse.png', fullPage: false });

  // -- AsterKV --------------------------------------------------------------
  console.log('AsterKV');
  await page.goto(`${BASE}/#asterkv`);
  await page.locator('#aster-status').filter({ hasText: 'Browser simulation' }).waitFor();
  await waitFor(async () => workers() === 3, 10000, 'three node workers');
  ok('three node workers started');

  const roles = () => page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('.sim-card')].map((c) => [c.dataset.node, c.className.replace('sim-card ', '')]),
  ));
  const leaderId = async () => Object.entries(await roles()).find(([, r]) => r.startsWith('leader'))?.[0];
  await waitFor(async () => !!(await leaderId()), 15000, 'a leader');
  const first = await leaderId();
  ok(`${first} elected leader`);

  async function run(op, fields = {}, target = 'auto') {
    await page.locator('.op-card', { has: page.locator(`input[value=${op}]`) }).click();
    assert.equal(await page.locator(`input[name=operation][value=${op}]`).isChecked(), true);
    for (const [id, value] of Object.entries(fields)) await page.locator(`#${id}`).fill(value);
    await page.locator('#target').selectOption(target);
    await page.locator('#submit').click();
    await page.locator('#outcome:not(.pending)').waitFor({ timeout: 20000 });
    return text('#outcome');
  }
  const card = (id) => page.locator(`.sim-card[data-node="${id}"]`);
  const indexes = async (id) => Promise.all(['last', 'commit', 'applied'].map(async (f) => Number(await card(id).locator(`[data-f="${f}"]`).innerText())));

  assert.match(await run('put', { key: 'greeting', value: 'hello' }), /Saved[\s\S]*Committed at log index/);
  assert.match(await run('get', { key: 'greeting' }), /Found it[\s\S]*hello/);
  assert.match(await run('cas', { key: 'greeting', expected: 'hello', value: 'hi' }), /Swapped/);
  assert.match(await run('cas', { key: 'greeting', expected: 'hello', value: 'nope' }), /Left unchanged[\s\S]*holds hi/);
  assert.match(await run('delete', { key: 'greeting' }), /Deleted/);
  assert.match(await run('get', { key: 'greeting' }), /Nothing there/);
  ok('PUT, GET, CAS success, CAS failure, DELETE, missing GET all committed through the log');
  await page.screenshot({ path: 'docs/screenshots/asterkv.png' });

  const follower = ['node1', 'node2', 'node3'].find((id) => id !== first);
  await card(follower).getByRole('button', { name: 'Stop' }).click();
  assert.equal(workers(), 2, 'stopping a node terminates its worker');
  assert.match(await run('put', { key: 'k1', value: 'while-down' }), /Saved/);
  await card(follower).getByRole('button', { name: 'Restart' }).click();
  await waitFor(async () => {
    const [f, l] = [await indexes(follower), await indexes(first)];
    return f[2] > 0 && f[2] === l[2] && f[0] === l[0];
  }, 15000, 'follower catch-up');
  assert.match(await card(follower).locator('[data-f="kv"]').innerText(), /k1 = while-down/);
  ok(`${follower} stopped (worker terminated), missed a write, restarted and caught up`);

  await card(first).getByRole('button', { name: 'Stop' }).click();
  await waitFor(async () => { const l = await leaderId(); return l && l !== first; }, 20000, 'a new leader');
  const second = await leaderId();
  assert.match(await run('put', { key: 'k2', value: 'after-failover' }), /Saved/);
  assert.match(await run('get', { key: 'k1' }), /while-down/);
  ok(`leader ${first} stopped; ${second} elected; old writes kept and new writes commit`);

  const third = ['node1', 'node2', 'node3'].find((id) => id !== first && id !== second);
  await card(third).getByRole('button', { name: 'Stop' }).click();
  const noQuorum = await run('put', { key: 'k3', value: 'no-majority' });
  assert.match(noQuorum, /No confirmation: outcome unknown/);
  assert.equal(await page.locator('#retry').isVisible(), true);
  ok('with two of three nodes stopped, a write times out and is not reported as saved');

  await card(first).getByRole('button', { name: 'Restart' }).click();
  await card(third).getByRole('button', { name: 'Restart' }).click();
  await waitFor(async () => !!(await leaderId()), 20000, 'recovery');
  assert.match(await run('get', { key: 'k2' }), /after-failover/);
  assert.match(await run('get', { key: 'k1' }), /while-down/);
  ok('majority restored: cluster recovers and every acknowledged write is still readable');

  // Isolated old leader cannot confirm writes.
  const isolatedLeader = await leaderId();
  await card(isolatedLeader).getByRole('button', { name: 'Isolate' }).click();
  const stale = await run('put', { key: 'k4', value: 'stale' }, isolatedLeader);
  assert.match(stale, /No confirmation/);
  await card(isolatedLeader).getByRole('button', { name: 'Reconnect' }).click();
  await waitFor(async () => { const l = await leaderId(); return l && !(await roles())[isolatedLeader].startsWith('leader'); }, 20000, 'old leader stepping down');
  assert.match(await run('get', { key: 'k2' }), /after-failover/);
  ok(`isolated leader ${isolatedLeader} could not confirm a write; after reconnecting it stepped down`);

  await page.locator('#cluster-reset').click();
  await waitFor(async () => workers() === 3, 5000, 'workers after reset');
  await waitFor(async () => !!(await leaderId()), 15000, 'leader after reset');
  assert.match(await run('get', { key: 'k2' }), /Nothing there/);
  ok('reset replaces all three workers and clears state');

  // -- lifecycle ------------------------------------------------------------
  console.log('Lifecycle');
  for (let i = 0; i < 3; i++) {
    await page.goto(`${BASE}/#home`);
    await waitFor(async () => workers() === 0, 5000, 'workers to close on leaving');
    await page.goto(`${BASE}/#asterkv`);
    await waitFor(async () => workers() === 3, 5000, 'workers on return');
  }
  await page.evaluate(() => { location.hash = '#projects'; });
  await waitFor(async () => workers() === 0, 5000, 'workers to close after in-app navigation');
  ok('navigating away terminates all workers; repeated visits never exceed 3');

  // -- network --------------------------------------------------------------
  const backendCalls = requests.filter((u) => /insider-api|aster-api|:8010|:8011|sec\.gov\/cgi|data\.sec\.gov|yahoo/i.test(u));
  assert.deepEqual(backendCalls, [], 'no backend, SEC or market-data requests');
  const foreign = [...new Set(requests.map((u) => new URL(u).origin))].filter((o) => o !== origin);
  assert.ok(foreign.every((o) => /fonts\.(googleapis|gstatic)\.com$/.test(o)), `unexpected origins: ${foreign}`);
  ok(`no backend calls; only other origins: ${foreign.join(', ') || 'none'}`);

  // -- mobile ---------------------------------------------------------------
  console.log('Mobile');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['home', 'projects', 'insiderpulse', 'asterkv', 'fluid', 'resume', 'contact']) {
    await page.goto(`${BASE}/#${route}`);
    if (route === 'insiderpulse') await page.locator('.filing-row').first().waitFor();
    if (route === 'asterkv') await waitFor(async () => !!(await leaderId()), 15000, 'mobile leader');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 0, `${route} overflows by ${overflow}px`);
    const shot = { home: 'mobile-home', insiderpulse: 'mobile-insider', asterkv: 'mobile-asterkv' }[route];
    if (shot) await page.screenshot({ path: `docs/screenshots/${shot}.png` });
  }
  await page.goto(`${BASE}/#home`);
  await page.locator('#menu').click();
  assert.equal(await page.locator('#menu').getAttribute('aria-expanded'), 'true');
  ok('mobile: no horizontal overflow on any route; menu opens');

  // -- reduced motion -------------------------------------------------------
  const reduced = await browser.newPage({ reducedMotion: 'reduce', viewport: { width: 1200, height: 900 } });
  reduced.on('pageerror', (e) => problems.push(`reduced-motion page error: ${e.message}`));
  await reduced.goto(`${BASE}/#asterkv`);
  await reduced.waitForTimeout(2500);
  assert.equal(await reduced.locator('#sim-packets circle').count(), 0);
  await reduced.close();
  ok('reduced motion: message dots are not animated');

  assert.deepEqual(problems, [], 'console, network and page errors');
  ok('no console errors, failed requests or missing assets');
  await fs.writeFile('docs/browser-verification.json', `${JSON.stringify({ base: BASE, checked: report }, null, 2)}\n`);
  console.log(`\nAll ${report.length} checks passed.`);
} catch (error) {
  console.error('\nFAILED:', error.message);
  if (problems.length) console.error(problems.join('\n'));
  await page.screenshot({ path: 'test-results/browser-check-failure.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
