import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {assessEvidenceGraphV2} from '../src/ui/state-verifier-v2.js';
import {withEvidenceGraph,recordEvidenceEvent} from '../src/ui/evidence-graph.js';
import {runAgent} from '../src/agent/agent.js';

const base = {
 status:'verified_complete', snapshotsSeen:2, goalVerifiedEvents:1,
 requirements:[{id:'r1',kind:'form_state',matched:true,lastProof:'browser_element',elementRef:'e2'}],
 actions:[{id:'a1',operation:'check',elementRef:'e2',executed:true,verified:true}],
 checkpoints:[{index:0,matched:0,total:1},{index:1,matched:1,total:1}],
 protectedStateViolations:0,
 lastSnapshot:{complete:true,conditions:[{id:'r1',matched:true,proof:'browser_element',elementRef:'e2'}]}
};
const clean=assessEvidenceGraphV2(base);
assert.equal(clean.assessment,'agreement');
assert.equal(clean.scope,'metadata_consistency_only');
assert.equal(clean.proofCoverage.direct,1);
assert.equal(assessEvidenceGraphV2({...base,lastSnapshot:{...base.lastSnapshot,complete:false}}).assessment,'disagreement');
assert.equal(assessEvidenceGraphV2({...base,protectedStateViolations:1}).assessment,'disagreement');
assert.equal(assessEvidenceGraphV2({...base,requirements:[{...base.requirements[0],matched:false}]}).assessment,'disagreement');
assert.equal(assessEvidenceGraphV2({...base,requirements:[]}).assessment,'disagreement');
assert.equal(assessEvidenceGraphV2({...base,requirements:[{...base.requirements[0],lastProof:'verifier_boolean'}],lastSnapshot:{complete:true,conditions:[{id:'r1',matched:true,proof:'verifier_boolean',elementRef:'e2'}]}}).assessment,'insufficient_evidence');
assert.equal(assessEvidenceGraphV2({...base,status:'planning_stagnation',lastSnapshot:{complete:false,conditions:[{id:'r1',matched:false,proof:'unmatched',elementRef:null}]},requirements:[{...base.requirements[0],matched:false}]}).assessment,'insufficient_evidence');
assert.equal(assessEvidenceGraphV2({...base,checkpoints:[{matched:1},{matched:0},{matched:1}]}).matchedCountDrops,1);
const action = {
 ...base, requirements:[{...base.requirements[0],lastProof:'action_receipt'}],
 lastSnapshot:{complete:true,conditions:[{id:'r1',matched:true,proof:'action_receipt',elementRef:'e2'}]}
};
assert.equal(assessEvidenceGraphV2(action).assessment,'agreement');
assert.equal(assessEvidenceGraphV2({...action,actions:[{...base.actions[0],verified:false}]}).assessment,'insufficient_evidence');
assert.equal(assessEvidenceGraphV2(null).assessment,'insufficient_evidence');
console.log('PASS: Shadow status triage, requirement identity, provenance, receipt links, alerts and snapshot regressions');

const outputDirectory=await mkdtemp(join(tmpdir(),'wc-state-v2-'));
const payload='PRIVATE_DATA_NEVER_SAVE_9234';
let report;
const result=await withEvidenceGraph(async()=>{
  recordEvidenceEvent({type:'evidence_snapshot',step:1,complete:false,requirements:[
    {kind:'form_state',matched:false,proof:'unmatched',elementRef:null,value:payload}
  ]});
  recordEvidenceEvent({type:'action_selected',ref:'e2',operation:'check',value:payload});
  recordEvidenceEvent({type:'action_executed',ref:'e2',operation:'check',executionCompleted:true,verified:true});
  recordEvidenceEvent({type:'evidence_snapshot',step:2,complete:true,requirements:[
    {kind:'form_state',matched:true,proof:'browser_element',elementRef:'e2',value:payload}
  ]});
  recordEvidenceEvent({type:'goal_verified',url:payload});
  return 101;
},{outputDirectory,status:'verified_complete',onComplete:x=>report=x});
assert.equal(result,101);
assert.equal(report.shadowVerifierV2.assessment,'agreement');
const file=(await readdir(outputDirectory))[0];
const raw=await readFile(join(outputDirectory,file),'utf8');
assert.ok(!raw.includes(payload));
assert.equal(JSON.parse(raw).shadowVerifierV2.mode,'shadow_only');
console.log('PASS: Persisted shadow audit contains no raw values and does not affect task result');

const browser=await chromium.launch({headless:true,args:['--no-sandbox'],
  ...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM}:{})});
try {
 const page=await browser.newPage();
 await page.setContent(`<!doctype html><title>Form</title><form onsubmit="window.sent=true;event.preventDefault()">
 <label>Check 1<input type="checkbox" name="checkboxes[]" value="cb1"></label>
 <label>Check 2<input type="checkbox" name="checkboxes[]" value="cb2"></label>
 <label>Check 3<input type="checkbox" name="checkboxes[]" value="cb3"></label>
 <button type="submit">Submit</button></form>`);
 let graph;
 const outcome=await withEvidenceGraph(()=>runAgent(page,
  'Check Checkbox 2 only. Do not modify any other form fields and do not submit the form.',
  {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'},
  {maxSteps:3,onAgentEvent:recordEvidenceEvent}
 ),{status:'verified_complete',onComplete:x=>graph=x});
 assert.equal(outcome.status,'verified_complete');
 assert.deepEqual(outcome.history.map(h=>h.decision.operation),['check']);
 assert.equal(graph.shadowVerifierV2.assessment,'agreement');
 assert.equal(graph.shadowVerifierV2.requirementsTotal,1);
 assert.equal(await page.locator('input[type=checkbox]').evaluateAll(xs=>xs.map(x=>x.checked)).then(JSON.stringify),'[false,true,false]');
 assert.equal(await page.evaluate(()=>window.sent),undefined);
 console.log('PASS: Real Chromium single-checkbox task; production result and safety unchanged; V2 agreement');
} finally {await browser.close();}
const prior=process.env.COPILOT_STATE_VERIFIER_V2;
process.env.COPILOT_STATE_VERIFIER_V2='0';
try {
 let disabled;
 await withEvidenceGraph(async()=>{recordEvidenceEvent({type:'goal_verified'});return 7;},
   {status:'verified_complete',onComplete:x=>disabled=x});
 assert.equal(disabled.shadowVerifierV2,undefined);
} finally {
 if(prior===undefined) delete process.env.COPILOT_STATE_VERIFIER_V2;
 else process.env.COPILOT_STATE_VERIFIER_V2=prior;
}
let thrown=false;
try {await withEvidenceGraph(async()=>{throw Error('ORIGINAL_TASK_ERROR');},{status:'error'});} catch(e){thrown=e.message==='ORIGINAL_TASK_ERROR';}
assert.ok(thrown);
console.log('PASS: V2 can be disabled, and original agent errors still propagate');
