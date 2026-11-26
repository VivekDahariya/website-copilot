import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {runAgent} from '../src/agent/agent.js';
import {observePage} from '../src/observer/dom-observer.js';
import {recoverExplicitSubmitAction} from '../src/agent/explicit-submit-recovery.js';
import {createWorkflowGoalVerifier} from '../src/agent/workflow-goal-verifier.js';

const task='On this sample web form, enter "Website CoPilot Approval Test" into the Text input field, then submit the form. Do not change any other fields.';
const goal={type:'form_state',fieldLabel:'Text input',expectedValue:'Website CoPilot Approval Test'};
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],
  ...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM}:{})});
try {
 const page=await browser.newPage();
 await page.setContent(`<html><title>Sample form</title><body><form id="sample" onsubmit="window.submitted=true;event.preventDefault()">
 <label>Text input <input aria-label="Text input" type="text" name="mytext"></label>
 <label>Checkbox One <input aria-label="Checkbox One" type="checkbox" checked></label>
 <button type="submit">Submit</button></form></body></html>`);
 const obs=await observePage(page);
 const verifier=createWorkflowGoalVerifier(goal,task);
 const before=verifier.verify(obs);
 assert.equal(before.evidence.requiresFinalizingAction,true);
 assert.equal(recoverExplicitSubmitAction({instruction:task,goal,observation:obs,verification:before,history:[]}),null);
 await page.locator('input[name=mytext]').fill('Website CoPilot Approval Test');
 const ready=await observePage(page);
 const verified=verifier.verify(ready);
 assert.equal(verified.completed,false);
 assert.equal(verified.evidence.conditions[0].completed,true);
 const history=[{decision:{operation:'fill'},execution:{executionCompleted:true}}];
 const candidate=recoverExplicitSubmitAction({instruction:task,goal,observation:ready,verification:verified,history});
 assert.deepEqual(candidate,{ref:ready.actionableElements.find(el=>el.type==='submit').ref,operation:'click',value:''});
 assert.equal(recoverExplicitSubmitAction({instruction:'Do not submit the form.',goal,observation:ready,verification:verified,history}),null);
 assert.equal(recoverExplicitSubmitAction({instruction:'Enter the text only.',goal,observation:ready,verification:verified,history}),null);
 assert.equal(recoverExplicitSubmitAction({instruction:task,goal,observation:ready,verification:{...verified,evidence:{...verified.evidence,conditions:[{completed:false}]}},history}),null);
 assert.equal(recoverExplicitSubmitAction({instruction:task,goal,observation:ready,verification:verified,history:[]}),null);
 const multiple={...ready,actionableElements:[...ready.actionableElements,{...ready.actionableElements.find(el=>el.type==='submit'),ref:'second-submit'}]};
 assert.equal(recoverExplicitSubmitAction({instruction:task,goal,observation:multiple,verification:verified,history}),null);
 const noAssociation={...ready,actionableElements:ready.actionableElements.map(el=>el.type==='submit'?{...el,formContext:{associated:false}}:el)};
 assert.equal(recoverExplicitSubmitAction({instruction:task,goal,observation:noAssociation,verification:verified,history}),null);
 console.log('PASS: Submit recovery requires explicit consent, verified fields, one live associated submit button, and prior action evidence');
 await page.locator('input[name=mytext]').fill('');
 const events=[];let invalid=0;let offered=0;
 const reasoner=async (_task,observation)=>{
    const input=observation.actionableElements.find(e=>e.name==='mytext');
    if(input?.currentValue!=='Website CoPilot Approval Test') return {ref:input.ref,operation:'fill',value:'Website CoPilot Approval Test'};
    invalid++;
    const checkbox=observation.actionableElements.find(e=>e.type==='checkbox');
    return {ref:checkbox.ref,operation:'uncheck',value:''};
 };
 const denied=await runAgent(page,task,goal,{reasoner,maxSteps:6,
    onAgentEvent:e=>events.push(e),approvalProvider:async ctx=>{offered++; assert.equal(ctx.action.operation,'click');assert.equal(ctx.element.type,'submit');return {granted:false};}});
 assert.equal(denied.status,'approval_required',JSON.stringify(denied));
 assert.equal(offered,1);
 assert(invalid>=2);
 assert(events.some(e=>e.type==='planning_recovered' && e.reason==='unique_explicit_submit_pending_approval'));
 assert.equal(await page.evaluate(()=>window.submitted),undefined);
 assert.equal(await page.locator('input[type=checkbox]').isChecked(),true);
 assert.equal(await page.locator('input[name=mytext]').inputValue(),'Website CoPilot Approval Test');
 console.log('PASS: Real Chromium fill -> planner cannot select submit -> recovered submit prompts for approval; denial causes no submit or unintended edits');
} finally { await browser.close(); }
