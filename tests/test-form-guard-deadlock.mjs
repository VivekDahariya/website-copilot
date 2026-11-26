import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {runAgent} from '../src/agent/agent.js';
import {observePage} from '../src/observer/dom-observer.js';
import {createFormMutationPolicy} from '../src/agent/form-mutation-policy.js';
import {groundFormGoal} from '../src/agent/task-interpreter.js';

const browser=await chromium.launch({headless:true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM}:{}),
  args:['--no-sandbox']});
const html=`<!doctype html><title>Independent form</title><form onsubmit="window.didSubmit=true;event.preventDefault()">
<label>Username <input name="username"></label>
<label>Comments <textarea name="comments"></textarea></label>
<label>Option Alpha <input type="checkbox" name="first"></label>
<label>Checkbox 2 <input type="checkbox" name="second"></label>
<label>Option Gamma <input type="checkbox" name="third" checked></label>
<label>Preference <select name="preference"><option>One</option><option>Four</option></select></label>
<button type="submit">Submit</button></form>`;
const originalInstruction=`Enter Atlas Research in Username, put "Independent automation test" in TextArea Comment, check Checkbox 2, and choose Four from Dropdown. Leave every other field unchanged. Do not submit.`;
const rawGoal={type:'all_of',conditions:[
  {type:'form_state',fieldLabel:'Username',expectedValue:'Atlas Research'},
  {type:'form_state',fieldLabel:'TextArea Comment',expectedValue:'Independent automation test'},
  {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'},
  {type:'form_state',fieldLabel:'Dropdown',expectedValue:'Four'}
]};
try {
  const page=await browser.newPage(); await page.setContent(html);
  const obs=await observePage(page);
  const policy=createFormMutationPolicy({goal:rawGoal,instruction:originalInstruction});
  policy.observe(obs);
  const get=label=>obs.actionableElements.find(e=>e.label===label || e.label?.startsWith(label+' '));
  assert.equal(policy.reject(obs,get('Username'),{ref:get('Username').ref,operation:'fill',value:'Atlas Research'}),null);
  assert.equal(policy.reject(obs,get('Comments'),{ref:get('Comments').ref,operation:'fill',value:'Independent automation test'}),null);
  assert.equal(policy.reject(obs,get('Checkbox 2'),{ref:get('Checkbox 2').ref,operation:'check',value:''}),null);
  assert.equal(policy.reject(obs,get('Preference'),{ref:get('Preference').ref,operation:'select',value:'Four'}),null);
  assert.equal(policy.reject(obs,get('Option Gamma'),{ref:get('Option Gamma').ref,operation:'uncheck',value:''}),'unrequested_form_field_change');
  console.log('PASS: Mismatched model labels resolve to uniquely grounded textarea/select/checkbox; unrelated field blocked');

  const partlyAmbiguous={type:'all_of',conditions:[
    {type:'form_state',fieldLabel:'Username',expectedValue:'Atlas Research'},
    {type:'form_state',fieldLabel:'Unknown control that cannot be grounded',expectedValue:'other'}
  ]};
  const partialPolicy=createFormMutationPolicy({goal:partlyAmbiguous,instruction:originalInstruction});
  partialPolicy.observe(obs);
  assert.equal(partialPolicy.reject(obs,get('Username'),{ref:get('Username').ref,operation:'fill',value:'Atlas Research'}),null);
  assert.equal(partialPolicy.reject(obs,get('Comments'),{ref:get('Comments').ref,operation:'fill',value:'other'}),'unrequested_form_field_change');
  console.log('PASS: One unresolved goal label no longer freezes independent authorized changes');

  // End-to-end: the existing interpreter's grounded field labels and the
  // actual Chromium observer drive actions; the proposed extraneous uncheck
  // must be rejected by the central runAgent loop before any click.
  const formControls=obs.actionableElements.filter(e=>e.tag==='input' || e.tag==='textarea' || e.tag==='select');
  const grounded=groundFormGoal(rawGoal,formControls,originalInstruction);
  const done=new Set();
  let rejected=false;
  const reasoner=async(_task,o,history,rejections)=>{
    const el=label=>o.actionableElements.find(e=>e.label===label || e.label?.startsWith(label+' '));
    if(history.length===0 && !rejections.length) return {ref:el('Option Gamma').ref,operation:'uncheck',value:''};
    if(rejections.some(a=>a.operation==='uncheck')) rejected=true;
    const username=el('Username');
    if(username.currentValue!=='Atlas Research') return {ref:username.ref,operation:'fill',value:'Atlas Research'};
    const comment=el('Comments');
    if(comment.currentValue!=='Independent automation test') return {ref:comment.ref,operation:'fill',value:'Independent automation test'};
    const checkbox=el('Checkbox 2');
    if(!checkbox.checked) return {ref:checkbox.ref,operation:'check',value:''};
    const pref=el('Preference');
    return {ref:pref.ref,operation:'select',value:'Four'};
  };
  const result=await runAgent(page,originalInstruction,grounded,{reasoner,maxSteps:7});
  assert.equal(result.status,'verified_complete',JSON.stringify(result));
  assert.equal(rejected,true);
  assert.deepEqual(result.history.map(x=>x.decision.operation),['fill','fill','check','select']);
  assert.equal(await page.locator('[name=third]').isChecked(),true);
  assert.equal(await page.locator('[name=second]').isChecked(),true);
  assert.equal(await page.locator('[name=preference]').inputValue(),'Four');
  assert.equal(await page.evaluate(()=>window.didSubmit),undefined);
  console.log('PASS: Full Chromium 4-field workflow rejects unintended uncheck and completes without submission');
  await page.close();

  const ambig=await browser.newPage();await ambig.setContent('<label>First <textarea></textarea></label><label>Second <textarea></textarea></label>');
  const oo=await observePage(ambig); const q=createFormMutationPolicy({goal:{type:'form_state',fieldLabel:'Textarea',expectedValue:'unsafe'}});
  q.observe(oo);
  const textareas=oo.actionableElements.filter(e=>e.tag==='textarea');
  assert.equal(textareas.length,2);
  assert.equal(q.reject(oo,textareas[0],{ref:textareas[0].ref,operation:'fill',value:'unsafe'}),'unrequested_form_field_change');
  console.log('PASS: Ambiguous repeated control types fail closed');
  await ambig.close();
} finally {await browser.close();}
