// A one-time code (or any secret the person types) is handled like a password:
// the model never types it, the run pauses for the person, and the run only
// goes on once the field really holds something. The value itself is never read,
// logged or sent to the model. A scripted model and a stand-in person are used.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { createActionApproval } from '../src/agent/action-approval.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

const CODE = '654321';        // what the person types
const MODEL_GUESS = '123456'; // what the model tries to type
const PASSWORD = 'pw-9Qx7';
const pages = {
  '/otp': `<title>Verify</title><h2>Verify</h2><div id="flash"></div><form onsubmit="if(this.code.value==='${CODE}'){location='/done'}else{document.getElementById('flash').textContent='Invalid code'}return false"><input name="code" aria-label="Verification code" autocomplete="one-time-code"><button type="submit">Verify</button></form>`,
  '/pw': `<title>Sign in</title><h2>Sign in</h2><div id="flash"></div><form onsubmit="if(this.password.value==='${PASSWORD}'){location='/done'}else{document.getElementById('flash').textContent='Wrong password'}return false"><input type="password" name="password" aria-label="Password"><button type="submit">Continue</button></form>`,
  '/done': '<title>Done</title><h2>Verified</h2><p>Your code was accepted.</p><a href="/otp">Back</a>'
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
const realFetch = globalThis.fetch; const realLog = console.log;
let passed = 0;
const ok = message => { passed += 1; console.log('PASS:', message); };

async function run({start, instruction, script, person, noProvider = false}) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(base + start);
  let calls = 0, handovers = 0;
  const prompts = [];
  globalThis.fetch = async (_url, request) => {
    prompts.push(String(request.body));
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    const step = script[calls++];
    const reply = action => ({ok: true, json: async () => ({message: {content: JSON.stringify(action)}})});
    if (!step) return reply({ref: '', operation: 'done', value: ''});
    const element = (payload.availableElements ?? []).find(item => step[0].test(String(item.label ?? '')));
    return reply(element ? {ref: element.ref, operation: step[1], value: step[2]} : {ref: 'e99', operation: 'click', value: ''});
  };
  console.log = () => {};
  let result;
  try {
    result = await executeNaturalLanguageTask(page, instruction, {orchestratorOptions: {agentOptions: {
      maxSteps: 8,
      ...(noProvider ? {} : {humanHandoverProvider: async ({targetHandle}) => { handovers += 1; return person(targetHandle); }}),
      approvalProvider: async ctx => createActionApproval(ctx.action, {pageUrl: ctx.pageUrl, targetIdentity: ctx.targetIdentity})
    }}});
  } finally { console.log = realLog; }
  const agent = result.execution?.result ?? {};
  const fieldValue = await page.locator('input').first().inputValue().catch(() => null);
  return {result, agent, handovers, prompts, fieldValue,
    ops: (agent.history ?? []).map(entry => entry.decision.operation),
    final: String(agent.finalUrl ?? '').replace(base, '')};
}

const OTP = {start: '/otp', instruction: 'Enter the verification code and click Verify',
  script: [[/Verification/, 'fill', MODEL_GUESS], [/^Verify$/, 'click', '']]};
const PW = {start: '/pw', instruction: 'Sign in and click Continue',
  script: [[/Password/, 'fill', MODEL_GUESS], [/^Continue$/, 'click', '']]};
const typing = value => async handle => { await handle.fill(value); return {completed: true}; };

try {
  {
    const r = await run({...OTP, person: typing(CODE)});
    assert.equal(r.result.status, 'verified_complete', JSON.stringify(r.agent.reason ?? r.result.status));
    assert.deepEqual(r.ops, ['human_handover', 'click']);
    assert.equal(r.final, '/done');
    assert.equal(r.handovers, 1);
    assert.equal(r.agent.history[0].execution.verified, true, 'the entry shows the field was filled');
    assert.equal(r.prompts.some(text => text.includes(CODE)), false, 'the typed code never reaches the model');
    ok('one-time code: person types it, the run continues and completes');
  }
  {
    const r = await run({...OTP, person: async () => ({completed: true})});
    assert.equal(r.result.status, 'human_handover_unverified', JSON.stringify(r.result.status));
    assert.deepEqual(r.ops, []);
    assert.equal(r.final, '/otp');
    assert.equal(r.fieldValue, '', 'the model never typed its own guess into the field');
    ok('one-time code: "done" with an empty field is not accepted, nothing is submitted');
  }
  {
    const r = await run({...OTP, person: async () => ({completed: false})});
    assert.equal(r.result.status, 'human_handover_required');
    assert.deepEqual(r.ops, []);
    assert.equal(r.fieldValue, '');
    ok('one-time code: person does not complete -> run stays paused');
  }
  {
    const r = await run({...OTP, noProvider: true});
    assert.equal(r.result.status, 'human_handover_required');
    assert.equal(r.fieldValue, '');
    ok('one-time code: no way to ask a person -> run stops, nothing typed');
  }
  {
    const r = await run({...OTP, person: typing('000000')});
    assert.equal(r.result.status, 'secret_entry_rejected', JSON.stringify(r.agent.reason ?? r.result.status));
    assert.equal(r.final, '/otp');
    assert.equal(r.agent.pageMessage, 'Invalid code', "the site's own words are reported");
    ok('one-time code: a wrong code typed by the person is not a success');
  }
  {
    const r = await run({...PW, person: async () => ({completed: true})});
    assert.equal(r.result.status, 'human_handover_unverified');
    assert.deepEqual(r.ops, []);
    ok('password: "done" with an empty field is still not accepted');
  }
  {
    const r = await run({...PW, person: typing(PASSWORD)});
    assert.equal(r.result.status, 'verified_complete', JSON.stringify(r.agent.reason ?? r.result.status));
    assert.equal(r.prompts.some(text => text.includes(PASSWORD)), false, 'the typed password never reaches the model');
    ok('password: person types it, the run completes, the model never sees it');
  }
  console.log(`handover-typed-secrets: ${passed} groups passed`);
} finally {
  globalThis.fetch = realFetch;
  await browser.close(); server.close();
}
