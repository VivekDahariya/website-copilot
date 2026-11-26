// Multi-tab work through the direct loop. A scripted stand-in model picks
// the action a correct planner would pick; tab handling, execution and the
// completion check are real. A link that opens a new tab puts that tab in
// front, as in any browser, and a task that names a tab must end on it.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

const pages = {
  '/': '<title>Opening a new window</title><h3>Opening a new window</h3><a href="/new" target="_blank">Click Here</a><p>Main page text.</p>',
  '/new': '<title>New Window</title><h3>New Window</h3><p>Fresh content.</p><a href="/third">Details</a>',
  '/third': '<title>Details</title><h3>Details page</h3>'
};
const server = http.createServer((request, response) => {
  const body = pages[request.url];
  response.writeHead(body ? 200 : 404, {'content-type':'text/html'});
  response.end(body ? `<!doctype html><html><body>${body}</body></html>` : 'missing');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// TAB_BACK = switch to the tab that is not in front.
const cases = [
 {name:'new tab is followed', instruction:'Click the "Click Here" link to open the new window.',
  script:[[/Click Here/,'click']], expect:'verified_complete', ops:['click'], final:'/new'},
 {name:'work continues in the new tab', instruction:'Click the "Click Here" link, and in the new tab click "Details".',
  script:[[/Click Here/,'click'],[/Details/,'click']], expect:'verified_complete', ops:['click','click'], final:'/third'},
 {name:'switch back to the first tab', instruction:'Click the "Click Here" link, then switch back to the first tab.',
  script:[[/Click Here/,'click'],['TAB_BACK','switch_tab']], expect:'verified_complete', ops:['click','switch_tab'], final:'/'},
 {name:'destination tab given in the wrong field', instruction:'Click the "Click Here" link, then switch back to the first tab.',
  script:[[/Click Here/,'click'],['TAB_BACK_MISPLACED','switch_tab']], expect:'verified_complete', ops:['click','switch_tab'], final:'/'},
 {name:'switching to the tab already in front is not an action', instruction:'Click the "Click Here" link to open the new window.',
  script:[[/Click Here/,'click'],['TAB_SAME','switch_tab'],['TAB_SAME','switch_tab']], expect:'verified_complete', ops:['click'], final:'/new', maxCalls:2},
 // The task says to end on the first tab; stopping on the new tab is not done.
 {name:'not on the first tab is not complete', instruction:'Click the "Click Here" link, then switch back to the first tab.',
  script:[[/Click Here/,'click']], expect:'unverified_completion_claim', ops:['click'], final:'/new',
  reason:/not on the first tab/},
];

const browser = await chromium.launch({headless:true});
const realFetch = globalThis.fetch; const realLog = console.log;
let passed = 0;
try {
  for (const c of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base + '/');
    let calls = 0;
    globalThis.fetch = async (_url, request) => {
      const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
      const step = c.script[calls++];
      const reply = action => ({ok:true, json: async () => ({message:{content:JSON.stringify(action)}})});
      if (!step) return reply({ref:'', operation:'done', value:''});
      // Seen live: the tab in front in "ref", the wanted tab in "value".
      if (step[0] === 'TAB_BACK_MISPLACED') {
        const tabs = payload.availableTabs ?? [];
        return reply({ref:tabs.find(item => item.active)?.ref, operation:'switch_tab',
          value:tabs.find(item => item.active === false)?.ref});
      }
      // Seen live: asking to switch to the tab that is already in front.
      if (step[0] === 'TAB_SAME') {
        const active = (payload.availableTabs ?? []).find(item => item.active);
        return reply({ref:active?.ref, operation:'switch_tab', value:active?.ref});
      }
      if (step[0] === 'TAB_BACK') {
        const tab = (payload.availableTabs ?? []).find(item => item.active === false);
        assert.ok(tab, `${c.name}: the planner is shown the other tab`);
        return reply({ref:tab.ref, operation:'switch_tab', value:''});
      }
      const element = (payload.availableElements ?? []).find(item => step[0].test(String(item.label ?? '')));
      assert.ok(element, `${c.name}: the planner is shown "${step[0].source}" on the tab in front`);
      return reply({ref:element.ref, operation:step[1], value:''});
    };
    console.log = () => {};
    let result;
    try {
      result = await executeNaturalLanguageTask(page, c.instruction,
        {orchestratorOptions:{agentOptions:{maxSteps:6}}});
    } finally { console.log = realLog; }
    const run = result.execution?.result ?? {};
    assert.equal(result.status, c.expect, `${c.name}: ${run.reason ?? ''}`);
    assert.deepEqual((run.history ?? []).map(entry => entry.decision.operation), c.ops, c.name);
    assert.equal(String(run.finalUrl ?? '').replace(base, ''), c.final, `${c.name}: tab in front at the end`);
    if (c.maxCalls) assert.ok(calls <= c.maxCalls, `${c.name}: ${calls} model calls`);
    if (c.reason) assert.match(String(run.reason ?? ''), c.reason, c.name);
    await context.close();
    passed += 1;
    console.log(`PASS: ${c.name} -> ${result.status}`);
  }
  console.log(`direct-instruction-tabs: ${passed} groups passed`);
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close();
  server.close();
}
