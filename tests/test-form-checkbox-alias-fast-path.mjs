import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {runAgent} from '../src/agent/agent.js';
import {observePage} from '../src/observer/dom-observer.js';
import {proposeGroundedFormBatch} from '../src/agent/form-fast-path.js';

const browser=await chromium.launch({headless:true,args:['--no-sandbox'],
  ...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM}:{})});
const instruction='On this webpage, enter "Atlas Research" in Username, replace the TextArea Comment with "Website CoPilot independent automation test", check Checkbox 2, and choose "Drop Down Item 4" from the Dropdown. Leave every other field unchanged. Do not submit the form.';
const goal={type:'all_of',conditions:[
 {type:'form_state',fieldLabel:'username',expectedValue:'Atlas Research'},
 {type:'form_state',fieldLabel:'comments',expectedValue:'Website CoPilot independent automation test'},
 {type:'form_state',fieldLabel:'checkboxes[]',expectedValue:true},
 {type:'form_state',fieldLabel:'dropdown',expectedValue:'dd4'},
 {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'}]};
const content=`<!doctype html><title>HTML Form Elements</title><form onsubmit="window.submitted=true;event.preventDefault()">
<label>Username<input name="username" /></label><label>Comments<textarea name="comments"></textarea></label>
<label>Check 1<input type="checkbox" name="checkboxes[]" value="cb1"></label>
<label>Check 2<input type="checkbox" name="checkboxes[]" value="cb2"></label>
<label>Check 3<input type="checkbox" name="checkboxes[]" value="cb3" checked></label>
<label>Drop Down<select name="dropdown"><option value="dd1">Drop Down Item 1</option><option value="dd4">Drop Down Item 4</option></select></label>
<button type="submit">Submit</button></form>`;
try {
 const page=await browser.newPage();
 await page.setContent(content);
 const observation=await observePage(page);
 const proposal=proposeGroundedFormBatch({instruction,goal,observation});
 assert(proposal,'Must ground exact logged 5-condition goal');
 assert.deepEqual(proposal.map(action=>action.operation),['fill','fill','select','check']);
 const target=observation.actionableElements.find(el=>el.type==='checkbox'&&el.ordinal===2);
 assert.equal(proposal[3].ref,target.ref);
 assert.equal(proposal.some(action=>action.ref===observation.actionableElements.find(el=>el.type==='checkbox'&&el.ordinal===3)?.ref),false);
 console.log('PASS: Exact five-condition interpretation coalesced into four authorized form edits');

 const events=[];
 const output=await runAgent(page,instruction,goal,{maxSteps:7,onAgentEvent:e=>events.push(e)});
 assert.equal(output.status,'verified_complete',JSON.stringify(output));
 assert.deepEqual(output.history.map(item=>item.decision.operation),['fill','fill','select','check']);
 assert.equal(events.filter(e=>e.type==='form_fast_path_planned'&&e.source==='goal_grounded').length,1);
 assert.equal(events.filter(e=>e.type==='form_fast_path_next').length,3);
 assert.equal(events.filter(e=>e.type==='planning_started').length,1);
 assert.deepEqual(await page.locator('input[type=checkbox]').evaluateAll(xs=>xs.map(x=>x.checked)),[false,true,true]);
 assert.equal(await page.locator('input[name=username]').inputValue(),'Atlas Research');
 assert.equal(await page.locator('textarea[name=comments]').inputValue(),'Website CoPilot independent automation test');
 assert.equal(await page.locator('select[name=dropdown]').inputValue(),'dd4');
 assert.equal(await page.evaluate(()=>window.submitted),undefined);
 console.log('PASS: Real Chromium end-to-end 4 actions from one grounded batch; no accidental checkbox edits or submission');
 await page.close();
 const testPage=await browser.newPage();await testPage.setContent(content);
 const state=await observePage(testPage);
 const run=(task,conditions)=>proposeGroundedFormBatch({instruction:task,goal:{type:'all_of',conditions},observation:state});
 const groupCondition=goal.conditions[2],namedCondition=goal.conditions[4];
 assert.equal(run(instruction.replace('check Checkbox 2','check Checkbox 1 and Checkbox 2'),goal.conditions),null);
 assert.equal(run(instruction.replace('check Checkbox 2','check all checkboxes'),goal.conditions),null);
 assert.equal(run(instruction.replace('check Checkbox 2','check checkboxes[] and Checkbox 2'),goal.conditions),null);
 assert.equal(run(instruction,[...goal.conditions.slice(0,2),{...groupCondition,expectedValue:false},...goal.conditions.slice(3)]),null);
 assert.equal(run(instruction,[...goal.conditions.slice(0,2),{...groupCondition,fieldLabel:'other[]'},...goal.conditions.slice(3)]),null);
 assert.equal(run(instruction,[...goal.conditions.slice(0,2),groupCondition,...goal.conditions.slice(3),{...namedCondition,fieldLabel:'Checkbox 1'}]),null);
 console.log('PASS: Multi-checkbox, all-checkbox, explicit group, conflict, mismatch and duplicate ordinals fail closed');
 await testPage.close();
} finally {await browser.close();}
