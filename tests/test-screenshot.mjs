// Taking a screenshot: done only when a real PNG is on disk and reads back with
// the same size and hash. The model's word is never evidence. Real browser,
// local server, scripted model.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { readPngSize } from '../src/executor/screenshot-save.js';
import { screenshotRequest } from '../src/agent/direct-instruction.js';
import {
  collectRunExplanationEvidence, collectCompletionChecks, collectRunSteps,
  collectRunContext, buildRunFacts, findContradiction, explainFromFacts
} from '../src/ui/run-explanation.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

// ---- what counts as asking ----
for (const [text, expected] of [
  ['Take a screenshot of the page', {fullPage: false}], ['take a full-page screenshot', {fullPage: true}],
  ['Save a screenshot of this page', {fullPage: false}], ['Grab a screen capture of the whole page', {fullPage: true}],
  ['Do not take a screenshot', null], ['Describe the screenshot', null], ['Open the screenshots page', null]
]) assert.deepEqual(screenshotRequest(text), expected, text);
assert.equal(readPngSize(Buffer.from('<html>not a png at all, definitely</html>')), null);

const pages = {
  '/small': '<title>Small</title><h1>Small page</h1><p>Hello</p>',
  '/tall': '<title>Tall</title><h1>Tall page</h1><div style="height:3000px;background:#def">tall</div>',
  '/huge': '<title>Huge</title><h1>Huge page</h1><div style="height:20000px">huge</div>'
};
const server = http.createServer((request, response) => {
  const body = pages[request.url];
  response.writeHead(body ? 200 : 404, {'content-type': 'text/html'});
  response.end(body ? `<!doctype html><html><body style="margin:0">${body}</body></html>` : 'missing');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless: true});
const realFetch = globalThis.fetch, realLog = console.log;
const directories = [];
let passed = 0;

async function run({name, path, instruction, script, expect, file = null, noFile = false, offered = null, reason = null, maxCalls = 8}) {
  const directory = await mkdtemp(join(tmpdir(), 'wcp-shot-')); directories.push(directory);
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(base + path);
  let calls = 0; const sawAction = [];
  globalThis.fetch = async (_u, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    sawAction.push(Boolean(payload.screenshotAction));
    const step = script[calls++];
    const reply = action => ({ok: true, json: async () => ({message: {content: JSON.stringify(action)}})});
    if (step === 'screenshot') return reply({ref: '', operation: 'screenshot', value: ''});
    return reply({ref: '', operation: 'done', value: ''});
  };
  console.log = () => {};
  let result;
  try { result = await executeNaturalLanguageTask(page, instruction, {orchestratorOptions: {agentOptions: {
    maxSteps: 6, mediaDirectory: directory, approvalProvider: async () => null}}}); }
  finally { console.log = realLog; globalThis.fetch = realFetch; }
  const run = result.execution?.result ?? {};
  if (expect !== null) assert.equal(result.status, expect, `${name}: ${run.reason ?? ''}`);
  assert.ok(calls <= maxCalls, `${name}: bounded planner calls (${calls})`);
  const entries = await readdir(directory);
  if (noFile) assert.deepEqual(entries, [], `${name}: nothing written`);
  if (file) {
    assert.equal(entries.length, 1, `${name}: exactly one file`);
    const bytes = await readFile(join(directory, entries[0]));
    const size = readPngSize(bytes);
    assert.ok(size, `${name}: a real PNG`);
    file(size, bytes);
    const entry = (run.history ?? []).find(item => item.decision.operation === 'screenshot');
    assert.equal(entry.execution.verified, true, `${name}: verified`);
    assert.equal(entry.execution.media.sha256, createHash('sha256').update(bytes).digest('hex'), `${name}: receipt hash`);
    assert.equal(entry.execution.media.bytes, bytes.length, `${name}: receipt size`);
  }
  if (reason) {
    const attempt = (run.history ?? []).find(item => item.decision.operation === 'screenshot');
    assert.equal(attempt?.execution?.verified, false, `${name}: recorded as failed`);
    assert.match(String(attempt?.execution?.errorDetail ?? ''), reason, `${name}: reason`);
  }
  if (offered !== null) assert.equal(sawAction.some(Boolean), offered, `${name}: screenshot offered = ${offered}`);
  await context.close();
  passed += 1;
  console.log(`PASS: ${name} -> ${result.status}`);
  return {run, sawAction, calls, result};
}

try {
  const first = await run({name: 'the visible page is saved as a verified PNG', path: '/small',
    instruction: 'Take a screenshot of the page', script: ['screenshot'], expect: 'verified_complete',
    file: size => { assert.equal(size.width, 1280); assert.equal(size.height, 720); }, offered: true});
  assert.equal(first.sawAction.length >= 1, true);
  await run({name: 'a full-page screenshot is as tall as the page', path: '/tall',
    instruction: 'Take a full-page screenshot', script: ['screenshot'], expect: 'verified_complete',
    file: size => { assert.equal(size.width, 1280); assert.ok(size.height >= 3000, 'height ' + size.height); }});
  await run({name: 'done without a screenshot is not complete', path: '/small',
    instruction: 'Take a screenshot of the page', script: [], expect: 'unverified_completion_claim', noFile: true});
  // A page taller than the limit: an honest failure, bounded attempts, nothing written.
  await run({name: 'a page taller than the limit is not claimed as captured', path: '/huge',
    instruction: 'Take a full-page screenshot', script: ['screenshot', 'screenshot', 'screenshot'],
    expect: 'unverified_completion_claim', noFile: true, reason: /16000 px/});
  // Not asked: never offered.
  await run({name: 'no screenshot is offered unless asked', path: '/small',
    instruction: 'Scroll down the page', script: [], expect: null, offered: false, noFile: true});
  // One is enough: after it is saved, the offer is gone.
  const once = await run({name: 'after one screenshot the offer is gone', path: '/small',
    instruction: 'Take a screenshot of the page', script: ['screenshot'], expect: 'verified_complete'});
  assert.equal(once.sawAction[0], true);
  assert.ok(once.sawAction.slice(1).every(value => value === false), 'not offered again');
  assert.equal(once.calls, 1, 'the planner is not asked again after the verified screenshot');
  // The usual wording starts with "Open <site> and ...". The opening is already
  // done on arrival, so this is still a one-part request.
  const opened = await run({name: 'Open <site> and take a screenshot ends after the verified screenshot', path: '/small',
    instruction: `Open ${base}/small and take a screenshot of the page`, script: ['screenshot'], expect: 'verified_complete'});
  assert.equal(opened.calls, 1, 'the planner is not asked again (calls ' + opened.calls + ')');
  // A second part after the screenshot must still reach the planner.
  const longer = await run({name: 'a request with a further part is not ended by the proposed done', path: '/small',
    instruction: `Open ${base}/small, take a screenshot and then scroll down`, script: ['screenshot'], expect: null});
  assert.ok(longer.calls >= 2, 'the planner was asked again (calls ' + longer.calls + ')');
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close(); server.close();
  await Promise.all(directories.map(directory => rm(directory, {recursive: true, force: true})));
}

// ---- the report ----
const edge = (operation, label, status = 'observed_after_action') => ({from: 'a', to: 'b', operation, label, status});
const state = {phase: 'finished', url: 'https://example.com/',
  result: {status: 'verified_complete'},
  actionTree: {nodes: [{id: 'a', title: 'Example'}, {id: 'b', title: 'Example'}], edges: [edge('screenshot', 'page')]},
  activity: []};
const evidence = collectRunExplanationEvidence(state);
const options = {checks: collectCompletionChecks(state), steps: collectRunSteps(state), context: collectRunContext(state)};
const facts = buildRunFacts(evidence, options.checks, options.steps, options.context);
assert.ok(facts.facts.stepsCoPilotDid.includes('took a screenshot of the page and saved it as a file'));
const report = explainFromFacts(evidence, options);
assert.equal(report.outcome, 'passed');
assert.equal(findContradiction(facts, report.explanation), null);
console.log(`screenshot: ${passed} groups passed`);
