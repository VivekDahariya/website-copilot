import assert from 'node:assert/strict';
import { verifyGoal } from '../src/agent/goal-verifier.js';
import { groundFormGoal, interpretTask } from '../src/agent/task-interpreter.js';
import { decideNextAction, buildCatalog } from '../src/agent/local-reasoner.js';

let checked = 0;
function check(name, fn) {
  fn(); checked++;
  console.log('PASS:', name);
}
function page(url,title,heading,tag='h1',insideNavigation=false) {
  return {
    url,title,headings:[heading],
    headingEvidence:[{tag,text:heading,insideNavigation}],
    visibleBodyText:'',actionableElements:[]
  };
}
const destination = {type:'page_destination',heading:'Alan Turing'};
check('Reject autocomplete suggestion headings', () =>
  assert.equal(verifyGoal(page('https://www.wikipedia.org/','Wikipedia','Alan Turing','h3'),destination).completed,false));
check('Reject unrelated primary h1 with misleading text', () =>
  assert.equal(verifyGoal(page('https://www.wikipedia.org/','Wikipedia','Alan Turing'),destination).completed,false));
check('Reject search results masquerading as document', () =>
  assert.equal(verifyGoal(page('https://en.wikipedia.org/wiki/Special:Search','Alan Turing - Search results','Alan Turing'),destination).completed,false));
check('Reject navigation/sidebar heading', () =>
  assert.equal(verifyGoal(page('https://en.wikipedia.org/wiki/Alan_Turing','Alan Turing - Wikipedia','Alan Turing','h1',true),destination).completed,false));
check('Verify actual destination article', () =>
  assert.equal(verifyGoal(page('https://en.wikipedia.org/wiki/Alan_Turing','Alan Turing - Wikipedia','Alan Turing'),destination).completed,true));
check('Verify a second independent destination', () =>
  assert.equal(verifyGoal(page('https://en.wikipedia.org/wiki/Bletchley_Park','Bletchley Park - Wikipedia','Bletchley Park'),{type:'page_destination',heading:'Bletchley Park'}).completed,true));
check('Preserve exact destination URL goal without a heading', () =>
  assert.equal(verifyGoal(page('https://en.wikipedia.org/wiki/Alan_Turing','Alan Turing - Wikipedia','Alan Turing'),{type:'page_destination',hostname:'en.wikipedia.org',pathname:'/wiki/Alan_Turing'}).completed,true));
check('Do not infer identity from unrelated subordinate headings', () =>
  assert.equal(verifyGoal(page('https://en.wikipedia.org/wiki/Wikipedia','Wikipedia - Wikipedia','Alan Turing'),{type:'page_destination',identity:'Alan Turing'}).completed,false));
const fields = [
  {tag:'input',type:'text',label:'Text input',options:[]},
  {tag:'textarea',type:'',label:'Textarea',options:[]},
  {tag:'select',type:'',label:'Dropdown (select)',options:[
    {label:'Open this select menu',value:''},
    {label:'One',value:'1'},
    {label:'Two',value:'2'},
    {label:'Three',value:'3'}
  ]}
];
const formInstruction = 'Use Alex as the name, put a short introduction in the large writing area, and choose the second option. Do not submit.';
const genericGoal = {type:'all_of',conditions:[
  {type:'form_state',fieldLabel:'Name',expectedValue:'Alex'},
  {type:'form_state',fieldLabel:'large writing area',expectedValue:'AI can help people learn.'},
  {type:'form_state',fieldLabel:'second option',expectedValue:'second option'}
]};
check('Ground informal field descriptions to the unique live controls', () => {
  const grounded=groundFormGoal(genericGoal,fields,formInstruction);
  assert.deepEqual(grounded.conditions.map(c=>c.fieldLabel),['Text input','Textarea','Dropdown (select)']);
  assert.equal(grounded.conditions[2].expectedValue,'Two');
  assert.equal(genericGoal.conditions[2].fieldLabel,'second option');
});
check('Do not mis-map ambiguous generic text fields', () => {
  const ambiguous = groundFormGoal({type:'form_state',fieldLabel:'Name',expectedValue:'Alex'},[
    {tag:'input',type:'text',label:'First name'},
    {tag:'input',type:'text',label:'Last name'}
  ],'Use Alex as the name');
  assert.equal(ambiguous.fieldLabel,'Name');
});
const response = (value) => ({
  ok:true,
  async json(){return {response:JSON.stringify(value)};}
});
const fakeFetch = async (url,opts) => {
  const body = JSON.parse(opts.body);
  const prompt = JSON.parse(body.prompt);
  assert.equal(prompt.userInstruction,formInstruction);
  assert.equal(prompt.currentUrl,'https://www.selenium.dev/selenium/web/web-form.html');
  assert.equal(prompt.formControls.length,3);
  return response({type:'browser_goal',instruction:formInstruction,goal:genericGoal});
};
const interpreted=await interpretTask(formInstruction,{
  fetchImpl:fakeFetch,currentUrl:'https://www.selenium.dev/selenium/web/web-form.html',formControls:fields
});
check('Interpreter grounds actual three-field goal and preserves prohibitions',()=>{
  assert.equal(interpreted.status,'interpreted');
  assert.equal(interpreted.task.goal.type,'all_of');
  assert.deepEqual(interpreted.task.goal.conditions.map(c=>c.fieldLabel),
    ['Text input','Textarea','Dropdown (select)']);
  assert.match(interpreted.task.instruction,/do not submit/i);
});
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch=async () => ({ok:true,json:async () =>({message:{content:JSON.stringify({operation:'back',ref:'',value:''})}})});
  const observed={url:'https://example.com/unrelated',title:'Unrelated',visibleBodyText:'',headings:[],actionableElements:[
    {ref:'e1',tag:'a',label:'Home',href:'https://example.com/home',editable:false}
  ]};
  const decision=await decideNextAction('Go to the intended source',observed,[],[],null,null);
  check('Planner accepts a bounded back-navigation decision',()=>
    assert.deepEqual(decision,{ref:'',operation:'back',value:''}));
} finally {globalThis.fetch=originalFetch;}
check('Form catalog remains available for form tasks',()=>{
  const observed={actionableElements:[
    {ref:'e1',tag:'input',type:'text',label:'Text input',editable:true,currentValue:'Alex'},
    {ref:'e2',tag:'textarea',label:'Textarea',editable:true,currentValue:'AI can help people learn.'},
    {ref:'e3',tag:'select',label:'Dropdown (select)',editable:false,currentValue:'1',options:[{label:'One',value:'1'},{label:'Two',value:'2'}]}
  ]};
  const catalog=buildCatalog(observed,[],genericGoal,formInstruction);
  assert.equal(catalog.length,3);
  assert(catalog.find(e=>e.ref==='e3').allowedOperations.includes('select'));
});
console.log(`74K.49 reliability tests: ${checked}/${checked} PASS (offline)`);
