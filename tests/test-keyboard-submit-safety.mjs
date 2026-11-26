import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { observePage } from '../src/observer/dom-observer.js';
import { executeAction } from '../src/executor/action-executor.js';
import { authorizeBrowserAction } from '../src/agent/action-safety-policy.js';
import { createActionApproval, validateActionApproval } from '../src/agent/action-approval.js';
import { inspectLiveTarget } from '../src/agent/live-target-identity.js';

const browser = await chromium.launch({headless: true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM} : {}), args:['--no-sandbox']});
try {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><title>Keyboard submit approval</title>
    <form id="actionForm" method="post" action="/placeholder" onsubmit="window.submits=(window.submits||0)+1;event.preventDefault()">
      <label for="message">Comment</label><textarea id="message" aria-label="Comment"></textarea>
      <button type="submit" id="search">Search</button>
      <button type="button" id="ordinary" onclick="window.ordinary=true">Preview</button>
    </form>
    <script>document.getElementById('message').addEventListener('keydown', e => {
      if(e.ctrlKey && e.key==='Enter')document.getElementById('actionForm').requestSubmit();
    });</script>`);
  const obs = await observePage(page);
  const refFor = label => {
    const element=obs.actionableElements.find(e => e.label?.includes(label));
    assert.ok(element,`Missing observed control: ${label}`);
    return element.ref;
  };
  assert.equal(authorizeBrowserAction({ref: 'e1', operation:'press',value:'Control+Enter'}, {label:'Comment',type:'textarea'}).allowed,false,
    'Ctrl+Enter must require approval even on an ordinary textarea');
  const comment=refFor('Comment');
  await assert.rejects(
    executeAction(page,{ref:comment,operation:'press',value:'Control+Enter'}),
    /SAFETY_APPROVAL_REQUIRED|SAFETY_REQUIRES_APPROVAL/
  );
  assert.equal(await page.evaluate(() => window.submits||0),0);
  console.log('PASS: Ctrl+Enter cannot submit an unapproved form');

  const search=refFor('Search');
  await assert.rejects(
    executeAction(page,{ref:search,operation:'press',value:'Space'}),
    /SAFETY_APPROVAL_REQUIRED|SAFETY_REQUIRES_APPROVAL/
  );
  assert.equal(await page.evaluate(() => window.submits||0),0);
  console.log('PASS: Space on a POST submit button labelled Search requires approval');

  for (const key of ['Meta+Enter','ControlOrMeta+Enter','Shift+Enter','Alt+Enter']) {
    assert.equal(authorizeBrowserAction({ref:comment,operation:'press',value:key},
      {label:'Comment',type:'textarea'}).allowed,false,`${key} must not bypass approval`);
  }
  assert.equal(authorizeBrowserAction({ref:search,operation:'press',value:'Spacebar'},
    {label:'Search',type:'submit',submitControl:true}).allowed,false);
  console.log('PASS: Modifier-Enter variants and Spacebar are classified as protected');

  // Explicit, source-bound approval must still work and be consumed once.
  const approvedAction={ref:comment,operation:'press',value:'Control+Enter'};
  const context=await inspectLiveTarget(page,approvedAction);
  const token=createActionApproval(approvedAction, context);
  const approved=await executeAction(page,approvedAction,{approval:token});
  assert.equal(approved.executionCompleted,true);
  assert.equal(await page.evaluate(()=>window.submits||0),1);
  assert.equal(validateActionApproval(token,approvedAction,context).allowed,false);
  console.log('PASS: Context-bound approval permits one Ctrl+Enter submit and is consumed');

  const preview=refFor('Preview');
  const action=await executeAction(page,{ref:preview,operation:'press',value:'Space'});
  assert.equal(action.executionCompleted,true);
  assert.equal(await page.evaluate(()=>window.ordinary),true);
  console.log('PASS: Ordinary keyboard activation of non-submitting controls remains permitted');

  assert.equal(authorizeBrowserAction({ref:'e1',operation:'press',value:'Enter'},
    {verifiedSearchContext:true, sensitiveFormContext:false,label:'Search',type:'search'}).allowed,true);
  console.log('PASS: Verified GET-only search keyboard Enter stays permitted');

  await page.setContent(`<!doctype html><form method="get" action="/query"
    onsubmit="window.searches=(window.searches||0)+1;event.preventDefault()">
    <input type="search" aria-label="Search" id="searchInput" />
    <button type="submit">Search</button></form>`);
  const getObs=await observePage(page);
  const searchInput=getObs.actionableElements.find(e=>e.type==='search');
  const searchButton=getObs.actionableElements.find(e=>e.type==='submit');
  assert.ok(searchInput && searchButton);
  const getEnter=await executeAction(page,{ref:searchInput.ref,operation:'press',value:'Enter'});
  assert.equal(getEnter.executionCompleted,true);
  const getSpace=await executeAction(page,{ref:searchButton.ref,operation:'press',value:'Space'});
  assert.equal(getSpace.executionCompleted,true);
  assert.equal(await page.evaluate(()=>window.searches),2);
  console.log('PASS: Real Chromium GET-only search Enter and Space remain permitted');
} finally { await browser.close(); }
