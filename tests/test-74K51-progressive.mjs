import assert from 'node:assert/strict';
import { interpretTask } from '../src/agent/task-interpreter.js';
import { decideNextAction } from '../src/agent/local-reasoner.js';

let count = 0;
const check = async (label, fn) => { await fn(); count++; console.log('PASS:', label); };
const request = "I'm testing a registration form. Use Alex as the name, put a short introduction about artificial intelligence in the large writing area, and choose the second option. Don't send anything.";
const fields = [
  {tag:'input',type:'text',label:'Text input',options:[]},
  {tag:'textarea',label:'Textarea',options:[]},
  {tag:'select',label:'Dropdown (select)',options:[
    {label:'Open this select menu',value:''},
    {label:'One',value:'1'}, {label:'Two',value:'2'}
  ]}
];
const validFormGoal = {type:'all_of',conditions:[
  {type:'form_state',fieldLabel:'name',expectedValue:'Alex'},
  {type:'form_state',fieldLabel:'large writing area',expectedValue:'AI introduction'},
  {type:'form_state',fieldLabel:'second option',expectedValue:'second option'}
]};
function fakeInterpreter(replies, onCall) { let i=0;return async (_,options)=>{
  const body=JSON.parse(options.body);onCall?.(body,i); const response=replies[Math.min(i++,replies.length-1)];
  return {ok:true,json:async()=>({response:JSON.stringify(response)})};
}; }
await check('Reject a page_destination goal for an explicit form-edit request and repair with second model call',async()=>{
  let calls=0;
  const result=await interpretTask(request,{formControls:fields,currentUrl:'https://www.selenium.dev/selenium/web/web-form.html',fetchImpl:fakeInterpreter([
    {type:'browser_goal',goal:{type:'page_destination',heading:'Web Form Example'}},
    {type:'browser_goal',goal:validFormGoal}
  ],(body,i)=>{calls++; if(i===0) assert.equal(JSON.parse(body.prompt).formEditsRequired,true); else assert.match(body.prompt,/page_destination goal is incorrect/); })});
  assert.equal(calls,2); assert.equal(result.status,'interpreted');
  assert.equal(result.task.goal.type,'all_of');
  assert.deepEqual(result.task.goal.conditions.map(g=>g.fieldLabel),['Text input','Textarea','Dropdown (select)']);
});
await check('Persistent wrong goal returns controlled clarification without browser actions',async()=>{
  const reply={type:'browser_goal',goal:{type:'page_destination',heading:'Web Form Example'}};
  const result=await interpretTask(request,{formControls:fields,fetchImpl:fakeInterpreter([reply,reply])});
  assert.equal(result.status,'needs_clarification');
});
await check('Reading an article is not wrongly classified as form editing',async()=>{
  const goal={type:'browser_goal',goal:{type:'page_destination',heading:'Alan Turing'}};
  const result=await interpretTask('Read about Alan Turing',{formControls:fields,fetchImpl:fakeInterpreter([goal])});
  assert.equal(result.status,'interpreted'); assert.equal(result.task.goal.heading,'Alan Turing');
});
const observation={url:'https://example.test/',title:'Example',headings:['Example'],visibleBodyText:'Example article with useful text about Alan Turing and codebreaking',
  actionableElements:[
    {ref:'e1',tag:'input',type:'search',label:'Search site',editable:true,currentValue:''},
    {ref:'e2',tag:'button',type:'submit',label:'Search',editable:false},
    ...Array.from({length:25},(_,i)=>({ref:`e${i+3}`,tag:'a',label:`Unrelated story ${i}`,href:`/story/${i}`,editable:false}))
  ]};
const goal={type:'page_destination',heading:'Alan Turing'};
const origFetch=globalThis.fetch;
const origMode=process.env.COPILOT_EVIDENCE_MODE;
try {
  delete process.env.COPILOT_EVIDENCE_MODE;
  await check('Choose clear search action from overview with one Ollama call',async()=>{
    let calls=0;
    globalThis.fetch=async(_,options)=>{
      calls++; const body=JSON.parse(options.body), ctx=JSON.parse(body.messages[1].content);
      assert.equal(ctx.evidenceMode,'overview'); assert(ctx.availableElements.length<=14);
      assert(ctx.currentPage.visibleBodyText.length<=350);
      return {ok:true,json:async()=>({message:{content:JSON.stringify({ref:'e1',operation:'fill',value:'Alan Turing'})}})};
    };
    const decision=await decideNextAction('Read about Alan Turing',observation,[],[],goal,{completed:false});
    assert.deepEqual(decision,{ref:'e1',operation:'fill',value:'Alan Turing'});
    assert.equal(calls,1);
  });
  await check('Request one extra headings read when overview is insufficient, then act',async()=>{
    let calls=0, expansions=0;
    const obs={...observation,requestMoreEvidence:async(scope)=>{expansions++;assert.equal(scope,'headings');return {headings:[{level:'h2',text:'Alan Turing'}]};}};
    globalThis.fetch=async(_,options)=>{
      const ctx=JSON.parse(JSON.parse(options.body).messages[1].content);
      calls++;
      if(calls===1) { assert.equal(ctx.evidenceMode,'overview');return {ok:true,json:async()=>({message:{content:JSON.stringify({ref:'',operation:'request_evidence',value:'headings'})}})}; }
      assert.equal(ctx.evidenceMode,'expanded'); assert.equal(ctx.evidenceScope,'headings');
      assert.equal(ctx.expandedEvidence.headings[0].text,'Alan Turing');
      return {ok:true,json:async()=>({message:{content:JSON.stringify({ref:'e1',operation:'fill',value:'Alan Turing'})}})};
    };
    const action=await decideNextAction('Read about Alan Turing',obs,[],[],goal,{completed:false});
    assert.equal(action.operation,'fill'); assert.equal(calls,2);assert.equal(expansions,1);
  });
  await check('A second request_evidence is rejected; bounded recovery produces a real action',async()=>{
    let calls=0;
    const obs={...observation,requestMoreEvidence:async()=>({})};
    globalThis.fetch=async()=>{
      calls++;
      const decision=calls===3?{ref:'e1',operation:'fill',value:'Alan Turing'}:{ref:'',operation:'request_evidence',value:'all'};
      return {ok:true,json:async()=>({message:{content:JSON.stringify(decision)}})};
    };
    const result=await decideNextAction('Alan Turing',obs,[],[],goal,{completed:false});
    assert.equal(result.operation,'fill'); assert.equal(calls,3);
  });
  await check('Full mode performs single-call legacy action planning and rejects inspection',async()=>{
    process.env.COPILOT_EVIDENCE_MODE='full';
    let calls=0;
    globalThis.fetch=async(_,options)=>{
      calls++;
      const ctx=JSON.parse(JSON.parse(options.body).messages[1].content);
      assert.equal(ctx.evidenceMode,'full');assert.equal(ctx.availableElements.length,2);
      return {ok:true,json:async()=>({message:{content:JSON.stringify({ref:'e1',operation:'fill',value:'Alan Turing'})}})};
    };
    const result=await decideNextAction('Alan Turing',observation,[],[],goal,{completed:false});
    assert.equal(result.operation,'fill');assert.equal(calls,1);
  });
} finally {
  globalThis.fetch=origFetch;
  if(origMode===undefined) delete process.env.COPILOT_EVIDENCE_MODE;
  else process.env.COPILOT_EVIDENCE_MODE=origMode;
}
console.log(`74K.51 regression: ${count}/${count} PASS`);
