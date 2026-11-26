import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {runAgent} from '../src/agent/agent.js';
import {observePage} from '../src/observer/dom-observer.js';
import {
  eligibleForFormFastPath, validateFormBatch, createFormFastPathSession,
  proposeFormBatch
} from '../src/agent/form-fast-path.js';

const instruction='Fill Username with "Atlas Research", fill Comments with "Fast path verified", select Four in Preference, and check Checkbox 2. Leave all other fields unchanged; do not submit.';
const goal={type:'all_of', conditions:[
  {type:'form_state',fieldLabel:'Username',expectedValue:'Atlas Research'},
  {type:'form_state',fieldLabel:'Comments',expectedValue:'Fast path verified'},
  {type:'form_state',fieldLabel:'Preference',expectedValue:'Four'},
  {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'}
]};
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],
  ...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM}:{})});
try {
  const page=await browser.newPage();
  await page.setContent(`<!doctype html><html><head><title>Fast Form</title></head><body>
    <form onsubmit="window.didSubmit=true;event.preventDefault()">
      <label>Username <input name="username" /></label>
      <label>Comments <textarea name="comments"></textarea></label>
      <label>Checkbox 1 <input type="checkbox" name="box1" /></label>
      <label>Checkbox 2 <input type="checkbox" name="box2" /></label>
      <label>Checkbox 3 <input type="checkbox" name="box3" checked /></label>
      <label>Preference <select name="preference"><option>One</option><option>Four</option></select></label>
      <button type="submit">Submit</button>
    </form></body></html>`);
  const observation=await observePage(page);
  assert.equal(eligibleForFormFastPath({instruction,goal,observation}),true);
  const byName=name=>observation.actionableElements.find(e=>e.name===name);
  const proposed=[
    {ref:byName('username').ref,operation:'fill',value:'Atlas Research'},
    {ref:byName('comments').ref,operation:'fill',value:'Fast path verified'},
    {ref:byName('preference').ref,operation:'select',value:'Four'},
    {ref:byName('box2').ref,operation:'check',value:''}
  ];
  assert.deepEqual(validateFormBatch({actions:proposed},observation,{instruction,goal}),proposed);
  assert.equal(validateFormBatch({actions:[...proposed,{ref:byName('box3').ref,operation:'uncheck',value:''}]},observation,{instruction,goal}),null,
    'Prevalidate every batch action against the existing form-preservation policy');
  assert.equal(validateFormBatch({actions:[...proposed,{ref:'invented',operation:'fill',value:'x'}]},observation,{instruction,goal}),null);
  assert.equal(validateFormBatch({actions:[...proposed,proposed[0]]},observation,{instruction,goal}),null);
  assert.equal(validateFormBatch({actions:[{ref:byName('username').ref,operation:'click',value:''},proposed[1]]},observation,{instruction,goal}),null);
  assert.equal(validateFormBatch({actions:[{ref:byName('username').ref,operation:'fill',value:'A'},
    {ref:byName('username').ref,operation:'fill',value:'B'}]},observation,{instruction,goal}),null);
  assert.equal(eligibleForFormFastPath({instruction:'Fill Username and then submit the form',goal,observation}),false);
  assert.equal(eligibleForFormFastPath({instruction:'Fill the password with secret and select Preference',goal,observation}),false);
  assert.equal(eligibleForFormFastPath({instruction,goal:{type:'page_destination',heading:'Docs'},observation}),false);
  console.log('PASS: Form-only eligibility, strict operation/ref validation, no batching submissions or sensitive requests');

  let fetchCalls=0;
  const fromModel=await proposeFormBatch({instruction,goal,observation,
    fetchImpl:async (url,req)=>{
      fetchCalls++;
      const body=JSON.parse(req.body);
      assert.equal(body.think,false);
      assert.equal(body.messages[1].role,'user');
      assert.equal(body.format.properties.actions.type,'array');
      assert(!body.messages[1].content.includes('window.didSubmit'));
      return {ok:true,json:async()=>({message:{content:JSON.stringify({actions:proposed})}})};
    }});
  assert.deepEqual(fromModel,proposed);assert.equal(fetchCalls,1);
  console.log('PASS: One structured Qwen-compatible /api/chat request proposes four independent edits');

  let batchCalls=0;let fallbackCalls=0;const events=[];
  const result=await runAgent(page,instruction,goal,{
    maxSteps:7,
    reasoner:async()=>{fallbackCalls++;throw new Error('Unexpected per-field model request');},
    formBatchPlanner:async()=>{batchCalls++;return proposed;},
    onAgentEvent:event=>events.push(event)
  });
  assert.equal(result.status,'verified_complete',JSON.stringify(result));
  assert.equal(batchCalls,1);
  assert.equal(fallbackCalls,0,'Four independent browser actions must not invoke Qwen again');
  assert.deepEqual(result.history.map(x=>x.decision.operation),['fill','fill','select','check']);
  assert.equal(await page.locator('[name=username]').inputValue(),'Atlas Research');
  assert.equal(await page.locator('[name=comments]').inputValue(),'Fast path verified');
  assert.equal(await page.locator('[name=preference]').inputValue(),'Four');
  assert.deepEqual(await page.locator('input[type=checkbox]').evaluateAll(els=>els.map(el=>el.checked)),[false,true,true]);
  assert.equal(await page.evaluate(()=>window.didSubmit),undefined);
  assert(events.some(e=>e.type==='form_fast_path_planned' && e.count===4));
  assert.equal(events.filter(e=>e.type==='planning_started').length,1,
    'Cached actions must not be reported as fresh Ollama planning');
  assert.equal(events.filter(e=>e.type==='form_fast_path_next').length,3);
  console.log('PASS: REAL CHROMIUM four edits from ONE planned batch; every action executed and verified; no unrelated changes or submit');
  await page.close();

  const changing=await browser.newPage();
  await changing.setContent('<label>One<input name="one"></label><label>Two<input name="two"></label>');
  const before=await observePage(changing);
  const batch=createFormFastPathSession();batch.markAttempted();
  const changes=[{ref:before.actionableElements[0].ref,operation:'fill',value:'a'},
    {ref:before.actionableElements[1].ref,operation:'fill',value:'b'}];
  assert(batch.start(changes,before));
  await changing.locator('[name=one]').fill('a');
  await changing.evaluate(()=>{const extra=document.createElement('input');extra.name='surprise';document.body.appendChild(extra)});
  const after=await observePage(changing);
  batch.accepted(changes[0],before,after);
  assert.equal(batch.remaining(),0,'DOM structural change must invalidate any remaining plan');
  console.log('PASS: Page structure change invalidates queued actions; replan instead of blind execution');
  await changing.close();
} finally {await browser.close();}
