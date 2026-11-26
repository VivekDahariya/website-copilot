import assert from 'node:assert/strict';
import { interpretTask, requiresFormStateGoal } from '../src/agent/task-interpreter.js';
import { createFormMutationPolicy } from '../src/agent/form-mutation-policy.js';

const grace = "Use Wikipedia's search to find Grace Hopper. Open her article and explain her profession and her major contributions to computing using the article's introductory text. Do not edit anything, log in, or visit external websites.";
const ada = "Use Wikipedia's search to find Ada Lovelace. Open her Wikipedia article and identify her occupation and what she is best known for, using the article's introductory text. Do not edit Wikipedia, log in, or navigate to external websites.";
const controls = [{name:'search',label:'Search Wikipedia',tag:'input',type:'search',editable:true,ref:'e4'}];
assert.equal(requiresFormStateGoal(grace,controls),false,'Search + text must not imply form editing');
assert.equal(requiresFormStateGoal(ada,controls),false);
assert.equal(requiresFormStateGoal('Use the form to enter "Alice" into Name',[{name:'Name',tag:'input',type:'text'}]),true);
assert.equal(requiresFormStateGoal('Use Checkbox 2',[{name:'cb2',tag:'input',type:'checkbox'}]),true);

const llm=(goal) => async (_url,opts) => {
  const request = JSON.parse(opts.body);
  assert.equal(request.prompt.includes('Grace Hopper') || request.prompt.includes('Ada Lovelace'),true);
  return {ok:true,json:async()=>({response:JSON.stringify({type:'browser_goal',goal})})};
};
for (const [instruction, person] of [[grace,'Grace Hopper'],[ada,'Ada Lovelace']]) {
  const result = await interpretTask(instruction,{currentUrl:'https://en.wikipedia.org/wiki/Main_Page',formControls:controls,fetchImpl:llm({type:'form_state',fieldLabel:'Search',expectedValue:person})});
  assert.equal(result.status,'interpreted',JSON.stringify(result));
  assert.deepEqual(result.task.goal,{type:'page_destination',identity:person});
  const policy = createFormMutationPolicy({goal:result.task.goal,instruction});
  const initial={url:'https://en.wikipedia.org/wiki/Main_Page',actionableElements:[{ref:'e4',tag:'input',type:'search',name:'search',label:'Search Wikipedia',currentValue:'',editable:true},{ref:'e5',tag:'input',type:'text',name:'unrelated',label:'Unrelated',currentValue:'safe',editable:true}]};
  policy.observe(initial);
  assert.equal(policy.reject(initial,initial.actionableElements[0],{ref:'e4',operation:'fill',value:person}),null);
  const after={...initial,actionableElements:[{...initial.actionableElements[0],currentValue:person},initial.actionableElements[1]]};
  assert.equal(policy.verify(after).verified,true,'No active form edit goal should block expressly requested search');
}
console.log('PASS: Grace and Ada search+article+answer preserve destination; intermediate search goal cannot claim completion');

// Plain form editing still uses form_state; search-only tasks and unrelated
// navigation are deliberately not converted into a compound article goal.
const ordinaryForm = await interpretTask('Fill Username with "Alice".',{currentUrl:'https://example.test/form',formControls:[{tag:'input',name:'Username',label:'Username',type:'text'}],fetchImpl: async()=>({ok:true,json:async()=>({response:JSON.stringify({type:'browser_goal',goal:{type:'form_state',fieldLabel:'Username',expectedValue:'Alice'}})})})});
assert.equal(ordinaryForm.status,'interpreted');
assert.equal(ordinaryForm.task.goal.type,'form_state');
console.log('PASS: Explicit form modification retains form_state goal');

const otherTasks=[
  'Use Wikipedia search to find Grace Hopper. Do not open an article.',
  'Use Wikipedia search to find Grace Hopper. Open her article.',
  'Use Wikipedia search to find Grace Hopper. Open her article and download it.',
  'Use Wikipedia search to find x. Open her article and explain the history.'
];
for (const instruction of otherTasks) {
  const result=await interpretTask(instruction,{currentUrl:'https://en.wikipedia.org/wiki/Main_Page',formControls:controls,fetchImpl:async()=>({ok:true,json:async()=>({response:JSON.stringify({type:'browser_goal',goal:{type:'form_state',fieldLabel:'Search',expectedValue:'Grace Hopper'}})})})});
  assert.equal(result.status,'interpreted');
  assert.notDeepEqual(result.task.goal,{type:'page_destination',identity:'Grace Hopper'},`Unexpected composite article coercion: ${instruction}`);
}
console.log('PASS: Unrelated search, navigation-only, downloads and ambiguous subjects are not coerced');
