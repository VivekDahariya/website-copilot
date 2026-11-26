// "Click A, then click B" must not be accepted after only A. The completion check
// used to look for the instruction's words anywhere on the page, and the second
// link was in the navigation bar, so one click was enough. Now each named step
// needs its own verified action, in the order written. Real browser, local
// server, scripted model.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sameAddress, sequencedTargets, unmetSteps } from '../src/agent/instruction-steps.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;
const realLog = console.log, realFetch = globalThis.fetch;
let passed = 0;
const ok = name => { passed += 1; realLog(`PASS: ${name}`); };

// ---- The steps read from an instruction.
const read = text => sequencedTargets(text).map(item => `${item.kind}:${item.display}`);
assert.deepEqual(read('Click the Sport link, then click the News link'), ['click:Sport', 'click:News']);
assert.deepEqual(read('Click the Sport link and then the News link'), ['click:Sport', 'click:News']);
assert.deepEqual(read('Click Sport, then News, then Contact us'), ['click:Sport', 'click:News', 'click:Contact us']);
assert.deepEqual(read('Click the Sport link. After that click the About link.'), ['click:Sport', 'click:About']);
assert.deepEqual(read('Click About and also click News'), ['click:About', 'click:News']);
assert.deepEqual(read('Open the Sport page and then the About page'), ['page:Sport page', 'page:About page']);
assert.deepEqual(read('Click the Sport link, then go back to Home'), ['click:Sport', 'back:go back to Home']);
assert.deepEqual(read('Click "Show details" then click "Hide details"'), ['click:"Show details"', 'click:"Hide details"']);
assert.deepEqual(read('Open https://bbc.com and click the Sport link'), ['click:Sport']);
for (const text of ['Click Sport and read the heading', 'Click the Terms and Conditions link', 'Click the first link, then the second link',
  'Click all the buttons', 'Fill Username with "Atlas" and select "Pro" from Plan. Do not submit.', 'Open https://example.com',
  'Scroll to the bottom, then back to the top']) {
  assert.deepEqual(read(text), [], text);
}
ok('the named steps are read from the instruction, and nothing else is');

// ---- Matching steps to what was done.
const entry = (label, urlAfter, operation = 'click', verified = true) => ({
  decision: {operation}, targetLabel: label,
  execution: {executionCompleted: true, verified, previousUrl: 'http://x.test/', urlAfter}
});
const both = 'Click the Sport link, then click the News link';
assert.deepEqual(unmetSteps(both, [entry('Sport', 'http://x.test/sport'), entry('News', 'http://x.test/news')]).missing, []);
assert.deepEqual(unmetSteps(both, [entry('Sport', 'http://x.test/sport')]).missing, ['News']);
assert.deepEqual(unmetSteps(both, [entry('News', 'http://x.test/news'), entry('Sport', 'http://x.test/sport')]).missing, ['News'], 'order matters');
assert.deepEqual(unmetSteps(both, [entry('Sport', 'http://x.test/sport'), entry('News', 'http://x.test/news', 'click', false)]).missing, ['News'], 'an unverified action does not count');
assert.deepEqual(unmetSteps(both, [entry('BBC Sport', 'http://x.test/sport'), entry('Latest News', 'http://x.test/n')]).missing, [], 'a longer label that contains the name counts');
assert.deepEqual(unmetSteps(both, [entry('Football', 'http://x.test/sport'), entry('Headlines', 'http://x.test/news')]).missing, [], 'the page reached counts too');
assert.deepEqual(unmetSteps(both, [entry('Sport', 'http://x.test/sport'), entry('Sport', 'http://x.test/sport')]).missing, ['News'], 'one action serves one step');
const pageThenClick = 'Open the Installation page and click How to install Toolkit';
assert.deepEqual(unmetSteps(pageThenClick, [entry('How to install Toolkit', 'http://x.test/docs/intro#how')], {currentWords: new Set(['installation', 'toolkit'])}).missing, [], 'the first page was already open');
assert.deepEqual(unmetSteps(pageThenClick, [entry('How to install Toolkit', 'http://x.test/docs/intro#how')], {currentWords: new Set(['toolkit'])}).missing, ['Installation page'], 'it was not open');
assert.deepEqual(unmetSteps('Click About, then open the Sport page', [entry('About', 'http://x.test/about')], {currentWords: new Set(['sport'])}).missing, ['Sport page'], 'only the first step may rely on the open page');
const wandered = [entry('Sport', 'http://x.test/sport'), entry('News', 'http://x.test/news'), entry('Sport', 'http://x.test/sport')];
assert.equal(unmetSteps(both, wandered).lastIndex, 1, 'the last step was done by the second action');
const repeated = [...wandered, entry('News', 'http://x.test/news')];
assert.equal(unmetSteps(both, repeated).lastIndex, 3, 'the latest matching action counts as the last step');
assert.equal(sameAddress('https://x.test/news#top', 'https://x.test/news/'), true);
assert.equal(sameAddress('https://x.test/news', 'https://x.test/sport'), false);
assert.equal(sameAddress('https://x.test/n?a=1', 'https://x.test/n?a=2'), false);
assert.equal(unmetSteps('Click the Sport link', []).applies, false, 'a single step is left to the other checks');
ok('each step needs its own verified action, in order');

// ---- Real runs.
const nav = '<nav><a href="/">Home</a> <a href="/sport">Sport</a> <a href="/news">News</a> <a href="/contact">Contact us</a> <a href="/about">About</a></nav>';
const titles = {'/': 'Home', '/sport': 'Sport', '/news': 'News', '/contact': 'Contact us', '/about': 'About'};
const server = http.createServer((q, r) => {
  const title = titles[q.url];
  r.writeHead(title ? 200 : 404, {'content-type': 'text/html'});
  r.end(`<title>${title ?? 'Missing'} page</title>${nav}<h1>${title ?? 'Missing'}</h1><p>Welcome to the ${title} section of this demo site with enough text.</p>`);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless: true});

// script: what the scripted model does, step by step; then it only says "done".
async function run(instruction, script) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(base + '/');
  let calls = 0;
  globalThis.fetch = async (_u, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    const step = script[calls++];
    let action = {ref: '', operation: 'done', value: ''};
    if (step === 'back') action = {ref: '', operation: 'back', value: ''};
    else if (step) action = {ref: payload.availableElements.find(item => item.label === step)?.ref ?? '', operation: 'click', value: ''};
    return {ok: true, json: async () => ({message: {content: JSON.stringify(action)}})};
  };
  console.log = () => {};
  let result;
  try { result = await executeNaturalLanguageTask(page, instruction, {orchestratorOptions: {agentOptions: {
    maxSteps: 7, mediaDirectory: await mkdtemp(join(tmpdir(), 'wcp-seq-')), approvalProvider: async () => null}}}); }
  finally { console.log = realLog; globalThis.fetch = realFetch; }
  const end = page.url().replace(base, '') || '/';
  const clicks = (result.execution?.result?.history ?? []).filter(h => h.decision?.operation === 'click').length;
  await page.context().close();
  return {status: result.status, end, clicks};
}
try {
  for (const [instruction, wanted] of [
    ['Click the Sport link, then click the News link', '/news'],
    ['Click Sport, then News, then Contact us', '/contact'],
    ['Click About and also click News', '/news'],
    ['Open the Sport page and then the About page', '/about']
  ]) {
    const partial = await run(instruction, ['Sport']);
    assert.notEqual(partial.status, 'verified_complete', `only the first part was done: ${instruction}`);
    ok(`first part only is refused: ${instruction}`);
  }

  const full = await run('Click the Sport link, then click the News link', ['Sport', 'News']);
  assert.equal(full.status, 'verified_complete', 'two clicks: ' + JSON.stringify(full)); assert.equal(full.end, '/news'); assert.equal(full.clicks, 2);
  const three = await run('Click Sport, then News, then Contact us', ['Sport', 'News', 'Contact us']);
  assert.equal(three.status, 'verified_complete', 'three clicks: ' + JSON.stringify(three)); assert.equal(three.end, '/contact'); assert.equal(three.clicks, 3);
  const pages = await run('Open the Sport page and then the About page', ['Sport', 'About']);
  assert.equal(pages.status, 'verified_complete', 'two pages: ' + JSON.stringify(pages)); assert.equal(pages.end, '/about');
  ok('doing every step is accepted');

  const reversed = await run('Click the Sport link, then click the News link', ['News', 'Sport']);
  assert.notEqual(reversed.status, 'verified_complete', 'wrong order');
  ok('the steps done in the wrong order are refused');

  // Once every step is done, in order, the planner is not asked again.
  {
    const page = await (await browser.newContext()).newPage();
    await page.goto(base + '/');
    let calls = 0;
    const script = ['Sport', 'News', 'Sport', 'Sport'];
    globalThis.fetch = async (_u, request) => {
      const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
      const label = script[calls++];
      const action = label ? {ref: payload.availableElements.find(item => item.label === label)?.ref ?? '', operation: 'click', value: ''}
        : {ref: '', operation: 'done', value: ''};
      return {ok: true, json: async () => ({message: {content: JSON.stringify(action)}})};
    };
    console.log = () => {};
    let result;
    try { result = await executeNaturalLanguageTask(page, 'Click the Sport link, then click the News link', {orchestratorOptions: {agentOptions: {
      maxSteps: 7, mediaDirectory: await mkdtemp(join(tmpdir(), 'wcp-seq-')), approvalProvider: async () => null}}}); }
    finally { console.log = realLog; globalThis.fetch = realFetch; }
    assert.equal(result.status, 'verified_complete');
    assert.equal(page.url(), base + '/news', 'it stopped on the last step\'s page, not on a third link');
    assert.equal(calls, 2, 'two planner calls for two steps (calls ' + calls + ')');
    await page.context().close();
    ok('after the last step the run ends without asking the planner for more');
  }

  // A run that did every step and then moved on is not finished where asked.
  {
    const page = await (await browser.newContext()).newPage();
    await page.goto(base + '/');
    const steps = ['Sport', 'News', 'Sport', 'News'];
    const reasoner = async (_task, observation, history) => {
      const label = steps[history.length];
      return label ? {ref: observation.actionableElements.find(item => item.label === label)?.ref ?? '', operation: 'click', value: ''}
        : {ref: '', operation: 'done', value: ''};
    };
    // History grows by one per executed action: Sport, News, Sport (wandered), then done.
    const wanderOnly = async (_task, observation, history) => history.length < 3
      ? reasoner(_task, observation, history) : {ref: '', operation: 'done', value: ''};
    console.log = () => {};
    let result;
    try { result = await executeNaturalLanguageTask(page, 'Click the Sport link, then click the News link', {orchestratorOptions: {agentOptions: {
      reasoner: wanderOnly, maxSteps: 7, mediaDirectory: await mkdtemp(join(tmpdir(), 'wcp-seq-')), approvalProvider: async () => null}}}); }
    finally { console.log = realLog; }
    assert.equal(page.url(), base + '/sport', 'the run really ended on the wrong page');
    assert.notEqual(result.status, 'verified_complete', 'it moved on after the last step');
    assert.match(String(result.execution?.result?.reason ?? ''), /moved on after the last step/);
    await page.context().close();
    ok('a run that moved on after the last step is refused, with the reason');
  }

  // ...and accepted once it is back on the last step's page.
  {
    const page = await (await browser.newContext()).newPage();
    await page.goto(base + '/');
    const steps = ['Sport', 'News', 'Sport', 'News'];
    const returning = async (_task, observation, history) => {
      const label = steps[history.length];
      return label ? {ref: observation.actionableElements.find(item => item.label === label)?.ref ?? '', operation: 'click', value: ''}
        : {ref: '', operation: 'done', value: ''};
    };
    console.log = () => {};
    let result;
    try { result = await executeNaturalLanguageTask(page, 'Click the Sport link, then click the News link', {orchestratorOptions: {agentOptions: {
      reasoner: returning, maxSteps: 7, mediaDirectory: await mkdtemp(join(tmpdir(), 'wcp-seq-')), approvalProvider: async () => null}}}); }
    finally { console.log = realLog; }
    assert.equal(page.url(), base + '/news');
    assert.equal(result.status, 'verified_complete', JSON.stringify(result.execution?.result?.reason));
    await page.context().close();
    ok('the same run is accepted once the last step is open again');
  }

  const goneBack = await run('Click the Sport link, then go back to Home', ['Sport', 'back']);
  assert.equal(goneBack.end, '/', 'the browser really went back');
  assert.equal(goneBack.status, 'verified_complete', 'went back: ' + JSON.stringify(goneBack));
  const notBack = await run('Click the Sport link, then go back to Home', ['Sport']);
  assert.notEqual(notBack.status, 'verified_complete', 'never went back');
  ok('"go back" is a step that needs a real action');

  const single = await run('Click the Sport link', ['Sport']);
  assert.equal(single.status, 'verified_complete'); assert.equal(single.clicks, 1);
  ok('a single-step instruction is unaffected');
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close(); server.close();
}
realLog(`sequence-steps: ${passed} groups passed`);
