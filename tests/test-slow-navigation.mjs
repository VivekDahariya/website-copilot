// A link whose server is slow or never answers. Playwright's click waits for the
// new page to start loading, so it timed out after 3.5 s although the click was
// performed, and the agent called that "blocked" and gave up on a page that was
// actually arriving. Now: a slow page is waited for; a page that never answers is
// stopped, reported as not responding and never clicked again. A really blocked
// click is still reported as blocked. Real browser, local server, scripted model.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

const hits = { slow: 0, hang: 0 };
const hung = [];
const server = http.createServer((q, r) => {
  if (q.url === '/slow') {
    hits.slow += 1;
    setTimeout(() => { r.writeHead(200, {'content-type': 'text/html'}); r.end('<title>Slow page</title><h1>Slow arrived</h1>'); }, 5000);
    return;
  }
  if (q.url === '/hang') { hits.hang += 1; hung.push(r); return; }
  const cover = q.url === '/covered' ? '<div style="position:fixed;inset:0;background:#fff8"></div>' : '';
  r.writeHead(200, {'content-type': 'text/html'});
  r.end('<title>Home</title><h1>Home</h1><a href="/slow">Slow</a> <a href="/hang">Hang</a> <a href="/slow">Covered</a>' + cover);
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless: true});
const realFetch = globalThis.fetch, realLog = console.log;
let passed = 0;

async function run(name, startPath, instruction, label, check) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(base + startPath);
  let calls = 0;
  globalThis.fetch = async (_u, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    const target = payload.availableElements.find(item => item.label === label);
    const action = calls++ === 0 && target ? {ref: target.ref, operation: 'click', value: ''} : {ref: '', operation: 'done', value: ''};
    return {ok: true, json: async () => ({message: {content: JSON.stringify(action)}})};
  };
  console.log = () => {};
  let result, took;
  const started = Date.now();
  try { result = await executeNaturalLanguageTask(page, instruction, {orchestratorOptions: {agentOptions: {
    maxSteps: 4, mediaDirectory: await mkdtemp(join(tmpdir(), 'wcp-sn-')), approvalProvider: async () => null}}}); }
  finally { took = Date.now() - started; console.log = realLog; globalThis.fetch = realFetch; }
  await check({result, calls, took, page, history: result.execution?.result?.history ?? []});
  await page.context().close();
  passed += 1; console.log(`PASS: ${name}`);
}

try {
  await run('a slow page is waited for, not reported as a blocked click', '/', 'Click the Slow link', 'Slow',
    async ({result, calls, page, history}) => {
      assert.equal(await page.title(), 'Slow page', 'the slow page really arrived');
      assert.equal(result.status, 'verified_complete');
      assert.equal(calls, 1, 'the planner was asked only once (calls ' + calls + ')');
      assert.equal(history.filter(h => h.execution?.errorCode).length, 0, 'no failed action recorded');
      assert.equal(hits.slow, 1, 'the link was requested once');
    });

  process.env.COPILOT_NAVIGATION_WAIT_MS = '2500';
  try {
    await run('a page that never answers is stopped, reported, and not clicked again', '/', 'Click the Hang link', 'Hang',
      async ({result, calls, took, page, history}) => {
        assert.equal(result.status, 'page_not_responding');
        assert.equal(history.at(-1).execution.errorCode, 'ACTION_NAVIGATION_TIMEOUT');
        assert.equal(calls, 1, 'no second planner call after a stopped navigation (calls ' + calls + ')');
        assert.equal(hits.hang, 1, 'the link was not requested again');
        assert.ok(took < 15000, 'it did not freeze (' + took + ' ms)');
        const asked = Date.now();
        assert.equal(await page.title(), 'Home', 'the previous page is still there and usable');
        assert.ok(Date.now() - asked < 2000, 'the page answers at once');
        assert.equal(page.url().replace(base, ''), '/');
      });
  } finally { delete process.env.COPILOT_NAVIGATION_WAIT_MS; }

  await run('a click that really is blocked is still reported as blocked', '/covered', 'Click the Covered link', 'Covered',
    async ({result, history}) => {
      assert.notEqual(result.status, 'page_not_responding');
      assert.ok(history.some(h => h.execution?.errorCode === 'ACTION_CLICK_BLOCKED'), 'recorded as blocked');
    });
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  hung.forEach(r => r.destroy());
  await browser.close(); server.close();
}
console.log(`slow-navigation: ${passed} groups passed`);
