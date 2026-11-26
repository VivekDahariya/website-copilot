import assert from 'node:assert/strict';
import { validateTaskContract, taskContractSchema } from '../src/agent/task-contract.js';
import { interpretTask } from '../src/agent/task-interpreter.js';

const instruction='Enter "Atlas Research" in Username, put "Checked" in Comments, check Checkbox 2, choose Option 4 from Dropdown. Do not submit; leave other fields unchanged.';
const controls=[
  {type:'text',tag:'input',name:'username',label:'Username'},
  {type:'textarea',tag:'textarea',name:'comments',label:'Comments'},
  {type:'checkbox',tag:'input',name:'checkboxes[]',label:'cb1',ordinal:1},
  {type:'checkbox',tag:'input',name:'checkboxes[]',label:'cb2',ordinal:2},
  {type:'checkbox',tag:'input',name:'checkboxes[]',label:'cb3',ordinal:3},
  {type:'select-one',tag:'select',name:'dropdown',label:'Dropdown'}
];
const goal={type:'all_of',conditions:[
 {type:'form_state',fieldLabel:'Username',expectedValue:'Atlas Research'},
 {type:'form_state',fieldLabel:'Comments',expectedValue:'Checked'},
 {type:'form_state',fieldLabel:'checkboxes[]',expectedValue:true},
 {type:'form_state',fieldLabel:'Dropdown',expectedValue:'Option 4'},
 {type:'form_state',fieldLabel:'Checkbox 2',expectedValue:'checked'}
]};
const task={type:'browser_goal',instruction,goal};
const saved=JSON.stringify(task);
assert.equal(taskContractSchema.safeParse(task).success,true);
assert.equal(validateTaskContract(task,{formControls:controls}),task);
assert.equal(JSON.stringify(task),saved,'Contract validation must be observation-only');
assert.equal(task.goal.conditions.length,5,'Do not silently remove a verification condition');
console.log('PASS: Zod schema validates the existing five-condition task without altering its goal or safety constraints');

const contradictory=structuredClone(task);
contradictory.goal.conditions[2].expectedValue=false;
assert.throws(()=>validateTaskContract(contradictory,{formControls:controls}),/Conflicting checkbox group/);
console.log('PASS: Contradictory shared-group and explicit-ordinal checkbox goals fail closed');

assert.equal(validateTaskContract({
 type:'browser_goal',instruction:'Open the official docs',goal:{type:'page_destination',hostname:'example.org'}
}).goal.type,'page_destination');
assert.equal(validateTaskContract({
 type:'product_comparison',category:'paper books',limit:3,startUrl:'https://example.org'
}).type,'product_comparison');
assert.equal(taskContractSchema.safeParse({...task,unexpected:true}).success,false);
assert.equal(taskContractSchema.safeParse({...task,goal:{type:'form_state',fieldLabel:'x',expectedValue:12}}).success,false);
assert.equal(taskContractSchema.safeParse({...task,goal:{type:'all_of',conditions:[]}}).success,false);
assert.equal(taskContractSchema.safeParse({...task,goal:{type:'visible_form',text:'invented'}}).success,false);
console.log('PASS: Strict Zod task schema rejects unknown keys, invalid values, and invalid goal shapes');

const fakeFetch=async()=>({ok:true,json:async()=>({response:JSON.stringify({type:'browser_goal',goal})})});
const interpreted=await interpretTask(instruction,{fetchImpl:fakeFetch,currentUrl:'https://example.org/form',formControls:controls});
assert.equal(interpreted.status,'interpreted',JSON.stringify(interpreted));
assert.equal(interpreted.task.instruction,instruction);
assert.equal(interpreted.task.goal.type,'all_of');
assert.equal(interpreted.task.goal.conditions.some(c=>c.fieldLabel==='Checkbox 2'),true);
console.log('PASS: Model-interpreted form task passes through contract while preserving the explicit checkbox requirement');
