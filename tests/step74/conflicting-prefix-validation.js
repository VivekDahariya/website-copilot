import assert from "node:assert/strict";
import { extractDesiredState } from "../../src/agent/intent-extractor.js";
import { verifyRequirementCoverage } from "../../src/agent/requirement-coverage-verifier.js";
import { evaluateFormCompleteness } from "../../src/agent/completeness-gate.js";

const instruction =
  "Set Workspace Name to Atlas Research, set Project Code to ABC, and save.";

const observation = {
  actionableElements: [
    {
      ref: "e1",
      tag: "input",
      type: "text",
      editable: true,
      label: "Workspace Name",
      currentValue: "Atlas Research"
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
  "Validation error: Workspace Name must start with PRJ-.";

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



assert.ok(
  extraction.unresolved.some(
    item => item.reason ===
      "contradictory_validation_prefix_constraints"
  ),
  "Extractor must recognize contradictory constraints."
);

assert.equal(
  completeness.submissionEligible,
  false,
  "Contradictory constraints must never authorize submission."
);

assert.equal(
  coverage.verified,
  false,
  "Contradictory prefixes must not receive coverage attestation."
);

console.log("PASS: Contradictory prefix constraints blocked");
