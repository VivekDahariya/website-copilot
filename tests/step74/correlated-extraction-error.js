import assert from "node:assert/strict";

import {
  verifyRequirementCoverage
} from "../../src/agent/requirement-coverage-verifier.js";

const instruction =
  'Set Workspace Name to "LAB-LAB-Atlas Research" and save.';

const incorrectlyExtracted = {
  label: "Workspace Name",
  kind: "text",
  value: "LAB-LAB-: Atlas Research"
};

const observation = {
  actionableElements: [
    {
      ref: "e1",
      tag: "input",
      type: "text",
      editable: true,
      label: "Workspace Name",
      currentValue: incorrectlyExtracted.value
    },
    {
      ref: "e2",
      tag: "button",
      type: "submit",
      label: "Save",
      text: "Save"
    }
  ]
};

const extraction = {
  requirements: [{ ...incorrectlyExtracted }],
  unresolved: []
};

// Deliberately simulate correlated errors by both extractors.
const independentExtractor = async () => ({
  requirements: [{ ...incorrectlyExtracted }],
  unresolved: [],
  reconciliation: {
    pending: [],
    satisfied: [
      {
        requirement: { ...incorrectlyExtracted },
        ref: "e1",
        actual: incorrectlyExtracted.value
      }
    ],
    unresolved: [],
    allSatisfied: true
  }
});

const coverage = await verifyRequirementCoverage({
  instruction,
  observation,
  extraction,
  independentExtractor
});

console.log("REQUESTED:", "LAB-LAB-Atlas Research");
console.log("EXTRACTED:", incorrectlyExtracted.value);
console.log("COVERAGE VERIFIED:", coverage.verified);
console.log("ISSUES:", coverage.issues);

assert.notEqual(
  incorrectlyExtracted.value,
  "LAB-LAB-Atlas Research"
);

assert.equal(
  coverage.verified,
  false,
  "Incorrect explicit values must never receive attestation."
);

assert.ok(
  coverage.issues.some(
    issue => issue.reason === "explicit_literal_value_mismatch"
  ),
  "Expected deterministic literal-grounding rejection."
);

assert.equal(coverage.attestation, null);

console.log(
  "PASS: Correlated extraction error blocked by literal grounding."
);
