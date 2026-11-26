import assert from "node:assert/strict";

import {createExplicitTabWorkflow}
  from "../src/agent/explicit-tab-workflow.js";

const instruction=`
On the current page, click the "Click Here" link to open
a new browser tab. Switch to the new tab and read its heading.
Verify that the heading is exactly "New Window".
Then switch back to the original tab, whose heading is
"Opening a new window". Keep both tabs open.
Report success only after returning to the original tab
and confirming that the new tab remains open.
`.replace(/\s+/g," ").trim();

const originalUrl=
  "https://the-internet.herokuapp.com/windows";

const newUrl=
  "https://the-internet.herokuapp.com/windows/new";

function replay({
  task=instruction,
  targetHeading="New Window",
  targetHeadings=null
}={}) {
  let original;

  const context={
    pages:()=>[original]
  };

  original={
    context:()=>context,
    isClosed:()=>false,
    url:()=>originalUrl
  };

  const popup={
    context:()=>context,
    isClosed:()=>false,
    url:()=>newUrl
  };

  const workflow=createExplicitTabWorkflow(task,original);

  assert.ok(
    workflow,
    "Explicit tab workflow must activate"
  );

  assert.equal(
    workflow.registerSourcePopup(popup),
    true
  );

  const resolve=ref=>
    ref==="tab_2" ? popup :
    ref==="tab_1" ? original : null;

  const originalObservation={
    url:originalUrl,
    title:"The Internet",
    headings:["Opening a new window"],
    availableTabs:[
      {ref:"tab_1"},
      {ref:"tab_2"}
    ]
  };

  const targetObservation={
    url:newUrl,
    title:"New Window",
    headings:targetHeadings??[targetHeading],
    availableTabs:[
      {ref:"tab_1"},
      {ref:"tab_2"}
    ]
  };

  workflow.observe(
    original,
    originalObservation,
    {completed:false},
    resolve
  );

  const openAction=workflow.nextAction(original);

  assert.deepEqual(openAction,{
    ref:"tab_2",
    operation:"switch_tab",
    value:""
  });

  workflow.observe(
    popup,
    targetObservation,
    {completed:false},
    resolve
  );

  const returnAction=workflow.nextAction(popup);

  const returned=workflow.observe(
    original,
    originalObservation,
    {completed:false},
    resolve
  );

  return {
    returnAction,
    returned,
    evidence:workflow.evidence()
  };
}

if(process.env.PHASE==="before") {
  const result=replay();

  console.log("Current guided return:",result.returnAction);
  console.log(
    "Current accepted heading:",
    result.evidence.observedHeading
  );

  assert.equal(
    result.returnAction,
    null,
    "Original heading parsing bug not reproduced"
  );

  assert.equal(result.returned,false);

  console.log(
    "PASS: Wrong heading extraction reproduced"
  );
  process.exit(0);
}

const result=replay();

assert.deepEqual(result.returnAction,{
  ref:"tab_1",
  operation:"switch_tab",
  value:""
});

assert.equal(result.returned,true);
assert.equal(
  result.evidence.observedHeading,
  "New Window"
);
assert.equal(
  result.evidence.originalTabRestored,
  true
);
assert.equal(
  result.evidence.newTabOpen,
  true
);

console.log("PASS: New tab heading recognized");
console.log("PASS: Guided return targets tab_1");
console.log("PASS: Original tab restored");
console.log("PASS: Both tabs remain open");

const wrongHeading=replay({
  targetHeading:"Unexpected Heading"
});

assert.equal(wrongHeading.returnAction,null);
assert.equal(wrongHeading.returned,false);

console.log("PASS: Incorrect heading blocks return");

const missingHeading=replay({
  targetHeadings:[]
});

assert.equal(missingHeading.returnAction,null);
assert.equal(missingHeading.returned,false);

console.log("PASS: Page title alone is insufficient");

const previousSyntax=instruction.replace(
  'Verify that the heading is exactly "New Window".',
  'Verify that the heading reads "New Window".'
);

assert.deepEqual(
  replay({task:previousSyntax}).returnAction,
  {ref:"tab_1",operation:"switch_tab",value:""}
);

console.log("PASS: Existing heading syntax preserved");

const noReturn=instruction.replace(
  "Then switch back to the original tab,",
  "Then inspect the original page,"
);

assert.equal(
  createExplicitTabWorkflow(noReturn,{
    context:()=>({pages:()=>[]})
  }),
  null
);

console.log("PASS: Return is never inferred");
console.log("PASS: Step 7F.32B regression");
