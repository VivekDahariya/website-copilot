import assert from "node:assert/strict";

import {
  detectNavigationIntent,
  createNavigationIntentGuard
} from "../src/agent/navigation-intent-guard.js";

const url =
  "https://www.eviltester.com/selenium/basic_html_form.html";

const instruction = `
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

const goal = {
  type:"all_of",
  conditions:[
    ["username","CoPilot_Acceptance_01"],
    ["comments","Website CoPilot end-to-end acceptance test. Do not submit this form."],
    ["Checkbox 1","checked"],
    ["Checkbox 3","unchecked"],
    ["Radio 1","checked"],
    ["dropdown","dd2"]
  ].map(([fieldLabel,expectedValue])=>({
    type:"form_state",
    fieldLabel,
    expectedValue
  }))
};

function canComplete(text,completed=true) {
  const guard=createNavigationIntentGuard(
    text,url,text
  );

  guard.observe(url);

  return guard.canComplete(
    completed,
    {url,title:"HTML Form Elements"},
    goal
  );
}

if(process.env.PHASE==="before") {
  assert.equal(
    detectNavigationIntent(instruction),
    true,
    "The original bug must reproduce before patching"
  );

  assert.equal(
    canComplete(instruction),
    false,
    "Original instruction must reproduce blocked completion"
  );

  console.log("PASS: Original false navigation requirement reproduced");
  process.exit(0);
}

assert.equal(
  detectNavigationIntent(instruction),
  false
);

assert.equal(
  canComplete(instruction),
  true
);

assert.equal(
  canComplete(instruction,false),
  false
);

console.log("PASS: Original six-field instruction can complete");
console.log("PASS: Failed goal verification still blocks completion");

const negativeExamples=[
  "Do not navigate away from the current page.",
  "Don't navigate to another page.",
  "Never open the documentation page.",
  "Do not visit the website.",
  "Do not go to the tutorial page.",
  "Do not search for the documentation.",
  "Without navigating away from this page.",
  "Do not follow the guide."
];

for(const sentence of negativeExamples) {
  assert.equal(
    detectNavigationIntent(sentence),
    false,
    `Negated navigation incorrectly required: ${sentence}`
  );
}

console.log("PASS: Negative navigation instructions respected");

const positiveExamples=[
  "Navigate to the documentation page.",
  "Open the tutorial page.",
  "Visit the website.",
  "Go to the guide page.",
  "Search for the documentation.",
  "Follow the article.",
  "Reach the profile page.",
  "Do not navigate away from this page. Open the documentation page."
];

for(const sentence of positiveExamples) {
  assert.equal(
    detectNavigationIntent(sentence),
    true,
    `Positive navigation not detected: ${sentence}`
  );
}

console.log("PASS: Positive navigation instructions retained");
console.log("PASS: Mixed positive and negative instructions handled");

const navigationInstruction="Open the documentation page.";

const navigationGuard=createNavigationIntentGuard(
  navigationInstruction,
  url,
  navigationInstruction
);

navigationGuard.observe(url);

assert.equal(
  navigationGuard.canComplete(
    true,{url},goal
  ),
  false
);

const destination="https://www.eviltester.com/documentation";

navigationGuard.observe(destination);

assert.equal(
  navigationGuard.canComplete(
    true,{url:destination},goal
  ),
  true
);

assert.equal(
  navigationGuard.canComplete(
    false,{url:destination},goal
  ),
  false
);

console.log("PASS: Real navigation still requires URL transition");
console.log("PASS: Navigation cannot override failed goal verification");
console.log("PASS: Step 7F.31P regression");
