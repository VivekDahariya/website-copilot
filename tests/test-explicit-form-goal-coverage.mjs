import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { interpretTask } from '../src/agent/task-interpreter.js';
import { checkExplicitFormGoalCoverage } from '../src/agent/form-goal-coverage.js';
import { runAgent } from '../src/agent/agent.js';

const instruction='Enter "Atlas Research" in Username, fill Comments with "Website CoPilot performance test", check Checkbox 2, and select Drop Down Item 4. Leave all other fields unchanged. Do not submit the form.';
const controls=[
 {tag:'input',type:'text',label:'Username',name:'username'},
 {tag:'textarea',type:'textarea',label:'Comments',name:'comments'},
 ...[1,2,3].map(n=>({tag:'input',type:'checkbox',label:`Check ${n}`,name:'checkboxes[]'})),
 {tag:'select',type:'select-one',label:'Drop Down',name:'dropdown',options:[
  {label:'Drop Down Item 1',value:'dd1'}, {label:'Drop Down Item 4',value:'dd4'}
 ]}
];
const goals=[
 {type:'form_state',fieldLabel:'Username',expectedValue:'Atlas Research'},
 {type:'form_state',fieldLabel:'Comments',expectedValue:'Website CoPilot performance test'},
 {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'},
 {type:'form_state',fieldLabel:'Drop Down',expectedValue:'dd4'}
];
const fake = goal => async () => ({ok:true,json:async()=>({response:JSON.stringify({type:'browser_goal',goal})})});
const parsed = await interpretTask(instruction,{formControls:controls,fetchImpl:fake({type:'all_of',conditions:goals})});
assert.equal(parsed.status,'interpreted',JSON.stringify(parsed));
assert.equal(parsed.task.goal.type,'all_of');
assert.equal(parsed.task.goal.conditions.length,4);
assert.deepEqual(checkExplicitFormGoalCoverage(instruction,parsed.task.goal,controls),{complete:true,checked:3,missing:[]});
console.log('PASS: Complete four-field goal accepted with required literal values and observed option');

const badCheckbox = await interpretTask(instruction,{formControls:controls,fetchImpl:fake(goals[2])});
assert.equal(badCheckbox.status,'needs_clarification',JSON.stringify(badCheckbox));
assert(!badCheckbox.task);
assert.match(badCheckbox.reason,/Username/);
assert.match(badCheckbox.reason,/Comments/);
assert.match(badCheckbox.reason,/Drop Down/);
console.log('PASS: Reproduced user failure: checkbox-only goal cannot claim four-field completion');

const bad3 = await interpretTask(instruction,{formControls:controls,fetchImpl:fake({type:'all_of',conditions:goals.slice(0,3)})});
assert.equal(bad3.status,'needs_clarification',JSON.stringify(bad3));
assert.match(bad3.reason,/Drop Down/);
const swapped = await interpretTask(instruction,{formControls:controls,fetchImpl:fake({type:'all_of',conditions:[
 {...goals[0],expectedValue:goals[1].expectedValue},
 {...goals[1],expectedValue:goals[0].expectedValue},goals[2],goals[3]
]})});
assert.equal(swapped.status,'needs_clarification',JSON.stringify(swapped));
console.log('PASS: Missing dropdown and swapped quoted field values fail closed');

const single = await interpretTask('Check Checkbox 2 only.',{formControls:controls,fetchImpl:fake(goals[2])});
assert.equal(single.status,'interpreted',JSON.stringify(single));
console.log('PASS: Ordinary single-checkbox request remains supported');

const browser=await chromium.launch({headless:true,args:['--no-sandbox'],
 ...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM}:{})});
try {
 const page=await browser.newPage();
 await page.setContent(`<!doctype html><title>Form</title><form onsubmit="window.submitted=true;event.preventDefault()">
 <label>Username<input name="username"></label><label>Comments<textarea name="comments"></textarea></label>
 <label>Check 1<input type="checkbox" name="checkboxes[]" value="cb1"></label>
 <label>Check 2<input type="checkbox" name="checkboxes[]" value="cb2"></label>
 <label>Check 3<input type="checkbox" name="checkboxes[]" value="cb3" checked></label>
 <label>Drop Down<select name="dropdown"><option value="dd1">Drop Down Item 1</option><option value="dd4">Drop Down Item 4</option></select></label>
 <button type="submit">Submit</button></form>`);
 const result=await runAgent(page,instruction,parsed.task.goal,{maxSteps:7});
 assert.equal(result.status,'verified_complete',JSON.stringify(result));
 assert.equal(result.history.length,4);
 assert.equal(await page.locator('[name=username]').inputValue(),'Atlas Research');
 assert.equal(await page.locator('[name=comments]').inputValue(),'Website CoPilot performance test');
 assert.deepEqual(await page.locator('[type=checkbox]').evaluateAll(xs=>xs.map(x=>x.checked)),[false,true,true]);
 assert.equal(await page.locator('[name=dropdown]').inputValue(),'dd4');
 assert.equal(await page.evaluate(()=>window.submitted),undefined);
 console.log('PASS: Complete four-field goal still executes exactly four verified Chromium actions without submitting');
 await page.close();
} finally { await browser.close(); }
