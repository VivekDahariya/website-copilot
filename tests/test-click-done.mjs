// "Click the Sport link": after a control with exactly that name was clicked the
// agent proposes done itself (the small planner went on to click a logo link and
// wandered back to the home page). Only for a one-part request and an exact name
// match; the completion verifier still decides. Real browser, local server,
// scripted model.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { namedClickTarget } from '../src/agent/local-reasoner.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

// The parser: one plainly named control, nothing else.
const cases = {
  'click the Sport link.': 'sport', 'Click on the "Sign in" button': 'sign in', 'Click Home': 'home',
  'select the About tab': 'about', 'Click the Contact us link!': 'contact us',
  'Click the first link': null, 'Click all the buttons': null, 'press the Next button': null,
  'Click the 3rd image': null, 'Click the Sport link, then Home': null, 'click the Sport link and then Home': null,
  'Open the Sport page': null, 'Show me the Sport link': null
};
for (const [text, expected] of Object.entries(cases)) assert.equal(namedClickTarget(text), expected, text);

const server = http.createServer((q, r) => {
  r.writeHead(200, {'content-type': 'text/html'});
  if (q.url === '/sport') return r.end('<title>Sport page</title><a href="/">BBC Sport</a><h1>Sport</h1><p>Scores and fixtures</p>');
  r.end('<title>Home page</title><a href="/sport">Sport</a> <a href="/news">News</a> <a href="/sport">BBC Sport</a> <a href="/">Home</a>');
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless: true});
const realFetch = globalThis.fetch, realLog = console.log;
let passed = 0;

async function run(name, instruction, pick, check) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(base + '/');
  let calls = 0;
  globalThis.fetch = async (_u, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    const action = calls++ === 0 ? pick(payload.availableElements) : {ref: '', operation: 'done', value: ''};
    return {ok: true, json: async () => ({message: {content: JSON.stringify(action)}})};
  };
  console.log = () => {};
  let result;
  try { result = await executeNaturalLanguageTask(page, instruction, {orchestratorOptions: {agentOptions: {
    maxSteps: 4, mediaDirectory: await mkdtemp(join(tmpdir(), 'wcp-cd-')), approvalProvider: async () => null}}}); }
  finally { console.log = realLog; globalThis.fetch = realFetch; }
  await check({result, calls, title: await page.title()});
  await page.context().close();
  passed += 1; console.log(`PASS: ${name}`);
}
const click = label => catalog => ({ref: catalog.find(item => item.label === label)?.ref ?? '', operation: 'click', value: ''});

try {
  await run('clicking the named link ends the run without asking the planner again', 'Click the Sport link.', click('Sport'),
    ({result, calls, title}) => {
      assert.equal(title, 'Sport page', 'the page really moved to Sport');
      assert.equal(result.status, 'verified_complete');
      assert.equal(calls, 1, 'the planner was asked only once (calls ' + calls + ')');
    });
  await run('"Open <site> and click the Sport link" is one part too', `Open ${base}/ and click the Sport link`, click('Sport'),
    ({result, calls}) => {
      assert.equal(result.status, 'verified_complete');
      assert.equal(calls, 1, 'the planner was asked only once (calls ' + calls + ')');
    });
  // A different control (the name only contains the word) is not the named one.
  await run('a control whose name only contains the word does not end the run', 'Click the Sport link', click('BBC Sport'),
    ({calls}) => assert.ok(calls >= 2, 'the planner was asked again (calls ' + calls + ')'));
  await run('a request with a second part is never ended early', 'Click the Sport link, then click the Home link', click('Sport'),
    ({calls}) => assert.ok(calls >= 2, 'the planner was asked again (calls ' + calls + ')'));
  await run('"click the first link" is not a named control', 'Click the first link', click('Sport'),
    ({calls}) => assert.ok(calls >= 2, 'the planner was asked again (calls ' + calls + ')'));
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close(); server.close();
}
console.log(`click-done: ${passed} groups passed`);
