import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createFixtureSite } from './battery/fixtures.mjs';
import { observePage } from '../src/observer/dom-observer.js';
import { reachableElements } from '../src/agent/covered-elements.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { createConversationalApprovalProvider } from '../src/agent/conversational-approval.js';

process.env.COPILOT_HEADLESS = '1';
globalThis.fetch = async () => { throw new Error('offline'); };
console.warn = () => {};
const site = await createFixtureSite();
const browser = await chromium.launch({ headless: true,
  ...(process.env.WC_TEST_CHROMIUM ? { executablePath: process.env.WC_TEST_CHROMIUM } : {}), args: ['--no-sandbox'] });
const labels = list => list.map(e => e.label);
const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

try {
  // 1. Under a full-window notice only the notice's own control can be clicked.
  {
    const page = await (await browser.newContext()).newPage();
    await page.goto(site.base + '/press');
    const obs = await observePage(page);
    assert.ok(labels(obs.actionableElements).includes('Annual report'));
    const reachable = await reachableElements(page, obs.actionableElements);
    assert.deepEqual(labels(reachable), ['Accept all cookies']);
    // 2. Once the notice is gone nothing is hidden from the planner.
    await page.getByRole('button', { name: /accept all/i }).click();
    const after = await observePage(page);
    const all = await reachableElements(page, after.actionableElements);
    assert.equal(all.length, after.actionableElements.length);
    assert.ok(labels(all).includes('Annual report'));
    // 3. Empty or unmeasurable input is returned as given.
    assert.deepEqual(await reachableElements(page, []), []);
    const stale = [{ ref: 'e999', label: 'Ghost' }];
    assert.deepEqual(await reachableElements(page, stale), stale);
    await page.close();
  }
  // 4. End to end with a planner that, like a weak model, keeps choosing the covered link
  //    for as long as it is offered, and only picks another control when it is not.
  async function run(path, instruction) {
    const page = await (await browser.newContext()).newPage();
    await page.goto(site.base + path);
    const offered = [];
    const reasoner = async (_task, obs) => {
      offered.push(labels(obs.actionableElements));
      const link = obs.actionableElements.find(e => e.label === 'Annual report');
      if (link) return { ref: link.ref, operation: 'click', value: '' };
      const accept = obs.actionableElements.find(e => /accept/i.test(e.label));
      return accept ? { ref: accept.ref, operation: 'click', value: '' } : { ref: '', operation: 'done', value: '' };
    };
    const result = await quiet(() => executeNaturalLanguageTask(page, instruction, { urlLess: false, orchestratorOptions: { agentOptions: {
      maxSteps: 8, reasoner,
      approvalProvider: createConversationalApprovalProvider({ requestUser: async () => ({ optionId: 'approve' }) }) } } }));
    const out = { result, offered, url: page.url() };
    await page.close();
    return out;
  }
  {
    const r = await run('/press', 'Click the Annual report link.');
    assert.match(r.url, /\/press\/annual-report$/, JSON.stringify(r.result).slice(0, 300));
    assert.equal(r.result.status, 'verified_complete');
    assert.ok(r.offered.length >= 2, 'the first click was covered, so the planner was asked again');
    assert.ok(r.offered[0].includes('Annual report'), 'before any block the planner sees everything');
    assert.deepEqual(r.offered[1], ['Accept all cookies'], 'after a covered click it sees only what a click can reach');
  }
  { // NEGATIVE: with no overlay nothing is filtered and the first click goes through
    const r = await run('/resources', 'Click the Reports link.');
    assert.ok(r.offered.every(list => list.length > 1), 'no block, no narrowing');
  }
} finally { await browser.close(); await site.close(); }
console.log('PASS test-covered-elements');
