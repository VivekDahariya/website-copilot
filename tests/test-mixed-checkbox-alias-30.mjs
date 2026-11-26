import assert from "node:assert/strict";
import {interpretTask} from "../src/agent/task-interpreter.js";
import {validateGoalSchema}
  from "../src/agent/goal-schema-validator.js";

const instruction=[
  'Set Username to "CoPilot_Acceptance_01".',
  'Replace TextArea Comment with "Acceptance test".',
  'Check Checkbox 1 and uncheck Checkbox 3.',
  'Select Radio 1 and Dropdown Item 2.',
  'Do not submit or reset the form.'
].join(" ");

const controls=[
  {tag:"input",type:"text",name:"username",
   label:"Username"},
  {tag:"textarea",type:"textarea",name:"comments",
   label:"TextArea Comment"},
  ...[1,2,3].map(n=>({
    tag:"input",type:"checkbox",name:"checkboxes[]",
    label:"Checkbox "+n,ordinal:n
  })),
  {tag:"input",type:"radio",name:"radioval",
   label:"Radio 1"},
  {tag:"select",type:"select",name:"dropdown",
   label:"Dropdown",options:[
     {label:"Drop Down Item 1",value:"1"},
     {label:"Drop Down Item 2",value:"2"}
   ]}
];

const others=[
  ["Username","CoPilot_Acceptance_01"],
  ["TextArea Comment","Acceptance test"],
  ["Radio 1","checked"],
  ["Dropdown","Drop Down Item 2"]
];

const modelGoal={
  type:"all_of",
  conditions:[
    ...others.map(([fieldLabel,expectedValue])=>({
      type:"form_state",fieldLabel,expectedValue
    })),
    {type:"form_state",fieldLabel:"checkboxes[]",
     expectedValue:true},
    {type:"form_state",fieldLabel:"checkboxes[]",
     expectedValue:false}
  ]
};

async function run(text){
  let calls=0;

  const output=await interpretTask(text,{
    currentUrl:"https://example.test/form",
    formControls:controls,
    fetchImpl:async()=>{
      calls++;
      return {
        ok:true,
        json:async()=>({
          response:JSON.stringify({
            type:"browser_goal",
            goal:modelGoal
          })
        })
      };
    }
  });

  return {output,calls};
}

const {output,calls}=await run(instruction);

assert.equal(output.status,"interpreted",JSON.stringify(output));
assert.equal(output.task.goal.type,"all_of");

const conditions=output.task.goal.conditions;
const values=new Map(
  conditions.map(x=>[x.fieldLabel,x.expectedValue])
);

assert.equal(conditions.length,6);
assert.equal(values.size,6);

for(const [label,value] of others){
  assert.equal(values.get(label),value);
}

assert.equal(values.get("Checkbox 1"),"checked");
assert.equal(values.get("Checkbox 3"),"unchecked");
assert.equal(values.has("checkboxes[]"),false);
assert.ok(calls<=2);

console.log("PASS: All six original requirements preserved");
console.log("PASS: Distinct checkbox targets grounded");
console.log("PASS: No shared-group aliases remain");

const explicit=await run(
  instruction+" Retain the checkboxes[] group requirement."
);

assert.equal(explicit.output.status,"needs_clarification");
assert.match(explicit.output.reason,/Conflicting checkbox group/);

console.log("PASS: Explicit group conflict rejected");

assert.throws(
  ()=>validateGoalSchema({
    type:"all_of",
    conditions:[
      {type:"form_state",fieldLabel:"Checkbox 1",
       expectedValue:"checked"},
      {type:"form_state",fieldLabel:"Checkbox 1",
       expectedValue:"unchecked"}
    ]
  }),
  /Contradictory form_state/
);

console.log("PASS: Same-control contradictions remain invalid");
console.log("PASS: Step 7F.30H targeted regression");
