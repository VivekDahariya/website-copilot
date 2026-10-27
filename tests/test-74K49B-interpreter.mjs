import assert from 'node:assert/strict';
import {interpretTask, normalizeModelTaskEnvelope} from '../src/agent/task-interpreter.js';

const request = "I'm testing a registration form. Use Alex as the name, put a short introduction about artificial intelligence in the large writing area, and choose the second option. Don't send anything.";
const url = 'https://www.selenium.dev/selenium/web/web-form.html';
const formControls = [
  {tag:'input',type:'text',label:'Text input',options:[]},
  {tag:'textarea',type:'',label:'Textarea',options:[]},
  {tag:'select',type:'',label:'Dropdown (select)',options:[
    {label:'Open this select menu',value:''},
    {label:'One',value:'1'},
    {label:'Two',value:'2'},
    {label:'Three',value:'3'}
  ]}
];
const goal = {type:'all_of',conditions:[
  {type:'form_state',fieldLabel:'Name',expectedValue:'Alex'},
  {type:'form_state',fieldLabel:'large writing area',expectedValue:'AI helps people discover and learn.'},
  {type:'form_state',fieldLabel:'second option',expectedValue:'second option'}
]};
function mockedFetch(responses, inspect) {
  let count=0;
  const fake=async (_url,opts)=>{
    const body=JSON.parse(opts.body);
    if(inspect) inspect(body,count);
    const content=responses[Math.min(count++,responses.length-1)];
    return {ok:true, async json(){return {response:typeof content==='string'?content:JSON.stringify(content)}}};
  };
  return {fetchImpl:fake,getCount:()=>count};
}
function verifyForm(result) {
  assert.equal(result.status,'interpreted', JSON.stringify(result));
  assert.equal(result.task.type,'browser_goal');
  assert.equal(result.task.goal.type,'all_of');
  assert.deepEqual(result.task.goal.conditions.map(x=>x.fieldLabel), ['Text input','Textarea','Dropdown (select)']);
  assert.deepEqual(result.task.goal.conditions.map(x=>x.expectedValue), ['Alex','AI helps people discover and learn.','Two']);
  assert.equal(result.task.instruction,request);
  assert.match(result.task.instruction,/don.t send anything/i);
}
const base={currentUrl:url,formControls};
let checks=0;
const test=async(name,fn)=>{await fn();checks++;console.log('PASS:',name)};

await test('Recover missing outer task type when goal is explicit', async()=>{
  const mock=mockedFetch([{goal}]);
  verifyForm(await interpretTask(request,{...base,...mock}));
  assert.equal(mock.getCount(),1);
});
await test('Recover direct goal object missing browser_goal envelope',async()=>{
  const mock=mockedFetch([goal]);
  verifyForm(await interpretTask(request,{...base,...mock}));
});
await test('Recover valid nested task object',async()=>{
  const mock=mockedFetch([{task:{goal,type:'browser_goal'}}]);
  verifyForm(await interpretTask(request,{...base,...mock}));
});
await test('Retry schema-invalid JSON, not just syntax-invalid JSON',async()=>{
  const mock=mockedFetch([{someRandomKey:true},{goal}],(body,count)=>{
    if(count===1){
      assert.match(body.prompt,/required task schema/i);
      assert.match(body.prompt,/AVAILABLE NON-SECRET FORM CONTROLS/);
    }
  });
  verifyForm(await interpretTask(request,{...base,...mock}));
  assert.equal(mock.getCount(),2);
});
await test('Return needs_clarification after two schema-invalid replies',async()=>{
  const mock=mockedFetch([{unexpected:'shape'},{another:'bad'}]);
  const result=await interpretTask(request,{...base,...mock});
  assert.equal(result.status,'needs_clarification');
  assert.match(result.reason,/valid browser task/i);
  assert.equal(mock.getCount(),2);
});
await test('Return controlled failure for missing goal, not TypeError',async()=>{
  const mock=mockedFetch([{type:'browser_goal'},{type:'browser_goal'}]);
  const result=await interpretTask(request,{...base,...mock});
  assert.equal(result.status,'needs_clarification');
  assert.equal(mock.getCount(),2);
});
await test('Preserve explicit unsupported status without browser actions',async()=>{
  const mock=mockedFetch([{type:'unsupported',reason:'Need the destination.'}]);
  const result=await interpretTask(request,{...base,...mock});
  assert.equal(result.status,'needs_clarification');
  assert.match(result.reason,/destination/);
});
await test('Reject wholly unrelated task object instead of coercing',async()=>{
  assert.equal(normalizeModelTaskEnvelope({operation:'click',ref:'e1'},request),null);
  assert.equal(normalizeModelTaskEnvelope({type:'delete_file',goal},request),null);
});
await test('Preserve completed destination interpretation',async()=>{
  const mock=mockedFetch([{type:'browser_goal',goal:{type:'page_destination',heading:'Alan Turing'}}]);
  const result=await interpretTask('Read about the person who helped break Enigma',{
    currentUrl:'https://www.wikipedia.org/',...mock
  });
  assert.equal(result.status,'interpreted');
  assert.equal(result.task.goal.heading,'Alan Turing');
});
console.log(`74K.49B interpreter tests: ${checks}/${checks} PASS (offline model stubs)`);
