import assert from 'node:assert/strict';
import { interpretTask } from '../src/agent/task-interpreter.js';

const request = "I'm testing a registration form. Use Alex as the name, put a short introduction about artificial intelligence in the large writing area, and choose the second option. Don't send anything.";
const controls = [
  { tag:'input',type:'text',label:'Text input' },
  { tag:'textarea',label:'Textarea' },
  { tag:'select',label:'Dropdown (select)',options:[
    {label:'Open this select menu',value:''},
    {label:'One',value:'1'},
    {label:'Two',value:'2'},
    {label:'Three',value:'3'}
  ]}
];
const three = [
  {type:'form_state',fieldLabel:'name',expectedValue:'Alex'},
  {type:'form_state',fieldLabel:'large writing area',expectedValue:'Artificial intelligence enables machines to learn.'},
  {type:'form_state',fieldLabel:'second option',expectedValue:'second option'}
];
function fake(replies,onCall=()=>{}) {
  let count=0;
  return async (_url, options) => {
    const i=count++;
    onCall(JSON.parse(options.body),i);
    return {ok:true,json:async()=>({response: JSON.stringify(replies[Math.min(i,replies.length-1)])})};
  };
}
let total = 0;
async function test(name,fn) { await fn(); total++; console.log('PASS:',name); }

await test('Recover model form_state.conditions into explicit multi-field all_of',async()=>{
  let calls=0;
  const output=await interpretTask(request,{formControls:controls,fetchImpl:fake([
    {type:'browser_goal',goal:{type:'form_state',conditions:three}}
  ],()=>calls++)});
  assert.equal(calls,1);
  assert.equal(output.status,'interpreted');
  assert.equal(output.task.goal.type,'all_of');
  assert.deepEqual(output.task.goal.conditions.map(x=>x.fieldLabel),['Text input','Textarea','Dropdown (select)']);
  assert.deepEqual(output.task.goal.conditions.map(x=>x.expectedValue),['Alex','Artificial intelligence enables machines to learn.','Two']);
  assert.match(output.task.instruction,/Don't send anything/);
});

await test('Root complete form state plus child conditions retain all specified fields',async()=>{
  const root={type:'form_state',fieldLabel:'name',expectedValue:'Alex',conditions:three.slice(1)};
  const output=await interpretTask(request,{formControls:controls,fetchImpl:fake([{type:'browser_goal',goal:root}])});
  assert.equal(output.status,'interpreted');
  assert.equal(output.task.goal.conditions.length,3);
});

await test('Schema invalid field inside child triggers corrected second model attempt',async()=>{
  let calls=0;
  const broken={type:'browser_goal',goal:{type:'form_state',conditions:[
    {type:'form_state',fieldLabel:'name',expectedValue:'Alex',unknownField:'nope'},...three.slice(1)
  ]}};
  const output=await interpretTask(request,{formControls:controls,fetchImpl:fake([
    broken,
    {type:'browser_goal',goal:{type:'all_of',conditions:three}}
  ],(body,i)=>{
    calls++;
    if(i===1){assert.match(body.prompt,/Unexpected field "unknownField"/);assert.match(body.prompt,/ONLY all_of/);}
  })});
  assert.equal(calls,2);
  assert.equal(output.status,'interpreted');
  assert.equal(output.task.goal.conditions.length,3);
});

await test('Unrepairable malformed form goals never execute browser actions',async()=>{
  const malformed={type:'browser_goal',goal:{type:'form_state',conditions:[
    {type:'form_state',fieldLabel:'name',expectedValue:'Alex',extra:'unsafe'}
  ]}};
  const output=await interpretTask(request,{formControls:controls,fetchImpl:fake([malformed,malformed])});
  assert.equal(output.status,'needs_clarification');
  assert.ok(!('task' in output));
});

await test('Unexpected fields on composite root are not silently discarded',async()=>{
  const output=await interpretTask(request,{formControls:controls,fetchImpl:fake([{
    type:'browser_goal',goal:{type:'form_state',conditions:three,extra:'invalid'}
  }])});
  assert.equal(output.status,'needs_clarification');
});

await test('Missing half of root form_state pair cannot be invented',async()=>{
  const output=await interpretTask(request,{formControls:controls,fetchImpl:fake([{
    type:'browser_goal',goal:{type:'form_state',fieldLabel:'name',conditions:three.slice(1)}
  }])});
  assert.equal(output.status,'needs_clarification');
});

await test('Legitimate single form goal still accepted',async()=>{
  const output=await interpretTask('Fill the name field with Alex',{formControls:controls,fetchImpl:fake([{
    type:'browser_goal',goal:{type:'form_state',fieldLabel:'name',expectedValue:'Alex'}
  }])});
  assert.equal(output.status,'interpreted');
  assert.equal(output.task.goal.type,'form_state');
  assert.equal(output.task.goal.fieldLabel,'Text input');
});

await test('Legitimate navigation goal remains unchanged',async()=>{
  const output=await interpretTask('Read about Alan Turing',{formControls:controls,fetchImpl:fake([{
    type:'browser_goal',goal:{type:'page_destination',heading:'Alan Turing'}
  }])});
  assert.equal(output.status,'interpreted');
  assert.equal(output.task.goal.heading,'Alan Turing');
});

await test('Schema errors in otherwise structurally valid goal cause corrective retry',async()=>{
  let calls=0;
  const output=await interpretTask('Read about Alan Turing',{fetchImpl:fake([
    {type:'browser_goal',goal:{type:'page_destination',heading:'Alan Turing',forceComplete:true}},
    {type:'browser_goal',goal:{type:'page_destination',heading:'Alan Turing'}}
  ],()=>calls++)});
  assert.equal(output.status,'interpreted'); assert.equal(calls,2);
});

console.log(`74K.51A interpreter: ${total}/${total} PASS`);
