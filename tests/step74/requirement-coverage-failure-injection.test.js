import assert from "node:assert/strict";
import {
  verifyRequirementCoverage
} from "../../src/agent/requirement-coverage-verifier.js";

const instruction = "Set Project Name to Orion and enable Activity Alerts.";

const requirements = [
  { label: "Project Name", kind: "text", value: "Orion" },
  { label: "Activity Alerts", kind: "checkbox", value: true }
];

const observation = {
  actionableElements: [
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
      label: "Activity Alerts",
      tag: "input",
      type: "checkbox",
      checked: false
    }
  ]
};

const good = () => ({
  requirements: structuredClone(requirements),
  unresolved: [],
  reconciliation: { unresolved: [] }
});

const tests = [
  ["Valid independent result", good, true],

  ["Extractor throws", () => {
    throw new Error("model unavailable");
  }, false],

  ["Extractor rejects", async () => {
    throw new Error("timeout");
  }, false],

  ["Null result", () => null, false],

  ["Undefined result", () => undefined, false],

  ["String result", () => "invalid JSON", false],

  ["Missing requirements", () => ({
    unresolved: [],
    reconciliation: { unresolved: [] }
  }), false],

  ["Missing unresolved array", () => ({
    requirements,
    reconciliation: { unresolved: [] }
  }), false],

  ["Missing reconciliation", () => ({
    requirements,
    unresolved: []
  }), false],

  ["Empty requirements", () => ({
    requirements: [],
    unresolved: [],
    reconciliation: { unresolved: [] }
  }), false],

  ["Contradictory checkbox", () => ({
    ...good(),
    requirements: [
      requirements[0],
      { ...requirements[1], value: false }
    ]
  }), false],

  ["Missing checkbox", () => ({
    ...good(),
    requirements: [requirements[0]]
  }), false],

  ["Duplicate field", () => ({
    ...good(),
    requirements: [...requirements, requirements[0]]
  }), false],

  ["Unresolved interpretation", () => ({
    ...good(),
    unresolved: [{ label: "Project Name", reason: "ambiguous" }]
  }), false],

  ["Unresolved DOM mapping", () => ({
    ...good(),
    reconciliation: {
      unresolved: [{ label: "Project Name", reason: "not found" }]
    }
  }), false]
];

let passed = 0;

for (const [name, extractor, expected] of tests) {
  try {
    const result = await verifyRequirementCoverage({
      instruction,
      observation,
      extraction: { requirements, unresolved: [] },
      independentExtractor: extractor
    });

    assert.equal(result.verified, expected);

    assert.equal(
      result.attestation !== null,
      expected,
      "Attestation must exist only for verified results"
    );

    console.log("PASS:", name);
    passed++;
  } catch (error) {
    console.error("FAIL:", name, error.message);
  }
}

console.log(
  `\nFailure injection: ${passed}/${tests.length} passed`
);

if (passed !== tests.length) process.exitCode = 1;
