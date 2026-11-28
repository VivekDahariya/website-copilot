// A consent notice served from a separate frame covers the page. CoPilot must
// (1) describe it with the names of the buttons inside the frame, and (2) when
// the planner repeats the covered click once, still reach the notice's button and
// finish. Real Chromium, the real agent and executor, a scripted model.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { describeBlockingOverlay } from '../src/executor/action-executor.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { buildCatalog, decideNextAction } from '../src/agent/local-reasoner.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

const NOTICE = `<h2>We value your privacy</h2><p>We use cookies.</p>${[1, 2, 3, 4, 5, 6, 7].map(n => `<a href="#p${n}">Partner ${n}</a>`).join(' ')}<button onclick="parent.document.getElementById('ov').remove()">Accept all</button><button>Manage options</button>`;
const overlay = `<iframe id="ov" srcdoc="${NOTICE.replace(/"/g, '&quot;')}" style="position:fixed;left:0;top:0;width:100vw;height:100vh;border:0;background:#fff;z-index:99"></iframe>`;
const pages = {
  '/': `<title>Home</title><h1>Home</h1><nav><a href="/pricing">Pricing</a> <a href="/about">About</a></nav>${overlay}`,
  '/plain': `<title>Plain</title><h1>Plain</h1><a id="t" href="/pricing">Pricing</a><div style="position:fixed;left:0;top:0;width:100vw;height:100vh;background:#fff;z-index:99" role="dialog" aria-label="Cookie notice"><a href="/privacy">Privacy policy</a> <button>Agree</button><button>Decline</button></div>`,
  '/clear': '<title>Clear</title><h1>Clear</h1><a id="t" href="/pricing">Pricing</a>',
  '/pricing': '<title>Pricing</title><h1>Pricing</h1><p>Plans start at 9 dollars.</p>',
  '/about': '<title>About</title><h1>About</h1>'
};
const server = http.createServer((request, response) => {
  const body = pages[request.url];
  response.writeHead(body ? 200 : 404, {'content-type': 'text/html'});
  response.end(body ? `<!doctype html><html><body>${body}</body></html>` : 'missing');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({headless: true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath: process.env.WC_TEST_CHROMIUM} : {}),
  args: ['--no-sandbox']});
const realFetch = globalThis.fetch;
let passed = 0;
const ok = message => { passed += 1; console.log('PASS:', message); };

try {
  // 1. The description of the overlay.
  {
    const page = await (await browser.newContext({viewport: {width: 900, height: 700}})).newPage();
    await page.goto(base + '/', {waitUntil: 'domcontentloaded'});
    const framed = await describeBlockingOverlay(await page.getByRole('link', {name: 'Pricing'}).elementHandle());
    assert.ok(framed, 'the covered link has an overlay description');
    assert.equal(framed.name, 'We value your privacy');
    assert.deepEqual(framed.controls.slice(0, 2), ['Accept all', 'Manage options'], 'buttons come before the small-print links');
    assert.equal(framed.controls.length, 8, 'the list is capped');
    ok('a notice served from a frame is described by the name and buttons inside it');

    await page.goto(base + '/plain', {waitUntil: 'domcontentloaded'});
    const plain = await describeBlockingOverlay(await page.locator('#t').elementHandle());
    assert.equal(plain.kind, 'dialog');
    assert.equal(plain.name, 'Cookie notice');
    assert.deepEqual(plain.controls, ['Agree', 'Decline', 'Privacy policy']);
    ok('an ordinary dialog is described as before');

    await page.goto(base + '/clear', {waitUntil: 'domcontentloaded'});
    assert.equal(await describeBlockingOverlay(await page.locator('#t').elementHandle()), null);
    ok('an uncovered link has no overlay');
  }

  // 2. The run: the planner insists on the covered click once, then takes the way past.
  {
    const page = await (await browser.newContext({viewport: {width: 900, height: 700}})).newPage();
    await page.goto(base + '/', {waitUntil: 'domcontentloaded'});
    let calls = 0, linkRef = null, sawControls = false;
    globalThis.fetch = async (_url, request) => {
      const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
      const all = payload.availableElements ?? [];
      const byLabel = label => all.find(item => item.label === label);
      if ((payload.previousActions ?? []).some(item => (item.blockedBy?.controls ?? []).includes('Accept all'))) sawControls = true;
      calls += 1;
      let action;
      if (calls === 1) { linkRef = byLabel('Pricing').ref; action = {ref: linkRef, operation: 'click', value: ''}; }
      else if (calls === 2) action = {ref: linkRef, operation: 'click', value: ''};          // the stubborn repeat
      else if (calls === 3) { assert.ok(byLabel('Accept all'), 'the planner is offered the notice\'s button'); action = {ref: byLabel('Accept all').ref, operation: 'click', value: ''}; }
      else if (calls === 4) action = {ref: byLabel('Pricing').ref, operation: 'click', value: ''};
      else action = {ref: '', operation: 'done', value: ''};
      return {ok: true, json: async () => ({message: {content: JSON.stringify(action)}})};
    };
    const realLog = console.log; console.log = () => {};
    let result;
    try { result = await executeNaturalLanguageTask(page, 'Click the Pricing link.', {orchestratorOptions: {agentOptions: {maxSteps: 8}}}); }
    finally { console.log = realLog; }
    const run = result.execution?.result ?? {};
    assert.equal(result.status, 'verified_complete', JSON.stringify(run.reason ?? result.status));
    assert.equal(new URL(page.url()).pathname, '/pricing');
    assert.ok(calls >= 4, `the planner was asked again after the repeated covered click (calls=${calls})`);
    assert.equal(sawControls, true, 'the planner was told which buttons the notice offers');
    const blocked = (run.history ?? []).find(item => item.execution?.errorCode === 'ACTION_CLICK_BLOCKED');
    assert.deepEqual(blocked?.execution?.blockedBy?.controls?.slice(0, 2), ['Accept all', 'Manage options']);
    ok('covered click, repeated by the planner: the run reaches the notice\'s button and completes');
  }
  // 3. The notice's buttons stay choosable even when the page has many links that
  //    match the task's words far better.
  {
    const links = Array.from({length: 60}, (_, index) => ({ref: `e${index + 1}`, tag: 'a', label: `Pricing plan ${index + 1}`, href: `/p${index}`}));
    const notice = [{ref: 'e90', tag: 'button', label: 'Accept all'}, {ref: 'e91', tag: 'button', label: 'Manage options'}];
    const observation = {url: base + '/', title: 'Home', actionableElements: [...links, ...notice]};
    const without = buildCatalog(observation, [], null, 'Click the Pricing link.');
    assert.equal(without.some(item => item.ref === 'e90'), false, 'precondition: the ranking alone leaves the notice out');
    const history = [{decision: {ref: 'e1', operation: 'click'}, execution: {executionCompleted: false, errorCode: 'ACTION_CLICK_BLOCKED',
      blockedBy: {kind: 'dialog', name: 'Privacy', controls: ['Accept all', 'Manage options']}}}];
    let offered = [];
    globalThis.fetch = async (_url, request) => {
      offered = JSON.parse(JSON.parse(request.body).messages[1].content).availableElements ?? [];
      return {ok: true, json: async () => ({message: {content: JSON.stringify({ref: 'e90', operation: 'click', value: ''})}})};
    };
    await decideNextAction('Click the Pricing link.', observation, history, [], null, null);
    assert.ok(offered.some(item => item.ref === 'e90') && offered.some(item => item.ref === 'e91'), 'the planner is offered the notice\'s buttons');
    // once something went through, the notice is no longer special
    const resolved = [...history, {decision: {ref: 'e90', operation: 'click'}, execution: {executionCompleted: true, verified: true}}];
    globalThis.fetch = async (_url, request) => {
      offered = JSON.parse(JSON.parse(request.body).messages[1].content).availableElements ?? [];
      return {ok: true, json: async () => ({message: {content: JSON.stringify({ref: 'e1', operation: 'click', value: ''})}})};
    };
    await decideNextAction('Click the Pricing link.', observation, resolved, [], null, null);
    assert.equal(offered.some(item => item.ref === 'e90'), false, 'after the notice was dealt with, ranking is back to the task');
    ok('the buttons a covering notice offers stay in the planner\'s list until something goes through');
  }
  // 6. The agent knows the notice still stands (what was covered is still covered):
  //    its list of the notice's buttons is honoured even though an action has gone through.
  {
    const links = Array.from({length: 60}, (_, index) => ({ref: `e${index + 1}`, tag: 'a', label: `Pricing plan ${index + 1}`, href: `/p${index}`}));
    const notice = [{ref: 'e90', tag: 'button', label: 'Accept all'}, {ref: 'e91', tag: 'button', label: 'Manage options'}];
    const observation = {url: base + '/', title: 'Home', actionableElements: [...links, ...notice], overlayControls: ['Accept all', 'Manage options']};
    const history = [
      {decision: {ref: 'e1', operation: 'click'}, execution: {executionCompleted: false, errorCode: 'ACTION_CLICK_BLOCKED',
        blockedBy: {kind: 'dialog', name: 'Privacy', controls: ['Accept all', 'Manage options']}}},
      {decision: {ref: 'e92', operation: 'click'}, execution: {executionCompleted: true, verified: null}}];
    let offered = [];
    globalThis.fetch = async (_url, request) => {
      offered = JSON.parse(JSON.parse(request.body).messages[1].content).availableElements ?? [];
      return {ok: true, json: async () => ({message: {content: JSON.stringify({ref: 'e90', operation: 'click', value: ''})}})};
    };
    await decideNextAction('Click the Pricing link.', observation, history, [], null, null);
    assert.ok(offered.some(item => item.ref === 'e90'), 'the notice\'s buttons are offered while the agent says it stands');
    ok('the agent\'s own record of the standing notice outlasts an action that went through');
  }
  // 7. While a covering notice is unresolved, an action that has a name is given to the
  //    planner by that name alone: its ref names another element after the next
  //    observation, and a model copies it. At any other time the ref is given as before.
  {
    const actionable = [{ref: 'e1', tag: 'a', label: 'Pricing', href: '/pricing'}, {ref: 'e2', tag: 'a', label: 'About', href: '/about'}];
    const named = {decision: {ref: 'e254', operation: 'click'}, targetLabel: 'partners', execution: {executionCompleted: true, verified: null}};
    const covered = {decision: {ref: 'e17', operation: 'click'}, execution: {executionCompleted: false, errorCode: 'ACTION_CLICK_BLOCKED',
      blockedBy: {kind: 'dialog', name: 'Privacy', controls: ['Accept all']}}};
    let previous = [];
    globalThis.fetch = async (_url, request) => {
      previous = JSON.parse(JSON.parse(request.body).messages[1].content).previousActions ?? [];
      return {ok: true, json: async () => ({message: {content: JSON.stringify({ref: 'e1', operation: 'click', value: ''})}})};
    };
    let system = '';
    const capture = globalThis.fetch;
    globalThis.fetch = async (url, request) => { system = JSON.parse(request.body).messages[0].content; return capture(url, request); };
    // a notice stands (the agent says so): the named action carries no number
    await decideNextAction('Click the Pricing link.', {url: base + '/', title: 'Home', actionableElements: actionable, overlayControls: ['Accept all']}, [covered, named], [], {type: 'direct_instruction'}, null);
    assert.equal(previous[1].targetLabel, 'partners');
    assert.equal('ref' in previous[1], false, 'no number to copy while a notice stands');
    assert.equal(previous[0].ref, 'e17', 'an action with no name keeps its number');
    assert.match(system, /covering the page[\s\S]*NOT the same element now/, 'the planner is told, while a notice stands, that an earlier ref is not an element now');
    assert.match(system, /click takes no value/i);
    // no notice: exactly as before
    await decideNextAction('Click the Pricing link.', {url: base + '/', title: 'Home', actionableElements: actionable}, [named], [], {type: 'direct_instruction'}, null);
    assert.equal(previous[0].ref, 'e254', 'without a notice the number is given');
    assert.equal(previous[0].targetLabel, 'partners');
    assert.doesNotMatch(system, /covering the page|NOT the same element now|takes no value/i, 'without a notice the instructions carry no such rule');
    ok('a named earlier action loses its ref, and the planner is told why, only while a covering notice is unresolved');
  }
  console.log(`overlay-frame: ${passed} groups passed`);
} finally {
  globalThis.fetch = realFetch;
  await browser.close(); server.close();
}
