import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { observePage } from '../src/observer/dom-observer.js';
import { executeAction } from '../src/executor/action-executor.js';
import { runAgent } from '../src/agent/agent.js';

const browser = await chromium.launch({
  headless:true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM} : {}),
  args:['--no-sandbox']
});
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><title>Dialog safety</title>
    <button id="confirm" onclick="window.confirmed=confirm('PRIVATE_CONFIRM_MARKER')">Proceed</button>
    <button id="prompt" onclick="window.promptResult=prompt('PRIVATE_PROMPT_MARKER','yes')">Ask input</button>
    <button id="alert" onclick="alert('PRIVATE_ALERT_MARKER');window.alertReturned=true">Show notice</button>
    <button id="ordinary" onclick="document.getElementById('done').textContent='Finished'">Ordinary action</button>
    <p id="done">Not finished</p>`);
  for (const [label, expectedType] of [
    ['Proceed','confirm'],['Ask input','prompt']
  ]) {
    const obs=await observePage(page);
    const element=obs.actionableElements.find(e=>e.label===label);
    assert.ok(element,`Expected ${label} element`);
    let error=null;
    try { await executeAction(page,{ref:element.ref,operation:'click',value:''}); }
    catch (e) {error=e;}
    assert.equal(error?.code,'ACTION_NATIVE_DIALOG_INTERRUPTED');
    assert.equal(error.dialogType,expectedType);
    assert.doesNotMatch(error.message,/PRIVATE_/);
    assert.equal(page.listenerCount('dialog'),0,'Action handler should be removed');
  }
  assert.equal(await page.evaluate(()=>window.confirmed),false,'Confirm must be dismissed');
  assert.equal(await page.evaluate(()=>window.promptResult),null,'Prompt must be dismissed');
  // A plain alert asks for no decision: it is acknowledged and the action
  // completes. Only the fact that it appeared is kept, never its text.
  {
    const obs=await observePage(page);
    const element=obs.actionableElements.find(e=>e.label==='Show notice');
    const noticed=await executeAction(page,{ref:element.ref,operation:'click',value:''});
    assert.equal(noticed.executionCompleted,true);
    assert.equal(noticed.acknowledgedAlert,true);
    assert.doesNotMatch(JSON.stringify(noticed),/PRIVATE_/);
    assert.equal(page.listenerCount('dialog'),0,'Action handler should be removed');
  }
  assert.equal(await page.evaluate(()=>window.alertReturned),true,'Alert acknowledged');
  // An alert followed by a confirm is still a decision: it stops the run.
  await page.evaluate(()=>{const b=document.createElement('button');b.textContent='Notice then ask';
    b.onclick=()=>{alert('PRIVATE_ALERT_MARKER');window.both=confirm('PRIVATE_CONFIRM_MARKER')};document.body.appendChild(b)});
  {
    const obs=await observePage(page);
    const element=obs.actionableElements.find(e=>e.label==='Notice then ask');
    let error=null;
    try { await executeAction(page,{ref:element.ref,operation:'click',value:''}); } catch (e) {error=e;}
    assert.equal(error?.code,'ACTION_NATIVE_DIALOG_INTERRUPTED');
    assert.equal(error.dialogType,'confirm');
    assert.equal(await page.evaluate(()=>window.both),false,'Confirm must be dismissed');
  }
  console.log('PASS: Native confirm/prompt fail closed, alert acknowledged, no private content leaked or dangling listeners');

  const obs=await observePage(page);
  const element=obs.actionableElements.find(e=>e.label==='Ordinary action');
  const ordinary=await executeAction(page,{ref:element.ref,operation:'click',value:''});
  assert.equal(ordinary.executionCompleted,true);
  assert.equal(await page.locator('#done').textContent(),'Finished');
  assert.equal(page.listenerCount('dialog'),0);
  console.log('PASS: Ordinary clicks still succeed without browser-dialog regressions');
  await page.setContent('<button onclick="window.accepted=confirm(\'PRIVATE_AGENT_MARKER\')">Proceed</button><div id="target">Still here</div>');
  const reasoner=async (_task,observation)=>({
    ref:observation.actionableElements.find(e=>e.label==='Proceed').ref,
    operation:'click',value:''
  });
  await assert.rejects(
    runAgent(page,'Open the next step.',{type:'visible_content',text:'Success'},{maxSteps:3,reasoner}),
    /ACTION_NATIVE_DIALOG_INTERRUPTED/
  );
  assert.equal(await page.evaluate(()=>window.accepted),false);
  console.log('PASS: Agent does not claim successful completion after a cancelled native confirm');
} finally {await browser.close();}
