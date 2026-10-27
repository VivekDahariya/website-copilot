import assert from "node:assert/strict";
import { createWorkflowGoalVerifier } from "../../src/agent/workflow-goal-verifier.js";

const goal = {
  type: "visible_content",
  text: "Preferences saved successfully"
};

const instruction = "Save the preferences and verify success";

const before = {
  url: "https://workflow-lab.example/preferences",
  visibleBodyText: "Preferences saved successfully",
  actionableElements: []
};

const afterUnchanged = {
  ...before
};

const verifier = createWorkflowGoalVerifier(goal, instruction);

verifier.verify(before);

verifier.recordAction(
  { operation: "click", ref: "save" },
  { label: "Save Preferences" },
  { executionCompleted: true }
);

const unchanged = verifier.verify(afterUnchanged);

console.log("SUCCESS ALREADY VISIBLE BEFORE SAVE:", unchanged.completed);

assert.equal(
  unchanged.completed,
  false,
  "FALSE POSITIVE: Pre-existing success evidence was accepted."
);

const noSuccessVerifier = createWorkflowGoalVerifier(goal, instruction);

const noSuccess = {
  ...before,
  visibleBodyText: "Preferences are not saved yet"
};

noSuccessVerifier.verify(noSuccess);

noSuccessVerifier.recordAction(
  { operation: "click", ref: "save" },
  { label: "Save Preferences" },
  { executionCompleted: true }
);

const missing = noSuccessVerifier.verify(noSuccess);

console.log("NO SUCCESS AFTER SAVE:", missing.completed);

assert.equal(
  missing.completed,
  false,
  "FALSE POSITIVE: Save was accepted without success evidence."
);

console.log("STEP 72J — CAUSAL TRANSITION TEST PASSED");
