// When the page cannot be read the run reports why in a sentence. It used to
// hand the raw assessment object to the report, which showed "[object Object]".
// Real browser, local server whose link drops the connection, scripted model.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeObservationFailure } from '../src/observer/reliable-observer.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;
const realLog = console.log, realFetch = globalThis.fetch;
let passed = 0;
const ok = name => { passed += 1; realLog(`PASS: ${name}`); };

// The sentences.
assert.match(describeObservationFailure({reason: 'title_only_observation'}, 'https://example.com/'), /no readable content/);
assert.match(describeObservationFailure({reason: 'observation_timeout', message: 'x'}, 'https://example.com/'), /did not answer in time/);
assert.match(describeObservationFailure({reason: 'observer_error', message: 'Target closed\nmore'}, ''), /^The page could not be read: Target closed$/);
assert.match(describeObservationFailure({reason: 'observer_error'}, ''), /^The page could not be read\.$/);
assert.match(describeObservationFailure(null, 'chrome-error://chromewebdata/'), /could not load the page/);
assert.match(describeObservationFailure(undefined, ''), /could not be read/);
for (const input of [[{reason: 'x'}, ''], [null, 'chrome-error://chromewebdata/'], [{reason: 'observer_error', message: {a: 1}}, '']]) {
  const text = describeObservationFailure(...input);
  assert.equal(typeof text, 'string'); assert.ok(!text.includes('[object Object]'), text);
}
ok('the failure sentences are plain text');

// The run itself.
const server = http.createServer((q, r) => {
  if (q.url === '/drop') { q.socket.destroy(); return; }
  r.writeHead(200, {'content-type': 'text/html'});
  r.end('<title>Home</title><h1>Home</h1><a href="/drop">Drop</a>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless: true});
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(base + '/');
  let calls = 0;
  globalThis.fetch = async (_u, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    const target = payload.availableElements.find(item => item.label === 'Drop');
    const action = calls++ === 0 && target ? {ref: target.ref, operation: 'click', value: ''} : {ref: '', operation: 'done', value: ''};
    return {ok: true, json: async () => ({message: {content: JSON.stringify(action)}})};
  };
  const mediaDirectory = await mkdtemp(join(tmpdir(), 'wcp-ofr-'));
  console.log = () => {};
  let result;
  try { result = await executeNaturalLanguageTask(page, 'Click the Drop link and read the heading', {orchestratorOptions: {agentOptions: {
    maxSteps: 4, mediaDirectory, approvalProvider: async () => null}}}); }
  finally { console.log = realLog; globalThis.fetch = realFetch; }
  const run = result.execution?.result ?? {};
  assert.equal(result.status, 'observation_unavailable');
  assert.equal(typeof run.reason, 'string', 'the reason is a sentence');
  assert.ok(!run.reason.includes('[object Object]'));
  assert.match(run.reason, /could not load the page/);
  assert.equal(typeof run.assessment, 'object', 'the raw assessment is kept next to it');
  ok('a link whose connection drops is reported in words, not as [object Object]');
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close(); server.close();
}
realLog(`observation-failure-reason: ${passed} groups passed`);
