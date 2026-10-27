import assert from 'node:assert/strict';
import { interpretTask } from '../src/agent/task-interpreter.js';
import { decideNextAction } from '../src/agent/local-reasoner.js';

let checks = 0;
const test = async (name, fn) => { await fn(); checks++; console.log('PASS:', name); };
const formRequest = "I'm testing a registration form. Use Alex as the name, put a short introduction about artificial intelligence in the large writing area, and choose the second option. Don't send anything.";
const controls = [
  { tag:'input', type:'text', label:'Text input', options:[] },
  { tag:'textarea', type:'', label:'Textarea', options:[] },
  { tag:'select', type:'', label:'Dropdown (select)', options:[
    {label:'Open this select menu',value:''},
    {label:'One',value:'1'}, {label:'Two',value:'2'}, {label:'Three',value:'3'}
  ] }
];
const formGoal = {type:'all_of',conditions:[
  {type:'form_state',fieldLabel:'Name',expectedValue:'Alex'},
  {type:'form_state',fieldLabel:'large writing area',expectedValue:'Artificial intelligence helps people understand information.'},
  {type:'form_state',fieldLabel:'second option',expectedValue:'second option'}
]};
function fakeInterpreterFetch(responses, inspect=()=>{}) {
  let i=0;
  return async (_url, options)=> {
    const body = JSON.parse(options.body);
    inspect(body,i);
    const reply=responses[Math.min(i++,responses.length-1)];
    return {ok:true,json:async()=>({response:JSON.stringify(reply),prompt_eval_count:500,eval_count:110})};
  };
}
const originalOverride=process.env.COPILOT_INTERPRETER_JSON;
try {
  delete process.env.COPILOT_INTERPRETER_JSON;
  await test('Interpreter uses structural schema, not syntax-only JSON mode',async()=>{
    let called=0;
    const result=await interpretTask('Read about the Enigma codebreaker',{
      currentUrl:'https://www.wikipedia.org/',
      fetchImpl:fakeInterpreterFetch([{type:'browser_goal',goal:{type:'page_destination',heading:'Alan Turing'}}],body=>{
        called++;
        assert.equal(body.format.type,'object');
        assert.deepEqual(body.format.required,['type']);
        assert.equal(body.format.properties.type.enum[0],'browser_goal');
        assert.equal(body.format.properties.goal.properties.conditions.items.required[0],'type');
        assert(!body.system.includes('"instruction":"the original')); // No echoed instruction in response schema
        assert.equal(body.options.num_predict,1024);
        assert.equal(body.think,false);
        assert.equal(body.options.temperature,0);
      })
    });
    assert.equal(called,1);
    assert.equal(result.status,'interpreted');
    assert.equal(result.task.goal.heading,'Alan Turing');
  });
  await test('Multi-field goals and no-submit survive compact interpreter',async()=>{
    const result=await interpretTask(formRequest,{
      currentUrl:'https://www.selenium.dev/selenium/web/web-form.html',
      formControls:controls,
      fetchImpl:fakeInterpreterFetch([{type:'browser_goal',goal:formGoal}])
    });
    assert.equal(result.status,'interpreted');
    assert.deepEqual(result.task.goal.conditions.map(x=>x.fieldLabel),['Text input','Textarea','Dropdown (select)']);
    assert.deepEqual(result.task.goal.conditions.map(x=>x.expectedValue),['Alex','Artificial intelligence helps people understand information.','Two']);
    assert.match(result.task.instruction,/Don't send anything/);
  });
  await test('One bounded recovery retry remains available for invalid model output',async()=>{
    let count=0;
    const result=await interpretTask(formRequest,{
      currentUrl:'https://www.selenium.dev/selenium/web/web-form.html',
      formControls:controls,
      fetchImpl:fakeInterpreterFetch([{type:'browser_goal'}, {type:'browser_goal',goal:formGoal}],(_body,i)=>count=i+1)
    });
    assert.equal(result.status,'interpreted');
    assert.equal(count,2);
  });
  await test('Unsupported tasks remain safe clarification, not fabricated goals',async()=>{
    const result=await interpretTask('Perform task with secret code I did not supply',{
      fetchImpl:fakeInterpreterFetch([{type:'unsupported',reason:'A required code is missing.'}])
    });
    assert.equal(result.status,'needs_clarification');
    assert.match(result.reason,/required code/);
  });
  await test('Explicit fallback to previous JSON mode is available',async()=>{
    process.env.COPILOT_INTERPRETER_JSON='1';
    const result=await interpretTask('Read about Alan Turing',{
      fetchImpl:fakeInterpreterFetch([{type:'browser_goal',goal:{type:'page_destination',heading:'Alan Turing'}}],body=>{
        assert.equal(body.format,'json');
      })
    });
    assert.equal(result.status,'interpreted');
    delete process.env.COPILOT_INTERPRETER_JSON;
  });
} finally {
  if(originalOverride===undefined) delete process.env.COPILOT_INTERPRETER_JSON;
  else process.env.COPILOT_INTERPRETER_JSON=originalOverride;
}

await test('Planner avoids duplicate completed-value lists while preserving live form state',async()=>{
  const oldFetch=globalThis.fetch;
  const longValue='An explanation of artificial intelligence. '.repeat(8);
  let calls=0;
  globalThis.fetch=async(_url,opts)=>{
    calls++;
    const body=JSON.parse(opts.body);
    const ctx=JSON.parse(body.messages[1].content);
    assert(!('completedFieldActions' in ctx));
    assert(!('completedSelections' in ctx));
    assert(!('completedChecks' in ctx));
    assert.equal(ctx.goalVerification.conditions[0].completed,true);
    assert.equal(ctx.availableElements.find(x=>x.ref==='e3').currentValue,longValue);
    assert.equal(ctx.availableElements.find(x=>x.ref==='e6').options[2].label,'Two');
    assert.match(body.messages[0].content,/NEVER submit when the user said/);
    assert.equal(body.think,false);
    return {ok:true,json:async()=>({message:{content:JSON.stringify({ref:'e6',operation:'select',value:'Two'})}})};
  };
  try {
    const observation={url:'https://www.selenium.dev/selenium/web/web-form.html',title:'Web form',headings:['Web form'],visibleBodyText:'Web form',
      actionableElements:[
        {ref:'e1',tag:'input',type:'text',label:'Text input',editable:true,currentValue:'Alex'},
        {ref:'e3',tag:'textarea',label:'Textarea',editable:true,currentValue:longValue},
        {ref:'e6',tag:'select',label:'Dropdown (select)',editable:false,currentValue:'1',options:controls[2].options}
      ]};
    const goal={type:'all_of',conditions:[
      {type:'form_state',fieldLabel:'Text input',expectedValue:'Alex'},
      {type:'form_state',fieldLabel:'Textarea',expectedValue:longValue},
      {type:'form_state',fieldLabel:'Dropdown (select)',expectedValue:'Two'}
    ]};
    const decision=await decideNextAction('Fill required fields and do not submit',observation,[],[],goal,{
      completed:false,evidence:{conditions:[{completed:true},{completed:true},{completed:false}]}
    });
    assert.deepEqual(decision,{ref:'e6',operation:'select',value:'Two'});
    assert.equal(calls,1);
  } finally {globalThis.fetch=oldFetch;}
});
console.log(`74K.50 performance contract tests: ${checks}/${checks} PASS (mock model)`);
