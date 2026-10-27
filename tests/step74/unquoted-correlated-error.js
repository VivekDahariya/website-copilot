import assert from "node:assert/strict";

import {
  verifyRequirementCoverage
} from "../../src/agent/requirement-coverage-verifier.js";

const instruction =
  "Set Workspace Name to LAB-LAB-Atlas Research, and save.";

const wrongValue = "LAB-LAB-: Atlas Research";

const requirement = {
  label: "Workspace Name",
  kind: "text",
  value: wrongValue
};

const observation = {
  actionableElements: [
    {
      ref: "e1",
      tag: "input",
      type: "text",
      editable: true,
      label: "Workspace Name",
      currentValue: wrongValue
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
  requirements: [{ ...requirement }],
  unresolved: []
};

const independentExtractor = async () => ({
  requirements: [{ ...requirement }],
  unresolved: [],
  reconciliation: {
    pending: [],
    satisfied: [],
    unresolved: [],
    allSatisfied: true
  }
});

const result = await verifyRequirementCoverage({
  instruction,
  observation,
  extraction,
  independentExtractor
});

console.log("REQUESTED: LAB-LAB-Atlas Research");
console.log("EXTRACTED:", wrongValue);
console.log("COVERAGE VERIFIED:", result.verified);
console.log("ISSUES:", result.issues);

assert.equal(result.verified, false);
assert.equal(result.attestation, null);

assert.ok(
  result.issues.some(
    issue =>
      issue.reason === "explicit_literal_value_mismatch"
  ),
  "Unquoted explicit-value mismatch must be detected"
);

console.log("PASS: Unquoted extraction error blocked");
