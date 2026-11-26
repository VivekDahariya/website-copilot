// Direct-instruction mode with the REAL planner code (local-reasoner.js) and a
// stand-in model endpoint. Replays behaviour seen from the real local model:
// it finishes the work, then keeps re-proposing an edit that is already done.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { verifyDirectCompletion } from '../src/agent/direct-instruction.js';

const browser = await chromium.launch({headless:true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM}:{}),
  args:['--no-sandbox']});

const form = `<!doctype html><html><head><title>Profile form</title></head><body>
<h1>Profile</h1>
<form onsubmit="event.preventDefault();document.title='SUBMITTED'">
<label>Username <input name="username" aria-label="Username"></label>
<label>City <input name="city" aria-label="City" value="Raipur"></label>
<label>Checkbox 2 <input type="checkbox" name="second" checked></label>
<label>Plan <select name="plan" aria-label="Plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
<button type="submit">Submit</button></form></body></html>`;
const instruction = 'Fill Username with "Atlas Research" and select "Pro" from Plan. Do not submit.';

const realFetch = globalThis.fetch;
const previousFlag = process.env.COPILOT_DIRECT_INSTRUCTION;
let passed = 0;
const ok = message => { passed += 1; console.log('PASS:', message); };

// script(payload, helpers) returns the model's next JSON decision.
async function run(script) {
  const seen = {calls:0, goalSent:false, directPrompt:true, feedback:[]};
  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    const payload = JSON.parse(body.messages[1].content);
    seen.calls += 1;
    if ('goal' in payload || 'goalVerification' in payload) seen.goalSent = true;
    if (!body.messages[0].content.includes('Decide only the next action')) seen.directPrompt = false;
    if (payload.completionFeedback) seen.feedback.push(payload.completionFeedback);
    const el = label => payload.availableElements.find(e => e.label === label);
    const selects = (payload.previousActions ?? []).filter(a => a.operation === 'select').length;
    const decision = script(payload, {el, selects});
    return {ok:true, json: async () => ({message:{content:JSON.stringify(decision)}})};
  };
  const page = await browser.newPage(); await page.setContent(form);
  try {
    const result = await executeNaturalLanguageTask(page, instruction,
      {orchestratorOptions:{agentOptions:{maxSteps:8}}});
    const state = {
      username: await page.locator('[name=username]').inputValue(),
      city: await page.locator('[name=city]').inputValue(),
      second: await page.locator('[name=second]').isChecked(),
      plan: await page.locator('[name=plan]').inputValue(),
      title: await page.title()
    };
    return {result, run: result.execution?.result ?? {}, state, seen};
  } finally { await page.close(); }
}

try {
  process.env.COPILOT_DIRECT_INSTRUCTION = '1';
  const fillUser = el => ({ref:el('Username').ref, operation:'fill', value:'Atlas Research'});

  // 1. Observed real-model behaviour: work finished, then a repeated edit.
  {
    const {result, run: agent, state, seen} = await run((payload, {el, selects}) =>
      !el('Username').currentValue ? fillUser(el)
        : selects === 0 ? {ref:el('Plan').ref, operation:'select', value:'pro'}
        : {ref:el('Plan').ref, operation:'select', value:'Pro'});
    assert.equal(result.status,'verified_complete',JSON.stringify(result.reason ?? agent.reason));
    assert.deepEqual(agent.history.map(e=>e.decision.operation),['fill','select']);
    assert.equal(seen.calls,3,'no wasted repair calls');
    assert.equal(seen.goalSent,false,'no structured goal may reach the model');
    assert.equal(seen.directPrompt,true);
    assert.deepEqual(state,{username:'Atlas Research',city:'Raipur',second:true,plan:'pro',title:'Profile form'});
    ok('repeating a finished edit triggers the evidence check and completes (no stagnation)');
  }

  // 2. Same symptom while work is still missing must NOT complete.
  {
    const {result, state, seen} = await run((payload, {el}) => fillUser(el));
    assert.equal(result.status,'unverified_completion_claim',JSON.stringify(result.status));
    assert.match(String(result.reason ?? result.execution?.result?.reason),/pro/i);
    assert.equal(state.plan,'free');
    assert(seen.feedback.length > 0,'the model was told what is missing');
    ok('repeating a finished edit with work missing is reported, never accepted');
  }

  // 3. The feedback lets the model finish the missing part.
  {
    const {result, run: agent, state} = await run((payload, {el, selects}) =>
      !el('Username').currentValue ? fillUser(el)
        : payload.completionFeedback && selects === 0
          ? {ref:el('Plan').ref, operation:'select', value:'Pro'}
          : fillUser(el));
    assert.equal(result.status,'verified_complete',JSON.stringify(result.reason ?? agent.reason));
    assert.deepEqual(agent.history.map(e=>e.decision.operation),['fill','select']);
    assert.equal(state.plan,'pro');
    ok('rejection reason reaches the model; it completes the missing step');
  }

  // 4. Unusable planner output after the work is done still ends correctly.
  {
    const {result, state} = await run((payload, {el, selects}) =>
      !el('Username').currentValue ? fillUser(el)
        : selects === 0 ? {ref:el('Plan').ref, operation:'select', value:'Pro'}
        : {ref:'e999', operation:'click', value:''});
    assert.equal(result.status,'verified_complete',JSON.stringify(result.status));
    assert.equal(state.title,'Profile form');
    ok('planner failure after finished work is resolved by browser evidence');
  }

  // 5. Unusable planner output with work missing stays a failure.
  {
    const {result} = await run(() => ({ref:'e999', operation:'click', value:''}));
    assert.notEqual(result.status,'verified_complete');
    ok('planner failure with nothing done is never reported as success');
  }

  // 6. A short quoted value must match as a whole word, not inside another.
  {
    const observation = {url:'https://x.test/', title:'Profile form', headings:['Profile'],
      visibleBodyText:'Profile', actionableElements:[
        {ref:'e1',tag:'select',label:'Plan',currentValue:'free'}]};
    const click = {decision:{ref:'e9',operation:'click',value:''}, targetLabel:'Plan',
      execution:{executionCompleted:true,verified:true}};
    const verdict = verifyDirectCompletion({
      instruction:'Select "Pro" from Plan.', observation, history:[click]});
    assert.equal(verdict.completed,false);
    assert.deepEqual(verdict.evidence.missing,['Pro']);
    ok('"Pro" is not satisfied by the word "Profile"');
  }

  // 7. Seen live: after a click that changed nothing, the model proposes the
  // same click again. That means it has nothing new to do, so completion is
  // checked from the browser at once instead of spending more model calls.
  {
    let calls = 0;
    globalThis.fetch = async (_url, request) => {
      const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
      calls += 1;
      const target = payload.availableElements.find(e => e.label === 'Show details');
      return {ok:true, json: async () => ({message:{content:JSON.stringify(
        {ref:target?.ref ?? 'e1', operation:'click', value:'Show details'})}})};
    };
    const page = await browser.newPage();
    const detailsHtml = `<!doctype html><html><head><title>Details</title></head><body>
<h1>Details</h1><p>Order details are listed on this page for reference.</p>
<button type="button">Show details</button><a href="#more">More</a></body></html>`;
    await page.setContent(detailsHtml);
    try {
      // The plain wording is a single named control: once it is clicked the
      // agent proposes done itself, so the planner is asked only once.
      const plain = await executeNaturalLanguageTask(page,
        'Click the "Show details" button.',
        {orchestratorOptions:{agentOptions:{maxSteps:8}}});
      assert.equal(plain.status,'verified_complete');
      assert.equal(plain.execution.result.history.filter(h => h.decision.operation === 'click').length,1);
      assert.equal(calls,1,'a named control that was clicked needs no second planner call');
      ok('a clicked named control ends the run after one planner call');

      // A wording that names no control is not a step the planner can tick off
      // itself, so it still reaches the repeat check.
      calls = 0;
      await page.setContent(detailsHtml);
      const result = await executeNaturalLanguageTask(page,
        'Click the first button on the page.',
        {orchestratorOptions:{agentOptions:{maxSteps:8}}});
      const run = result.execution?.result ?? {};
      assert.equal(result.status,'verified_complete');
      assert.equal(run.history.filter(h => h.decision.operation === 'click').length,1);
      assert.equal(calls,2,'one call to act, one to notice nothing is left');
      ok('repeating an action that changed nothing triggers the completion check, not more planning');
    } finally { await page.close(); }
  }

  console.log(`direct-instruction-planner: ${passed} groups passed`);
} finally {
  globalThis.fetch = realFetch;
  if (previousFlag === undefined) delete process.env.COPILOT_DIRECT_INSTRUCTION;
  else process.env.COPILOT_DIRECT_INSTRUCTION = previousFlag;
  await browser.close();
}
