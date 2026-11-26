import assert from "node:assert/strict";
import {verifyGoal} from "../src/agent/goal-verifier.js";
import {createWorkflowGoalVerifier}
  from "../src/agent/workflow-goal-verifier.js";

const comment =
  "Website CoPilot end-to-end acceptance test. Do not submit this form.";

const goal = {
  type:"all_of",
  conditions:[
    {type:"form_state",fieldLabel:"username",
     expectedValue:"CoPilot_Acceptance_01"},
    {type:"form_state",fieldLabel:"comments",
     expectedValue:comment},
    {type:"form_state",fieldLabel:"radioval",
     expectedValue:"radioval1"},
    {type:"form_state",fieldLabel:"dropdown",
     expectedValue:"dd2"},
    {type:"form_state",fieldLabel:"Checkbox 1",
     expectedValue:"checked"},
    {type:"form_state",fieldLabel:"Checkbox 3",
     expectedValue:"unchecked"}
  ].map(condition =>
    condition.fieldLabel==="radioval"
      ? {...condition,fieldLabel:"Radio 1",expectedValue:"checked"}
      : condition
  )
};

const observation = {
  url:"https://www.eviltester.com/selenium/basic_html_form.html",
  actionableElements:[
    {ref:"e1",tag:"input",type:"text",
     label:"username",name:"username",editable:true,
     currentValue:"CoPilot_Acceptance_01"},
    {ref:"e3",tag:"textarea",type:null,
     label:"comments",name:"comments",editable:true,
     currentValue:comment},
    {ref:"e5",tag:"input",type:"checkbox",
     label:"cb1",name:"checkboxes[]",ordinal:1,
     stableKey:"checkbox:1",checked:true},
    {ref:"e6",tag:"input",type:"checkbox",
     label:"cb2",name:"checkboxes[]",ordinal:2,
     stableKey:"checkbox:2",checked:false},
    {ref:"e7",tag:"input",type:"checkbox",
     label:"cb3",name:"checkboxes[]",ordinal:3,
     stableKey:"checkbox:3",checked:false},
    {ref:"e8",tag:"input",type:"radio",
     label:"rd1",name:"radioval",ordinal:1,
     stableKey:"radio:1",checked:true},
    {ref:"e9",tag:"input",type:"radio",
     label:"rd2",name:"radioval",ordinal:2,
     stableKey:"radio:2",checked:false},
    {ref:"e12",tag:"select",type:null,
     label:"Drop Down Item 1 Drop Down Item 2",
     name:"dropdown",currentValue:"dd2",
     selectedLabel:"Drop Down Item 2"}
  ]
};

const originalInstruction=`
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

const withoutClickProhibition=originalInstruction.replace(
  "Do not click Submit, Cancel, or Reset.",
  "Keep all other controls unchanged."
);

const check=instruction=>
  createWorkflowGoalVerifier(goal,instruction)
    .verify(observation).completed;

assert.equal(
  verifyGoal(observation,goal).completed,
  true,
  "All six direct browser-state goals must match"
);

const baseline=check(withoutClickProhibition);
const actual=check(originalInstruction);

console.log("Direct goal verifier: true");
console.log("Without negative click sentence:",baseline);
console.log("Original instruction:",actual);

assert.equal(
  baseline,true,
  "Test fixture must satisfy normal workflow verification"
);

if(process.env.CHECK_STAGE==="before"){
  assert.equal(
    actual,false,
    "Suspected false-positive not reproduced; abort patch"
  );
  console.log("PASS: Completion blocker reproduced");
} else {
  assert.equal(
    actual,true,
    "Negative Submit instruction must not require submission"
  );

  assert.equal(
    check("Fill all six fields. Do not click the Submit button."),
    true
  );

  assert.equal(
    check("Fill all six fields. Do not click on Submit."),
    true
  );

  assert.equal(
    check("Fill all six fields. Click Submit."),
    false,
    "Positive submission must still require submission evidence"
  );

  assert.equal(
    check("Do not click Submit yet. Then click Submit."),
    false,
    "A later positive Submit instruction must remain effective"
  );

  const missingCheckbox={
    ...observation,
    actionableElements:observation.actionableElements.map(
      element=>element.ref==="e7"
        ? {...element,checked:true}
        : element
    )
  };

  assert.equal(
    createWorkflowGoalVerifier(goal,originalInstruction)
      .verify(missingCheckbox).completed,
    false,
    "Unsatisfied field must block success"
  );

  console.log("PASS: Original six-field instruction completes");
  console.log("PASS: Negated Submit button actions excluded");
  console.log("PASS: Positive Submit still requires evidence");
  console.log("PASS: Missing form condition still blocks success");
  console.log("PASS: Step 7F.31M regression");
}
