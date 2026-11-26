import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/agent.js';
const launchOptions={headless:true,...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM,args:['--no-sandbox']}: {})};
const b=await chromium.launch(launchOptions);
try {
 const context=await b.newContext(); const p=await context.newPage();
 await p.setContent(`<title>The Internet</title><h1>The Internet</h1><a href="about:blank" id="go" onclick="event.preventDefault();setTimeout(()=>window.open('about:blank','_blank'),800);">Click Here</a>`);
 context.on('page', async pg=>{console.log('POPUP EVENT DETECTED');await pg.setContent('<title>New Window</title><h1>New Window</h1>');});
 let decisions=0;
 const reasoner=async(_,obs,h)=>{decisions++;console.log('REASONER sees', obs.availableTabs, 'history:', h.map(x=>x.decision.operation)); if(!h.length)return{ref:obs.actionableElements.find(x=>x.label.includes('Click Here')).ref,operation:'click',value:''};throw Error('No permitted tab action from stale observation');};
 const ins='Click the "Click Here" link to open a new browser tab or window. Switch to the newly opened page, read its heading, then return to the original tab. Keep both tabs open.';
 const r=await runAgent(p,ins,{type:'visible_content',text:'New Window'},{reasoner,maxSteps:6});
 assert.equal(r.status, 'verified_complete');
 assert.deepEqual(r.history.map(x=>x.decision.operation), ['click','switch_tab','switch_tab']);
 assert.equal(context.pages().length,2);
 assert.equal(decisions,1);
 assert.equal(r.verification?.evidence?.tabWorkflow?.observedHeading,'New Window');
 assert.equal(r.verification?.evidence?.tabWorkflow?.originalTabRestored,true);
 console.log('PASS: Delayed real popup (800ms) waits before snapshot, returns to initial tab, both remain open; no stale model replan');

} finally {await b.close();}
