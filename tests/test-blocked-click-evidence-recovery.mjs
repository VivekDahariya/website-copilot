import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {runAgent} from '../src/agent/agent.js';
import {createStagnationRecovery} from '../src/agent/stagnation-recovery.js';

// Fingerprint scope: same action is only suppressed on an unchanged page state.
const recovery = createStagnationRecovery();
const action = {ref:'e1',operation:'click',value:''};
const element = {ref:'e1',label:'Blocked navigation',tag:'button'};
const before = {url:'https://example.test/',headings:[],visibleBodyText:'ready',actionableElements:[element]};
recovery.remember(before,element,action);
assert.equal(recovery.isIneffective(before,element,action),true);
assert.equal(recovery.isIneffective({...before,visibleBodyText:'overlay cleared'},element,action),false);
console.log('PASS: Blocked action is excluded only for the same observed page fingerprint');

const browser=await chromium.launch({headless:true,
  ...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM}:{}),
  args:['--no-sandbox']});
try {
  const page=await browser.newPage();
  await page.setContent(`<!doctype html><title>Alternative route test</title>
    <style>
      #blocked {position:absolute;top:20px;left:20px;width:150px;height:40px}
      #shield {position:absolute;top:0;left:0;width:200px;height:100px;z-index:99;background:transparent}
      #alternative {position:absolute;top:20px;left:320px;width:150px;height:40px}
    </style>
    <button id="blocked" onclick="window.blockedWasClicked=true">Blocked route</button>
    <div id="shield"></div>
    <button id="alternative" onclick="document.getElementById('result').textContent='Recovery successful'">Alternative route</button>
    <p id="result">Not completed</p>`);
  const selections=[];
  const events=[];
  const reasoner=async (_task,obs,_history,rejected)=>{
    const blocked=obs.actionableElements.find(e=>e.label==='Blocked route');
    const alternate=obs.actionableElements.find(e=>e.label==='Alternative route');
    assert.ok(blocked && alternate,'Expected both routes to remain observable');
    const chosen=rejected.some(a=>a.ref===blocked.ref)?alternate:blocked;
    selections.push({chosen:chosen.label,rejected:rejected.length});
    return {ref:chosen.ref,operation:'click',value:''};
  };
  const result=await runAgent(page,
    'Open the route that displays Recovery successful.',
    {type:'visible_content',text:'Recovery successful'},
    {reasoner,maxSteps:5,onAgentEvent:event=>events.push(event)});
  assert.equal(result.status,'verified_complete',JSON.stringify(result));
  assert.equal(await page.evaluate(()=>window.blockedWasClicked),undefined);
  assert.equal(await page.locator('#result').textContent(),'Recovery successful');
  assert.equal(result.history.filter(x=>x.execution?.errorCode==='ACTION_CLICK_BLOCKED').length,1);
  assert.equal(result.history.filter(x=>x.execution?.executionCompleted===true).length,1);
  assert.equal(selections.filter(x=>x.chosen==='Blocked route').length,2);
  assert.equal(selections.filter(x=>x.chosen==='Alternative route').length,1);
  assert.ok(events.some(x=>x.type==='action_failed'));
  console.log('PASS: Real Chromium blocked click recorded once; repeated identical target rejected, alternative action verified');
  await page.close();
} finally {await browser.close();}
