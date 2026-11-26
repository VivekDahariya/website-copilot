import assert from "node:assert/strict";

import {
  interpretTask
} from "../src/agent/task-interpreter.js";

import {
  checkExplicitFormGoalCoverage
} from "../src/agent/form-goal-coverage.js";

import {
  validateGoalSchema
} from "../src/agent/goal-schema-validator.js";

const textareaValue=
  "Website CoPilot end-to-end acceptance test. Do not submit this form.";

const task=[
  "On the current HTML Form Elements page,",
  'Set Username to "CoPilot_Acceptance_01".',
  `Replace the entire TextArea Comment with "${textareaValue}"`,
  "Check Checkbox 1 and uncheck Checkbox 3.",
  "Select radio 1 in the Radio Items group.",
  "Select Drop Down Item 2 in the Dropdown.",
  "Do not modify password or file upload fields.",
  "Verify all six requested conditions.",
  "Do not click Submit, Cancel, or Reset.",
  "Do not navigate away from the form."
].join(" ");

const others=[
  ["Username","CoPilot_Acceptance_01"],
  ["TextArea Comment",textareaValue],
  ["Radio 1","checked"],
  ["Dropdown","Drop Down Item 2"]
];

const aliases=[
  {type:"form_state",fieldLabel:"checkboxes[]",
   expectedValue:true},
  {type:"form_state",fieldLabel:"checkboxes[]",
   expectedValue:false}
];

const model={
  type:"all_of",
  conditions:[
    ...others.map(([fieldLabel,expectedValue])=>({
      type:"form_state",fieldLabel,expectedValue
    })),
    ...aliases
  ]
};

async function interpret(instruction,goal=model){
  let calls=0;

  const result=await interpretTask(instruction,{
    currentUrl:
      "https://www.eviltester.com/selenium/basic_html_form.html",
    formControls:[],
    fetchImpl:async()=>{
      calls++;
      return {
        ok:true,
        json:async()=>({
          response:JSON.stringify({
            type:"browser_goal",goal
          })
        })
      };
    }
  });

  return {result,calls};
}

const {result,calls}=await interpret(task);

assert.equal(
  result.status,
  "interpreted",
  JSON.stringify(result)
);

const goal=result.task.goal;
assert.equal(goal.type,"all_of");

const conditions=goal.conditions;

assert.equal(conditions.length,6);

const values=new Map(
  conditions.map(c=>[c.fieldLabel,c.expectedValue])
);

assert.equal(values.size,6);

for(const [name,value] of others){
  assert.equal(values.get(name),value);
}

assert.equal(values.get("Checkbox 1"),"checked");
assert.equal(values.get("Checkbox 3"),"unchecked");
assert.equal(values.has("checkboxes[]"),false);
assert.ok(calls<=2);

console.log("PASS: Six-field pre-browser interpretation");
console.log("PASS: Mixed checkbox identities preserved");

const unobserved=checkExplicitFormGoalCoverage(
  task,goal,[]
);

assert.equal(
  unobserved.complete,true,
  JSON.stringify(unobserved)
);

assert.equal(unobserved.checked,2);

console.log("PASS: Username and textarea literals checked without DOM");

const observedControls=[
  {tag:"input",type:"text",
   name:"username",label:"Username"},
  {tag:"textarea",type:"textarea",
   name:"comments",label:"Comments"}
];

const observed=checkExplicitFormGoalCoverage(
  task,goal,observedControls
);

assert.equal(
  observed.complete,true,
  JSON.stringify(observed)
);

console.log("PASS: Observed unique textarea grounded");

const withoutUsername={
  ...goal,
  conditions:conditions.filter(
    c=>c.fieldLabel!=="Username"
  )
};

assert.equal(
  checkExplicitFormGoalCoverage(
    task,withoutUsername,[]
  ).complete,
  false
);

const withoutTextarea={
  ...goal,
  conditions:conditions.filter(
    c=>c.fieldLabel!=="TextArea Comment"
  )
};

assert.equal(
  checkExplicitFormGoalCoverage(
    task,withoutTextarea,[]
  ).complete,
  false
);

console.log("PASS: Missing text requirements rejected");

const subset=await interpret(
  task,{type:"all_of",conditions:aliases}
);

assert.notEqual(
  subset.result.status,"interpreted"
);

console.log("PASS: Checkbox-only subset rejected");

const group=await interpret(
  task+" Retain the checkboxes[] group requirement."
);

assert.notEqual(
  group.result.status,"interpreted"
);

console.log("PASS: Explicit group conflict not discarded");

assert.throws(
  ()=>validateGoalSchema({
    type:"all_of",
    conditions:[
      {type:"form_state",
       fieldLabel:"Checkbox 1",
       expectedValue:"checked"},
      {type:"form_state",
       fieldLabel:"Checkbox 1",
       expectedValue:"unchecked"}
    ]
  }),
  /Contradictory form_state/
);

console.log("PASS: Genuine same-field contradictions rejected");
console.log("PASS: Step 7F.30M regression");
