import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { extractStructuredEnumeration, requestedExplanationCount } from '../src/agent/structured-reading.js';
import { answerWebpage } from '../src/agent/webpage-answer.js';

const launch={headless:true,...(existsSync('/usr/bin/chromium') ? {executablePath:'/usr/bin/chromium',args:['--no-sandbox']} : {})};
const browser=await chromium.launch(launch);
try {
 const ctx=await browser.newContext(); const p=await ctx.newPage();
 const fake=(url='https://fictional-docs.test/guide')=>({
   url:()=>url,
   evaluate:async (fn,arg)=>{
     const output=await p.evaluate(fn,arg);
     return output && typeof output==='object' && 'url' in output ? {...output,url} : output;
   }
 });
 const request='Read the current webpage and list all eight components mentioned under "Eight Basic Components". Explain the first three briefly. Do not navigate away or modify anything.';
 const names=['Initialize environment','Inspect available state','Collect browser information','Set execution parameters','Find matching element','Perform an element action','Read returned details','End the workflow'];
 const items=names.map((name,i)=>`<h3>${i+1}. ${name}</h3><p>${name} is used by the application for a documented step ${i+1} to ensure an accurate result.</p><div class="tabs"><h5>Code snippet</h5><pre>${'long source code sentence '.repeat(80)}</pre></div>`).join('');
 await p.setContent(`<html><head><title>Working manual</title></head><body><nav><ol>${Array.from({length:8},(_,i)=>`<li>Misleading navigation ${i+1}</li>`).join('')}</ol></nav><main><h1>Working manual</h1>${'<p>Unrelated overview.</p>'.repeat(50)}<h2>Eight Basic Components</h2><p>These are the verified basic components.</p>${items}<h2>Appendix</h2><h3>1. Unrelated appendix step</h3></main></body></html>`);
 const original=await p.locator('body').innerHTML();const page=fake();
 const extracted=await extractStructuredEnumeration(page,request,8);
 assert.equal(extracted?.found,true,JSON.stringify(extracted));
 assert.equal(extracted.method,'numbered_headings');
 assert.deepEqual(extracted.items.map(x=>x.title),names);
 assert.equal(requestedExplanationCount(request,8),3);
 let modelCalls=0;
 const timeoutStub=async()=>{modelCalls++;return {ok:true,json:async()=>({response:'{"explanations":["Partial result',done:true,done_reason:'length'})};};
 const result=await answerWebpage(page,request,{fetchImpl:timeoutStub});
 assert.equal(result.status,'answer_ready',JSON.stringify(result));
 assert.equal(modelCalls,1,'One concise explanation attempt, never repeat full document');
 assert.equal(result.evidence.verifiedItems,8);
 assert.equal(result.evidence.modelExplanation,'model_output_cut_off');
 for(const [i,name] of names.entries()) assert.ok(result.answer.includes(`${i+1}. **${name}**`));
 assert.match(result.answer,/1\. \*\*Initialize environment\*\* — Initialize environment is used/);
 assert.equal(await p.locator('body').innerHTML(),original,'No DOM mutation');
 assert.equal(ctx.pages().length,1,'No browser navigation/new tabs');
 console.log('PASS: 8 numbered subheadings, long code panels, unrelated sidebar; source-grounded answer despite model output cutoff.');

 // Same engine, different webpage with real semantic lists.
 await p.setContent(`<html><body><main><h1>Reference</h1><h2>Three Installation Stages</h2><ol>
 <li><strong>Prepare workspace</strong> — Create a clean directory and confirm its contents.</li>
 <li><strong>Install packages</strong> — Use the package manager to install dependencies.</li>
 <li><strong>Run validation</strong> — Execute the checks and inspect the output.</li>
 </ol></main></body></html>`);
 const other='List all three stages under "Three Installation Stages".';
 const found=await extractStructuredEnumeration(page,other,3);
 assert.equal(found?.found,true,JSON.stringify(found));
 assert.equal(found.method,'semantic_list');
 assert.deepEqual(found.items.map(x=>x.title),['Prepare workspace','Install packages','Run validation']);
 const noCall=await answerWebpage(page,other,{fetchImpl:async()=>{throw Error('Model should not be called for factual list names.');}});
 assert.equal(noCall.status,'answer_ready',JSON.stringify(noCall));
 assert.equal(noCall.evidence.generationAttempts,0);
 console.log('PASS: Generic OL section; exact list names copied from DOM with zero model calls.');

 // Missing item must not be fabricated.
 await p.setContent(`<html><body><main><h1>Guide</h1><h2>Four Stages</h2><h3>1. Plan</h3><p>Determine requirements carefully.</p><h3>2. Act</h3><p>Perform the selected action.</p><h3>3. Review</h3><p>Review results.</p></main></body></html>`);
 const short=await answerWebpage(page,'List all four stages under "Four Stages".',{fetchImpl:async()=>{throw Error('No guessing');}});
 assert.equal(short.status,'answer_unavailable',JSON.stringify(short));
 assert.match(short.reason,/did not contain all 4 verifiable items/);
 console.log('PASS: Incomplete source enumeration is rejected; no invented fourth item.');

 // Normal prose question remains on the original generic reader path.
 await p.setContent(`<html><body><main><h1>A long reference</h1><p>${'A documented claim about software versioning. '.repeat(12)}</p></main></body></html>`);
 let calls=0;
 const generic=await answerWebpage(page,'What does this page describe?',{fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({done:true,done_reason:'stop',response:'This page describes documented claims about software versioning.'})};}});
 assert.equal(generic.status,'answer_ready',JSON.stringify(generic));assert.equal(calls,1);
 console.log('PASS: Normal unstructured questions still use the original general model reader.');

 // Small grounded model explanation works without delegating item names.
 await p.setContent(`<html><body><main><h1>Course</h1><h2>Two Steps</h2><h3>1. Prepare workspace</h3><p>Prepare workspace with a verified directory.</p><h3>2. Inspect source</h3><p>Inspect source metadata before execution.</p></main></body></html>`);
 const full=await answerWebpage(page,'List all two steps under "Two Steps" and explain first two.', {fetchImpl:async()=>({ok:true,json:async()=>({done:true,done_reason:'stop',response:JSON.stringify({explanations:['Prepare a verified workspace directory.','Inspect source metadata before execution.']})})})});
 assert.equal(full.status,'answer_ready',JSON.stringify(full));
 assert.equal(full.evidence.modelExplanation,'model_grounded');
 console.log('PASS: Short model explanations are merged into source-owned item names.');
} finally { await browser.close(); }
