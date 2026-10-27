
import {
  classifyFinalizingAction
} from "../../src/agent/finalizing-action-classifier.js";

const instruction =
  "Change Project Name to Website CoPilot and save preferences.";

const goal = {
  type: "all_of",
  conditions: [
    {
      type: "form_state",
      fieldLabel: "Project Name",
      expectedValue: "Website CoPilot"
    },
    {
      type: "visible_content",
      text: "Preferences saved successfully"
    }
  ]
};

const observation = {
  actionableElements: [
    {
      ref: "input",
      tag: "input",
      label: "Project Name",
      editable: true
    }
  ]
};

const cases = [
  {
    name: "Save Preferences",
    label: "Save Preferences",
    expected: true
  },
  {
    name: "Icon-only Apply",
    label: "Apply",
    expected: true
  },
  {
    name: "Update Preview",
    label: "Update Preview",
    expected: false
  },
  {
    name: "Apply Filter",
    label: "Apply Filter",
    expected: false
  },
  {
    name: "Confirm Selection",
    label: "Confirm Selection",
    expected: false
  },
  {
    name: "Next",
    label: "Next",
    expected: false
  },
  {
    name: "Cancel",
    label: "Cancel",
    expected: false
  },
  {
    name: "Open Menu",
    label: "Open Menu",
    expected: false
  },
  {
    name: "View Details",
    label: "View Details",
    expected: false
  },
  {
    name: "Submit Form",
    label: "Submit Form",
    expected: true
  }
];

let passed = 0;
let failed = 0;

for (const test of cases) {
  const result = classifyFinalizingAction({
    action: {
      ref: "button",
      operation: "click"
    },
    element: {
      ref: "button",
      tag: "button",
      role: "button",
      label: test.label,
      type: "button"
    },
    instruction,
    goal,
    observation
  });

  const success = result.finalizing === test.expected;

  if (success) {
    passed++;
  } else {
    failed++;
  }

  console.log(
    `${success ? "PASS" : "FAIL"}: ${test.name}`
  );

  console.log(
    `  Expected: ${test.expected}`
  );

  console.log(
    `  Actual:   ${result.finalizing}`
  );

  console.log(
    `  Reason:   ${result.reason}`
  );
}

console.log(
  "\n========== STEP 74K.8 SUMMARY =========="
);

console.log(`Passed: ${passed}/${cases.length}`);
console.log(`Failed: ${failed}/${cases.length}`);

if (failed > 0) {
  console.log(
    "\nDIAGNOSTIC RESULT: False-positive classification detected."
  );
} else {
  console.log(
    "\nDIAGNOSTIC RESULT: All tested classifications matched expectations."
  );
}
