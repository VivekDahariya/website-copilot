import assert from "node:assert/strict";

import {addCheckboxOrdinals30W}
  from "../src/agent/form-checkbox-ordinals-30W.js";

import {interpretTask}
  from "../src/agent/task-interpreter.js";

const instruction=`
On the current HTML Form Elements page, complete the following form fields:

Set Username to "CoPilot_Acceptance_01".

Replace the entire TextArea Comment with "Website CoPilot end-to-end acceptance test. Do not submit this form."

Check Checkbox 1 and uncheck Checkbox 3.

Select radio 1 in the Radio Items group.

Select Drop Down Item 2 in the Dropdown.

Do not modify the password or file upload fields.

After making these changes, independently inspect the current form state and verify that all six requested field conditions are satisfied.

Do not click Submit, Cancel, or Reset. Do not navigate away from the form.

Report success only if every requested condition is verified. Otherwise, report which conditions remain unverified.
`.trim();

const comment=
  "Website CoPilot end-to-end acceptance test. Do not submit this form.";

// Faithful fixture from the user's real Chromium diagnostic.
const controls=[
  {tag:"input",type:"text",label:"",name:"username",options:[]},
  {tag:"textarea",type:"",label:"",name:"comments",options:[]},

  ...Array.from({length:3},()=>({
    tag:"input",
    type:"checkbox",
    label:"",
    name:"checkboxes[]",
    options:[]
  })),

  ...Array.from({length:3},()=>({
    tag:"input",
    type:"radio",
    label:"",
    name:"radioval",
    options:[]
  })),

  {
    tag:"select",type:"",label:"",
    name:"multipleselect[]",
    options:[1,2,3,4].map(i=>({
      label:`Selection Item ${i}`,
      value:`ms${i}`
    }))
  },
  {
    tag:"select",type:"",label:"",
    name:"dropdown",
    options:[1,2,3,4,5,6].map(i=>({
      label:`Drop Down Item ${i}`,
      value:`dd${i}`
    }))
  }
];

assert.equal(controls.length,10);

addCheckboxOrdinals30W(controls);

assert.deepEqual(
  controls.filter(c=>c.type==="checkbox")
    .map(c=>c.ordinal),
  [1,2,3]
);

assert.ok(
  controls.filter(c=>c.type!=="checkbox")
    .every(c=>c.ordinal===undefined)
);

console.log("PASS: Unlabelled checkboxes identified as 1, 2, 3");
console.log("PASS: Other controls unchanged");

// Independent shared-name groups must not share numbering.
const groups=[
  {type:"checkbox",name:"group-a"},
  {type:"checkbox",name:"group-b"},
  {type:"checkbox",name:"group-a"},
  {type:"checkbox",name:"group-b"}
];

addCheckboxOrdinals30W(groups);

assert.deepEqual(
  groups.map(c=>c.ordinal),
  [1,1,2,2]
);

console.log("PASS: Separate checkbox groups isolated");

const first={
  type:"browser_goal",
  goal:{
    type:"form_state",
    conditions:[
      {type:"form_state",label:"Username",
       expectedValue:"CoPilot_Acceptance_01"},
      {type:"form_state",label:"Comment",
       expectedValue:comment},
      {type:"form_state",label:"Checkbox 1",
       expectedValue:"checked"},
      {type:"form_state",label:"Checkbox 3",
       expectedValue:"unchecked"},
      {type:"form_state",label:"Radio 1",
       expectedValue:"radioval1"},
      {type:"form_state",label:"Dropdown Item 2",
       expectedValue:"dd2"}
    ]
  }
};

const second={
  type:"browser_goal",
  goal:{
    type:"form_state",
    conditions:[
      {type:"form_state",fieldLabel:"username",
       expectedValue:"CoPilot_Acceptance_01"},
      {type:"form_state",fieldLabel:"comments",
       expectedValue:comment},
      {type:"form_state",fieldLabel:"checkboxes[]",
       expectedValue:"checked"},
      {type:"form_state",fieldLabel:"checkboxes[]",
       expectedValue:"unchecked"},
      {type:"form_state",fieldLabel:"radioval",
       expectedValue:"radioval1"},
      {type:"form_state",fieldLabel:"dropdown",
       expectedValue:"dd2"}
    ]
  }
};

let calls=0;

const result=await interpretTask(instruction,{
  currentUrl:
    "https://www.eviltester.com/selenium/basic_html_form.html",
  formControls:controls,
  fetchImpl:async()=>{
    const response=calls++===0 ? first : second;

    return {
      ok:true,
      json:async()=>({
        response:JSON.stringify(response)
      })
    };
  }
});

assert.equal(
  result.status,"interpreted",
  JSON.stringify(result)
);

assert.equal(calls,2);

const goal=result.task.goal;

assert.equal(goal.type,"all_of");
assert.equal(goal.conditions.length,6);

const states=goal.conditions.filter(
  c=>c.type==="form_state"
);

const checkbox1=states.filter(
  c=>c.fieldLabel==="Checkbox 1"
);

const checkbox3=states.filter(
  c=>c.fieldLabel==="Checkbox 3"
);

assert.equal(checkbox1.length,1);
assert.equal(checkbox3.length,1);

assert.ok(
  checkbox1[0].expectedValue===true ||
  checkbox1[0].expectedValue==="checked"
);

assert.ok(
  checkbox3[0].expectedValue===false ||
  checkbox3[0].expectedValue==="unchecked"
);

assert.ok(states.some(
  c=>c.expectedValue==="CoPilot_Acceptance_01"
));

assert.ok(states.some(
  c=>c.expectedValue===comment
));

assert.ok(states.some(
  c=>c.expectedValue==="radioval1" ||
     c.expectedValue==="checked" &&
     /radio/i.test(c.fieldLabel)
));

assert.ok(states.some(
  c=>c.expectedValue==="dd2" ||
     c.expectedValue==="Drop Down Item 2"
));

assert.ok(!states.some(
  c=>c.fieldLabel==="checkboxes[]"
));

console.log("PASS: Both REAL dashboard Qwen responses replayed");
console.log("PASS: Shared checkbox contradiction eliminated");
console.log("PASS: Six field goals preserved");
console.log("PASS: Independent Checkbox 1/3 states retained");
console.log("PASS: Step 7F.30W regression");
