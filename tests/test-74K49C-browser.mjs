import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { observePage } from '../src/observer/dom-observer.js';
import { executeAction } from '../src/executor/action-executor.js';
import { createWorkflowGoalVerifier } from '../src/agent/workflow-goal-verifier.js';
import { groundFormGoal } from '../src/agent/task-interpreter.js';

const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_BIN ? {executablePath:process.env.CHROMIUM_BIN} : {}), args:['--no-sandbox']});
try {
const page=await browser.newPage();
await page.setContent(`<!doctype html><html><head><title>Web form</title></head><body><h1>Web form</h1>
<form id="sample" onsubmit="window.submitted=true;return false;">
<label for="text">Text input</label><input id="text" type="text">
<input aria-label="OTP Code" id="secret" type="text" value="123456">
<label for="description">Textarea</label><textarea id="description"></textarea>
<label for="choice">Dropdown (select)<div>Open this select menu</div><div>One</div><div>Two</div><div>Three</div></label>
<select id="choice"><option value="">Open this select menu</option><option value="1">One</option><option value="2">Two</option><option value="3">Three</option></select>
<button type="submit">Submit</button>
</form></body></html>`);
const safeObservation=await observePage(page);
assert.equal(safeObservation.actionableElements.find(el=>el.label==='OTP Code')?.currentValue,'[REDACTED]');
console.log('PASS: OTP input remains redacted from browser snapshot');
const expected='Artificial intelligence is a branch of computer science that focuses on the creation of intelligent machines, including robots, computers, and software that can perform tasks that typically require human intelligence, such as learning, problem-solving, and decision-making.';
const rawGoal={type:'all_of',conditions:[
{type:'form_state',fieldLabel:'Text input',expectedValue:'Alex'},
{type:'form_state',fieldLabel:'Textarea',expectedValue:expected},
{type:'form_state',fieldLabel:'Dropdown (select)\n  Open this select menu\n  One\n',expectedValue:'Two'}
]};
const controls=[{tag:'input',type:'text',label:'Text input',name:'text'}, {tag:'textarea',type:'',label:'Textarea',name:'description'},
{tag:'select',type:'',label:'Dropdown (select)\n  Open this select menu\n  One\n',options:[{label:'Open this select menu',value:''},{label:'One',value:'1'},{label:'Two',value:'2'},{label:'Three',value:'3'}]}];
const instruction="I'm testing a registration form. Use Alex as the name, put a short introduction about artificial intelligence in the large writing area, and choose the second option. Don't send anything.";
const goal=groundFormGoal(rawGoal,controls,instruction);
assert.equal(goal.conditions[2].fieldLabel,'Dropdown (select)');
const verifier=createWorkflowGoalVerifier(goal,instruction);
const actions=[['Text input','fill','Alex'],['Textarea','fill',expected],['Dropdown (select)','select','Two']];
for (const [label,operation,value] of actions){
 const before=await observePage(page);
 const element=before.actionableElements.find(x=>x.label.startsWith(label));
 assert.ok(element,'Missing element '+label);
 const result=await executeAction(page,{ref:element.ref,operation,value});
 assert.equal(result.verified,true,label+' not verified by executor');
 verifier.recordAction({ref:element.ref,operation,value},element,result);
 const after=await observePage(page);
 const verified=verifier.verify(after);
 const specific=verified.evidence.conditions.find(x=>x.evidence?.expectedField?.startsWith(label));
 assert.equal(specific?.completed,true,label+' not recognized as complete');
 console.log('PASS: '+label+' survives fresh observation, goal verification and executor');
}
const last=await observePage(page);
assert.equal(verifier.verify(last).completed,true);
assert.equal(await page.locator('#description').inputValue(),expected);
assert.equal(await page.locator('#choice').inputValue(),'2');
assert.notEqual(await page.evaluate(()=>window.submitted),true);
console.log('PASS: 273-character textarea, label/value select and no submission');
} finally {await browser.close();}
