import assert from 'node:assert/strict';
import { interpretTask } from '../src/agent/task-interpreter.js';
import { buildCatalog, decideNextAction } from '../src/agent/local-reasoner.js';
import { classifyBrowserAction } from '../src/agent/action-safety-policy.js';

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log('PASS:', name);
};
const mockedInterpreter = (answer, probe) => async (_url, opts) => {
  const body = JSON.parse(opts.body);
  if (probe) probe(body);
  return {ok:true, json:async()=>({response:JSON.stringify(answer)})};
};
const website = 'https://www.wikipedia.org/';
await test('Current page is separate from user instruction', async () => {
  const instruction='Read about the man who helped crack Enigma';
  const outcome=await interpretTask(instruction, {
    currentUrl:website,
    fetchImpl:mockedInterpreter({type:'browser_goal',instruction:'wrong',goal:{type:'page_destination',heading:'Alan Turing'}},
      body=>{
        const user=JSON.parse(body.prompt);
        assert.equal(user.userInstruction,instruction);
        assert.equal(user.currentUrl,website);
        assert.doesNotMatch(user.userInstruction,/https?:/);
      })
  });
  assert.equal(outcome.status,'interpreted');
  assert.equal(outcome.task.instruction,instruction);
  assert.equal(outcome.task.goal.heading,'Alan Turing');
});
await test('Reject malformed destination from model', async () => {
  const result=await interpretTask('Find the Enigma codebreaker',{
    currentUrl:website,
    fetchImpl:mockedInterpreter({type:'browser_goal',instruction:'bad',goal:{type:'page_destination',identity:'webpage: https://www'}})
  });
  assert.equal(result.status,'needs_clarification');
});
await test('Keep inferred destination for indirect question', async () => {
  const instruction='Take me to the Wikipedia page about the place where Turing worked on British wartime codebreaking';
  const result=await interpretTask(instruction,{currentUrl:'https://en.wikipedia.org/wiki/Alan_Turing',fetchImpl:mockedInterpreter({type:'browser_goal',instruction,goal:{type:'page_destination',heading:'Bletchley Park'}})});
  assert.equal(result.task.goal.heading,'Bletchley Park');
});
await test('Keep multi-condition form goal and do-not-submit', async () => {
  const instruction='Use Alex as name, choose Two; do not submit';
  const result=await interpretTask(instruction,{currentUrl:'https://example.com/form',fetchImpl:mockedInterpreter({type:'browser_goal',instruction:'fill and submit',goal:{type:'all_of',conditions:[{type:'form_state',fieldLabel:'Text input',expectedValue:'Alex'},{type:'form_state',fieldLabel:'Dropdown',expectedValue:'Two'}]}})});
  assert.equal(result.status,'interpreted');
  assert.equal(result.task.goal.conditions.length,2);
  assert.match(result.task.instruction,/do not submit/);
});
await test('Relevant far-down links enter short catalog',async()=>{
  const controls=Array.from({length:250},(_,i)=>({ref:`e${i+1}`,tag:'a',label:`Generic note ${i}`,href:`/wiki/Note_${i}`,editable:false}));
  controls[238]={ref:'e239',tag:'a',label:'Bletchley Park',href:'/wiki/Bletchley_Park',editable:false};
  controls[110]={ref:'e111',tag:'input',type:'search',label:'Search Wikipedia',editable:true,currentValue:''};
  const result=buildCatalog({actionableElements:controls},[],{type:'page_destination',heading:'Bletchley Park'},'Find Bletchley Park');
  assert.ok(result.length<=42);
  assert.ok(result.some(e=>e.ref==='e239'));
  assert.ok(result.some(e=>e.ref==='e111'));
});
await test('Planner receives structured goal, compact catalog, no submit encouragement',async()=>{
  const originalFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async (_url, opts)=>{
    calls++;
    const payload=JSON.parse(opts.body);
    assert.match(payload.messages[0].content,/NEVER submit when the user/);
    assert.doesNotMatch(payload.messages[0].content,/If all requested form fields are satisfied and a submission button is available, choose that button/);
    const input=JSON.parse(payload.messages[1].content);
    assert.equal(input.goal.heading,'Bletchley Park');
    assert.ok(input.availableElements.length<=42);
    assert.ok(input.availableElements.some(e=>e.ref==='e239'));
    assert.equal(input.goalVerification.completed,false);
    return {ok:true,json:async()=>({message:{content:JSON.stringify({ref:'e239',operation:'click',value:''})}})};
  };
  try {
    const controls=Array.from({length:249},(_,i)=>({ref:`e${i+1}`,tag:'a',label:'Other',href:`/wiki/Other_${i}`}));
    controls[238]={ref:'e239',tag:'a',label:'Bletchley Park',href:'/wiki/Bletchley_Park'};
    const action=await decideNextAction('Find Bletchley Park',{url:'https://en.wikipedia.org',headings:[],visibleBodyText:'',actionableElements:controls},[],[],{type:'page_destination',heading:'Bletchley Park'},{completed:false,evidence:{conditions:[{completed:false}]}});
    assert.equal(action.ref,'e239');assert.equal(calls,1);
  } finally {globalThis.fetch=originalFetch;}
});
await test('Verified GET search is safe, sensitive form remains gated',async()=>{
  assert.equal(classifyBrowserAction({operation:'click',value:''},{label:'Search',verifiedSearchContext:true}).classification,'safe');
  assert.equal(classifyBrowserAction({operation:'press',value:'Enter'},{label:'Search',verifiedSearchContext:true}).classification,'safe');
  assert.equal(classifyBrowserAction({operation:'press',value:'Enter'},{label:'Search',verifiedSearchContext:true,sensitiveFormContext:true}).classification,'requires_approval');
  assert.equal(classifyBrowserAction({operation:'click',value:''},{label:'Send Message'}).classification,'requires_approval');
});
console.log(`74K.46 core tests: ${passed}/${passed} PASS (offline model stubs)`);
