import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const report=[];const errors=[];
const page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>errors.push(e.message));
await fs.mkdir('docs/screenshots',{recursive:true});
try {
 await page.goto('http://127.0.0.1:5173');await page.screenshot({path:'docs/screenshots/home-desktop.png'});
 await page.getByRole('link',{name:'Explore InsiderPulse'}).click();await page.locator('.filing-row').first().waitFor();
 assert.match(await page.locator('#data-status').innerText(),/CACHED/);
 await page.locator('#search').fill('UNH');await page.locator('#start').fill('2025-05-01');await page.locator('#end').fill('2025-05-31');await page.locator('#code').selectOption({value:'P'});
 await page.getByRole('button').filter({hasText:'HEMSLEY STEPHEN J'}).first().click();
 assert.match(await page.locator('#detail').innerText(),/25,019,019/);
 assert.match(await page.locator('#detail').innerText(),/5 DISTINCT NAMES/);
 assert.match(await page.locator('#detail').innerText(),/Historical backtest/);
 const link=await page.getByRole('link',{name:'SEC filing'}).getAttribute('href');assert.match(link,/https:\/\/www.sec.gov\/Archives\/edgar\/data\//);
 await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:'docs/screenshots/insider-desktop.png'});await page.locator('#detail').screenshot({path:'docs/screenshots/insider-detail.png'});report.push('Real cached filing, verified URL, company/date/code filters, 5-insider cluster, historical results');
 await page.locator('#search').fill('no-company');assert.match(await page.locator('#filing-list').innerText(),/No filings/);report.push('Empty state');
 await page.locator('#search').fill('');await page.locator('#start').fill('');await page.locator('#end').fill('');await page.locator('#code').selectOption('');
 await page.getByRole('button',{name:'Sample fixture',exact:true}).click();await page.locator('#data-status').filter({hasText:'SYNTHETIC'}).waitFor();await page.locator('.filing-row').nth(1).click();assert.match(await page.locator('#detail').innerText(),/Not reported/);assert.equal(await page.getByRole('link',{name:'SEC filing'}).count(),0);report.push('Synthetic sample labeled, missing price preserved, no fabricated SEC link');
 await page.getByRole('button',{name:'Connected backend',exact:true}).click();await page.locator('#data-status').filter({hasText:'Backend connected'}).waitFor();report.push('Real InsiderPulse HTTP adapter connected; cached provenance retained');
 await page.locator('#search').fill('UNH');await page.locator('#start').fill('2025-05-01');await page.locator('#end').fill('2025-05-31');await page.locator('#code').selectOption('P');await page.waitForFunction(()=>document.querySelector('#count').textContent==='5 ROWS');assert.equal(await page.locator('.filing-row').count(),5);report.push('Connected search queries the backend beyond the initial 200-row page');
 await page.locator('#start').fill('2025-06-01');await page.locator('#data-status').filter({hasText:'ERROR'}).waitFor();report.push('Invalid live date range labeled as input error');
 await page.locator('#start').fill('2025-05-01');await page.locator('.filing-row').first().waitFor();
 await page.route('**/insider-api/**',r=>r.fulfill({status:429,contentType:'application/json',body:'{"state":"rate-limited"}'}));await page.locator('#refresh').click();await page.locator('#data-status').filter({hasText:'RATE-LIMITED'}).waitFor();await page.unroute('**/insider-api/**');report.push('Explicit rate-limited frontend state');

 await page.route('**/insider-api/**',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"Test unavailable"}'}));await page.locator('#refresh').click();await page.locator('#data-status').filter({hasText:'UNAVAILABLE'}).waitFor();assert.equal(await page.locator('.filing-row').count(),0);report.push('Backend failure does not substitute sample data');
 await page.unroute('**/insider-api/**');
 await page.goto('http://127.0.0.1:5173/#asterkv');await page.locator('#aster-status').filter({hasText:'3/3'}).waitFor();
 for(const [op,value,expected,out] of [['put','browser-test','',/"success": true/],['get','','',/browser-test/],['cas','updated','browser-test',/"success": true/],['cas','bad','mismatch',/"success": false/],['delete','','',/"success": true/],['get','','',/"found": false/]]){
  await page.locator('#operation').selectOption(op);if(!['get','delete'].includes(op))await page.locator('#value').fill(value);if(op==='cas')await page.locator('#expected').fill(expected);await page.getByRole('button',{name:'Execute command'}).click();await page.getByRole('button',{name:'Execute command'}).waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('"result"'));assert.match(await page.locator('#result').innerText(),out);
 }
 await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:'docs/screenshots/aster-desktop.png'});report.push('Real 3-node AsterKV PUT, GET, CAS success/failure, DELETE, missing GET through browser');
 await page.setViewportSize({width:390,height:844});
 for(const [route,file] of [['asterkv','aster-mobile'],['insiderpulse','insider-mobile'],['home','home-mobile']]){
  await page.goto('http://127.0.0.1:5173/#'+route);if(route==='insiderpulse')await page.locator('.filing-row').first().waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,route+' overflows');
  await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:`docs/screenshots/${file}.png`});
 }
 await page.getByRole('button',{name:/Menu/}).click();assert.equal(await page.locator('#menu').getAttribute('aria-expanded'),'true');await page.locator('#nav').getByRole('link',{name:'InsiderPulse Lab'}).click();await page.waitForFunction(()=>document.querySelector('#menu').getAttribute('aria-expanded')==='false');report.push('390px mobile layouts, no horizontal overflow, navigation opens and closes');
 assert.deepEqual(errors,[]);report.push('No browser JavaScript errors');
 await fs.writeFile('docs/browser-verification.json',JSON.stringify({passed:report},null,2));console.log(report.join('\n'));
}catch(e){console.log(await page.locator('#code').count()?await page.locator('#code').innerHTML():'no code select');await page.screenshot({path:'docs/screenshots/failure.png'});throw e;}finally {await browser.close();}
