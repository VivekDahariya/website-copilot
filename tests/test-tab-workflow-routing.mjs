import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { validateGoalSchema } from '../src/agent/goal-schema-validator.js';
import { validateTaskContract } from '../src/agent/task-contract.js';

// This file tests the earlier structured-goal interpreter path. Direct
// mode is the default, so that path is selected here explicitly.
process.env.COPILOT_DIRECT_INSTRUCTION = '0';

const task = 'Click the "Click Here" link to open a new browser tab or window. Switch to the newly opened page, read its heading, then return to the original tab. Keep both tabs open.';
const browser = await chromium.launch({headless:true,...(process.env.WC_TEST_CHROMIUM?{
  executablePath:process.env.WC_TEST_CHROMIUM,args:['--no-sandbox']
}:{})});
try {
  const page = await browser.newPage();
  await page.setContent('<title>Original tab</title><h1>Original tab</h1><a href="about:blank" target="_blank">Click Here</a>');
  const popupReady = new Promise(resolve=>page.once('popup',async p=>{
    await p.setContent('<title>New Window</title><h1>New Window</h1>');
    resolve(p);
  }));
  let interpreterCalls=0,actionModelCalls=0;
  const events=[];
  const result = await executeNaturalLanguageTask(page,task,{
    interpreterOptions: {fetchImpl:async()=>{
      interpreterCalls++;
      return {ok:true,json:async()=>({response:JSON.stringify({type:'unsupported',reason:'No form controls available to interact with.'})})};
    }},
    orchestratorOptions:{agentOptions:{maxSteps:8,
      onAgentEvent:event=>events.push(event),
      reasoner:async(_task,observation,history)=>{
        actionModelCalls++;
        assert.equal(history.length,0,'Second/third tab decisions must be grounded automation');
        const openingLink=observation.actionableElements.find(x=>x.label.includes('Click Here'));
        assert.ok(openingLink);
        return {ref:openingLink.ref,operation:'click',value:''};
      },
      observer:async currentPage=>{
        if(actionModelCalls>0) await popupReady;
        const {observeReliably}=await import('../src/observer/reliable-observer.js');
        return observeReliably(currentPage);
      }
    }}
  });
  assert.equal(result.status,'verified_complete',JSON.stringify(result));
  assert.equal(interpreterCalls,0,'Model must not misclassify an exact tab sequence as a form');
  assert.equal(actionModelCalls,1,'Only the first grounded click needs the action planner');
  assert.equal(result.execution.result.history.length,3);
  assert.deepEqual(result.execution.result.history.map(x=>x.decision.operation),['click','switch_tab','switch_tab']);
  assert.equal(result.interpretedTask.goal.type,'tab_workflow');
  assert.equal(result.execution.result.verification.evidence.tabWorkflow.originalTabRestored,true);
  assert.equal(result.execution.result.verification.evidence.tabWorkflow.observedHeading,'New Window');
  assert.equal(page.context().pages().length,2);
  const lastObserved=events.filter(x=>x.type==='page_observed').at(-1);
  assert.equal(lastObserved?.title,'Original tab','Final UI observation must be original tab');
  assert.equal(events.filter(x=>x.type==='goal_verified').length,1);
  assert.ok(events.some(x=>x.type==='evidence_snapshot'&&x.phase==='post_action'&&x.complete===true));
  console.log('PASS: Tab sequence bypasses incorrect form interpretation; real Chromium click/switch/return independently verified; final UI observation reports original tab');
  await page.context().close();

  assert.deepEqual(validateGoalSchema({type:'tab_workflow'}),{type:'tab_workflow'});
  assert.throws(()=>validateGoalSchema({type:'tab_workflow',text:'invented'}));
  assert.throws(()=>validateTaskContract({type:'browser_goal',instruction:task,goal:{type:'tab_workflow'}}),'Untrusted model goals cannot inject tab workflow mode');
  assert.throws(()=>validateTaskContract({type:'browser_goal',instruction:task,goal:{type:'tab_workflow',unexpected:true}}));
  console.log('PASS: Task and goal contracts preserve strict tab workflow schema');

  // Nonmatching instructions must retain normal interpretation, including
  // ordinary read-only questions, forms, and general website navigation.
  const normal=await browser.newPage();
  await normal.setContent('<title>Original tab</title><h1>Original tab</h1>');
  let ordinaryCalls=0;
  const ordinary=await executeNaturalLanguageTask(normal,'Open Report and verify its heading.',{
    interpreterOptions:{fetchImpl:async()=>{ordinaryCalls++;return {ok:true,json:async()=>({response:JSON.stringify({type:'unsupported',reason:'Missing report location'})})}}}
  });
  assert.equal(ordinary.status,'needs_clarification');
  assert.equal(ordinaryCalls,1);
  console.log('PASS: Ordinary browser tasks still rely on interpreter and fail closed when unsupported');
  await normal.context().close();
} finally {await browser.close()}
