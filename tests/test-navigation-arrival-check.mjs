import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createFixtureSite } from './battery/fixtures.mjs';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';

process.env.COPILOT_HEADLESS = '1';
const realFetch = globalThis.fetch;
// The reading model is replaced by a fixed reply; everything else is offline.
const generated = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/api/generate')) {
    generated.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ response: 'The page says it was found there.', done: true }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('offline');
};
console.warn = () => {};
const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

const site = await createFixtureSite();
const browser = await chromium.launch({ headless: true,
  ...(process.env.WC_TEST_CHROMIUM ? { executablePath: process.env.WC_TEST_CHROMIUM } : {}), args: ['--no-sandbox'] });
const byLabel = (obs, label) => obs.actionableElements.find(e => e.label === label);

// A planner that does what a weak model does: it keeps clicking the link to
// the page it is already on instead of saying it is done.
function planner(labels) {
  const calls = [];
  const reasoner = async (_task, obs) => {
    calls.push(obs.url);
    const label = labels[Math.min(calls.length - 1, labels.length - 1)];
    const el = byLabel(obs, label);
    return el ? { ref: el.ref, operation: 'click', value: '' } : { ref: '', operation: 'done', value: '' };
  };
  return { calls, reasoner };
}
async function run(start, instruction, labels) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(site.base + start);
  const p = planner(labels);
  const result = await quiet(() => executeNaturalLanguageTask(page, instruction,
    { urlLess: false, orchestratorOptions: { agentOptions: { maxSteps: 8, reasoner: p.reasoner } } }));
  const out = { result, calls: p.calls, url: page.url() };
  await page.close();
  return out;
}

try {
  // 1. One navigation, then a question: done as soon as the browser shows the page.
  {
    const r = await run('/', 'Open the About page and tell me which city the company was founded in.', ['About']);
    assert.equal(r.result.status, 'answer_ready', JSON.stringify(r.result).slice(0, 300));
    assert.equal(r.calls.length, 1, 'planner must not be asked again once the page is open');
    assert.match(r.url, /\/about$/);
  }
  // 2. Two navigations, then a question: not done after the first, done after the second.
  {
    const r = await run('/', 'Open the Products page, open Gadget, and tell me its price.', ['Products', 'Gadget']);
    assert.equal(r.result.status, 'answer_ready', JSON.stringify(r.result).slice(0, 300));
    assert.equal(r.calls.length, 2);
    assert.match(r.url, /\/products\/gadget$/);
  }
  // 3. NEGATIVE: landing on the wrong page is not completion.
  {
    const r = await run('/', 'Open the About page and tell me which city the company was founded in.', ['Contact']);
    assert.notEqual(r.result.status, 'answer_ready', 'a wrong page must not be read as the answer');
    assert.notEqual(r.result.status, 'verified_complete');
    assert.ok(r.calls.length >= 2, 'the loop must keep going after landing on the wrong page');
  }
  // 4. NEGATIVE: the first of two steps is not the whole task.
  {
    const r = await run('/', 'Open the Products page, open Gadget, and tell me its price.', ['Products', 'Products', 'Products']);
    assert.notEqual(r.result.status, 'answer_ready');
    assert.doesNotMatch(r.url, /gadget/);
  }
  // 5. A link that opens a new tab: the page that is read is the new tab.
  {
    generated.length = 0;
    const r = await run('/resources', 'Click the User guide link and tell me which email address handles support.', ['User guide']);
    assert.equal(r.result.status, 'answer_ready', JSON.stringify(r.result).slice(0, 300));
    assert.equal(r.calls.length, 1);
    assert.ok(generated.length >= 1 && generated.every(body => body.includes('help@acme.test')),
      'the reader must be given the guide page, not the page the run started on');
    assert.ok(generated.every(body => !body.includes('Press room')), 'the starting tab is not what was read');
  }
} finally {
  await browser.close(); await site.close(); globalThis.fetch = realFetch;
}
console.log('PASS test-navigation-arrival-check');
