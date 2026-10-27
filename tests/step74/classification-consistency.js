import assert from "node:assert/strict";

import {
  classifyFinalizingAction
} from "../../src/agent/finalizing-action-classifier.js";

import {
  isFinalizingAction
} from "../../src/agent/async-action-settlement.js";

import {
  createWorkflowGoalVerifier
} from "../../src/agent/workflow-goal-verifier.js";

const instruction = "Save preferences";

const goal = {
  type: "visible_content",
  text: "Preferences saved successfully"
};

const action = {
  ref: "e2",
  operation: "click"
};

const formContext = {
  associated: true,
  id: "settings",
  fieldCount: 1,
  fields: [
    {
      tag: "input",
      name: "projectName"
    }
  ]
};

const scenarios = [
  {
    name: "Icon-only submit",
    element: {
      ref: "e2",
      tag: "button",
      label: "",
      effectiveType: "submit",
      formContext
    },
    expected: true
  },
  {
    name: "Intermediate preview",
    element: {
      ref: "e2",
      tag: "button",
      label: "Update Preview",
      effectiveType: "submit",
      formContext
    },
    expected: false
  },
  {
    name: "Contextual apply",
    element: {
      ref: "e2",
      tag: "button",
      label: "Apply",
      effectiveType: "button",
      formContext
    },
    expected: true
  },
  {
    name: "Unrelated filter",
    element: {
      ref: "e2",
      tag: "button",
      label: "Apply Filter",
      effectiveType: "button",
      formContext: {
        associated: false,
        fieldCount: 0,
        fields: []
      }
    },
    expected: false
  }
];

let passed = 0;
let failed = 0;

for (const scenario of scenarios) {
  const observation = {
    visibleBodyText: "Settings",
    actionableElements: [
      {
        ref: "e1",
        tag: "input",
        editable: true,
        label: "Project Name",
        currentValue: "Website CoPilot"
      },
      scenario.element
    ]
  };

  try {
    const direct = classifyFinalizingAction({
      action,
      element: scenario.element,
      goal,
      instruction,
      observation
    }).finalizing;

    const settlement = isFinalizingAction(
      action,
      scenario.element,
      goal,
      instruction,
      observation
    );

    assert.equal(direct, scenario.expected);
    assert.equal(settlement, scenario.expected);

    const verifier = createWorkflowGoalVerifier(
      goal,
      instruction
    );

    verifier.verify(observation);

    verifier.recordAction(
      action,
      scenario.element,
      {
        executionCompleted: true
      }
    );

    const verification = verifier.verify({
      ...observation,
      visibleBodyText:
        "Settings Preferences saved successfully"
    });

    assert.equal(
      verification.evidence.finalizingActionObserved,
      scenario.expected
    );

    passed++;
    console.log(`PASS: ${scenario.name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${scenario.name}`);
    console.error(error.message);
  }
}

console.log("\n========== STEP 74K.10F ==========");
console.log(`Passed: ${passed}/${scenarios.length}`);
console.log(`Failed: ${failed}/${scenarios.length}`);

if (failed > 0) {
  process.exitCode = 1;
}
