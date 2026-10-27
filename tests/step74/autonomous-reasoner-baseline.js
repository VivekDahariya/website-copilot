import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { decideNextAction } from "../../src/agent/local-reasoner.js";

const cases = [
  {
    name: "Identify correct text field",
    task: "Enter Atlas Research in the workspace name field.",
    observation: {
      url: "http://localhost/settings",
      title: "Workspace Settings",
      headings: ["Workspace Settings"],
      actionableElements: [
        {
          ref: "e1",
          tag: "input",
          type: "text",
          label: "Contact Email",
          editable: true,
          currentValue: "",
          checked: false
        },
        {
          ref: "e2",
          tag: "input",
          type: "text",
          label: "Workspace Name",
          editable: true,
          currentValue: "",
          checked: false
        },
        {
          ref: "e3",
          tag: "button",
          type: "button",
          label: "Save Settings",
          editable: false
        }
      ]
    },
    expected: {
      ref: "e2",
      operation: "fill",
      value: "Atlas Research"
    }
  },
  {
    name: "Select production environment",
    task: "Set the deployment environment to production.",
    observation: {
      url: "http://localhost/settings",
      title: "Deployment Settings",
      headings: ["Deployment"],
      actionableElements: [
        {
          ref: "e1",
          tag: "select",
          type: "select-one",
          label: "Deployment Environment",
          editable: false,
          currentValue: "development"
        },
        {
          ref: "e2",
          tag: "button",
          type: "button",
          label: "Delete Workspace",
          editable: false
        }
      ]
    },
    expected: {
      ref: "e1",
      operation: "select",
      value: "production"
    }
  },
  {
    name: "Enable notifications",
    task: "Enable email notifications.",
    observation: {
      url: "http://localhost/preferences",
      title: "Preferences",
      headings: ["Preferences"],
      actionableElements: [
        {
          ref: "e1",
          tag: "input",
          type: "checkbox",
          label: "Email Notifications",
          editable: false,
          checked: false
        },
        {
          ref: "e2",
          tag: "input",
          type: "checkbox",
          label: "Marketing Emails",
          editable: false,
          checked: false
        }
      ]
    },
    expected: {
      ref: "e1",
      operation: "check"
    }
  }
];

let passed = 0;

for (const testCase of cases) {
  console.log(`\n========== ${testCase.name} ==========`);

  const started = performance.now();

  try {
    const decision = await decideNextAction(
      testCase.task,
      testCase.observation,
      [],
      []
    );

    const durationMs = Math.round(performance.now() - started);

    console.log("AI DECISION:", decision);
    console.log("DURATION:", durationMs, "ms");

    assert.equal(decision.ref, testCase.expected.ref);
    assert.equal(decision.operation, testCase.expected.operation);

    if (testCase.expected.value !== undefined) {
      assert.equal(decision.value, testCase.expected.value);
    }

    passed++;
    console.log("PASS");
  } catch (error) {
    console.error("FAIL");
    console.error(error.message);
  }
}

console.log("\n========== STEP 74K.12B ==========");
console.log(`Passed: ${passed}/${cases.length}`);
console.log(`Failed: ${cases.length - passed}/${cases.length}`);

if (passed !== cases.length) {
  process.exitCode = 1;
}
