import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runAgent } from '../src/agent/agent.js';

const browser = await chromium.launch({headless:true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM}:{}),
  args:['--no-sandbox']});
try {
  const context = await browser.newContext();
  const original = await context.newPage();
  const unrelated = await context.newPage();
  await original.setContent('<title>Original tab</title><h1>Original tab</h1><a id="open" href="#" onclick="event.preventDefault()">Click Here</a>');
  await unrelated.setContent('<title>Unrelated tab</title><h1>Unrelated tab</h1>');
  const instruction = 'Click the "Click Here" link to open a new browser tab or window. Switch to the newly opened page, read its heading, then return to the original tab. Keep both tabs open.';
  let unrelatedPopup = null;
  const unrelatedOpen = new Promise(resolve => context.on('page', async popup => {
    if (popup === original || popup === unrelated) return;
    unrelatedPopup = popup;
    await popup.setContent('<title>New Window</title><h1>New Window</h1>');
    resolve();
  }));
  let reasonerCalls=0;
  const reasoner=async (_task,observation)=>{
    reasonerCalls++;
    if (reasonerCalls===1) {
      const link = observation.actionableElements.find(x=>x.label==='Click Here');
      assert.ok(link);
      // Unrelated tab opens a convincing fake page while the clicked link
      // itself does NOT open a new tab.
      setTimeout(()=>unrelated.evaluate(()=>window.open('about:blank','_blank')).catch(()=>{}),120);
      return {ref:link.ref,operation:'click',value:''};
    }
    throw new Error('No further grounded task action');
  };
  const result=await runAgent(original,instruction,
    {type:'visible_content',text:'New Window'},
    {reasoner,maxSteps:4});
  await unrelatedOpen;
  assert.notEqual(result.status,'verified_complete',JSON.stringify(result));
  assert.notEqual(result.verification?.evidence?.tabWorkflow?.originalTabRestored,true);
  assert.equal(original.isClosed(),false);
  assert.equal(unrelatedPopup.isClosed(),false);
  assert.equal(reasonerCalls>=2,true);
  console.log('PASS: Unrelated popup with matching heading cannot falsely complete source-tab workflow');
  await context.close();
} finally {await browser.close();}
