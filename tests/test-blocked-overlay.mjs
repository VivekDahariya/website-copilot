// A click covered by a cookie banner, dialog or other overlay: the planner is
// told what covers it and which of its controls are on the page, so it can
// dismiss the overlay and then repeat the click. Nothing is dismissed
// automatically. Real browser, local server, scripted model.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { describeBlockingOverlay } from '../src/executor/action-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

const dialog = `<div role="dialog" aria-label="Cookie consent" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99;display:flex;align-items:flex-end"><div style="background:#fff;width:100%;padding:20px">We use cookies.
<button onclick="this.closest('[role=dialog]').remove()">Accept all</button> <button onclick="this.closest('[role=dialog]').remove()">Reject non-essential</button> <button>Manage preferences</button></div></div>`;
const plain = `<div id="promo" style="position:fixed;inset:0;background:#fffc;z-index:99"><h2>Subscribe to our newsletter today</h2><button onclick="document.getElementById('promo').remove()">No thanks</button></div>`;
const page = overlay => `<!doctype html><title>Shop</title><body><h1>Shop</h1><a href="/pricing">Pricing</a> <a href="/about">About us</a>${overlay}</body>`;
const server = http.createServer((q, r) => {
  r.writeHead(200, {'content-type': 'text/html'});
  if (q.url === '/pricing') return r.end('<title>Pricing page</title><h1>Pricing</h1><p>Plans and prices</p>');
  if (q.url.startsWith('/plain')) return r.end(page(plain));
  if (q.url.startsWith('/clear')) return r.end(page(''));
  r.end(page(dialog));
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless: true});
const realFetch = globalThis.fetch, realLog = console.log;
let passed = 0;
const refOf = (catalog, pattern) => catalog.find(item => pattern.test(item.label))?.ref ?? '';

async function run(name, path, instruction, script, check) {
  const tab = await (await browser.newContext()).newPage();
  await tab.goto(base + path);
  const payloads = []; let prompt = ''; let calls = 0;
  globalThis.fetch = async (_u, request) => {
    const body = JSON.parse(request.body);
    prompt = body.messages[0].content;
    const payload = JSON.parse(body.messages[1].content);
    payloads.push(payload);
    const action = script(calls++, payload.availableElements) ?? {ref: '', operation: 'done', value: ''};
    return {ok: true, json: async () => ({message: {content: JSON.stringify(action)}})};
  };
  console.log = () => {};
  let result;
  try { result = await executeNaturalLanguageTask(tab, instruction, {orchestratorOptions: {agentOptions: {
    maxSteps: 6, mediaDirectory: await mkdtemp(join(tmpdir(), 'wcp-ov-')), approvalProvider: async () => null}}}); }
  finally { console.log = realLog; globalThis.fetch = realFetch; }
  await check({result, payloads, prompt, calls, title: await tab.title()});
  await tab.context().close();
  passed += 1; console.log(`PASS: ${name}`);
}

try {
  // The planner learns what covers the click and which controls dismiss it.
  await run('a click under a cookie dialog reports the dialog and its controls', '/', 'Click the Pricing link',
    (call, catalog) => call === 0 ? {ref: refOf(catalog, /^Pricing/), operation: 'click', value: ''} : null,
    ({payloads, prompt}) => {
      const failed = payloads[1].previousActions[0];
      assert.equal(failed.failed, true);
      assert.equal(failed.blockedBy.kind, 'dialog');
      assert.equal(failed.blockedBy.name, 'Cookie consent');
      for (const label of ['Accept all', 'Reject non-essential', 'Manage preferences']) assert.ok(failed.blockedBy.controls.includes(label), label);
      assert.match(prompt, /blockedBy/, 'the planner is told how to use blockedBy');
      assert.equal(payloads[0].previousActions.some(item => item.blockedBy), false, 'nothing is reported before a click fails');
    });
  // The full path: dismiss with the planner's choice, repeat the click, verified.
  await run('after the overlay is dismissed the original click succeeds and is verified', '/', 'Click the Pricing link',
    (call, catalog) => {
      if (call === 0) return {ref: refOf(catalog, /^Pricing/), operation: 'click', value: ''};
      if (call === 1) return {ref: refOf(catalog, /^Reject non-essential/), operation: 'click', value: ''};
      if (call === 2) return {ref: refOf(catalog, /^Pricing/), operation: 'click', value: ''};
      return null;
    },
    ({result, title}) => {
      assert.equal(title, 'Pricing page', 'the page really moved to Pricing');
      assert.equal(result.status, 'verified_complete');
    });
  // An overlay that is not a dialog is described too.
  await run('a plain overlay is described as an overlay with its control', '/plain', 'Click the Pricing link',
    (call, catalog) => call === 0 ? {ref: refOf(catalog, /^Pricing/), operation: 'click', value: ''} : null,
    ({payloads}) => {
      const blocked = payloads[1].previousActions[0].blockedBy;
      assert.equal(blocked.kind, 'overlay');
      assert.match(blocked.name, /Subscribe to our newsletter/);
      assert.ok(blocked.controls.includes('No thanks'));
    });
  // Nothing covers the target: nothing is reported, and the click works.
  await run('an uncovered link is clicked normally, with no blocker reported', '/clear', 'Click the Pricing link',
    (call, catalog) => call === 0 ? {ref: refOf(catalog, /^Pricing/), operation: 'click', value: ''} : null,
    ({result, payloads, title}) => {
      assert.equal(title, 'Pricing page');
      assert.equal(result.status, 'verified_complete');
      assert.equal(payloads.flatMap(payload => payload.previousActions).some(item => item.blockedBy), false);
    });
  // The measurement itself: covered -> described; not covered -> null; hostile page text stays short.
  const tab = await (await browser.newContext()).newPage();
  await tab.goto(base + '/clear');
  assert.equal(await describeBlockingOverlay(await tab.$('a[href="/pricing"]')), null);
  await tab.evaluate(() => {
    const long = 'x'.repeat(400);
    document.body.insertAdjacentHTML('beforeend', `<div role="dialog" aria-label="${long}" style="position:fixed;inset:0;z-index:9">${Array.from({length: 12}, (_, i) => `<button>${long}${i}</button>`).join('')}</div>`);
  });
  const hostile = await describeBlockingOverlay(await tab.$('a[href="/pricing"]'));
  assert.ok(hostile.name.length <= 60, 'the name is shortened');
  assert.ok(hostile.controls.length <= 6 && hostile.controls.every(label => label.length <= 60), 'controls are limited and shortened');
  await tab.context().close(); passed += 1; console.log('PASS: the measurement is limited in size');
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close(); server.close();
}
console.log(`blocked-overlay: ${passed} groups passed`);
