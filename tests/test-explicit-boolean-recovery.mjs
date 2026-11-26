import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {runAgent} from '../src/agent/agent.js';
import {recoverExplicitBooleanAction} from '../src/agent/explicit-boolean-recovery.js';
import {observePage} from '../src/observer/dom-observer.js';

const instruction='On this webpage, enter "Atlas Research" in Username, replace the TextArea Comment with "Website CoPilot independent automation test", check Checkbox 2, and choose "Drop Down Item 4" from the Dropdown. Leave every other field unchanged. Do not submit the form.';
const goal={type:'all_of', conditions:[
  {type:'form_state',fieldLabel:'Username',expectedValue:'Atlas Research'},
  {type:'form_state',fieldLabel:'TextArea Comment',expectedValue:'Website CoPilot independent automation test'},
  {type:'form_state',fieldLabel:'Dropdown',expectedValue:'Drop Down Item 4'},
  {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'}
]};
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],
 ...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM}:{})});
try {
  const page=await browser.newPage();
  await page.setContent(`<html><title>Independent Form</title><body><form onsubmit="window.submitted=true;event.preventDefault()"><table>
    <tr><td>Username</td><td><input name="username" aria-label="Username"></td></tr>
    <tr><td>Password</td><td><input type="password" name="password"></td></tr>
    <tr><td>TextArea Comment</td><td><textarea name="comments" aria-label="TextArea Comment"></textarea></td></tr>
    <tr><td>Checkbox Items</td><td>
      <input type="checkbox" name="checkboxes[]" value="cb1">Checkbox 1
      <input type="checkbox" name="checkboxes[]" value="cb2">Checkbox 2
      <input type="checkbox" name="checkboxes[]" value="cb3" checked>Checkbox 3
    </td></tr>
    <tr><td>Radio Items</td><td><input type="radio" name="rad" value="1">radio 1 <input type="radio" name="rad" value="2">radio 2</td></tr>
    <tr><td>Multiple</td><td><select name="multi" multiple><option>Alpha</option><option>Beta</option></select></td></tr>
    <tr><td>Dropdown</td><td><select name="dropdown" aria-label="Dropdown"><option>Drop Down Item 3</option><option>Drop Down Item 4</option></select></td></tr>
    <tr><td><button type="submit">Submit</button></td></tr>
    </table></form></body></html>`);
  const initial=await observePage(page);
  const checkbox = initial.actionableElements.filter(e=>e.type==='checkbox');
  assert.deepEqual(checkbox.map(e=>[e.ordinal,e.checked]),[[1,false],[2,false],[3,true]]);
  const check2=checkbox[1].ref;
  assert.equal(recoverExplicitBooleanAction({instruction,goal,observation:initial}),null,
    'Do not bypass model planning while other tasks are unfinished');
  await page.locator('[name="username"]').fill('Atlas Research');
  await page.locator('[name="comments"]').fill('Website CoPilot independent automation test');
  await page.locator('[name="dropdown"]').selectOption({label:'Drop Down Item 4'});
  const readyForRecovery=await observePage(page);
  assert.deepEqual(recoverExplicitBooleanAction({instruction,goal,observation:readyForRecovery}),
    {ref:check2,operation:'check',value:''});
  const oldGoal={type:'all_of',conditions:goal.conditions.slice(0,-1)};
  assert.equal(recoverExplicitBooleanAction({instruction,goal:oldGoal,observation:readyForRecovery}),null,
    'Incomplete model goal does not authorize a fallback');
  assert.equal(recoverExplicitBooleanAction({instruction:'Do not check Checkbox 2.',goal,observation:readyForRecovery}),null);
  assert.equal(recoverExplicitBooleanAction({instruction:'Check Checkbox 3.',goal,observation:readyForRecovery}),null);
  const contradictory={...goal,conditions:[...goal.conditions.slice(0,-1),
    {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'unchecked'}]};
  assert.equal(recoverExplicitBooleanAction({instruction,goal:contradictory,observation:readyForRecovery}),null);
  const ambiguous={...readyForRecovery,actionableElements:[...readyForRecovery.actionableElements,
    {...checkbox[1],ref:'duplicateCheckbox'}]};
  assert.equal(recoverExplicitBooleanAction({instruction,goal,observation:ambiguous}),null,
    'Duplicated browser ordinal cannot authorize recovery');
  console.log('PASS: Final-step recovery only for a unique explicit unmet checkbox goal; ambiguous and forbidden mutations fail closed');
  await page.locator('[name="username"]').fill('');
  await page.locator('[name="comments"]').fill('');
  await page.locator('[name="dropdown"]').selectOption({label:'Drop Down Item 3'});

  let failures=0; const events=[];
  const reasoner=async(_task,obs)=>{
    const elements=obs.actionableElements;
    const find=pred=>{const e=elements.find(pred);assert(e);return e.ref;};
    if(elements.find(e=>e.name==='username')?.currentValue!=='Atlas Research')
      return {ref:find(e=>e.name==='username'),operation:'fill',value:'Atlas Research'};
    if(elements.find(e=>e.name==='comments')?.currentValue!=='Website CoPilot independent automation test')
      return {ref:find(e=>e.name==='comments'),operation:'fill',value:'Website CoPilot independent automation test'};
    if(elements.find(e=>e.name==='dropdown')?.selectedLabel!=='Drop Down Item 4')
      return {ref:find(e=>e.name==='dropdown'),operation:'select',value:'Drop Down Item 4'};
    failures++;
    // Mimics a model unable to distinguish identically named checkboxes.
    return {ref:find(e=>e.type==='checkbox' && e.ordinal===3),operation:'uncheck',value:''};
  };
  const result=await runAgent(page,instruction,goal,{reasoner,maxSteps:6,onAgentEvent:event=>events.push(event)});
  assert.equal(result.status,'verified_complete',JSON.stringify(result));
  assert.deepEqual(result.history.map(h=>h.decision.operation),['fill','fill','select','check']);
  assert(failures>=2,'Model must have failed at least twice before recovery');
  assert(events.some(e=>e.type==='planning_recovered' && e.ref===check2));
  assert.deepEqual(await page.locator('input[type="checkbox"]').evaluateAll(nodes=>nodes.map(e=>e.checked)),
    [false,true,true]);
  assert.equal(await page.evaluate(()=>window.submitted),undefined);
  console.log('PASS: Real Chromium multi-field run recovers after two rejected model actions; one authorized check, no unrelated change or submit');
  await page.close();
} finally {await browser.close();}
