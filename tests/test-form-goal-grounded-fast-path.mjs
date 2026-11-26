import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {runAgent} from '../src/agent/agent.js';
import {observePage} from '../src/observer/dom-observer.js';
import {proposeGroundedFormBatch} from '../src/agent/form-fast-path.js';

const browser = await chromium.launch({headless:true,args:['--no-sandbox'],
  ...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM}:{})});
const instruction='On this webpage, enter "Atlas Research" in Username, replace the TextArea Comment with "Website CoPilot independent automation test", check Checkbox 2, and choose "Drop Down Item 4" from the Dropdown. Leave every other field unchanged. Do not submit the form.';
const goal={type:'all_of',conditions:[
  {type:'form_state',fieldLabel:'Username',expectedValue:'Atlas Research'},
  {type:'form_state',fieldLabel:'Comment',expectedValue:'Website CoPilot independent automation test'},
  {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'},
  {type:'form_state',fieldLabel:'Dropdown',expectedValue:'Drop Down Item 4'}
]};
try {
  const page=await browser.newPage();
  await page.setContent(`<!doctype html><title>HTML Form Elements</title><form onsubmit="window.submitted=true;event.preventDefault()">
    <label>Username : <input name="username" type="text" /></label>
    <label>Comment : <textarea name="comments"></textarea></label>
    <label>Checkbox group: <input type="checkbox" name="checkboxes[]" value="cb1"></label>
    <label>Checkbox group: <input type="checkbox" name="checkboxes[]" value="cb2"></label>
    <label>Checkbox group: <input type="checkbox" name="checkboxes[]" value="cb3" checked></label>
    <label>Dropdown Menu <select name="dropdown"><option value="dd1">Drop Down Item 1</option><option value="dd4">Drop Down Item 4</option></select></label>
    <button type="submit">Submit</button>
  </form>`);
  const observation=await observePage(page);
  const proposal=proposeGroundedFormBatch({instruction,goal,observation});
  assert(proposal, 'All four native targets must be uniquely identified');
  assert.deepEqual(proposal.map(a=>a.operation),['fill','fill','check','select']);
  assert(proposal.some(a=>a.operation==='select' && a.value==='Drop Down Item 4'));
  console.log('PASS: Realistic native controls grounded from interpreter goals without second model request');
  const events=[];
  const output=await runAgent(page,instruction,goal,{maxSteps:7,onAgentEvent:e=>events.push(e)});
  assert.equal(output.status,'verified_complete',JSON.stringify(output));
  assert.deepEqual(output.history.map(h=>h.decision.operation),['fill','fill','check','select']);
  assert.equal(events.filter(e=>e.type==='form_fast_path_planned' && e.source==='goal_grounded').length,1);
  assert.equal(events.filter(e=>e.type==='form_fast_path_next').length,3);
  assert.equal(await page.locator('input[name=username]').inputValue(),'Atlas Research');
  assert.equal(await page.locator('textarea').inputValue(),'Website CoPilot independent automation test');
  assert.deepEqual(await page.locator('input[type=checkbox]').evaluateAll(xs=>xs.map(x=>x.checked)),[false,true,true]);
  assert.equal(await page.locator('select').inputValue(),'dd4');
  assert.equal(await page.evaluate(()=>window.submitted),undefined);
  console.log('PASS: Real Chromium four edits, zero planner calls, every action verified, unrelated controls intact');
  await page.close();
  const ambiguous=await browser.newPage();
  await ambiguous.setContent('<label>Username<input name="username"></label><label>Comments<textarea></textarea></label><label>Notes<textarea></textarea></label><label>Dropdown<select><option>Four</option></select></label>');
  assert.equal(proposeGroundedFormBatch({instruction,goal:{type:'all_of',conditions:[
    {type:'form_state',fieldLabel:'Username',expectedValue:'Atlas Research'},
    {type:'form_state',fieldLabel:'TextArea Comment',expectedValue:'Text'},
    {type:'form_state',fieldLabel:'Dropdown',expectedValue:'Four'}
  ]},observation:await observePage(ambiguous)}),null);
  console.log('PASS: Ambiguous native type does not authorize blind form edits');
  await ambiguous.close();
  assert.equal(proposeGroundedFormBatch({instruction:instruction.replace('Do not submit','Submit'),goal,observation}),null);
  assert.equal(proposeGroundedFormBatch({instruction,goal:{type:'page_destination',heading:'Home'},observation}),null);
  const conflicting={type:'all_of',conditions:[goal.conditions[0],{...goal.conditions[0],expectedValue:'Wrong'}]};
  assert.equal(proposeGroundedFormBatch({instruction,goal:conflicting,observation}),null);
  console.log('PASS: Consequential tasks, non-form goals, conflicting edits excluded');
} finally {await browser.close();}
