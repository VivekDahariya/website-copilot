import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../src/agent/agent.js';
import { makeEvidenceSnapshot } from '../src/agent/evidence-snapshot.js';
import { withEvidenceGraph, recordEvidenceEvent } from '../src/ui/evidence-graph.js';

const instruction = 'On this webpage enter Atlas Research in Username, fill Comments with PRIVATE_MARKER_348, check Checkbox 2, and choose Drop Down Item 4. Do not submit.';
const goal = {type:'all_of',conditions:[
  {type:'form_state',fieldLabel:'username',expectedValue:'Atlas Research'},
  {type:'form_state',fieldLabel:'comments',expectedValue:'PRIVATE_MARKER_348'},
  {type:'form_state',fieldLabel:'checkboxes[]',expectedValue:true},
  {type:'form_state',fieldLabel:'dropdown',expectedValue:'dd4'},
  {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'}
]};
const rawVerification = {completed:false,evidence:{conditions:[
  {completed:true,evidence:{matchedReference:'e1',expectedValue:'PRIVATE_MARKER_348'}},
  {completed:false,evidence:{expectedField:'PRIVATE_MARKER_348'}},
  {completed:true,evidence:{matchedReference:'e7',expectedValue:'PRIVATE_MARKER_348'}},
  {completed:false,evidence:{}},
  {completed:false,evidence:{}}
]}};
const safe = makeEvidenceSnapshot(goal,rawVerification,1);
assert.equal(safe.requirements.length,5);
assert.equal(safe.requirements[2].elementRef,'e7');
assert.equal(safe.requirements[4].matched,false);
assert.ok(!JSON.stringify(safe).includes('PRIVATE_MARKER_348'));
assert.ok(!JSON.stringify(safe).includes('checkboxes[]'));
console.log('PASS: Five goal conditions preserved as separate anonymous evidence nodes; raw values omitted');

const directory = await mkdtemp(join(tmpdir(),'wc-evidence-v1-'));
let first, second;
await Promise.all([
  withEvidenceGraph(async()=>{
    recordEvidenceEvent({...safe,url:'https://private.example/SECRET',task:'PRIVATE_MARKER_348'});
    recordEvidenceEvent({type:'action_selected',ref:'e2',operation:'fill',value:'PRIVATE_MARKER_348'});
    recordEvidenceEvent({type:'action_executed',ref:'e2',operation:'fill',executionCompleted:true,verified:true});
    const matched = {...safe,requirements:safe.requirements.map((r,i)=>
      i===1 ? {...r,matched:true,proof:'browser_element',elementRef:'e2'} : r)};
    recordEvidenceEvent(matched);
    recordEvidenceEvent({type:'evidence_invariant',passed:false,issues:[{value:'PRIVATE_MARKER_348'}]});
    recordEvidenceEvent({type:'goal_verified',url:'https://private.example/SECRET'});
    return 17;
  },{outputDirectory:directory,status:'verified_complete',onComplete:x=>first=x}),
  withEvidenceGraph(async()=>{
    recordEvidenceEvent({type:'action_selected',ref:'e900',operation:'click',url:'https://private.example/SECRET'});
    recordEvidenceEvent({type:'action_executed',ref:'e900',operation:'click',executionCompleted:false});
    return 18;
  },{outputDirectory:directory,status:'action_outcome_unverified',onComplete:x=>second=x})
]);
assert.equal(first.requirements.length,5);
assert.equal(first.edges.some(e=>e.requirement==='r2'&&e.action==='a1'),true);
assert.equal(first.protectedStateViolations,1);
assert.equal(second.actions.length,1);
assert.equal(second.requirements.length,0);
assert.equal(second.actions[0].executed,false);
assert.equal(first.actions.length,1);
const stored = (await readdir(directory)).sort();
assert.equal(stored.length,2);
for (const file of stored) {
  const raw = await readFile(join(directory,file),'utf8');
  for (const secret of ['PRIVATE_MARKER_348','Atlas Research','private.example','SECRET','checkboxes[]']) {
    assert.equal(raw.includes(secret),false,`Leaked ${secret}`);
  }
  assert.equal(JSON.parse(raw).mode,'observation_only');
}
console.log('PASS: Concurrent evidence graphs isolated; edges and protected-state alerts recorded; no private data persisted');

const browser = await chromium.launch({headless:true,args:['--no-sandbox'],
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM} : {})});
try {
  const page=await browser.newPage();
  await page.setContent(`<!doctype html><title>Generic Form</title>
  <form onsubmit="window.submitted=true;event.preventDefault()">
  <label>Username<input name="username"></label>
  <label>Comments<textarea name="comments"></textarea></label>
  <label>Check 1<input type="checkbox" name="checkboxes[]" value="cb1"></label>
  <label>Check 2<input type="checkbox" name="checkboxes[]" value="cb2"></label>
  <label>Check 3<input type="checkbox" name="checkboxes[]" value="cb3" checked></label>
  <label>Drop Down<select name="dropdown"><option value="dd1">Drop Down Item 1</option><option value="dd4">Drop Down Item 4</option></select></label>
  <button type="submit">Submit</button></form>`);
  const reportDir=await mkdtemp(join(tmpdir(),'wc-evidence-browser-'));
  let report;
  const output=await withEvidenceGraph(()=>runAgent(page,instruction,goal,{
    maxSteps:7,onAgentEvent:recordEvidenceEvent
  }),{outputDirectory:reportDir,status:'verified_complete',onComplete:x=>report=x});
  assert.equal(output.status,'verified_complete');
  assert.deepEqual(output.history.map(x=>x.decision.operation),['fill','fill','select','check']);
  assert.equal(report.requirements.length,5);
  assert.equal(report.lastSnapshot?.complete,true);
  assert.equal(report.requirements.filter(x=>x.matched).length,5);
  assert.equal(report.actions.filter(a=>a.executed&&a.verified).length,4);
  assert.equal(report.protectedStateViolations,0);
  assert.ok(report.edges.some(x=>x.requirement==='r5'&&x.action !== null));
  assert.deepEqual(await page.locator('input[type=checkbox]').evaluateAll(xs=>xs.map(x=>x.checked)),[false,true,true]);
  assert.equal(await page.evaluate(()=>window.submitted),undefined);
  const graphFile=(await readdir(reportDir))[0];
  const disk=await readFile(join(reportDir,graphFile),'utf8');
  assert.ok(!disk.includes('PRIVATE_MARKER_348'));
  assert.ok(!disk.includes('Atlas Research'));
  console.log('PASS: Real Chromium four-field run produces read-only 5-condition evidence ledger, 4 action receipts, no submit');
  await page.close();
} finally { await browser.close(); }

let propagated=false;
try {
  await withEvidenceGraph(async()=>{
    recordEvidenceEvent(safe);
    throw new Error('Original agent failure');
  },{outputDirectory:join(directory,'cannot-write','a'),status:'error'});
} catch(e) { propagated=e.message==='Original agent failure'; }
assert.equal(propagated,true);
let finished=false;
await withEvidenceGraph(async()=>{ finished=true; return 99; },
  {outputDirectory:'/dev/null/not-a-directory',status:'verified_complete'});
assert.equal(finished,true);
console.log('PASS: Write failures cannot interrupt tasks; original agent errors propagate');
