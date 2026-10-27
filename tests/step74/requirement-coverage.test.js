import assert from "node:assert/strict";
import { verifyRequirementCoverage } from
  "../../src/agent/requirement-coverage-verifier.js";

const instruction =
  "Set the project name to Orion, choose private visibility, " +
  "and enable activity alerts. Save the settings.";

const observation = {
  actionableElements: [
    {
      ref: "a",
      label: "Project Name",
      tag: "input",
      type: "text",
      editable: true,
      currentValue: ""
    },
    {
      ref: "b",
      label: "Visibility",
      tag: "select",
      type: "select-one",
      currentValue: "public",
      options: [
        { value: "public", label: "Public" },
        { value: "private", label: "Private" }
      ]
    },
    {
      ref: "c",
      label: "Activity Alerts",
      tag: "input",
      type: "checkbox",
      checked: false
    }
  ]
};

const correct = [
  { label: "Project Name", kind: "text", value: "Orion" },
  { label: "Visibility", kind: "select", value: "private" },
  { label: "Activity Alerts", kind: "checkbox", value: true }
];

const cases = [
  {
    name: "Complete extraction",
    requirements: correct,
    expected: true
  },
  {
    name: "Omitted checkbox requirement",
    requirements: correct.slice(0, 2),
    expected: false
  },
  {
    name: "Incorrect select value",
    requirements: [
      correct[0],
      { ...correct[1], value: "public" },
      correct[2]
    ],
    expected: false
  },
  {
    name: "Incorrect checkbox state",
    requirements: [
      correct[0],
      correct[1],
      { ...correct[2], value: false }
    ],
    expected: false
  },
  {
    name: "Invented extra requirement",
    requirements: [
      ...correct,
      { label: "Billing Country", kind: "select", value: "india" }
    ],
    expected: false
  },
  {
    name: "Validation constraint omitted",
    requirements: correct,
    validationFeedback:
      "Validation error: Project Name must start with PRJ-.",
    expected: false
  },
  {
    name: "Validation constraint applied",
    requirements: [
      { ...correct[0], value: "PRJ-Orion" },
      correct[1],
      correct[2]
    ],
    validationFeedback:
      "Validation error: Project Name must start with PRJ-.",
    expected: true
  }
];

let passed = 0;

for (const scenario of cases) {
  const start = Date.now();

  const result = await verifyRequirementCoverage({
    instruction,
    observation,
    validationFeedback: scenario.validationFeedback ?? "",
    extraction: {
      requirements: scenario.requirements,
      unresolved: []
    }
  });

  try {
    assert.equal(
      result.verified,
      scenario.expected,
      `Unexpected coverage decision: ${JSON.stringify(result.issues)}`
    );

    assert.equal(
      Boolean(result.attestation),
      scenario.expected
    );

    passed++;

    console.log(
      `PASS: ${scenario.name} (${Date.now() - start}ms)`
    );
  } catch (error) {
    console.error(`FAIL: ${scenario.name}`);
    console.error(error.message);
    console.error("Verifier result:", JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
}

console.log(`\nRequirement coverage: ${passed}/${cases.length} passed`);

if (passed !== cases.length) {
  process.exitCode = 1;
}
