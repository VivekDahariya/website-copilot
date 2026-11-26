// The run report says "searched the web for the website, then opened the page"
// only when that really happened. It used to say so for every run without a
// Starting URL, including a run whose address was typed in the task and a run
// that never opened any page. Real browser, local servers, scripted model.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { chromium } from 'playwright';
import { usedWebSearch } from '../src/agent/website-discovery.js';
import { buildRunFacts, collectRunContext, collectRunExplanationEvidence, collectCompletionChecks, collectRunSteps } from '../src/ui/run-explanation.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;
const realLog = console.log, realFetch = globalThis.fetch;
let passed = 0;
const ok = name => { passed += 1; realLog(`PASS: ${name}`); };

// The rule itself.
assert.equal(usedWebSearch({status: 'found', discoveryMethod: 'search_duckduckgo'}), true);
assert.equal(usedWebSearch({status: 'found', discoveryMethod: 'direct_domain'}), false);
assert.equal(usedWebSearch({status: 'site_unreachable', reason: 'x'}), false);
assert.equal(usedWebSearch({status: 'needs_clarification', discoveryMethod: 'search_x'}), false);
assert.equal(usedWebSearch(null), false);
assert.equal(usedWebSearch(undefined), false);
ok('only a site found by searching counts as searched for');

// What the report may say about the start of the run.
{
  const failed = {phase: 'finished', url: 'chrome-error://chromewebdata/', result: {status: 'site_unreachable', foundSite: false,
    reason: 'x.invalid could not be opened: the address does not exist.', checks: [], history: []}, actionTree: {nodes: [], edges: []}, activity: []};
  const run = buildRunFacts(collectRunExplanationEvidence(failed), collectCompletionChecks(failed), collectRunSteps(failed), collectRunContext(failed));
  const text = JSON.stringify(run.facts);
  assert.ok(!/searched the web|opened the page/.test(text), text);
  assert.equal(run.facts.outcome, 'FAILED');
  ok('the report of a run that opened nothing does not claim it searched or opened a page');
}

const free = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const site = http.createServer((q, r) => { r.writeHead(200, {'content-type': 'text/html'}); r.end('<title>Local site</title><h1>Local site</h1><p>This page has enough readable text to count as a real, reachable website.</p>'); });
await new Promise(done => site.listen(0, '127.0.0.1', done));
const sitePort = site.address().port;
const browser = await chromium.launch({headless: true});
async function run(instruction) {
  const page = await (await browser.newContext()).newPage();
  const seen = [];
  globalThis.fetch = async () => ({ok: true, json: async () => ({message: {content: JSON.stringify({ref: '', operation: 'done', value: ''})}})});
  console.log = () => {};
  try { await executeNaturalLanguageTask(page, instruction, {urlLess: true, onDiscovery: found => seen.push(found),
    orchestratorOptions: {agentOptions: {maxSteps: 2, approvalProvider: async () => null}}}); }
  finally { console.log = realLog; globalThis.fetch = realFetch; }
  await page.context().close();
  return seen;
}
try {
  const given = await run(`Open http://127.0.0.1:${sitePort}/ and read the heading`);
  assert.equal(given.length, 1, 'the callback is called once');
  assert.equal(given[0].status, 'found');
  assert.equal(given[0].discoveryMethod, 'direct_domain');
  assert.equal(usedWebSearch(given[0]), false, 'an address typed in the task is not a search');
  ok('a task that names its address is not reported as a web search');

  const dead = await run(`Open http://127.0.0.1:${free}/ and click Home`);
  assert.equal(dead.length, 1);
  assert.equal(dead[0].status, 'site_unreachable');
  assert.equal(usedWebSearch(dead[0]), false, 'a page that never opened is not reported as opened');
  ok('a run that never opened a page is not reported as having opened one');
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close(); site.close();
}
realLog(`found-site-claim: ${passed} groups passed`);
