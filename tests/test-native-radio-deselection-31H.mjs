import assert from "node:assert/strict";

import {createFormMutationPolicy}
  from "../src/agent/form-mutation-policy.js";

const url=
  "https://www.eviltester.com/selenium/basic_html_form.html";

const radio=(n,checked,name="radioval")=>({
  ref:`r${n}`,
  tag:"input",
  type:"radio",
  label:`rd${n}`,
  name,
  ordinal:n,
  stableKey:`radio:${n}`,
  checked,
  currentValue:`rd${n}`
});

const checkbox=(n,checked)=>({
  ref:`c${n}`,
  tag:"input",
  type:"checkbox",
  label:`cb${n}`,
  name:"checkboxes[]",
  ordinal:n,
  stableKey:`checkbox:${n}`,
  checked,
  currentValue:`cb${n}`
});

const before={
  url,
  actionableElements:[
    radio(1,false),
    radio(2,true),
    radio(3,false),
    checkbox(1,false),
    checkbox(2,false),
    checkbox(3,true)
  ]
};

const changed=(observation,updates)=>({
  ...observation,
  actionableElements:observation.actionableElements.map(
    item=>updates[item.ref]
      ? {...item,...updates[item.ref]}
      : {...item}
  )
});

const after=changed(before,{
  r1:{checked:true},
  r2:{checked:false}
});

const radioGoal={
  type:"form_state",
  fieldLabel:"Radio 1",
  expectedValue:"checked"
};

function policy(goal=radioGoal,initial=before){
  const p=createFormMutationPolicy({
    goal,
    instruction:"Select radio 1 in the Radio Items group."
  });

  p.observe(initial);
  return p;
}

const p=policy();

assert.equal(
  p.reject(before,before.actionableElements[0],{
    ref:"r1",operation:"check",value:""
  }),
  null
);

assert.deepEqual(p.verify(after),{
  verified:true,
  issues:[]
});

console.log(
  "PASS: Real radio-default scenario accepted"
);
console.log(
  "PASS: Native Radio 2 deselection not a violation"
);

// Still reject modifications outside the requested radio group.
const checkboxChanged=changed(after,{
  c2:{checked:true}
});

const checkboxResult=policy().verify(checkboxChanged);

assert.equal(checkboxResult.verified,false);
assert.ok(
  checkboxResult.issues.some(
    x=>x.reason==="protected_field_changed"
  )
);

console.log("PASS: Unrequested checkbox change rejected");

// Reject changes to an unrelated native radio group.
const differentGroup=changed(before,{
  r2:{name:"differentGroup"}
});

const differentAfter=changed(differentGroup,{
  r1:{checked:true},
  r2:{checked:false}
});

assert.equal(
  policy(radioGoal,differentGroup)
    .verify(differentAfter).verified,
  false
);

console.log("PASS: Unrelated radio group remains protected");

// Do not excuse additional changes to radio states.
const invalidRadioState=changed(after,{
  r3:{checked:true}
});

assert.equal(
  policy().verify(invalidRadioState).verified,
  false
);

console.log("PASS: Invalid multi-radio state rejected");

// A separately protected Radio 2 is not automatically mutable.
const protectedGoal={
  type:"all_of",
  conditions:[
    radioGoal,
    {
      type:"form_state",
      fieldLabel:"Radio 2",
      expectedValue:"unchanged"
    }
  ]
};

assert.equal(
  policy(protectedGoal).verify(after).verified,
  false
);

console.log("PASS: Explicit Radio 2 preservation respected");

// Radio 2 cannot simply be deselected without selecting Radio 1.
const deselectionOnly=changed(before,{
  r2:{checked:false}
});

assert.equal(
  policy().verify(deselectionOnly).verified,
  false
);

console.log("PASS: Unpaired radio deselection rejected");

// The original baseline remains authoritative.
assert.deepEqual(
  before.actionableElements
    .filter(e=>e.type==="radio")
    .map(e=>e.checked),
  [false,true,false]
);

console.log("PASS: Initial browser state unchanged");
console.log("PASS: Step 7F.31H regression");
