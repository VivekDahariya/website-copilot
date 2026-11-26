import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { interpretTask } from '../src/agent/task-interpreter.js';
import { observePage } from '../src/observer/dom-observer.js';
import { verifyGoal } from '../src/agent/goal-verifier.js';
import { runAgent } from '../src/agent/agent.js';

const instruction = 'Check Checkbox 2 only. Do not modify any other form fields and do not submit the form.';
const controls = [
  {tag:'input', type:'text', name:'username', label:'Username'},
  {tag:'input', type:'checkbox', name:'checkboxes[]',label:'Checkbox 1',ordinal:1},
  {tag:'input', type:'checkbox', name:'checkboxes[]',label:'Checkbox 2',ordinal:2},
  {tag:'input', type:'checkbox', name:'checkboxes[]',label:'Checkbox 3',ordinal:3},
  {tag:'input', type:'checkbox', name:'preferences[]',label:'Preference 1',ordinal:4},
  {tag:'input', type:'checkbox', name:'preferences[]',label:'Preference 2',ordinal:5},
];
const explicit = {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'};
const malformed = {type:'form_state',fieldLabel:'checkboxes[]',expectedValue:'Check Checkbox 2 only'};
const read = async (goal, text=instruction, formControls=controls) => {
  const fetchImpl = async () => ({ok:true,json:async()=>({response:JSON.stringify({type:'browser_goal',goal})})});
  const output = await interpretTask(text,{fetchImpl,currentUrl:'https://example.test/form',formControls});
  return output;
};
const one = await read(malformed);
assert.equal(one.status,'interpreted',JSON.stringify(one));
assert.deepEqual(one.task.goal,explicit);
const doubled = await read({type:'all_of',conditions:[malformed,explicit]});
assert.equal(doubled.status,'interpreted');
assert.deepEqual(doubled.task.goal,explicit);
console.log('PASS: Invalid model-generated shared checkbox alias removed for one explicit ordinal goal');

const username = {type:'form_state',fieldLabel:'Username',expectedValue:'Atlas Research'};
const multi = await read({type:'all_of',conditions:[username,malformed]});
assert.deepEqual(multi.task.goal,{type:'all_of',conditions:[username,explicit]});
const trueAlias = {type:'form_state',fieldLabel:'checkboxes[]',expectedValue:true};
const valid = await read({type:'all_of',conditions:[trueAlias,explicit]});
assert.equal(valid.task.goal.type,'all_of');
assert.deepEqual(valid.task.goal.conditions,[trueAlias,explicit]);
const ordinary = await read({type:'all_of',conditions:[username,{type:'form_state',fieldLabel:'Unknown',expectedValue:'text'}]});
assert.equal(ordinary.task.goal.conditions.length,3); // unrelated remains; explicit appended
const explicitGroupMention = await read({type:'all_of',conditions:[malformed,explicit]},
  instruction.replace('only.','only; retain the checkboxes[] group requirement.'));
assert.equal(explicitGroupMention.task.goal.conditions.length,2);
const missingGroup = await read(malformed,instruction,controls.filter(c=>c.name!=='checkboxes[]'));
assert.equal(missingGroup.task.goal.conditions.length,2);
console.log('PASS: Valid group aliases and unrelated user goals retained; ambiguous groups not silently discarded');

const conflict={type:'all_of',conditions:[{...trueAlias,expectedValue:false},explicit]};
const conflictOut=await read(conflict);
assert.equal(conflictOut.status,'needs_clarification');
assert.match(conflictOut.reason,/Conflicting checkbox group/);
const multiCheckbox = await read(malformed,'Check Checkbox 1 and check Checkbox 2. Do not submit.');
assert.equal(multiCheckbox.task.goal.type,'all_of');
assert.equal(multiCheckbox.task.goal.conditions.length,3); // preserve ambiguous group alias + 2 explicit goals
console.log('PASS: Contradictions rejected and multi-target checkbox requests not coalesced');

const browser=await chromium.launch({headless:true,args:['--no-sandbox'],
 ...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM}:{})});
try {
  const page=await browser.newPage();
  await page.setContent(`<!doctype html><title>Form</title><form onsubmit="window.submitted=true;event.preventDefault()">
    <input name="username" value="original">
    <input type="checkbox" name="checkboxes[]" value="1">Checkbox 1
    <input type="checkbox" name="checkboxes[]" value="2">Checkbox 2
    <input type="checkbox" name="checkboxes[]" value="3" checked>Checkbox 3
    <button type="submit">Submit</button></form>`);
  const before=await observePage(page);
  assert.equal(verifyGoal(before,one.task.goal).completed,false);
  const target=before.actionableElements.find(e=>e.type==='checkbox'&&e.ordinal===2);
  assert(target,'Exact checkbox 2 must be observable');
  const result=await runAgent(page,instruction,one.task.goal,{maxSteps:3,
    reasoner:async()=>({ref:target.ref,operation:'check',value:''})});
  assert.equal(result.status,'verified_complete',JSON.stringify(result));
  assert.equal(result.history.length,1);
  assert.deepEqual(await page.locator('input[type=checkbox]').evaluateAll(xs=>xs.map(x=>x.checked)),[false,true,true]);
  assert.equal(await page.locator('input[name=username]').inputValue(),'original');
  assert.equal(await page.evaluate(()=>window.submitted),undefined);
  console.log('PASS: Real Chromium one-checkbox task completes in one authorized action, without submit or other edits');
  await page.close();
} finally { await browser.close(); }
