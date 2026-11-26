// The page can move on between looking and acting (a late redirect). The
// executor refuses such an action before doing anything; the agent then looks
// again and decides again, a bounded number of times. Real browser, local
// server, scripted model.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

const pages = {
  '/one': `<title>One</title><h1>One</h1><a href="/other">Go</a>
    <script>setTimeout(() => location.replace('/two'), 350);</script>`,
  '/two': `<title>Two</title><h1>Two</h1><button id="b" onclick="this.textContent='Finished';document.title='Finished'">Finish</button>`
};
// A page that keeps redirecting: every observation is out of date by the time the model answers.
const drift = n => `<title>Drift ${n}</title><h1>Drift ${n}</h1><a href="/other">Go</a>
  <script>setTimeout(() => location.replace('/drift/${n + 1}'), 300);</script>`;
const server = http.createServer((request, response) => {
  const m = /^\/drift\/(\d+)$/.exec(request.url);
  const body = m ? drift(Number(m[1])) : pages[request.url];
  response.writeHead(body ? 200 : 404, {'content-type': 'text/html'});
  response.end(body ? `<!doctype html><html><body>${body}</body></html>` : 'missing');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const realFetch = globalThis.fetch, realLog = console.log;

async function run(startPath, instruction, script, delayMs) {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(base + startPath);
  let calls = 0; const seenTitles = [];
  globalThis.fetch = async (_u, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    seenTitles.push(payload.currentPage?.title ?? payload.currentPage?.url ?? '');
    await new Promise(resolve => setTimeout(resolve, delayMs)); // the page moves on while the model "thinks"
    const step = script[Math.min(calls++, script.length - 1)];
    const reply = action => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(action) } }) });
    if (step === 'done') return reply({ ref: '', operation: 'done', value: '' });
    const element = (payload.availableElements ?? []).find(item => step.test(String(item.label ?? '')));
    if (!element) return reply({ ref: '', operation: 'done', value: '' });
    return reply({ ref: element.ref, operation: 'click', value: '' });
  };
  console.log = () => {};
  let result, thrown = null;
  try { result = await executeNaturalLanguageTask(page, instruction, { orchestratorOptions: { agentOptions: {
    maxSteps: 8, approvalProvider: async () => null } } }); }
  catch (error) { thrown = error; }
  finally { console.log = realLog; globalThis.fetch = realFetch; }
  const finalTitle = await page.title().catch(() => '');
  await context.close();
  return { result, thrown, calls, seenTitles, finalTitle };
}

try {
  // The page redirects while the model answers: the click is refused, nothing is lost, the run continues.
  const first = await run('/one', 'Click the Finish button', [/^Go/, /Finish/, 'done'], 900);
  assert.equal(first.thrown, null, 'no crash: ' + first.thrown?.message);
  assert.equal(first.result.status, 'verified_complete', first.result.execution?.result?.reason);
  assert.equal(first.finalTitle, 'Finished', 'the real page shows the button was pressed');
  // Two planner looks: the refused click, then the Finish click. The run then ends by
  // itself (a clicked named control), so no third "done" call is needed any more.
  assert.ok(first.seenTitles.length >= 2, 'the planner looked again after the page moved');
  assert.equal(first.seenTitles[0] !== first.seenTitles[first.seenTitles.length - 1], true, 'the second look saw the new page');
  console.log('PASS: a page that moved on is observed again and the run continues');

  // A page that never settles: bounded, then it stops as before (no endless loop).
  const second = await run('/drift/1', 'Click the Go link', [/^Go/], 700);
  const stopped = second.thrown !== null || second.result?.status !== 'verified_complete';
  assert.ok(stopped, 'never reported as completed');
  assert.ok(second.calls <= 8, 'bounded number of planner calls: ' + second.calls);
  console.log('PASS: a page that never settles is not retried forever');
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close(); server.close();
}
console.log('page-changed-recovery: all groups passed');
