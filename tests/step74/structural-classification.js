import assert from "node:assert/strict";
import { classifyFinalizingAction } from "../../src/agent/finalizing-action-classifier.js";

const goal = {
  type: "visible_content",
  text: "Preferences saved successfully"
};

const instruction = "Save preferences";

const form = (associated, fieldCount = 1) => ({
  associated,
  id: associated ? "settings" : null,
  fieldCount,
  fields: associated
    ? [{ tag: "input", name: "projectName" }]
    : []
});

const cases = [
  {
    name: "Icon-only submit inside real form",
    element: {
      tag: "button",
      label: "",
      effectiveType: "submit",
      formContext: form(true)
    },
    expected: true
  },
  {
    name: "External submit associated with form",
    element: {
      tag: "button",
      label: "Apply",
      effectiveType: "submit",
      formContext: form(true)
    },
    expected: true
  },
  {
    name: "Default HTML submit button",
    element: {
      tag: "button",
      label: "Continue",
      effectiveType: "submit",
      formContext: form(true)
    },
    expected: true
  },
  {
    name: "Icon-only button outside form",
    element: {
      tag: "button",
      label: "",
      effectiveType: "button",
      formContext: form(false)
    },
    expected: false
  },
  {
    name: "Submit-like button without form ownership",
    element: {
      tag: "button",
      label: "Continue",
      effectiveType: "submit",
      formContext: form(false)
    },
    expected: false
  },
  {
    name: "Intermediate preview inside form",
    element: {
      tag: "button",
      label: "Update Preview",
      effectiveType: "submit",
      formContext: form(true)
    },
    expected: false
  },
  {
    name: "Intermediate filter inside form",
    element: {
      tag: "button",
      label: "Apply Filter",
      effectiveType: "submit",
      formContext: form(true)
    },
    expected: false
  },
  {
    name: "Selection confirmation inside form",
    element: {
      tag: "button",
      label: "Confirm Selection",
      effectiveType: "submit",
      formContext: form(true)
    },
    expected: false
  },
  {
    name: "Contextual apply with associated fields",
    element: {
      tag: "button",
      label: "Apply",
      effectiveType: "button",
      formContext: form(true, 1)
    },
    expected: true
  },
  {
    name: "Contextual apply with unrelated editable field",
    element: {
      tag: "button",
      label: "Apply",
      effectiveType: "button",
      formContext: form(false)
    },
    observation: {
      actionableElements: [
        { ref: "e1", editable: true }
      ]
    },
    expected: false
  },
  {
    name: "Contextual apply with empty form",
    element: {
      tag: "button",
      label: "Apply",
      effectiveType: "button",
      formContext: form(true, 0)
    },
    expected: false
  },
  {
    name: "Navigation link remains non-finalizing",
    element: {
      tag: "a",
      label: "Save Preferences",
      href: "/settings",
      formContext: form(false)
    },
    expected: false
  }
];

let passed = 0;
let failed = 0;

for (const test of cases) {
  const result = classifyFinalizingAction({
    action: { operation: "click", ref: "e2" },
    element: test.element,
    goal,
    instruction,
    observation: test.observation ?? null
  });

  try {
    assert.equal(
      result.finalizing,
      test.expected,
      `Expected ${test.expected}, got ${result.finalizing}: ${result.reason}`
    );

    passed++;
    console.log(`PASS: ${test.name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${test.name}`);
    console.error(error.message);
  }
}

console.log("\n========== STEP 74K.10E ==========");
console.log(`Passed: ${passed}/${cases.length}`);
console.log(`Failed: ${failed}/${cases.length}`);

if (failed > 0) {
  process.exitCode = 1;
}
