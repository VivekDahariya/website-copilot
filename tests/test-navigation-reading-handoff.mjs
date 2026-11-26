import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import {
  isReadOnlyQuestion,
  isNavigationThenReadingTask,
  answerWebpage
} from '../src/agent/webpage-answer.js';

const task = `Use Wikipedia's search to find Ada Lovelace. Open her Wikipedia article and identify her occupation and what she is best known for, using the article's introductory text. Do not edit Wikipedia, log in, or navigate to external websites.`;
assert.equal(isReadOnlyQuestion(task), false);
assert.equal(isNavigationThenReadingTask(task), true);
for (const ordinary of [
  'Read this article and describe the author. Do not navigate elsewhere.',
  'Click the Click Here link, switch to the new tab, read heading and return to original tab.',
  'Open the Ada Lovelace article.',
  'Fill the form and then summarize the result.',
  'Explain how to search for an article and then open it.',
  'Navigate to the article, then download the PDF and explain it.'
]) {
  assert.equal(isNavigationThenReadingTask(ordinary), false, ordinary);
}
console.log('PASS: Only navigation followed by a requested informational answer activates handoff');
const browser = await chromium.launch({headless:true,
  ...(existsSync('/usr/bin/chromium') ? {executablePath:'/usr/bin/chromium',args:['--no-sandbox']} : {})
});
const start = 'https://wiki-fixture.test/wiki/Main_Page';
const destination = 'https://wiki-fixture.test/wiki/Ada_Lovelace';
const article = 'Ada Lovelace was an English mathematician and writer, chiefly known for her work on Charles Babbage’s proposed Analytical Engine. Her published notes described an algorithm intended for a machine, and historians consider this contribution a foundational milestone in computing. The article describes her mathematical studies, correspondence, and work translating an academic account of the Analytical Engine.';
let interpretCalls=0, readCalls=0, decisionCalls=0;
const interpretFetch=async (_url,options)=>{
  interpretCalls++;
  assert.equal(JSON.parse(options.body).model.length>0,true);
  return {ok:true,json:async()=>({response:JSON.stringify({type:'browser_goal',goal:{type:'page_destination',heading:'Ada Lovelace'}})})};
};
const expectedAnswer='Ada Lovelace was an English mathematician and writer. She is best known for her work on Charles Babbage’s proposed Analytical Engine, as documented in the article introduction.';
const readFetch=async (_url,opts)=>{
  readCalls++;
  const body=JSON.parse(opts.body);
  assert.match(body.prompt,/SOURCE URL:\s*https:\/\/wiki-fixture\.test\/wiki\/Ada_Lovelace/);
  assert.match(body.prompt,/English mathematician and writer/);
  assert.equal(body.model,process.env.COPILOT_READING_MODEL || 'qwen2.5:3b');
  return {ok:true,json:async()=>({response:expectedAnswer,done:true,done_reason:'stop'})};
};
try {
  const context=await browser.newContext();
  await context.route('https://wiki-fixture.test/**', route=>{
    const url=route.request().url();
    if(url===start) return route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><title>Wikipedia, the free encyclopedia</title><main><h1>Wikipedia, the free encyclopedia</h1><p>Welcome to the encyclopedia with links to millions of entries.</p><a href="${destination}">Ada Lovelace</a></main>`});
    if(url===destination) return route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><title>Ada Lovelace - Wikipedia</title><main><article><h1>Ada Lovelace</h1><p>${article}</p></article></main>`});
    return route.fulfill({status:404,body:'Not found'});
  });
  const page=await context.newPage();
  await page.goto(start);
  const result=await executeNaturalLanguageTask(page,task,{
    interpreterOptions:{fetchImpl:interpretFetch},
    orchestratorOptions:{agentOptions:{maxSteps:4,reasoner:async (_instruction,obs,history)=>{
      decisionCalls++;
      assert.equal(history.length,0);
      const link=obs.actionableElements.find(el=>el.label.includes('Ada Lovelace'));
      assert.ok(link,'Expected grounded link');
      return {ref:link.ref,operation:'click',value:''};
    }}},
    answerOptions:{fetchImpl:readFetch}
  });
  assert.equal(result.status,'answer_ready',JSON.stringify(result));
  assert.equal(page.url(),destination);
  assert.equal(result.sourceUrl,destination);
  assert.equal(result.answer,expectedAnswer);
  assert.equal(result.execution.status,'verified_complete');
  assert.equal(result.execution.result.history.length,1);
  assert.equal(interpretCalls,1);
  assert.equal(readCalls,1);
  assert.equal(decisionCalls,1);
  console.log('PASS: Verified Chromium navigation hands off to grounded reading on final page; preserves action history');

  // A source-limited response must not turn verified page arrival into a false claim
  // that the whole user question was answered.
  await page.goto(start);
  readCalls=0;
  const failed=await executeNaturalLanguageTask(page,task,{
    interpreterOptions:{fetchImpl:interpretFetch},
    orchestratorOptions:{agentOptions:{maxSteps:4,reasoner:async(_instruction,obs)=>({ref:obs.actionableElements.find(e=>e.label.includes('Ada Lovelace')).ref,operation:'click',value:''})}},
    answerOptions:{fetchImpl:async()=>{readCalls++;return {ok:true,json:async()=>({response:'An incomplete answer.',done:true,done_reason:'length'})};}}
  });
  assert.equal(failed.status,'answer_unavailable');
  assert.equal(failed.execution.status,'verified_complete');
  assert.equal(failed.answer,undefined);
  assert.equal(readCalls,2);
  console.log('PASS: Bounded reader failure returns answer_unavailable, never navigation-only verified_complete');

  await page.goto(start);
  const navOnly=await executeNaturalLanguageTask(page,'Open the Ada Lovelace article.',{
    interpreterOptions:{fetchImpl:interpretFetch},
    orchestratorOptions:{agentOptions:{maxSteps:4,reasoner:async(_instruction,obs)=>({ref:obs.actionableElements.find(e=>e.label.includes('Ada Lovelace')).ref,operation:'click',value:''})}},
    answerOptions:{fetchImpl:async()=>{throw Error('Navigation-only task unexpectedly called the reader')}}
  });
  assert.equal(navOnly.status,'verified_complete');
  console.log('PASS: Navigation-only task retains original completion behavior');

  const bad=await answerWebpage(page,'Fill a form then submit it.',{navigationCompleted:true});
  assert.equal(bad.status,'unsupported_reading_intent');
  console.log('PASS: Navigated-reader option cannot bypass non-reading intent safety');
  await context.close();
} finally {await browser.close();}
