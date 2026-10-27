import assert from "node:assert/strict";
import {
  verifyRequirementCoverage
} from "../../src/agent/requirement-coverage-verifier.js";

const fields = [
  {
    ref: "e1",
    label: "Project Name",
    tag: "input",
    type: "text",
    editable: true,
    currentValue: ""
  },
  {
    ref: "e2",
    label: "Visibility",
    tag: "select",
    type: "select",
    editable: true,
    currentValue: "public",
    options: [
      { value: "public", label: "Public" },
      { value: "private", label: "Private" }
    ]
  },
  {
    ref: "e3",
    label: "Activity Alerts",
    tag: "input",
    type: "checkbox",
    checked: false
  }
];

const observation = {
  url: "http://localhost:3000/settings",
  title: "Project Settings",
  actionableElements: fields
};

const instruction =
  "Set the project name to Orion, choose private visibility, " +
  "and enable activity alerts.";

const correct = [
  { label: "Project Name", kind: "text", value: "Orion" },
  { label: "Visibility", kind: "select", value: "private" },
  { label: "Activity Alerts", kind: "checkbox", value: true }
];

const cases = [
  {
    name: "Missing checkbox",
    requirements: correct.slice(0, 2)
  },
  {
    name: "Incorrect checkbox",
    requirements: correct.map(x =>
      x.label === "Activity Alerts" ? { ...x, value: false } : x
    )
  },
  {
    name: "Incorrect select",
    requirements: correct.map(x =>
      x.label === "Visibility" ? { ...x, value: "public" } : x
    )
  },
  {
    name: "Invented field",
    requirements: [
      ...correct,
      { label: "Billing Country", kind: "text", value: "India" }
    ]
  },
  {
    name: "Duplicate field",
    requirements: [...correct, { ...correct[0] }]
  },
  {
    name: "Wrong field kind",
    requirements: correct.map(x =>
      x.label === "Activity Alerts"
        ? { ...x, kind: "text", value: "true" }
        : x
    )
  },
  {
    name: "Missing text value",
    requirements: correct.map(x =>
      x.label === "Project Name"
        ? { ...x, value: "" }
        : x
    )
  },
  {
    name: "Unknown select option",
    requirements: correct.map(x =>
      x.label === "Visibility"
        ? { ...x, value: "restricted" }
        : x
    )
  },
  {
    name: "Explicit unresolved requirement",
    requirements: correct,
    unresolved: [
      { label: "Project Name", reason: "ambiguous value" }
    ]
  },
  {
    name: "Unmet validation constraint",
    requirements: correct,
    validationFeedback:
      "Validation error: Project Name must start with PRJ-."
  }
];

let passed = 0;
let failed = 0;

for (const test of cases) {
  try {
    const result = await verifyRequirementCoverage({
      instruction,
      observation,
      extraction: {
        requirements: test.requirements,
        unresolved: test.unresolved ?? []
      },
      validationFeedback: test.validationFeedback ?? ""
    });

    assert.equal(
      result.verified,
      false,
      "Verifier incorrectly approved an adversarial extraction"
    );

    assert.equal(
      result.attestation,
      null,
      "Rejected extraction must not receive attestation"
    );

    console.log("PASS:", test.name);
    passed++;
  } catch (error) {
    console.error("FAIL:", test.name);
    console.error(error.message);
    failed++;
  }
}

console.log(
  `\nAdversarial coverage: ${passed}/${cases.length} passed`
);

if (failed > 0) process.exitCode = 1;
