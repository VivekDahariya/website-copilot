import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { observePage } from '../src/observer/dom-observer.js';
import { executeAction } from '../src/executor/action-executor.js';
import { inspectLiveTarget } from '../src/agent/live-target-identity.js';
import { createConversationalApprovalProvider } from '../src/agent/conversational-approval.js';
import { validateActionApproval } from '../src/agent/action-approval.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { chooseDiscoveryCandidate, discoverWebsite, inferTargetDomain } from '../src/agent/website-discovery.js';
import { shouldCloseBrowserAfterRun } from '../src/ui/browser-run-lifecycle.js';

// This file tests the earlier structured-goal interpreter path. Direct
// mode is the default, so that path is selected here explicitly.
process.env.COPILOT_DIRECT_INSTRUCTION = '0';

const browser=await chromium.launch({
  headless:true,
  ...(process.env.CHROMIUM_BIN ? {executablePath:process.env.CHROMIUM_BIN} : {}),
  args:['--no-sandbox']
});
const savedFetch=globalThis.fetch;
try {
  // Actual Chromium form state and actual browser action executor.
  const page=await browser.newPage();
  await page.setContent(`<!doctype html><html><head><title>Registration</title></head><body><h1>Registration</h1><form onsubmit="window.sent=true;event.preventDefault()">
    <label>Display name<input id="display" aria-label="Display name"></label>
    <label>Country<select id="country" aria-label="Country"><option value="in">India</option><option value="jp">Japan</option></select></label>
    <button type="submit">Submit form</button>
  </form></body></html>`);
  let obs=await observePage(page);
  const getRef = name=>{
    const el=obs.actionableElements.find(x=>String(x.label||'').includes(name));
    assert(el,`Missing element: ${name}`);
    return el.ref;
  };
  await executeAction(page,{ref:getRef('Display name'),operation:'fill',value:'Alex'});
  obs=await observePage(page);
  await executeAction(page,{ref:getRef('Country'),operation:'select',value:'Japan'});
  assert.equal(await page.locator('#display').inputValue(),'Alex');
  assert.equal(await page.locator('#country').inputValue(),'jp');
  assert.notEqual(await page.evaluate(()=>window.sent),true);
  console.log('PASS: Chromium form fields updated; no accidental submission');

  obs=await observePage(page);
  const action={ref:getRef('Submit form'),operation:'click',value:''};
  let denied=false;
  try {await executeAction(page,action);}catch(e){denied=/APPROVAL/.test(e.message);}
  assert(denied,'Unapproved submit was not blocked');
  console.log('PASS: Real form submit blocked without approval');

  const live=await inspectLiveTarget(page,action);
  const element=obs.actionableElements.find(e=>e.ref===action.ref);
  let modelCalls=0;
  globalThis.fetch=async()=>{modelCalls++;throw new Error('Ollama unavailable for approval dialog')};
  const deny=createConversationalApprovalProvider({requestUser:async()=>({optionId:'deny'})});
  assert.equal(await deny({action,element,pageUrl:live.pageUrl,targetIdentity:live.targetIdentity}),null);
  assert.notEqual(await page.evaluate(()=>window.sent),true);
  console.log('PASS: Denied approval cannot execute consequential action');

  const provider=createConversationalApprovalProvider({requestUser:async dialog=>{
    assert.match(dialog.question,/Approve click/);
    assert.match(dialog.question,/Submit form/);
    assert.equal(dialog.pendingAction.operation,'click');
    return {optionId:'approve'};
  }});
  const approval=await provider({action,element,pageUrl:live.pageUrl,targetIdentity:live.targetIdentity});
  assert.equal(approval?.granted,true);
  assert.equal(validateActionApproval(approval,action,live).allowed,true);
  assert.equal(validateActionApproval(approval,{...action,ref:'different'},live).allowed,false);
  assert.equal(validateActionApproval(approval,action,{pageUrl:'https://wrong.test/',targetIdentity:live.targetIdentity}).allowed,false);
  await executeAction(page,action,{approval});
  assert.equal(await page.evaluate(()=>window.sent),true);
  assert.equal(validateActionApproval(approval,action,live).allowed,false);
  console.log('PASS: Direct UI approval works without Qwen, bound to exact live action, single-use');

  const textProvider=createConversationalApprovalProvider({requestUser:async()=>({text:'approve'})});
  assert.equal(await textProvider({action,element,pageUrl:live.pageUrl,targetIdentity:live.targetIdentity}),null);
  console.log('PASS: Natural-language approval fails closed when Ollama is unavailable');
  assert(modelCalls>=4,'Fallback/model failure paths not exercised');

  assert.equal(inferTargetDomain('Find the guide at atlas-docs.example.net'), 'atlas-docs.example.net');
  assert.equal(inferTargetDomain('Navigate to docs.alpha.example.co.in'), 'docs.alpha.example.co.in');
  assert.equal(inferTargetDomain('Visit github.com'), 'github.com');
  console.log('PASS: Full explicit subdomains retained without site-specific lookup');

  // URL-less discovery logic on a simulated page, because this container
  // blocks arbitrary external hostnames before Playwright routes can fire.
  const mockDiscoveredPage = {
    currentUrl: 'about:blank',
    url(){return this.currentUrl},
    async goto(next){this.currentUrl=next},
    async title(){return 'Atlas Docs'},
    locator(){return {innerText:async()=>
      'Atlas Docs documentation: installation, configuration, API usage and other helpful reference topics.'}}
  };
  const discovery=await discoverWebsite(mockDiscoveredPage,
    'Find the installation guide on atlas-docs.example.net');
  assert.equal(discovery.status,'found',JSON.stringify(discovery));
  assert.equal(new URL(discovery.url).hostname,'atlas-docs.example.net');
  console.log('PASS: URL-less explicit-domain discovery retains and verifies full hostname (simulated page)');

  // Normal navigation still passes the real browser/task-orchestrator path.
  // The model output is deliberately injected, so this is not a live-Qwen test.
  const page2=await browser.newPage();
  await page2.setContent(`<!doctype html><html><title>Docs</title><body><h1>Docs</h1>
    <a href="#" onclick="event.preventDefault();document.querySelector('h1').textContent='Installation guide opened';this.remove()">Installation guide</a></body></html>`);
  let interpreterCalls=0;
  globalThis.fetch=async (_url,opts)=>{
    interpreterCalls++;
    assert.match(_url,/\/api\/generate$/);
    return {ok:true,json:async()=>({response:JSON.stringify({
      type:'browser_goal',
      goal:{type:'visible_content',text:'Installation guide opened'}
    })})};
  };
  const result=await executeNaturalLanguageTask(page2,
    'Click Installation guide and verify the text Installation guide opened',{
      orchestratorOptions:{agentOptions:{maxSteps:3,reasoner:async(_task,observation)=>{
        const link=observation.actionableElements.find(e=>e.label?.includes('Installation guide'));
        assert(link,'Installation guide link missing');
        return {ref:link.ref,operation:'click',value:''};
      }}}
    });
  assert.equal(result.status,'verified_complete',JSON.stringify(result));
  assert.equal(await page2.locator('h1').innerText(),'Installation guide opened');
  assert.equal(interpreterCalls,1);
  assert.equal(result.execution.result.history.length,1);
  console.log('PASS: Interpreter -> Chromium action -> independent browser verification (mocked decision)');

  const ambiguous=chooseDiscoveryCandidate([
    {url:'https://first-example.org/resource',title:'Resource Installation Guide'},
    {url:'https://second-example.org/resource',title:'Resource Installation Guide'}
  ],'Find resource installation guide');
  assert.equal(ambiguous,null);
  console.log('PASS: Ambiguous search results cannot silently select a website');

  const redirectPage = {
    currentUrl: 'about:blank',
    url(){return this.currentUrl},
    async goto(next){ this.currentUrl='https://unrelated.example.net/'; },
    async title(){return 'Unrelated'},
    locator(){return {innerText:async()=> 'Unrelated unexpected domain that does not match the user request.'}}
  };
  const wrongDomain=await discoverWebsite(redirectPage,'Find docs on docs.example.net');
  assert.notEqual(wrongDomain.status,'found');
  console.log('PASS: URL-less discovery rejects off-domain redirect (simulated page)');

  const closing=['planning_stagnation','step_limit_reached','stagnation_detected','action_blocked','answer_unavailable','needs_clarification'];
  for(const status of closing) assert(shouldCloseBrowserAfterRun('finished',status),status);
  for(const status of ['verified_complete','answer_ready','download_ready','action_outcome_unverified','approval_required','human_handover_required']) {
    assert.equal(shouldCloseBrowserAfterRun('finished',status),false,status);
  }
  assert(shouldCloseBrowserAfterRun('error'));
  assert(shouldCloseBrowserAfterRun('cancelled'));
  assert.equal(shouldCloseBrowserAfterRun('running','planning_stagnation'),false);
  const serverSource=await readFile(new URL('../src/ui/server.js',import.meta.url),'utf8');
  assert.match(serverSource,/shouldCloseBrowserAfterRun\(/);
  console.log('PASS: Generic terminal-run cleanup; successful and inspectable outcomes preserved');

  console.log('STEP 3: ALL CHROMIUM / APPROVAL / DISCOVERY / LIFECYCLE TESTS PASS');
} finally {
  globalThis.fetch=savedFetch;
  await browser.close();
}
