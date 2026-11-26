import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {runAgent} from '../src/agent/agent.js';
import {createActionApproval} from '../src/agent/action-approval.js';
import {observePage} from '../src/observer/dom-observer.js';
import {verifySubmittedFormOutcome} from '../src/agent/submission-outcome-evidence.js';

const task='On this sample form, enter "Approval Test" in the Text input field, then submit the form. Do not change any other fields.';
const goal={type:'form_state',fieldLabel:'Text input',expectedValue:'Approval Test'};
let outcome='success';
const base='https://forms.example.test';
const browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM}:{})});
async function runOnce({mode='success',deny=false}={}) {
 outcome=mode;
 const page=await browser.newPage();
 await page.setContent(`<!doctype html><html><title>Web form</title><body><h1>Web form</h1><form id="form">
 <label>Text input<input type="text" name="mytext" aria-label="Text input"></label>
 <label>Stay<input type="checkbox" checked></label><button type="submit">Submit</button></form>
 <script>window.submits=0;document.querySelector('form').addEventListener('submit',event=>{
   event.preventDefault();window.submits++;
   const mode=window.outcome;
   if(mode==='success') {document.title='Web form - target page';document.body.innerHTML='<h1>Form submitted</h1><p>Received!</p>';}
   if(mode==='failure') {document.title='Submission error';document.body.innerHTML='<h1>Submission failed</h1><p>Could not submit the form.</p>';}
   if(mode==='unrelated') {document.title='Account home';document.body.innerHTML='<h1>Account home</h1><p>Welcome, browse available services.</p>';}
 });</script></body></html>`);
 await page.evaluate(mode=>{window.outcome=mode},mode);
 let approvals=0;
 const events=[];
 const reasoner=async(_task,obs)=>{
   const input=obs.actionableElements.find(e=>e.name==='mytext');
   if(input && input.currentValue!=='Approval Test')return {ref:input.ref,operation:'fill',value:'Approval Test'};
   const submit=obs.actionableElements.find(e=>e.type==='submit');
   if(submit)return {ref:submit.ref,operation:'click',value:''};
   throw new Error('Unexpected planner invocation after form navigation');
 };
 const result=await runAgent(page,task,goal,{reasoner,maxSteps:4,
   observer:async page=>{const observation=await observePage(page); observation.url=observation.title==='Web form'?base+'/form':base+'/submitted';return {status:'ready',observation,attempts:1};},
   onAgentEvent:e=>events.push(e),
   approvalProvider:async ctx=>{approvals++;return deny?null:createActionApproval(ctx.action,{pageUrl:ctx.pageUrl,targetIdentity:ctx.targetIdentity});}});
 const title=await page.title();
 const submitCount=await page.evaluate(()=>window.submits);
 await page.close();
 return {result,approvals,title,events,submitCount};
}
try {
 let result=await runOnce();
 assert.equal(result.result.status,'verified_complete',JSON.stringify(result.result));
 assert.equal(result.approvals,1);
 assert.equal(result.submitCount,1,'submit should be executed only once');
 assert.equal(result.title,'Web form - target page');
 assert(result.events.some(e=>e.type==='goal_verified'));
 console.log('PASS: Approved native submit transitions to positive confirmation; workflow reports verified_complete, exactly one browser submit event');

 result=await runOnce({mode:'failure'});
 assert.notEqual(result.result.status,'verified_complete',JSON.stringify(result.result));
 assert.equal(result.submitCount,1);
 console.log('PASS: Post-submit validation/failure page cannot claim success or automatically resubmit');
 result=await runOnce({mode:'unrelated'});
 assert.notEqual(result.result.status,'verified_complete');
 console.log('PASS: Unrelated post-submit navigation cannot claim success');

 result=await runOnce({mode:'success',deny:true});
 assert.equal(result.result.status,'approval_required');
 assert.equal(result.submitCount,0);
 console.log('PASS: Denial blocks the browser submit event and cannot claim success');
 // Direct helper guard: URL change alone or a generic success message on an unrelated URL is insufficient.
 const beforeObs={url:base+'/form',headings:['Web form'],visibleBodyText:'Text input Submit',actionableElements:[]};
 const element={tag:'button',type:'submit',formContext:{associated:true}};
 const action={ref:'e2',operation:'click'};
 const verification={evidence:{requiresFinalizingAction:true,conditions:[{completed:true}]}};
 const check=after=>verifySubmittedFormOutcome({instruction:task,action,element,before:beforeObs,after,preActionVerification:verification});
 assert.equal(check({url:base+'/form',headings:['Form submitted'],visibleBodyText:'Received!',actionableElements:[]}).verified,true);
 assert.equal(check({url:base+'/other',headings:['Home'],visibleBodyText:'Welcome',actionableElements:[]}).verified,false);
 assert.equal(check({url:'https://elsewhere.test/submitted',headings:['Form submitted'],visibleBodyText:'Received!',actionableElements:[]}).verified,false);
 assert.equal(check({url:base+'/submitted',headings:['Submission failed'],visibleBodyText:'Not submitted',actionableElements:[]}).verified,false);
 assert.equal(verifySubmittedFormOutcome({instruction:'Do not submit the form',action,element,before:beforeObs,after:{url:base+'/submitted',headings:['Form submitted'],visibleBodyText:'Received!'},preActionVerification:verification}).verified,false);
 console.log('PASS: Positive confirmation requires authorized native submit, verified prerequisites, and independently changed document evidence');
} finally { await browser.close(); }
