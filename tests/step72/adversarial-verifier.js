import assert from "node:assert/strict";

import {
  createWorkflowGoalVerifier
} from "../../src/agent/workflow-goal-verifier.js";

const goal = {
  type: "all_of",
  conditions: [
    {
      type: "form_state",
      fieldLabel: "Project Name",
      expectedValue: "Website CoPilot"
    },
    {
      type: "form_state",
      fieldLabel: "Contact Email",
      expectedValue: "test@example.com"
    },
    {
      type: "visible_content",
      text: "Preferences saved successfully"
    }
  ]
};

const verifier = createWorkflowGoalVerifier(goal, "Save the preferences and verify success");

const formPage = {
  url: "https://workflow-lab.example/preferences",
  title: "Preferences",
  visibleBodyText: "Edit notification preferences",
  headings: ["Preferences"],
  actionableElements: [
    {
      ref: "e1",
      tag: "input",
      label: "Project Name",
      editable: true,
      currentValue: "Website CoPilot"
    },
    {
      ref: "e2",
      tag: "input",
      label: "Contact Email",
      editable: true,
      currentValue: "test@example.com"
    }
  ]
};

const misleadingPage = {
  url: "https://workflow-lab.example/review",
  title: "Review",
  visibleBodyText: [
    "Preferences saved successfully",
    "This is an example of a success message.",
    "Project Name: Website CoPilot",
    "Contact Email: test@example.com",
    "No changes have been saved."
  ].join("\n"),
  headings: ["Review"],
  actionableElements: []
};

const before = verifier.verify(formPage);
const after = verifier.verify(misleadingPage);

console.log("FORM STATE:", before.completed);
console.log("MISLEADING PAGE:", after.completed);
console.log("EVIDENCE:", JSON.stringify(after.evidence, null, 2));

assert.equal(
  after.completed,
  false,
  "FALSE POSITIVE: The verifier accepted a misleading review page."
);

console.log("STEP 72B — ADVERSARIAL VERIFIER PASSED");

const secondVerifier = createWorkflowGoalVerifier(goal, "Save the preferences and verify success");

secondVerifier.verify(formPage);

const deceptivePage = {
  ...misleadingPage,
  visibleBodyText: [
    "Preferences saved successfully",
    "Project Name: Website CoPilot",
    "Contact Email: test@example.com"
  ].join("\n")
};

const deceptiveResult = secondVerifier.verify(deceptivePage);

console.log(
  "DECEPTIVE SUCCESS WITHOUT WARNING:",
  deceptiveResult.completed
);

assert.equal(
  deceptiveResult.completed,
  false,
  "FALSE POSITIVE: Unverified success text was accepted."
);

console.log("STEP 72D — DECEPTIVE SUCCESS TEST PASSED");

// Step 72I: A Save click succeeds, but the page does not change.
const fakeSaveVerifier = createWorkflowGoalVerifier(
  goal,
  "Save the preferences and verify success"
);

fakeSaveVerifier.verify(formPage);

fakeSaveVerifier.recordAction(
  { operation: "click", ref: "fake-save" },
  { label: "Save Preferences" },
  { executionCompleted: true }
);

const fakeSaveResult = fakeSaveVerifier.verify(formPage);

console.log(
  "FAKE SAVE WITHOUT STATE CHANGE:",
  fakeSaveResult.completed
);

assert.equal(
  fakeSaveResult.completed,
  false,
  "FALSE POSITIVE: A Save click was accepted without verified consequences."
);

console.log("STEP 72I — FAKE SAVE TEST PASSED");
