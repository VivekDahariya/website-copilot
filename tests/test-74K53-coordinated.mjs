import assert from 'node:assert/strict';
import { deriveExplicitOutcomeGoal } from '../src/agent/explicit-goal-repair.js';
import { createBrowserStateBaseline, rejectContradictoryFormAction } from '../src/agent/browser-state-baseline.js';
import { verifyGoal } from '../src/agent/goal-verifier.js';
import { validateGoalSchema } from '../src/agent/goal-schema-validator.js';
import { buildCatalog } from '../src/agent/local-reasoner.js';
import { interpretTask } from '../src/agent/task-interpreter.js';

const multi = deriveExplicitOutcomeGoal('Open the Dropdown example from the homepage, then select Option 2 from its dropdown.');
assert.deepEqual(multi,{type:'form_state',fieldLabel:'dropdown',expectedValue:'2'});
assert.deepEqual(validateGoalSchema(multi),multi);
assert.equal(verifyGoal({url:'https://the-internet.herokuapp.com/dropdown',actionableElements:[{
  ref:'e1', tag:'select', label:'Please select an option Option 1 Option 2',currentValue:'2',selectedLabel:'Option 2'
}]},multi).completed,true);

const count = deriveExplicitOutcomeGoal('Click "Add Element" once and verify that exactly one "Delete" button is present.');
assert.deepEqual(count,{type:'element_count',label:'Delete',expectedValue:'1'});
assert.equal(verifyGoal({actionableElements:[{ref:'e2',tag:'button',label:'Delete'}]},count).completed,true);
assert.equal(verifyGoal({actionableElements:[]},count).completed,false);

const checkboxes = deriveExplicitOutcomeGoal('Check the first checkbox. Leave the second checkbox unchanged.');
assert.equal(checkboxes.type,'all_of');
const baseline = createBrowserStateBaseline();
const obs = (one,two) => ({url:'https://the-internet.herokuapp.com/checkboxes',actionableElements:[
 {ref:'e1',tag:'input',type:'checkbox',label:'Checkbox 1',ordinal:1,stableKey:'checkbox:1',checked:one},
 {ref:'e2',tag:'input',type:'checkbox',label:'Checkbox 2',ordinal:2,stableKey:'checkbox:2',checked:two}
]});
const initial = baseline.enrich(obs(false,true));
const good = baseline.enrich(obs(true,true));
const wrong = baseline.enrich(obs(true,false));
assert.equal(verifyGoal(initial,checkboxes).completed,false);
assert.equal(verifyGoal(good,checkboxes).completed,true);
assert.equal(verifyGoal(wrong,checkboxes).completed,false);
assert.equal(rejectContradictoryFormAction(checkboxes,good.actionableElements[1],{operation:'uncheck'}),'protected_unchanged_field');
assert.equal(rejectContradictoryFormAction(checkboxes,good.actionableElements[0],{operation:'uncheck'}),'reverses_required_checkbox_state');
assert.equal(rejectContradictoryFormAction(checkboxes,initial.actionableElements[0],{operation:'check'}),null);

// A completed secure handover should NOT advertise another password fill.
const catalog = buildCatalog({actionableElements:[
 {ref:'e1',tag:'input',type:'password',label:'Password',editable:true,hasValue:true,currentValue:'[REDACTED]',relevanceScore:20},
 {ref:'e2',tag:'button',type:null,label:'Login',editable:false,relevanceScore:10}
]},[],{type:'page_destination',heading:'Secure Area'},'Log into this demo website');
assert.equal(catalog.find(item=>item.ref==='e1')?.allowedOperations.includes('fill') ?? false,false);
assert.equal(catalog.find(item=>item.ref==='e2')?.allowedOperations.includes('click'),true);

// Deliberately malformed LLM outputs: recover from user instruction without
// accepting the invalid schema or inventing extra requirements.
const malformedFetch = async () => ({ok:true, json:async () => ({response:JSON.stringify({type:'browser_goal',goal:{type:'form_state',fieldLabel:'Delete',expectedValue:'1',conditions:[{type:'page_destination',heading:'Other'}]}})})});
const parsed = await interpretTask('Click "Add Element" once and verify that exactly one "Delete" button is present.',{fetchImpl:malformedFetch,currentUrl:'https://the-internet.herokuapp.com/add_remove_elements/'});
assert.equal(parsed.status,'interpreted');
assert.deepEqual(parsed.task.goal,count);

console.log('74K53: 14 coordinated regression assertions passed');
