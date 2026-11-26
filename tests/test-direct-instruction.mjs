// Direct-instruction mode: no structured goal. Real Chromium, scripted planner.
// Proves: (1) tasks run and complete without any goal, (2) a "done" claim is
// never accepted without browser evidence, (3) form protection still holds.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runAgent } from '../src/agent/agent.js';
import { executeTask } from '../src/agent/task-orchestrator.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { createActionApproval } from '../src/agent/action-approval.js';
import {
  DIRECT_INSTRUCTION_GOAL, verifyDirectCompletion, createDirectFormScope,
  splitInstruction
} from '../src/agent/direct-instruction.js';

const browser = await chromium.launch({headless:true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM}:{}),
  args:['--no-sandbox']});

const form = `<!doctype html><html><head><title>Profile form</title></head><body>
<h1>Profile</h1>
<form id="f" onsubmit="event.preventDefault();document.body.innerHTML='<h1>Thank you</h1><p>Your profile was submitted successfully.</p>'">
<label>Username <input name="username" aria-label="Username"></label>
<label>City <input name="city" aria-label="City" value="Raipur"></label>
<label>Checkbox 1 <input type="checkbox" name="first"></label>
<label>Checkbox 2 <input type="checkbox" name="second" checked></label>
<label>Plan <select name="plan" aria-label="Plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
<button type="submit">Submit</button></form></body></html>`;

const pick = (obs,label,operation,value='') => {
  const element = obs.actionableElements.find(e => e.label === label);
  assert(element, `Missing control: ${label}`);
  return {ref:element.ref, operation, value};
};
const done = (value='') => ({ref:'', operation:'done', value});
let passed = 0;
const ok = message => { passed += 1; console.log('PASS:', message); };

try {
  // 1. Completes with no structured goal; evidence comes from the browser.
  {
    const page = await browser.newPage(); await page.setContent(form);
    const instruction = 'Fill Username with "Atlas Research" and check the first checkbox. Do not submit.';
    const reasoner = async (_t, obs) => {
      if (!obs.actionableElements.find(e=>e.label==='Username').currentValue)
        return pick(obs,'Username','fill','Atlas Research');
      if (!obs.actionableElements.find(e=>e.label==='Checkbox 1').checked)
        return pick(obs,'Checkbox 1','check');
      return done('Atlas Research');
    };
    const result = await runAgent(page, instruction, DIRECT_INSTRUCTION_GOAL, {reasoner, maxSteps:6});
    assert.equal(result.status,'verified_complete',JSON.stringify(result.reason));
    assert.equal(result.verification.evidence.direct,true);
    assert.deepEqual(result.history.map(e=>e.decision.operation),['fill','check']);
    assert.equal(await page.locator('[name=username]').inputValue(),'Atlas Research');
    assert.equal(await page.locator('[name=first]').isChecked(),true);
    assert.equal(await page.locator('[name=second]').isChecked(),true);
    assert.equal(await page.locator('[name=city]').inputValue(),'Raipur');
    assert.equal(await page.locator('h1').innerText(),'Profile','form must not be submitted');
    await page.close();
    ok('goal-free run completes from browser evidence; untouched fields preserved; not submitted');
  }

  // 2. A model that says "done" immediately is never believed.
  {
    const page = await browser.newPage(); await page.setContent(form);
    const result = await runAgent(page,
      'Fill Username with "Atlas Research".', DIRECT_INSTRUCTION_GOAL,
      {reasoner: async () => done('Profile'), maxSteps:4});
    assert.equal(result.status,'unverified_completion_claim',JSON.stringify(result));
    assert.equal(result.history.length,0);
    assert.match(result.reason,/Atlas Research/);
    assert.equal(await page.locator('[name=username]').inputValue(),'');
    await page.close();
    ok('immediate "done" with no action is rejected (false success blocked)');
  }

  // 3. Premature "done" after only part of the work is rejected, then the
  //    agent continues and finishes when the evidence exists.
  {
    const page = await browser.newPage(); await page.setContent(form);
    let prematureClaims = 0, feedbackSeen = false;
    const reasoner = async (_t, obs, history, rejected) => {
      if (rejected.some(a => a.operation==='done' && a.reason)) feedbackSeen = true;
      if (!obs.actionableElements.find(e=>e.label==='Username').currentValue)
        return pick(obs,'Username','fill','Atlas Research');
      if (obs.actionableElements.find(e=>e.label==='Plan').selectedLabel !== 'Pro') {
        if (prematureClaims === 0 && !rejected.length) { prematureClaims += 1; return done('Atlas Research'); }
        return pick(obs,'Plan','select','Pro');
      }
      return done('Pro');
    };
    const result = await runAgent(page,
      'Fill Username with "Atlas Research" and select "Pro" from Plan.',
      DIRECT_INSTRUCTION_GOAL, {reasoner, maxSteps:6});
    assert.equal(result.status,'verified_complete',JSON.stringify(result.reason));
    assert.equal(prematureClaims,1); assert.equal(feedbackSeen,true);
    assert.deepEqual(result.history.map(e=>e.decision.operation),['fill','select']);
    assert.equal(await page.locator('[name=plan]').inputValue(),'pro');
    await page.close();
    ok('premature "done" rejected with a reason; run continues to verified completion');
  }

  // 4. Existing information is protected without any goal.
  {
    const page = await browser.newPage(); await page.setContent(form);
    const result = await runAgent(page,
      'Fill Username with "Atlas Research".', DIRECT_INSTRUCTION_GOAL,
      {reasoner: async (_t, obs) => pick(obs,'Checkbox 2','uncheck'), maxSteps:2});
    assert.notEqual(result.status,'verified_complete');
    assert.equal(result.history.length,0);
    assert.equal(await page.locator('[name=second]').isChecked(),true);
    const overwrite = await browser.newPage(); await overwrite.setContent(form);
    const second = await runAgent(overwrite,
      'Fill Username with "Atlas Research".', DIRECT_INSTRUCTION_GOAL,
      {reasoner: async (_t, obs) => pick(obs,'City','fill','Delhi'), maxSteps:2});
    assert.notEqual(second.status,'verified_complete');
    assert.equal(await overwrite.locator('[name=city]').inputValue(),'Raipur');
    await page.close(); await overwrite.close();
    ok('unrequested change to a pre-checked box and a pre-filled field is refused');
  }

  // 5. "Leave the second checkbox unchanged" protects it; it is not a request.
  {
    const page = await browser.newPage(); await page.setContent(form);
    let refused = false;
    const reasoner = async (_t, obs, history, rejected) => {
      if (!history.length && !rejected.length) return pick(obs,'Checkbox 2','uncheck');
      if (rejected.some(a => a.operation==='uncheck')) refused = true;
      if (!obs.actionableElements.find(e=>e.label==='Checkbox 1').checked)
        return pick(obs,'Checkbox 1','check');
      return done('Checkbox 1');
    };
    const result = await runAgent(page,
      'Check the first checkbox. Leave the second checkbox unchanged.',
      DIRECT_INSTRUCTION_GOAL, {reasoner, maxSteps:5});
    assert.equal(result.status,'verified_complete',JSON.stringify(result.reason));
    assert.equal(refused,true);
    assert.equal(await page.locator('[name=second]').isChecked(),true);
    assert.equal(await page.locator('[name=first]').isChecked(),true);
    await page.close();
    ok('protective clause blocks the edit and is not treated as work to do');
  }

  // 6. Page-side mutation of an unrelated control is still caught.
  {
    const page = await browser.newPage(); await page.setContent(form);
    await page.evaluate(() => document.querySelector('[name=first]')
      .addEventListener('change', () => { document.querySelector('[name=second]').checked = false; }));
    const result = await runAgent(page, 'Check the first checkbox.',
      DIRECT_INSTRUCTION_GOAL,
      {reasoner: async (_t, obs) => pick(obs,'Checkbox 1','check'), maxSteps:2});
    assert.equal(result.status,'protected_form_state_changed',JSON.stringify(result.status));
    await page.close();
    ok('unexpected page-side change to a protected control is reported, not hidden');
  }

  // 7. Multi-page navigation, then completion on the destination evidence.
  {
    const context = await browser.newContext();
    await context.route('http://site.test/**', route => {
      const path = new URL(route.request().url()).pathname;
      const body = path === '/pricing'
        ? '<title>Pricing</title><h1>Pricing</h1><p>Team plan costs 20 dollars.</p><a href="/">Home</a>'
        : '<title>Home</title><h1>Welcome</h1><a href="/pricing">Pricing</a><a href="/docs">Docs</a>';
      route.fulfill({contentType:'text/html', body:`<!doctype html><html><body>${body}</body></html>`});
    });
    const page = await context.newPage(); await page.goto('http://site.test/');
    const reasoner = async (_t, obs) => /pricing/.test(obs.url)
      ? done('Team plan costs 20 dollars') : pick(obs,'Pricing','click');
    const result = await runAgent(page, 'Open the Pricing page.',
      DIRECT_INSTRUCTION_GOAL, {reasoner, maxSteps:4});
    assert.equal(result.status,'verified_complete',JSON.stringify(result.reason));
    assert.match(page.url(),/\/pricing$/);
    const wrong = await context.newPage(); await wrong.goto('http://site.test/');
    const stay = await runAgent(wrong, 'Open the Billing page.',
      DIRECT_INSTRUCTION_GOAL, {reasoner: async () => done('Welcome'), maxSteps:3});
    assert.equal(stay.status,'unverified_completion_claim');
    assert.match(stay.reason,/billing/i);
    await context.close();
    ok('navigation completes on destination evidence; a wrong-page "done" is rejected');
  }

  // 8. Requested submit: must actually happen and be confirmed by the page.
  {
    const page = await browser.newPage(); await page.setContent(form);
    const early = await runAgent(page,
      'Fill Username with "Atlas Research" and submit the form.',
      DIRECT_INSTRUCTION_GOAL, {
        reasoner: async (_t, obs) =>
          obs.actionableElements.find(e=>e.label==='Username').currentValue
            ? done('Atlas Research') : pick(obs,'Username','fill','Atlas Research'),
        maxSteps:4
      });
    assert.equal(early.status,'unverified_completion_claim',JSON.stringify(early.status));
    assert.match(early.reason,/submit/i);
    assert.equal(await page.locator('h1').innerText(),'Profile');
    await page.close();
    ok('"done" before the requested submit is rejected; nothing was submitted');
  }

  // 9. Orchestrator accepts a direct task with no goal object.
  {
    await assert.rejects(() => executeTask({}, {type:'direct_instruction', instruction:'  '}),
      /requires an instruction/);
    await assert.rejects(() => executeTask({}, {type:'browser_goal', instruction:'x'}),
      /requires instruction and goal/);
    ok('orchestrator: direct task needs only an instruction; goal tasks unchanged');
  }

  // 10. Unit checks of the evidence rules.
  {
    const obs = {url:'https://x.test/a', title:'A', headings:['Profile'],
      visibleBodyText:'Profile', actionableElements:[
        {ref:'e1',tag:'input',type:'text',editable:true,label:'Username',currentValue:'Atlas Research'}]};
    const fill = {decision:{ref:'e1',operation:'fill',value:'Atlas Research'}, targetLabel:'Username',
      execution:{executionCompleted:true,verified:true,previousUrl:obs.url,urlAfter:obs.url}};
    const base = {instruction:'Fill Username with "Atlas Research".', observation:obs};
    assert.equal(verifyDirectCompletion({...base, history:[fill]}).completed,true);
    assert.equal(verifyDirectCompletion({...base, history:[]}).completed,false);
    assert.equal(verifyDirectCompletion({...base, history:[fill],
      preservation:{verified:false,issues:[{}]}}).completed,false);
    assert.equal(verifyDirectCompletion({...base, history:[
      {...fill, execution:{executionCompleted:false,verified:false}}]}).completed,false);
    assert.equal(verifyDirectCompletion({...base, history:[fill],
      workflow:{explicitFailureEvidence:true}}).completed,false);
    assert.equal(verifyDirectCompletion({...base, history:[fill],
      workflow:{requiresFinalizingAction:true,finalizingActionObserved:false}}).completed,false);
    assert.equal(verifyDirectCompletion({...base, history:[fill],
      observation:{...obs, actionableElements:[{...obs.actionableElements[0],currentValue:'Atlas'}]}}).completed,
      true, 'verified fill value is browser-returned evidence');
    assert.equal(splitInstruction('Check A. Do not submit.').positive.includes('submit'),false);
    const scope = createDirectFormScope('Check the first checkbox. Leave the second checkbox unchanged.');
    assert.equal(scope.reject({type:'checkbox',ordinal:1,label:'Checkbox 1',checked:false},{operation:'check'}),null);
    assert.equal(scope.reject({type:'checkbox',ordinal:2,label:'Checkbox 2',checked:true},{operation:'uncheck'}),'protected_unchanged_field');
    const open = createDirectFormScope('Sign up for the newsletter.');
    assert.equal(open.reject({tag:'input',type:'text',editable:true,label:'Email',currentValue:''},{operation:'fill',value:'a@b.c'}),null);
    assert.equal(open.reject({tag:'input',type:'text',editable:true,label:'Email',currentValue:'old@b.c'},{operation:'fill',value:'a@b.c'}),'unrequested_form_field_change');
    ok('evidence rules: vetoes, missing actions and protected fields all fail closed');
  }

  // 11. Requested submit still needs approval; with approval the result is
  //     judged from the confirmation page, not from the click.
  {
    const context = await browser.newContext();
    await context.route('http://form.test/**', route => {
      const path = new URL(route.request().url()).pathname;
      const body = path === '/done'
        ? '<title>Done</title><h1>Thank you</h1><p>Your profile was submitted successfully for Atlas Research.</p>'
        : '<title>Profile form</title><h1>Profile</h1><form action="/done" method="get"><label>Username <input name="username" aria-label="Username"></label><button type="submit">Submit</button></form>';
      route.fulfill({contentType:'text/html', body:`<!doctype html><html><body>${body}</body></html>`});
    });
    const reasoner = async (_t, obs) => /\/done/.test(obs.url) ? done('Thank you')
      : !obs.actionableElements.find(e=>e.label==='Username').currentValue
        ? pick(obs,'Username','fill','Atlas Research') : pick(obs,'Submit','click');
    const instruction = 'Fill Username with "Atlas Research" and submit the form.';

    const denied = await context.newPage(); await denied.goto('http://form.test/');
    const refused = await runAgent(denied, instruction, DIRECT_INSTRUCTION_GOAL,
      {reasoner, maxSteps:5, approvalProvider: async () => null});
    assert.equal(refused.status,'approval_required');
    assert.equal(denied.url(),'http://form.test/');

    const granted = await context.newPage(); await granted.goto('http://form.test/');
    let approvals = 0;
    const result = await runAgent(granted, instruction, DIRECT_INSTRUCTION_GOAL, {
      reasoner, maxSteps:5,
      approvalProvider: async ctx => { approvals += 1;
        return createActionApproval(ctx.action,{pageUrl:ctx.pageUrl,targetIdentity:ctx.targetIdentity}); }
    });
    assert.equal(result.status,'verified_complete',JSON.stringify(result.reason ?? result.status));
    assert.equal(approvals,1);
    assert.deepEqual(result.history.map(e=>e.decision.operation),['fill','click']);
    assert.match(granted.url(),/\/done\?username=Atlas\+Research$/);
    await context.close();
    ok('submit without approval is not executed; approved submit is verified from the result page');
  }

  // 12. Routing: with the flag on, no interpreter call is made at all.
  {
    const previous = process.env.COPILOT_DIRECT_INSTRUCTION;
    let interpreterCalls = 0;
    const interpreterOptions = {fetchImpl: async () => { interpreterCalls += 1; throw new Error('offline'); }};
    const reasoner = async (_t, obs) =>
      obs.actionableElements.find(e=>e.label==='Username').currentValue
        ? done('Atlas Research') : pick(obs,'Username','fill','Atlas Research');
    try {
      process.env.COPILOT_DIRECT_INSTRUCTION = '1';
      const page = await browser.newPage(); await page.setContent(form);
      const result = await executeNaturalLanguageTask(page,
        'Fill Username with "Atlas Research". Do not submit.',
        {interpreterOptions, orchestratorOptions:{agentOptions:{reasoner, maxSteps:4}}});
      assert.equal(result.status,'verified_complete',JSON.stringify(result.reason ?? result.status));
      assert.equal(interpreterCalls,0,'interpreter must not run in direct mode');
      assert.equal(result.interpretedTask?.goal,undefined);
      await page.close();

      // Default (no setting at all) is direct mode.
      delete process.env.COPILOT_DIRECT_INSTRUCTION;
      const byDefault = await browser.newPage(); await byDefault.setContent(form);
      const defaulted = await executeNaturalLanguageTask(byDefault,
        'Fill Username with "Atlas Research". Do not submit.',
        {interpreterOptions, orchestratorOptions:{agentOptions:{reasoner, maxSteps:4}}});
      assert.equal(defaulted.status,'verified_complete',JSON.stringify(defaulted.reason ?? defaulted.status));
      assert.equal(interpreterCalls,0,'interpreter must not run by default');
      await byDefault.close();

      process.env.COPILOT_DIRECT_INSTRUCTION = '0';
      const legacy = await browser.newPage(); await legacy.setContent(form);
      // Flag set to 0: the existing interpreter path is untouched, including
      // its behavior when the model is unreachable.
      const before = await executeNaturalLanguageTask(legacy,
        'Tidy up this profile somehow.',
        {interpreterOptions, orchestratorOptions:{agentOptions:{reasoner, maxSteps:2}}})
        .catch(error => ({status:'threw', reason:error.message}));
      assert.notEqual(before.status,'verified_complete');
      assert(interpreterCalls > 0,'default path is unchanged and still interprets');
      await legacy.close();
    } finally {
      if (previous === undefined) delete process.env.COPILOT_DIRECT_INSTRUCTION;
      else process.env.COPILOT_DIRECT_INSTRUCTION = previous;
    }
    ok('direct mode on by default; interpreter runs only with the flag set to 0');
  }

  console.log(`direct-instruction: ${passed} groups passed`);
} finally {
  await browser.close();
}
