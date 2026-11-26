import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRunMetrics, recordAgentMetric, recordExecutionDurations } from '../src/ui/run-metrics.js';

const httpServer = http.createServer(async (req,res) => {
  let body=''; for await (const c of req) body+=c;
  await new Promise(r=>setTimeout(r,12));
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({ok:true, discarded:body}));
});
await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));
const endpoint='http://127.0.0.1:'+httpServer.address().port;
process.env.COPILOT_OLLAMA_URL=endpoint+'/api/chat';
const directory=await mkdtemp(join(tmpdir(),'wc-safe-run-metrics-'));
try {
  let one, two;
  await Promise.all([
    withRunMetrics(async () => {
      recordAgentMetric({type:'page_observed', url:'https://private.example/path', task:'SECRET A'});
      recordAgentMetric({type:'form_fast_path_planned',source:'goal_grounded', count:4});
      recordAgentMetric({type:'form_fast_path_next'});
      recordAgentMetric({type:'action_selected',operation:'fill',value:'SECRET A'});
      recordAgentMetric({type:'action_executed',executionCompleted:true,verified:true});
      recordExecutionDurations([{execution:{durationMs:7,value:'SECRET A'}}]);
      const rsp=await fetch(endpoint+'/api/chat',{method:'POST',body:JSON.stringify({model:'qwen',prompt:'SECRET A'})});
      await rsp.json();
      const irrelevant=await fetch(endpoint+'/not-ollama',{method:'POST',body:'SECRET A'});
      await irrelevant.text();
    },{outputDirectory:directory,status:()=>'verified_complete',onComplete:x=>one=x}),
    withRunMetrics(async()=> {
      recordAgentMetric({type:'planning_started'});
      const rsp=await fetch(endpoint+'/api/generate',{method:'POST',body:'SECRET B'});
      await rsp.text();
      recordAgentMetric({type:'form_fast_path_fallback',reason:'dont_leak_this'});
    },{outputDirectory:directory,status:'planning_stagnation',onComplete:x=>two=x})
  ]);
  assert.equal(one.model.calls,1);
  assert.equal(two.model.calls,1);
  assert.equal(one.agent.groundedFastPathPlans,1);
  assert.equal(one.agent.cachedActions,1);
  assert.equal(one.agent.verifiedActions,1);
  assert.equal(one.browser.executionMs,7);
  assert.equal(two.agent.planningAttempts,1);
  assert.equal(two.agent.fastPathFallbacks,1);
  assert.ok(one.model.totalMs>=10);
  assert.ok(two.model.totalMs>=10);
  const files=await readdir(directory);assert.equal(files.length,2);
  for(const file of files){
    const raw=await readFile(join(directory,file),'utf8');
    assert.ok(!raw.includes('SECRET'));
    assert.ok(!raw.includes('private.example'));
    assert.ok(!raw.includes('dont_leak_this'));
    const data=JSON.parse(raw);
    assert.ok(data.totalMs>=10);
    assert.ok(['verified_complete','planning_stagnation'].includes(data.status));
  }
  console.log('PASS: Actual fetch HTTP metrics isolated across concurrent runs, 1 model request each');
  console.log('PASS: Fast-path/action metrics, browser duration, privacy-safe persisted files');

  const badDir=join(directory,'unwritable');
  await chmod(directory,0o500); // no writing if unprivileged; telemetry is nonfatal either way
  let finished=false;
  await withRunMetrics(async()=>{finished=true;return 123;}, {outputDirectory:badDir,status:'verified_complete'});
  assert.ok(finished);
  console.log('PASS: Missing/unwritable metrics directory cannot interrupt successful task');
  await chmod(directory,0o700);
  let errored=false;
  try { await withRunMetrics(async()=>{throw new Error('browser error');},{status:'error'}); }
  catch (e) {errored = e.message==='browser error'; }
  assert.ok(errored);
  console.log('PASS: Original task error propagates without interception');
} finally {
  await new Promise(resolve=>httpServer.close(resolve));
}
