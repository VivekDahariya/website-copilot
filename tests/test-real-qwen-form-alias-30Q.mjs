import assert from "node:assert/strict";
import {interpretTask}
  from "../src/agent/task-interpreter.js";
import {validateGoalSchema}
  from "../src/agent/goal-schema-validator.js";

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
      {type:"form_state",label:"Radio Items",
       expectedValue:"Radio 1"},
      {type:"form_state",label:"Dropdown",
       expectedValue:"Item 2"}
    ]
  }
};

const second={
  type:"browser_goal",
  goal:{
    type:"form_state",
    conditions:[
      {type:"form_state",fieldLabel:"Username",
       expectedValue:"CoPilot_Acceptance_01"},
      {type:"form_state",fieldLabel:"Comment",
       expectedValue:comment},
      {type:"form_state",fieldLabel:"Checkbox 1",
       expectedValue:true},
      {type:"form_state",fieldLabel:"Checkbox 3",
       expectedValue:false},
      {type:"form_state",fieldLabel:"Radio Items",
       expectedValue:"Radio 1"},
      {type:"form_state",fieldLabel:"Dropdown",
       expectedValue:"Item 2"}
    ]
  }
};

async function replay(responses) {
  let calls=0;

  const result=await interpretTask(instruction,{
    currentUrl:
      "https://www.eviltester.com/selenium/basic_html_form.html",
    formControls:[],
    fetchImpl:async()=>{
      const response=responses[
        Math.min(calls++,responses.length-1)
      ];

      return {
        ok:true,
        json:async()=>({
          response:JSON.stringify(response)
        })
      };
    }
  });

  return {result,calls};
}

const {result,calls}=await replay([first,second]);

assert.equal(
  result.status,"interpreted",
  JSON.stringify(result)
);

assert.equal(calls,2);
assert.equal(result.task.goal.type,"all_of");

const conditions=result.task.goal.conditions;

assert.equal(conditions.length,6);

const values=new Map(
  conditions.map(c=>[c.fieldLabel,c.expectedValue])
);

assert.equal(values.size,6);
assert.equal(values.get("Username"),"CoPilot_Acceptance_01");
assert.equal(values.get("TextArea Comment"),comment);
assert.equal(values.get("Radio 1"),"checked");
assert.equal(values.get("Dropdown"),"Drop Down Item 2");

// The interpreter legitimately permits both equivalent
// checkbox state representations.
assert.ok(
  values.get("Checkbox 1")===true ||
  values.get("Checkbox 1")==="checked"
);

assert.ok(
  values.get("Checkbox 3")===false ||
  values.get("Checkbox 3")==="unchecked"
);

console.log("PASS: Both captured Qwen replies replayed");
console.log("PASS: All six requested fields preserved");
console.log("PASS: Boolean/string checkbox states recognized");

const direct=await replay([second]);

assert.equal(
  direct.result.status,"interpreted",
  JSON.stringify(direct.result)
);
assert.equal(direct.calls,1);

console.log("PASS: Correctable Qwen response accepted directly");

const wrong=structuredClone(second);
wrong.goal.conditions[1].expectedValue="Wrong text";

const bad=await replay([wrong,wrong]);

assert.notEqual(bad.result.status,"interpreted");

console.log("PASS: Wrong textarea value rejected");

const missing=structuredClone(second);
missing.goal.conditions.splice(1,1);

const incomplete=await replay([missing,missing]);

assert.notEqual(incomplete.result.status,"interpreted");

console.log("PASS: Missing textarea condition rejected");

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

console.log("PASS: Genuine contradictions still rejected");
console.log("PASS: Step 7F.30Q regression");
