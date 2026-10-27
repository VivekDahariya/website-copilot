import assert from "node:assert/strict";
import { extractDesiredState } from "../../src/agent/intent-extractor.js";
import { verifyRequirementCoverage } from "../../src/agent/requirement-coverage-verifier.js";
import { evaluateFormCompleteness } from "../../src/agent/completeness-gate.js";

const instruction =
  "Set Workspace Name to LAB-LAB-Atlas Research, set Project Code to ABC, and save.";

const observation = {
  actionableElements: [
    {
      ref: "e1",
      tag: "input",
      type: "text",
      editable: true,
      label: "Workspace Name",
      currentValue: "LAB-LAB-Atlas Research"
    },
    {
      ref: "e2",
      tag: "input",
      type: "text",
      editable: true,
      label: "Project Code",
      currentValue: "ABC"
    },
    {
      ref: "e3",
      tag: "button",
      type: "submit",
      label: "Save",
      text: "Save"
    }
  ]
};

const feedback =
  "Validation error: Workspace Name must start with LAB-. " +
  "Validation error: Project Code must start with PRJ-.";

const extraction = await extractDesiredState(
  instruction,
  observation,
  feedback
);

const coverage = await verifyRequirementCoverage({
  instruction,
  observation,
  extraction,
  validationFeedback: feedback
});

const completeness = evaluateFormCompleteness({
  extraction,
  attestation: coverage.attestation
});

console.log("EXTRACTION:", JSON.stringify(extraction, null, 2));
console.log("COVERAGE:", JSON.stringify(coverage, null, 2));
console.log("COMPLETENESS:", JSON.stringify(completeness, null, 2));



const workspace = extraction.requirements.find(
  item => item.label === "Workspace Name"
);

const project = extraction.requirements.find(
  item => item.label === "Project Code"
);

assert.equal(
  workspace?.value,
  "LAB-LAB-Atlas Research",
  "Explicitly requested repeated prefixes must be preserved."
);

assert.equal(project?.value, "PRJ-ABC");
assert.equal(extraction.unresolved.length, 0);
assert.equal(coverage.verified, true);
assert.equal(completeness.status, "pending");
assert.equal(completeness.submissionEligible, false);
assert.equal(extraction.reconciliation.pending.length, 1);

console.log("PASS: Explicit user value preserved");
