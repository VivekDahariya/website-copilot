import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import {
  answerWebpage,
  extractReadablePage,
  selectRelevantPageEvidence
} from '../src/agent/webpage-answer.js';

const browser = await chromium.launch({headless:true,...(existsSync('/usr/bin/chromium')?{executablePath:'/usr/bin/chromium',args:['--no-sandbox']}: {})});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const items = Array.from({length:8},(_,i)=>`<li>Component ${i+1} — ${'Documented details '.repeat(6)}</li>`).join('');
  await page.setContent(`<html><head><title>Reference</title></head><body><main><h1>Reference</h1><h2>Eight Basic Components</h2><ol>${items}</ol><p>Each component is independently documented.</p></main></body></html>`);
  const url = 'https://reading-fixture.test/guide';
  const readingPage = {
    url: () => url,
    evaluate: async cb => {
      const result = await page.evaluate(cb);
      return result && typeof result === 'object' && 'url' in result ? {...result,url} : result;
    }
  };
  const before = await page.locator('body').innerHTML();
  const req = 'Read this page, list all eight basic components and explain first three. Do not modify anything.';
  const full = Array.from({length:8},(_,i)=>`${i+1}. Component ${i+1} — ${i<3?'A documented component with details.':'Documented component.'}`).join('\n');
  const captured=[];
  const fetchImpl=async(_url,options)=>{
    const body=JSON.parse(options.body);
    captured.push(body);
    if(captured.length===1) return {ok:true,json:async()=>({response:full.slice(0,100),done:true,done_reason:'length'})};
    return {ok:true,json:async()=>({response:full,done:true,done_reason:'stop'})};
  };
  const result=await answerWebpage(readingPage,req,{fetchImpl});
  assert.equal(result.status,'answer_ready',JSON.stringify(result));
  assert.equal(result.evidence.generationAttempts,2);
  assert.equal(captured.length,2);
  assert.ok(captured[0].options.num_predict>650,'Output budget must adapt to explicit enumeration.');
  assert.ok(captured[1].options.num_predict>captured[0].options.num_predict,'Retry must enlarge output allowance.');
  assert.ok(captured[1].options.num_ctx>=captured[0].options.num_ctx,'Retry must have sufficient context.');
  assert.ok(captured.every(c=>c.model==='qwen3:4b-instruct'||c.model==='qwen3:4b'));
  assert.ok(captured.every(c=>c.think===false && c.options.temperature===0));
  assert.equal(await page.locator('body').innerHTML(),before);
  assert.equal(readingPage.url(),url);
  console.log('PASS: Chromium read-only page + Ollama truncated response -> bounded larger retry -> complete grounded result.');

  let cappedCalls=0;
  const fail=await answerWebpage(readingPage,req,{fetchImpl:async()=>{
    cappedCalls++;
    return {ok:true,json:async()=>({response:full.slice(0,120),done:true,done_reason:'length'})};
  }});
  assert.equal(fail.status,'answer_unavailable');
  assert.equal(cappedCalls,2,'No unbounded looping.');
  assert.match(fail.reason,/output limit/i);
  console.log('PASS: Two length-limited responses -> honest answer_unavailable, no unbounded retries.');

  let incompleteCalls=0;
  const incomplete=await answerWebpage(readingPage,req,{fetchImpl:async()=>{
    incompleteCalls++;
    return {ok:true,json:async()=>({response:full.split('\n').slice(0,3).join('\n'),done:true,done_reason:'stop'})};
  }});
  assert.equal(incomplete.status,'answer_unavailable');
  assert.equal(incompleteCalls,2);
  assert.match(incomplete.reason,/expected 8 numbered items/i);
  console.log('PASS: Nontruncated but incomplete enumeration cannot be marked answer_ready.');

  const bad=await answerWebpage(readingPage,req,{fetchImpl:async()=>({ok:false,status:503})});
  assert.equal(bad.status,'answer_unavailable');
  assert.match(bad.reason,/HTTP 503/);
  console.log('PASS: Model-unavailable failure remains explicit.');
} finally {
  await browser.close();
}
