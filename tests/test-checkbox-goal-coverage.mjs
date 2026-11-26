import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { interpretTask } from '../src/agent/task-interpreter.js';
import { extractExplicitCheckboxConditions } from '../src/agent/explicit-goal-repair.js';
import { verifyGoal } from '../src/agent/goal-verifier.js';
import { runAgent } from '../src/agent/agent.js';

const instruction='On this webpage, enter "Atlas Research" in Username, replace the TextArea Comment with "Website CoPilot independent automation test", check Checkbox 2, and choose "Drop Down Item 4" from the Dropdown. Leave every other field unchanged. Do not submit the form.';
const originalModelGoal={type:'all_of',conditions:[
 {type:'form_state',fieldLabel:'Username',expectedValue:'Atlas Research'},
 {type:'form_state',fieldLabel:'TextArea Comment',expectedValue:'Website CoPilot independent automation test'},
 {type:'form_state',fieldLabel:'Dropdown',expectedValue:'Drop Down Item 4'}
]};
const fakeFetch=async()=>({ok:true,json:async()=>({response:JSON.stringify({type:'browser_goal',goal:originalModelGoal})})});
const parsed=await interpretTask(instruction,{fetchImpl:fakeFetch,currentUrl:'https://unknown.example/form',formControls:[
 {tag:'input',type:'text',label:'Username'},
 {tag:'textarea',type:'textarea',label:'TextArea Comment'},
 {tag:'input',type:'checkbox',label:'checkboxes[]'},
 {tag:'input',type:'checkbox',label:'checkboxes[]'},
 {tag:'input',type:'checkbox',label:'checkboxes[]'},
 {tag:'select',type:'select-one',label:'Dropdown'}
]});
assert.equal(parsed.status,'interpreted',JSON.stringify(parsed));
assert.equal(parsed.task.goal.type,'all_of');
assert.equal(parsed.task.goal.conditions.length,4,JSON.stringify(parsed.task.goal));
assert.deepEqual(parsed.task.goal.conditions.at(-1),{type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'});
assert.equal(extractExplicitCheckboxConditions('Check the second checkbox.')[0].fieldLabel,'Checkbox 2');
assert.equal(extractExplicitCheckboxConditions('Do not check Checkbox 2.').length,0);
assert.equal(extractExplicitCheckboxConditions('Uncheck Checkbox 3.')[0].expectedValue,'unchecked');
assert.equal(extractExplicitCheckboxConditions('Keep Checkbox 3 unchanged.')[0].expectedValue,'unchanged');
console.log('PASS: Model omitted Checkbox 2; user instruction restores fourth goal without losing other fields');

const browser=await chromium.launch({headless:true,args:['--no-sandbox'],
 ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM}:{} )});
try {
 const page=await browser.newPage();
 await page.setContent(`<!doctype html><html><title>Unseen form</title><body><form onsubmit="window.submitted=true;event.preventDefault()">
 <input name="username" aria-label="Username"><textarea name="comments" aria-label="TextArea Comment"></textarea>
 <input type="checkbox" name="checkboxes[]" value="cb1">Checkbox 1
 <input type="checkbox" name="checkboxes[]" value="cb2">Checkbox 2
 <input type="checkbox" name="checkboxes[]" value="cb3" checked>Checkbox 3
 <select name="dropdown" aria-label="Dropdown"><option value="dd3">Drop Down Item 3</option><option value="dd4">Drop Down Item 4</option></select>
 <button type="submit">Submit</button></form></body></html>`);
 const {observePage}=await import('../src/observer/dom-observer.js');
 const initial=await observePage(page);
 const checklist=initial.actionableElements.filter(e=>e.type==='checkbox');
 assert.deepEqual(checklist.map(e=>e.checked),[false,false,true]);
 assert.equal(verifyGoal(initial,parsed.task.goal).completed,false);
 // The first three fields can be correct while Checkbox 2 is still false.
 await page.locator('[name="username"]').fill('Atlas Research');
 await page.locator('[name="comments"]').fill('Website CoPilot independent automation test');
 await page.locator('[name="dropdown"]').selectOption('dd4');
 const partial=await observePage(page);
 assert.equal(verifyGoal(partial,parsed.task.goal).completed,false,'Partial form must not finish');
 await page.locator('[name="username"]').fill('');
 await page.locator('[name="comments"]').fill('');
 await page.locator('[name="dropdown"]').selectOption('dd3');
 const reasoner=async(_task,obs)=>{
   const el=obs.actionableElements;
   const find=pred=>{const item=el.find(pred);assert(item);return item.ref};
   if(el.find(e=>e.name==='username')?.currentValue!=='Atlas Research')
     return {ref:find(e=>e.name==='username'),operation:'fill',value:'Atlas Research'};
   if(el.find(e=>e.name==='comments')?.currentValue!=='Website CoPilot independent automation test')
     return {ref:find(e=>e.name==='comments'),operation:'fill',value:'Website CoPilot independent automation test'};
   if(el.find(e=>e.name==='dropdown')?.selectedLabel!=='Drop Down Item 4')
     return {ref:find(e=>e.name==='dropdown'),operation:'select',value:'Drop Down Item 4'};
   return {ref:find(e=>e.type==='checkbox' && e.ordinal===2),operation:'check',value:''};
 };
 const result=await runAgent(page,instruction,parsed.task.goal,{reasoner,maxSteps:6});
 assert.equal(result.status,'verified_complete',JSON.stringify(result));
 assert.equal(result.history.length,4);
 assert.deepEqual(result.history.map(e=>e.decision.operation),['fill','fill','select','check']);
 assert.deepEqual(await page.locator('input[type="checkbox"]').evaluateAll(els=>els.map(e=>e.checked)),[false,true,true]);
 assert.equal(await page.evaluate(()=>window.submitted),undefined);
 console.log('PASS: Real Chromium + mock decisions: partial goals rejected, fourth checkbox required, original controls preserved, no submit');
 await page.close();
} finally {await browser.close();}
