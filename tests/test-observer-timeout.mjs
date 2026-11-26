// A page that starts a navigation to a server that never answers (a script
// redirect) made every look at the page wait forever, so the whole run froze.
// Each look is now time-limited; the pending load is stopped and the page read
// again. A slow but answering page is not cut off. Real browser, local server,
// scripted model.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeReliably } from '../src/observer/reliable-observer.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;
const realLog = console.log, realFetch = globalThis.fetch;
const usable = {title: 'Page', headings: ['Page'], actionableElements: [], visibleBodyText: 'Some text'};
const fakePage = {}; // no browser: stopping a navigation is best effort and must not throw
let passed = 0;
const ok = name => { passed += 1; realLog(`PASS: ${name}`); };
const quiet = async fn => { console.log = () => {}; try { return await fn(); } finally { console.log = realLog; } };

process.env.COPILOT_OBSERVE_TIMEOUT_MS = '600';
{
  const started = Date.now();
  const result = await quiet(() => observeReliably(fakePage, {maxAttempts: 2, retryDelayMs: 10, observer: () => new Promise(() => {})}));
  assert.equal(result.status, 'observation_unavailable');
  assert.equal(result.assessment.reason, 'observation_timeout');
  assert.ok(Date.now() - started < 5000, 'bounded, not forever');
  ok('a look that never returns ends as observation_unavailable, not a freeze');
}
{
  let calls = 0;
  const result = await quiet(() => observeReliably(fakePage, {maxAttempts: 3, retryDelayMs: 10,
    observer: () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve(usable)}));
  assert.equal(result.status, 'ready');
  assert.equal(result.attempts, 2);
  ok('after a stuck look the page is read again and the run goes on');
}
{
  const result = await observeReliably(fakePage, {maxAttempts: 2, retryDelayMs: 10,
    observer: () => new Promise(resolve => setTimeout(() => resolve(usable), 300))});
  assert.equal(result.status, 'ready');
  assert.equal(result.attempts, 1);
  ok('a slow page that does answer is not cut off');
}

// Real browser: a button whose script redirects to a server that never answers.
const hung = []; let hangHits = 0;
const server = http.createServer((q, r) => {
  if (q.url === '/hang') { hangHits += 1; hung.push(r); return; }
  r.writeHead(200, {'content-type': 'text/html'});
  r.end(`<title>Home</title><h1>Home</h1><button onclick="setTimeout(()=>{location.href='/hang'},300)">Go</button>`);
});
await new Promise(ok2 => server.listen(0, '127.0.0.1', ok2));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless: true});
try {
  process.env.COPILOT_OBSERVE_TIMEOUT_MS = '2500';
  const page = await (await browser.newContext()).newPage();
  await page.goto(base + '/');
  let calls = 0;
  globalThis.fetch = async (_u, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    const target = payload.availableElements.find(item => item.label === 'Go');
    const action = calls++ === 0 && target ? {ref: target.ref, operation: 'click', value: ''} : {ref: '', operation: 'done', value: ''};
    return {ok: true, json: async () => ({message: {content: JSON.stringify(action)}})};
  };
  const mediaDirectory = await mkdtemp(join(tmpdir(), 'wcp-ot-'));
  const started = Date.now();
  const guard = new Promise(resolve => setTimeout(() => resolve('FROZEN'), 30000));
  const result = await quiet(() => Promise.race([guard, executeNaturalLanguageTask(page, 'Click the Go button', {orchestratorOptions: {agentOptions: {
    maxSteps: 4, mediaDirectory, approvalProvider: async () => null}}})]));
  globalThis.fetch = realFetch;
  assert.notEqual(result, 'FROZEN', 'the run froze');
  assert.ok(Date.now() - started < 20000, 'finished in time (' + (Date.now() - started) + ' ms)');
  assert.equal(calls, 1, 'the planner was asked once');
  assert.equal(hangHits, 1, 'the dead address was requested once');
  const asked = Date.now();
  assert.equal(await page.title(), 'Home', 'the page is still usable');
  assert.ok(Date.now() - asked < 2000, 'and answers at once');
  ok('a script redirect to a dead server no longer freezes the run');
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  delete process.env.COPILOT_OBSERVE_TIMEOUT_MS;
  hung.forEach(r => r.destroy());
  await browser.close(); server.close();
}
realLog(`observer-timeout: ${passed} groups passed`);
