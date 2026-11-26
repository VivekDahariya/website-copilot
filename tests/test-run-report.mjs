// Run report: code decides the facts and the pass/fail verdict; the local
// model only words them. A text that contradicts the record is never shown.
// Uses a stand-in model endpoint and real Chromium for the dashboard part.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  collectRunExplanationEvidence, collectCompletionChecks, collectRunSteps,
  collectRunContext, buildRunFacts, findContradiction, explainRun
} from '../src/ui/run-explanation.js';

let passed = 0;
const ok = message => { passed += 1; console.log('PASS:', message); };
const edge = (operation, label) => ({from:'a', to:'b', operation, label, status:'observed_after_action'});
const stateFor = (status, extra = {}) => ({
  phase:'finished', url:'https://shop.example/checkboxes',
  result:{status, ...extra},
  actionTree:{nodes:[{id:'a',title:'Start'},{id:'b',title:'Start'}],
    edges: extra.edges ?? [edge('click','Checkboxes'), edge('check','Checkbox 1')]},
  activity:[]
});
const allChecks = [
  'form_state_preserved','last_action_succeeded','no_explicit_failure',
  'quoted_values_present','instruction_words_evidenced','requested_change_performed',
  'every_numbered_target_handled','action_effects_still_visible'
].map(check => ({check, passed:true, relevant:true}));

// replies: one model answer per call, in order.
async function explain(state, replies) {
  const calls = [];
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    calls.push(body);
    const reply = replies[Math.min(calls.length, replies.length) - 1];
    if (reply instanceof Error) throw reply;
    return {ok:true, json: async () => ({message:{content:JSON.stringify(reply)}})};
  };
  const result = await explainRun(collectRunExplanationEvidence(state), {
    checks: collectCompletionChecks(state), steps: collectRunSteps(state), fetchImpl
  }).then(value => ({value}), error => ({error}));
  return {...result, calls};
}

const goodPass = {
  whatHappened:'CoPilot opened the site and clicked "Checkboxes" to reach that page. Then it ticked the checkbox "Checkbox 1".',
  why:'After its last action CoPilot looked at the page again. The box was still ticked and nothing else had been touched.'
};

{
  const {value, calls} = await explain(stateFor('verified_complete', {checks:allChecks}), [goodPass]);
  assert.equal(value.outcome,'passed');
  assert.equal(value.explanation.whatHappened, goodPass.whatHappened);
  assert.equal(value.explanation.why, goodPass.why);
  assert.equal('whatToTry' in value.explanation, false);
  assert.equal('limitations' in value.explanation, false, 'no "what remains uncertain" section');
  assert.equal(calls.length,1);
  const facts = JSON.parse(calls[0].messages[1].content);
  assert.equal(facts.outcome,'PASSED');
  assert.deepEqual(facts.stepsCoPilotDid,['clicked "Checkboxes"','ticked the checkbox "Checkbox 1"']);
  assert(facts.whyItPassed.includes('each ticked or unticked box is still in that state'));
  assert.equal(facts.whyItPassed[0],'CoPilot looked at the page again after its last action');
  assert.match(calls[0].messages[0].content,/The run PASSED\. Never say or imply the opposite/);
  assert.deepEqual(calls[0].format.required,['whatHappened','why']);
  ok('passed run: model words the facts; verdict and steps come from code');
}
{
  const wrong = {...goodPass, why:'Unfortunately the task failed because the checkbox could not be found on the page.'};
  const {value, calls} = await explain(stateFor('verified_complete', {checks:allChecks}), [wrong, goodPass]);
  assert.equal(calls.length,2,'one corrective retry');
  assert.match(calls[1].messages[1].content,/previous answer was rejected: the run PASSED but the text says it failed/);
  assert.equal(value.explanation.why, goodPass.why);
  ok('a passed run described as failed is rejected, then corrected on retry');
}
{
  const lie = {
    whatHappened:'CoPilot typed the requested text into the field "Customer name" and the order was submitted.',
    why:'The task was completed successfully and everything was verified on the page.',
    whatToTry:'Nothing further is needed for this task at all.'
  };
  const state = stateFor('approval_required', {edges:[edge('fill','Customer name')]});
  const {value, error, calls} = await explain(state, [lie, lie]);
  assert.equal(value, undefined, 'a false success is never returned');
  assert.match(error.message,/contradicted the recorded run: the run FAILED but the text says it succeeded/);
  assert.equal(calls.length,2);
  ok('failed run described as a success is refused, not shown');
}
{
  const good = {
    whatHappened:'CoPilot typed the requested text into the field "Customer name" and then stopped before sending the order.',
    why:'Sending the order could change something, so CoPilot asked for approval first. It was not approved, so the order was not completed and nothing was submitted.',
    whatToTry:'Run the task again and approve the action when CoPilot asks, if you want it to go ahead.'
  };
  const state = stateFor('approval_required', {edges:[edge('fill','Customer name')]});
  const {value, calls} = await explain(state, [good]);
  assert.equal(value.outcome,'failed');
  assert.equal(value.explanation.whatToTry, good.whatToTry);
  const facts = JSON.parse(calls[0].messages[1].content);
  assert.equal(facts.outcome,'FAILED');
  assert.match(facts.whyItFailed[0],/asked for approval and did not get it\. Nothing was submitted/);
  assert.match(facts.whatTheUserCanTry[0],/approve the action when CoPilot asks/);
  assert.deepEqual(calls[0].format.required,['whatHappened','why','whatToTry']);
  ok('failed run: why it failed and what to try come from the recorded status');
}
{
  const run = buildRunFacts(collectRunExplanationEvidence(stateFor('verified_complete')), allChecks,
    [{operation:'click',label:'Checkboxes'},{operation:'check',label:'Checkbox 1'}]);
  assert.match(findContradiction(run, {...goodPass, whatHappened:'CoPilot opened the page and ticked a box for the task that was given.'}),
    /must mention the control "Checkboxes"/);
  assert.match(findContradiction(run, {...goodPass, whatHappened:'The user clicked "Checkboxes" and then ticked "Checkbox 1" on that page.'}),
    /CoPilot did the actions, not the user/);
  assert.match(findContradiction(run, {whatHappened:'Done.', why:'OK.'}),/too short/);
  assert.match(findContradiction(run, {...goodPass, why:goodPass.why + ' The page showed (presumably) a success message.'}),
    /guesses/);
  assert.equal(findContradiction(run, goodPass), null);
  assert.equal(findContradiction(run, {...goodPass,
    why:'CoPilot checked the page again afterwards and nothing had failed. The box was still ticked.'}), null,
    '"nothing had failed" is not a failure claim');
  const failed = buildRunFacts({status:'unverified_completion_claim', reason:'No browser evidence yet for: pro.'}, [], []);
  assert.equal(findContradiction(failed, {
    whatHappened:'CoPilot opened the page but did not click or change anything on it.',
    why:'The agent thought it was done, but the page never showed "pro", so the task was not completed.',
    whatToTry:'Look at the page and run the task again with the exact words shown.'}), null,
    '"not completed" is not a success claim');
  assert(failed.facts.whyItFailed.includes('detail: No browser evidence yet for: pro.'));
  ok('missing controls, wrong actor and empty text are caught; honest negatives pass');
}
{
  const down = await explain(stateFor('verified_complete'), [new Error('connect ECONNREFUSED')]);
  assert.match(down.error.message,/ECONNREFUSED/);
  assert.equal(down.value, undefined, 'no made-up fallback text when the model is unavailable');
  const state = stateFor('step_limit_reached', {edges:[edge('fill','Card number 4111 1111 1111 1111'), edge('click','e7')]});
  const run = buildRunFacts(collectRunExplanationEvidence(state), [], collectRunSteps(state));
  assert.doesNotMatch(JSON.stringify(run.facts),/4111/,'card-like numbers never reach the model');
  assert.equal(run.facts.stepsCoPilotDid[1],'clicked a control','raw element ids are not shown as names');
  assert.match(run.facts.whatTheUserCanTry[0],/larger action budget/);
  for (const status of ['planning_stagnation','protected_form_state_changed','answer_unavailable','some_new_status']) {
    const facts = buildRunFacts({status}, [], []).facts;
    assert.equal(facts.outcome,'FAILED');
    assert(facts.whyItFailed[0].length > 20 && facts.whatTheUserCanTry[0].length > 20, status);
  }
  ok('model unavailable gives an error to retry; every failure status has a reason and advice');
}

// Replay of what the real local model wrote for a run where approval was
// denied: it said the Submit button was clicked (it was not) and gave the
// field's name as the text that was typed.
{
  const state = stateFor('approval_required', {edges:[
    {from:'a', to:'b', operation:'fill', label:'Customer name:', status:'observed_after_action'},
    {from:'b', to:null, operation:'click', label:'Submit order', status:'selected'}]});
  const steps = collectRunSteps(state);
  assert.deepEqual(steps.map(step => [step.label, step.done]),
    [['Customer name', true], ['Submit order', false]]);
  const run = buildRunFacts(collectRunExplanationEvidence(state), [], steps);
  assert.deepEqual(run.facts.stepsCoPilotDid, [
    'filled in the field named "Customer name"',
    'was about to click "Submit order" but did NOT do it']);
  const rest = {
    why:'Sending the order needed approval first and it was not given, so nothing was sent.',
    whatToTry:'Run the task again and approve the action when CoPilot asks.'};
  const modelText = "CoPilot typed 'Customer name:' into the field provided and then clicked the button labeled \"Submit order\".";
  assert.match(findContradiction(run, {...rest, whatHappened:modelText}),
    /did NOT carry out the action on "Submit order"/);
  assert.match(findContradiction(run, {...rest,
    whatHappened:'CoPilot typed "Customer name" into the form. It was about to click "Submit order" but did not.'}),
    /is the name of the field, not the text typed into it/);
  const honest = 'CoPilot filled in the field named "Customer name". It was about to click "Submit order" but did not do it.';
  assert.equal(findContradiction(run, {...rest, whatHappened:honest}), null);
  const {value, calls} = await explain(state, [{...rest, whatHappened:modelText}, {...rest, whatHappened:honest}]);
  assert.equal(calls.length,2);
  assert.equal(value.explanation.whatHappened, honest);
  const failedEdge = stateFor('planning_stagnation', {edges:[
    {from:'a', to:null, operation:'click', label:'Save', status:'failed'}]});
  assert.equal(buildRunFacts({status:'planning_stagnation'}, [], collectRunSteps(failedEdge)).facts.stepsCoPilotDid[0],
    'tried to click "Save" but it did not work');
  const dragEdge = stateFor('verified_complete', {edges:[
    {from:'a', to:'a', operation:'drag', label:'A', destination:'B', status:'observed_after_action'}]});
  assert.equal(buildRunFacts({status:'verified_complete'}, [], collectRunSteps(dragEdge)).facts.stepsCoPilotDid[0],
    'dragged "A" onto "B"');
  assert.equal(collectRunExplanationEvidence(dragEdge).actions[0].target, 'A onto B');
  const sliderEdges = stateFor('verified_complete', {edges:[
    {from:'a', to:'a', operation:'set_range', label:'Slider', setValue:'3.5', status:'observed_after_action'},
    {from:'a', to:'a', operation:'set_range', label:'Volume', setValue:'7', status:'observed_after_action'}]});
  const sliderFacts = buildRunFacts({status:'verified_complete'}, [], collectRunSteps(sliderEdges)).facts.stepsCoPilotDid;
  assert.equal(sliderFacts[0], 'set the slider to 3.5');
  assert.equal(sliderFacts[1], 'set the slider "Volume" to 7');
  assert.equal(collectRunExplanationEvidence(sliderEdges).actions[0].target, 'Slider to 3.5');
  const alertEdge = stateFor('verified_complete', {edges:[
    {from:'a', to:'a', operation:'right_click', label:'hot-spot', alert:true, status:'executed'}]});
  assert.equal(buildRunFacts({status:'verified_complete'}, [], collectRunSteps(alertEdge)).facts.stepsCoPilotDid[0],
    'right-clicked "hot-spot", and the page answered with an alert box that CoPilot closed with OK');
  const scrollEdges = stateFor('verified_complete', {edges:[
    {from:'a', to:'a', operation:'scroll', label:'page', scrollTo:'bottom', status:'action_verified'},
    {from:'a', to:'a', operation:'scroll', label:'page', scrollTo:'down', status:'action_verified'}]});
  const scrollFacts = buildRunFacts({status:'verified_complete'}, [], collectRunSteps(scrollEdges)).facts.stepsCoPilotDid;
  assert.equal(scrollFacts[0], 'scrolled the page to the bottom');
  assert.equal(scrollFacts[1], 'scrolled the page down');
  assert.equal(collectRunExplanationEvidence(scrollEdges).actions[0].target, 'page to the bottom');
  const keyEdges = stateFor('verified_complete', {edges:[
    {from:'a', to:'a', operation:'press', label:'target', pressKey:'Tab', status:'executed'},
    {from:'a', to:'a', operation:'press', label:'e9', status:'executed'}]});
  const keyFacts = buildRunFacts({status:'verified_complete'}, [], collectRunSteps(keyEdges)).facts.stepsCoPilotDid;
  assert.equal(keyFacts[0], 'pressed the Tab key in "target"');
  assert.equal(keyFacts[1], 'pressed a key');
  const tabEdge = stateFor('verified_complete', {edges:[
    {from:'a', to:'b', operation:'click', label:'Click Here', openedTab:true, status:'executed'}]});
  assert.equal(buildRunFacts({status:'verified_complete'}, [], collectRunSteps(tabEdge)).facts.stepsCoPilotDid[0],
    'clicked "Click Here", which opened a new browser tab that CoPilot moved to');
  const switchEdges = stateFor('verified_complete', {edges:[
    {from:'b', to:'a', operation:'switch_tab', label:'The Internet', status:'action_verified'},
    {from:'b', to:'a', operation:'switch_tab', label:'tab_1', status:'action_verified'}]});
  const switchFacts = buildRunFacts({status:'verified_complete'}, [], collectRunSteps(switchEdges)).facts.stepsCoPilotDid;
  assert.equal(switchFacts[0], 'switched to the browser tab "The Internet"');
  assert.equal(switchFacts[1], 'switched to another browser tab');
  // A password the person typed is told as theirs, not as a failed fill.
  const handoverEdges = stateFor('verified_complete', {edges:[
    {from:'a', to:'a', ref:'e3', operation:'fill', label:'Username', status:'action_verified'},
    {from:'a', to:null, ref:'e4', operation:'fill', label:'Password', status:'not_executed'},
    {from:'a', to:'a', ref:'e4', operation:'human_handover', label:'Password', status:'action_verified'}]});
  const handoverFacts = buildRunFacts({status:'verified_complete'}, [], collectRunSteps(handoverEdges)).facts.stepsCoPilotDid;
  assert.equal(handoverFacts.length, 2);
  assert.equal(handoverFacts[1], 'handed the field "Password" over to you to fill in yourself');
  const confirmEdge = stateFor('error', {edges:[
    {from:'a', to:null, operation:'click', label:'Delete', dialogStopped:'confirm', status:'executed'}]});
  assert.match(buildRunFacts({status:'error'}, [], collectRunSteps(confirmEdge)).facts.stepsCoPilotDid[0],
    /^clicked "Delete", and the page then asked a question in a browser dialog; CoPilot did not answer it/);
  ok('an action that was chosen but never carried out is not told as done');
}

// Replay of a real run with no starting URL: the site was found, the right
// page opened, and no action was needed. The model then wrote about a
// "last action" and "changes" that never happened.
{
  const state = {url:'https://playwright.dev/docs/intro',
    result:{status:'verified_complete', foundSite:true, checks:[
      {check:'form_state_preserved', passed:true, relevant:false},
      {check:'last_action_succeeded', passed:true, relevant:false},
      {check:'quoted_values_present', passed:true, relevant:false},
      {check:'instruction_words_evidenced', passed:true, relevant:true},
      {check:'requested_page_is_open', passed:true, relevant:true},
      {check:'requested_change_performed', passed:true, relevant:false},
      {check:'every_numbered_target_handled', passed:true, relevant:false}]},
    actionTree:{nodes:[{id:'n1', title:'Installation | Playwright'}], edges:[]}, activity:[]};
  const context = collectRunContext(state);
  assert.deepEqual(context,{foundSite:true, pageTitle:'Installation | Playwright'});
  const run = buildRunFacts(collectRunExplanationEvidence(state),
    collectCompletionChecks(state), collectRunSteps(state), context);
  assert.deepEqual(run.facts.stepsCoPilotDid, [
    'searched the web for the website the user asked for',
    'opened the page titled "Installation | Playwright" on playwright.dev',
    'did not need to click or change anything on the page']);
  assert.deepEqual(run.facts.whyItPassed, [
    'CoPilot looked at the page that opened',
    'the page that is open is the page the user asked for; its title and address say so',
    'the page shows what the user asked for'],
    'checks that had nothing to check are not given as reasons');
  const modelText = {
    whatHappened:'CoPilot looked at the page again after its last action and nothing the user did not ask for was changed. The last action worked, the page showed no error.',
    why:'The run counts as passed because each change requested by the user was actually made and every numbered item was handled.'};
  assert.match(findContradiction(run, modelText),/no browser action was carried out in this run/);
  assert.equal(findContradiction(run, {
    whatHappened:'CoPilot searched the web for the website and opened the page titled "Installation | Playwright" on playwright.dev. It did not need to click anything.',
    why:'The page that opened is the page that was asked for: its title and address say so, and it shows what was asked for.'}), null);
  ok('a run that only found and opened the page is described as that, with only real reasons');
}

// Dashboard: the heading follows the verdict; "What remains uncertain" is gone.
{
  const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html,/What remains uncertain|Why the run passed or failed/);
  const browser = await chromium.launch({headless:true,
    ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM}:{}),
    args:['--no-sandbox']});
  try {
    const show = async report => {
      const page = await browser.newPage({viewport:{width:1280,height:900}});
      await page.route('http://copilot-ui.test/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') return route.fulfill({status:200, contentType:'text/html', body:html});
        const body = pathname === '/api/run-explanation' ? report
          : pathname === '/api/state' ? {phase:'idle',activity:[],result:null,actionTree:{nodes:[],edges:[]}} : {};
        return route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(body)});
      });
      await page.goto('http://copilot-ui.test/');
      // The dashboard's own first state request must finish before the test
      // draws its state, or that late reply can hide the button being clicked.
      await page.waitForLoadState('networkidle');
      await page.evaluate(status => renderState({phase:'finished', activity:[],
        result:{status, history:[]}, actionTree:{nodes:[],edges:[]}}), report.status);
      await page.locator('#resultDetailsBtn').click();
      await page.locator('#runDetailsOutput').waitFor({state:'visible'});
      const seen = {
        whyHeading: await page.locator('#runDetailsWhyHeading').innerText(),
        why: await page.locator('#runDetailsWhy').innerText(),
        tryVisible: await page.locator('#runDetailsTry').isVisible(),
        tryHeadingVisible: await page.locator('#runDetailsTryHeading').isVisible(),
        tryText: await page.locator('#runDetailsTry').textContent(),
        actions: await page.locator('#runDetailsActions li').count()
      };
      await page.close();
      return seen;
    };
    const action = {number:1, operation:'check', target:'Checkbox 1', to:'Start', outcome:'observed_after_action'};
    const good = await show({status:'verified_complete', outcome:'passed', model:'m', actions:[action],
      explanation:goodPass});
    assert.equal(good.whyHeading,'Why it passed');
    assert.equal(good.why, goodPass.why);
    assert.equal(good.tryVisible,false); assert.equal(good.tryHeadingVisible,false);
    assert.equal(good.actions,1,'recorded actions are always listed');
    const bad = await show({status:'approval_required', outcome:'failed', model:'m', actions:[action],
      explanation:{whatHappened:'CoPilot typed into "Name" and then stopped.',
        why:'Approval was needed and was not given.', whatToTry:'Run it again and approve the action.'}});
    assert.equal(bad.whyHeading,'Why it failed');
    assert.equal(bad.tryVisible,true); assert.equal(bad.tryHeadingVisible,true);
    assert.equal(bad.tryText,'Run it again and approve the action.');
    assert.equal(bad.actions,1);
    ok('dashboard shows "Why it passed" or "Why it failed", advice only on failure, actions always');
  } finally { await browser.close(); }
}
console.log(`run-report: ${passed} groups passed`);
