import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runAgent } from '../src/agent/agent.js';
import { observePage } from '../src/observer/dom-observer.js';
import { createFormMutationPolicy } from '../src/agent/form-mutation-policy.js';

const browser=await chromium.launch({headless:true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM}:{}),
  args:['--no-sandbox']});

const html=`<!doctype html><html><head><title>Independent form</title></head><body>
<form id="test" onsubmit="window.submitted=true;event.preventDefault()">
<label>Username <input name="username" aria-label="Username"></label>
<label>Comment <textarea name="comment" aria-label="Comment"></textarea></label>
<label>Checkbox 1 <input type="checkbox" name="first"></label>
<label>Checkbox 2 <input type="checkbox" name="second"></label>
<label>Checkbox 3 <input type="checkbox" name="third" checked></label>
<label>Dropdown <select name="choice" aria-label="Dropdown"><option value="1">Item 1</option><option value="4">Item 4</option></select></label>
<button type="submit">Submit</button></form></body></html>`;
const goal={type:'all_of',conditions:[
 {type:'form_state',fieldLabel:'Username',expectedValue:'Atlas Research'},
 {type:'form_state',fieldLabel:'Comment',expectedValue:'Independent automation test'},
 {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'},
 {type:'form_state',fieldLabel:'Dropdown',expectedValue:'Item 4'}
]};
const instruction='Fill Username and Comment, check Checkbox 2, select Item 4 from Dropdown. Leave every other field unchanged. Do not submit.';
function choose(obs, label, operation, value='') {
 const element=obs.actionableElements.find(e=>e.label===label);
 assert(element,`Missing browser control: ${label}`);
 return {ref:element.ref,operation,value};
}

try {
 // A real Chromium snapshot is taken before any action. A model proposes an
 // unrelated checkbox edit; the agent must reject it before Playwright.
 const page=await browser.newPage();
 await page.setContent(html);
 let rejected=false;
 const reasoner=async(_task,obs,history,rejections)=>{
   if(history.length===0 && !rejections.length) return choose(obs,'Checkbox 3','uncheck');
   if(rejections.some(a=>a.operation==='uncheck')) rejected=true;
   if(!obs.actionableElements.find(e=>e.label==='Username').currentValue)
     return choose(obs,'Username','fill','Atlas Research');
   if(!obs.actionableElements.find(e=>e.label==='Comment').currentValue)
     return choose(obs,'Comment','fill','Independent automation test');
   if(obs.actionableElements.find(e=>e.label==='Dropdown').selectedLabel!=='Item 4')
     return choose(obs,'Dropdown','select','Item 4');
   return choose(obs,'Checkbox 2','check');
 };
 const result=await runAgent(page,instruction,goal,{reasoner,maxSteps:7});
 assert.equal(result.status,'verified_complete',JSON.stringify(result));
 assert.equal(rejected,true,'Unrequested action was not challenged');
 assert.equal(result.history.length,4);
 assert.deepEqual(result.history.map(e=>e.decision.operation),['fill','fill','select','check']);
 assert.equal(await page.locator('[name="third"]').isChecked(),true,'Untargeted checkbox changed');
 assert.equal(await page.locator('[name="second"]').isChecked(),true);
 assert.equal(await page.locator('[name="first"]').isChecked(),false);
 assert.equal(await page.locator('[name="username"]').inputValue(),'Atlas Research');
 assert.equal(await page.locator('[name="comment"]').inputValue(),'Independent automation test');
 assert.equal(await page.locator('[name="choice"]').inputValue(),'4');
 assert.equal(await page.evaluate(()=>window.submitted),undefined);
 console.log('PASS: Real Chromium + mock planner: unrelated checkbox uncheck rejected; four authorized edits; untouched fields preserved; verified_complete');
 await page.close();

 // A model that repeatedly proposes only the unauthorized change cannot
 // be granted success and cannot mutate the protected checkbox.
 const blocked=await browser.newPage();await blocked.setContent(html);
 const rejectedRun=await runAgent(blocked,instruction,goal,{
   reasoner:async(_task,obs)=>choose(obs,'Checkbox 3','uncheck'),maxSteps:2
 });
 assert.notEqual(rejectedRun.status,'verified_complete');
 assert.equal(rejectedRun.history.length,0);
 assert.equal(await blocked.locator('[name="third"]').isChecked(),true);
 console.log('PASS: Repeated unauthorized model decision fails closed, no Playwright actions');
 await blocked.close();

 // A page's own onchange handler can mutate an unrelated control. Detect
 // this in the post-action browser snapshot, even if all requested goals match.
 const coupled=await browser.newPage();
 await coupled.setContent(html);
 await coupled.evaluate(()=>{
   const a=document.querySelector('[name="second"]');
   a.addEventListener('change',()=>document.querySelector('[name="third"]').checked=false);
 });
 const coupledResult=await runAgent(coupled,
   'Check Checkbox 2; leave all other fields unchanged.',
   {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'},
   {reasoner:async(_task,obs)=>choose(obs,'Checkbox 2','check'),maxSteps:2});
 assert.equal(coupledResult.status,'protected_form_state_changed',JSON.stringify(coupledResult));
 assert(coupledResult.preservationIssues.some(x=>x.reason==='protected_field_changed'));
 assert.equal(await coupled.locator('[name="second"]').isChecked(),true);
 assert.equal(await coupled.locator('[name="third"]').isChecked(),false);
 console.log('PASS: Unexpected page-side modification caught; false-positive completion blocked');
 await coupled.close();

 // An explicitly requested checkbox change is authorized. The protection
 // targets what the user did NOT request, not particular checkbox indices.
 const deliberate=await browser.newPage();await deliberate.setContent(html);
 const deliberateResult=await runAgent(deliberate,'Uncheck Checkbox 3.',
   {type:'form_state',fieldLabel:'Checkbox 3',expectedValue:'unchecked'},
   {reasoner:async(_task,obs)=>choose(obs,'Checkbox 3','uncheck'),maxSteps:2});
 assert.equal(deliberateResult.status,'verified_complete',JSON.stringify(deliberateResult));
 assert.equal(await deliberate.locator('[name="third"]').isChecked(),false);
 console.log('PASS: Explicitly requested uncheck remains allowed');
 await deliberate.close();

 // Unit-level checks of identity/state for a second unknown form, including
 // absence of checkbox controls. Never key solely by Playwright ref index.
 const policy=createFormMutationPolicy({goal:{type:'form_state',fieldLabel:'Name',expectedValue:'Test'}});
 const before={url:'https://example.test/form',actionableElements:[
   {ref:'e1',tag:'input',type:'text',editable:true,label:'Name',name:'name',currentValue:''},
   {ref:'e2',tag:'select',label:'Region',name:'region',currentValue:'north'}
 ]};
 policy.observe(before);
 assert.equal(policy.reject(before,before.actionableElements[1],{ref:'e2',operation:'select',value:'south'}),'unrequested_form_field_change');
 const shifted={url:before.url,actionableElements:[
   {...before.actionableElements[0],ref:'e2',currentValue:'Test'},
   {...before.actionableElements[1],ref:'e3',currentValue:'south'}
 ]};
 assert.equal(policy.verify(shifted).verified,false);
 assert.equal(policy.verify({...shifted,actionableElements:[shifted.actionableElements[0],{...shifted.actionableElements[1],currentValue:'north'}]}).verified,true);
 console.log('PASS: Text/select preservation survives changed observation reference numbers');

 // An explicitly named "unchanged" field is still protected in the final
 // snapshot, even though it is listed among the goal's conditions.
 const unchangedGoal={type:'all_of',conditions:[
   {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'},
   {type:'form_state',fieldLabel:'Checkbox 3',expectedValue:'unchanged'}
 ]};
 const unchangedPolicy=createFormMutationPolicy({goal:unchangedGoal});
 const unchangedInitial={url:'https://sample.test/checkboxes',actionableElements:[
   {ref:'e1',tag:'input',type:'checkbox',label:'Checkbox 2',ordinal:2,stableKey:'checkbox:2',checked:false},
   {ref:'e2',tag:'input',type:'checkbox',label:'Checkbox 3',ordinal:3,stableKey:'checkbox:3',checked:true}
 ]};
 unchangedPolicy.observe(unchangedInitial);
 const unchangedChanged={...unchangedInitial,actionableElements:[
   {...unchangedInitial.actionableElements[0],checked:true},
   {...unchangedInitial.actionableElements[1],checked:false}
 ]};
 assert.equal(unchangedPolicy.verify(unchangedChanged).verified,false);
 assert.equal(unchangedPolicy.reject(unchangedInitial,unchangedInitial.actionableElements[1],{ref:'e2',operation:'uncheck'}),'protected_unchanged_field');
 console.log('PASS: Explicit unchanged field protected before and after action');
} finally {await browser.close();}
