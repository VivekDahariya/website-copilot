import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {runAgent} from '../src/agent/agent.js';
import {buildCatalog} from '../src/agent/local-reasoner.js';
import {classifyBrowserAction} from '../src/agent/action-safety-policy.js';

const observation={url:'about:blank',actionableElements:[
  {ref:'e1',tag:'button',role:'button',label:'Menu',type:'button',editable:false},
  {ref:'e2',tag:'input',role:'textbox',label:'Search',type:'text',editable:true}
]};
const notRequested=buildCatalog(observation,[],null,'Open the Menu');
const requested=buildCatalog(observation,[],null,'Hover over the Menu');
assert.equal(notRequested.find(e=>e.ref==='e1').allowedOperations.includes('hover'),false);
assert.equal(requested.find(e=>e.ref==='e1').allowedOperations.includes('hover'),true);
assert.equal(requested.find(e=>e.ref==='e2').allowedOperations.includes('hover'),false);
assert.equal(classifyBrowserAction({ref:'e1',operation:'hover',value:''},{label:'Menu',type:'button'}).classification,'safe');
assert.equal(classifyBrowserAction({ref:'e1',operation:'hover',value:''},{label:'Send payment',type:'button'}).classification,'requires_approval');
console.log('PASS: Hover is catalogued only for explicit user requests; sensitive target is not auto-approved');

const browser=await chromium.launch({headless:true,
  ...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM}:{}),
  args:['--no-sandbox']});
try {
  const page=await browser.newPage();
  await page.setContent(`<!doctype html><title>Hover menu</title>
    <style>#submenu{display:none}#nav:hover #submenu{display:block}</style>
    <div id="nav"><button id="menu">Menu</button><div id="submenu">Submenu ready</div></div>
    <button id="danger" onclick="window.clicked=true">Delete</button>`);
  const choices=[];
  const task='Hover over Menu to reveal Submenu ready. Do not click anything.';
  const result=await runAgent(page,task,{type:'visible_content',text:'Submenu ready'},
    {maxSteps:4,reasoner:async (_task,obs)=>{
      const menu=obs.actionableElements.find(el=>el.label==='Menu');
      assert.ok(menu,'Menu should be observed');
      choices.push(menu.ref);
      return {ref:menu.ref,operation:'hover',value:''};
    }});
  assert.equal(result.status,'verified_complete',JSON.stringify(result));
  assert.equal(result.history.filter(h=>h.decision?.operation==='hover' && h.execution?.executionCompleted).length,1);
  assert.equal(await page.locator('#submenu').isVisible(),true);
  assert.equal(await page.evaluate(()=>window.clicked),undefined);
  console.log('PASS: Real Chromium hover reveals menu and final DOM goal independently verifies without click');

  await page.reload().catch(()=>{}); // about:blank reset below
  await page.setContent('<!doctype html><title>Hover not requested</title><button>Menu</button>');
  const blocked=await runAgent(page,'Read the Menu label.',
    {type:'visible_content',text:'Never present'},
    {maxSteps:2,reasoner:async (_task,obs)=>({
      ref:obs.actionableElements.find(e=>e.label==='Menu')?.ref || '',
      operation:'hover',value:''
    })});
  assert.notEqual(blocked.status,'verified_complete');
  assert.equal(blocked.history.some(h=>h.decision?.operation==='hover' && h.execution?.executionCompleted),false);
  console.log('PASS: Agent refuses unrequested hover even if planner attempts it');
} finally {
  await browser.close();
}
