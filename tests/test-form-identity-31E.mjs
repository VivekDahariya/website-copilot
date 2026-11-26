import assert from "node:assert/strict";

import {interpretTask}
  from "../src/agent/task-interpreter.js";

import {verifyGoal}
  from "../src/agent/goal-verifier.js";

import {createFormMutationPolicy}
  from "../src/agent/form-mutation-policy.js";

import {addCheckboxOrdinals30W}
  from "../src/agent/form-checkbox-ordinals-30W.js";

import {reconcileExplicitRadioGoal31E}
  from "../src/agent/form-radio-identity-31E.js";

const comment=
  "Website CoPilot end-to-end acceptance test. Do not submit this form.";

const instruction=`
On the current HTML Form Elements page, complete the following form fields:

Set Username to "CoPilot_Acceptance_01".

Replace the entire TextArea Comment with "${comment}"

Check Checkbox 1 and uncheck Checkbox 3.

Select radio 1 in the Radio Items group.

Select Drop Down Item 2 in the Dropdown.

Do not modify the password or file upload fields.

After making these changes, independently inspect the current form state and verify that all six requested field conditions are satisfied.

Do not click Submit, Cancel, or Reset. Do not navigate away from the form.

Report success only if every requested condition is verified. Otherwise, report which conditions remain unverified.
`.trim();

// Actual Chromium metadata structure from the dashboard diagnostic.
const controls=[
  {tag:"input",type:"text",label:"",name:"username",options:[]},
  {tag:"textarea",type:"",label:"",name:"comments",options:[]},

  ...Array.from({length:3},()=>({
    tag:"input",type:"checkbox",label:"",
    name:"checkboxes[]",options:[]
  })),

  ...Array.from({length:3},()=>({
    tag:"input",type:"radio",label:"",
    name:"radioval",options:[]
  })),

  {
    tag:"select",type:"",label:"",
    name:"multipleselect[]",options:[]
  },

  {
    tag:"select",type:"",label:"",
    name:"dropdown",
    options:[
      {label:"Drop Down Item 1",value:"dd1"},
      {label:"Drop Down Item 2",value:"dd2"}
    ]
  }
];

addCheckboxOrdinals30W(controls);

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
  formControls:controls,
  currentUrl:
    "https://www.eviltester.com/selenium/basic_html_form.html",
  fetchImpl:async()=>({
    ok:true,
    json:async()=>({
      response:JSON.stringify(
        calls++===0 ? first : second
      )
    })
  })
});

assert.equal(
  result.status,"interpreted",
  JSON.stringify(result)
);
assert.equal(calls,2);

const goal=result.task.goal;

assert.equal(goal.type,"all_of");
assert.equal(goal.conditions.length,6);

const radio=goal.conditions.filter(c=>
  c.fieldLabel==="Radio 1"
);

assert.equal(
  radio.length,1,
  "Final goal must contain exactly one Radio 1"
);
assert.equal(radio[0].expectedValue,"checked");

assert.equal(
  goal.conditions.some(c=>c.fieldLabel==="radioval"),
  false
);

console.log("PASS: Both captured Qwen replies replayed");
console.log("PASS: Final-stage Radio 1 identity preserved");
console.log("PASS: All six original conditions retained");

const textarea={
  ref:"e3",tag:"textarea",type:null,
  label:"comments",name:"comments",
  editable:true,currentValue:comment
};

const textareaGoal={
  type:"form_state",
  fieldLabel:"TextArea Comment",
  expectedValue:comment
};

assert.equal(
  verifyGoal({actionableElements:[textarea]},textareaGoal)
    .completed,
  true
);

assert.equal(
  verifyGoal({actionableElements:[textarea]},{
    ...textareaGoal,
    fieldLabel:"TextArea Address"
  }).completed,
  false
);

assert.equal(
  verifyGoal({
    actionableElements:[
      textarea,
      {...textarea,ref:"other",name:"other",label:"other"}
    ]
  },textareaGoal).completed,
  false
);

console.log("PASS: Correct textarea verified");
console.log("PASS: Wrong or ambiguous textarea rejected");

const radioElements=[1,2,3].map(n=>({
  ref:`r${n}`,tag:"input",type:"radio",
  label:`radioval${n}`,name:"radioval",
  ordinal:n,stableKey:`radio:${n}`,
  checked:n===1,currentValue:`radioval${n}`
}));

const observation={
  url:"https://www.eviltester.com/selenium/basic_html_form.html",
  actionableElements:[
    {
      ref:"e1",tag:"input",type:"text",
      label:"username",name:"username",
      editable:true,currentValue:"CoPilot_Acceptance_01"
    },
    textarea,
    {
      ref:"e5",tag:"input",type:"checkbox",
      label:"cb1",name:"checkboxes[]",
      ordinal:1,stableKey:"checkbox:1",
      checked:true
    },
    {
      ref:"e7",tag:"input",type:"checkbox",
      label:"cb3",name:"checkboxes[]",
      ordinal:3,stableKey:"checkbox:3",
      checked:false
    },
    ...radioElements,
    {
      ref:"e12",tag:"select",type:null,
      label:"Drop Down Item 1 Drop Down Item 2",
      name:"dropdown",currentValue:"dd2",
      selectedLabel:"Drop Down Item 2",
      options:[
        {label:"Drop Down Item 1",value:"dd1"},
        {label:"Drop Down Item 2",value:"dd2"}
      ]
    }
  ]
};

assert.equal(
  verifyGoal(observation,goal).completed,
  true
);

const withoutRadio={
  ...observation,
  actionableElements:observation.actionableElements.map(e=>
    e.ref==="r1" ? {...e,checked:false} : e
  )
};

assert.equal(
  verifyGoal(withoutRadio,goal).completed,
  false
);

console.log("PASS: Six browser states independently verifiable");
console.log("PASS: Missing Radio 1 correctly prevents completion");

const policy=createFormMutationPolicy({
  goal,instruction
});

policy.observe(withoutRadio);

assert.equal(
  policy.reject(
    withoutRadio,
    withoutRadio.actionableElements.find(e=>e.ref==="r1"),
    {ref:"r1",operation:"check",value:""}
  ),
  null
);

assert.equal(
  policy.reject(
    withoutRadio,
    withoutRadio.actionableElements.find(e=>e.ref==="r2"),
    {ref:"r2",operation:"check",value:""}
  ),
  "unrequested_form_field_change"
);

console.log("PASS: Requested Radio 1 is authorized");
console.log("PASS: Unrequested Radio 2 remains blocked");

// Negative ambiguity: two independent radio groups.
const ambiguous=[
  {type:"radio",name:"radioval"},
  {type:"radio",name:"radioval"},
  {type:"radio",name:"other"}
];

const rawGoal={
  type:"all_of",
  conditions:[{
    type:"form_state",
    fieldLabel:"radioval",
    expectedValue:"radioval1"
  }]
};

assert.deepEqual(
  reconcileExplicitRadioGoal31E(
    rawGoal,instruction,ambiguous
  ),
  rawGoal
);

console.log("PASS: Ambiguous radio groups remain unresolved");
console.log("PASS: Step 7F.31E regression");
