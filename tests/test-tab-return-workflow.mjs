import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runAgent } from '../src/agent/agent.js';
import { observeReliably } from '../src/observer/reliable-observer.js';
import { createExplicitTabWorkflow } from '../src/agent/explicit-tab-workflow.js';

const instruction='Click the "Click Here" link to open a new browser tab or window. Switch to the newly opened page, read its heading, then return to the original tab. Keep both tabs open.';
const launchOptions={ headless:true, ...(process.env.WC_TEST_CHROMIUM ? { executablePath:process.env.WC_TEST_CHROMIUM, args:['--no-sandbox'] } : {}) };
const browser=await chromium.launch(launchOptions);
try {
  const page=await browser.newPage();
  await page.setContent('<title>The Internet</title><h1>The Internet</h1><a href="about:blank" target="_blank">Click Here</a>');
  let modelCalls=0;
  let popup;
  const popupReady=new Promise(resolve=>page.once('popup',async p=>{popup=p;await p.setContent('<title>New Window</title><h1>New Window</h1>');resolve(p)}));
  const reasoner=async(_task,observation,history)=>{
    modelCalls++;
    assert.equal(history.length,0,'Model must not be asked to improvise tab transitions');
    const element=observation.actionableElements.find(x=>x.label.includes('Click Here'));
    assert.ok(element,'Opening link must be grounded in real DOM');
    return {ref:element.ref,operation:'click',value:''};
  };
  const observer=async currentPage=>{
    if(modelCalls>=1) await popupReady;
    return observeReliably(currentPage);
  };
  const result=await runAgent(page,instruction,{type:'visible_content',text:'New Window'}, {reasoner,observer,maxSteps:6});
  const actions=result.history.map(x=>x.decision.operation);
  assert.equal(result.status,'verified_complete',JSON.stringify(result));
  assert.deepEqual(actions,['click','switch_tab','switch_tab']);
  assert.equal(modelCalls,1);
  assert.equal(result.verification?.evidence?.tabWorkflow?.observedHeading,'New Window');
  assert.equal(result.verification?.evidence?.tabWorkflow?.originalTabRestored,true);
  assert.equal(page.context().pages().length,2);
  assert.ok(!page.isClosed()&&!popup.isClosed());
  console.log('PASS: Real Chromium click -> new tab -> observed heading -> return to first tab -> both remain open; no repeated model decisions');
  await page.context().close();

  // Unsupported/nonmatching instruction must retain the old model-driven tab path.
  const original=await browser.newPage();
  await original.setContent('<title>Workspace</title><h1>Workspace</h1><a href="about:blank" target="_blank">Open Report</a>');
  let pending;
  const ready=new Promise(resolve=>original.once('popup',async p=>{pending=p;await p.setContent('<title>Report</title><h1>Report ready</h1>');resolve(p)}));
  let originalCalls=0;
  const originalReasoner=async(_task,obs,history)=>{
    originalCalls++;
    if(!history.length) return {ref:obs.actionableElements.find(x=>x.label==='Open Report').ref,operation:'click',value:''};
    const target=obs.availableTabs.find(t=>!t.active&&t.title==='Report');
    assert.ok(target);
    return {ref:target.ref,operation:'switch_tab',value:''};
  };
  const originalObs=async p=>{if(originalCalls>=1)await ready;return observeReliably(p)};
  const oldResult=await runAgent(original,'Click Open Report, switch to report tab and verify Report ready.',{type:'visible_content',text:'Report ready'},{reasoner:originalReasoner,observer:originalObs,maxSteps:6});
  assert.equal(oldResult.status,'verified_complete');
  assert.deepEqual(oldResult.history.map(h=>h.decision.operation),['click','switch_tab']);
  console.log('PASS: Original Oct21 goal-based tab task unchanged: Qwen-style decisions click -> switch_tab -> verified_complete');
  await original.context().close();

  const noPopup=await browser.newPage();
  await noPopup.setContent('<title>The Internet</title><h1>The Internet</h1><a href="about:blank">Click Here</a>');
  let attempted=false;
  const noPopupResult=await runAgent(noPopup,instruction,{type:'visible_content',text:'New Window'}, {
    maxSteps:3,
    reasoner:async(_task,obs,history)=>{
      if(!attempted){attempted=true;return {ref:obs.actionableElements.find(x=>x.label.includes('Click Here')).ref,operation:'click',value:''}}
      throw new Error('No grounded action');
    }
  });
  assert.notEqual(noPopupResult.status,'verified_complete');
  console.log('PASS: No popup -> never invents a successful return workflow');
  await noPopup.context().close();

  assert.equal(createExplicitTabWorkflow('Read the current webpage',noPopup),null);
  assert.equal(createExplicitTabWorkflow('Click Open Report, switch to report tab and verify Report ready.',noPopup),null);
  console.log('PASS: Normal navigation, PDF, and read-only tasks do not activate specialized tab path');
} finally {await browser.close();}
