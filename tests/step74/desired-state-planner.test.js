import assert from "node:assert/strict";
import { reconcileDesiredState } from
  "../../src/agent/desired-state-planner.js";

const requirements = [
  {
    label: "Workspace Name",
    kind: "text",
    value: "LAB-Atlas Research"
  },
  {
    label: "Deployment Environment",
    kind: "select",
    value: "production"
  },
  {
    label: "Email Notifications",
    kind: "checkbox",
    value: true
  }
];

function observe(name, environment, notifications) {
  return {
    actionableElements: [
      {
        ref: "e1",
        label: "Workspace Name",
        tag: "input",
        type: "text",
        editable: true,
        currentValue: name
      },
      {
        ref: "e2",
        label: "Deployment Environment",
        tag: "select",
        type: "select-one",
        currentValue: environment
      },
      {
        ref: "e3",
        label: "Email Notifications",
        tag: "input",
        type: "checkbox",
        checked: notifications
      }
    ]
  };
}

// Test 1: all requirements unfinished.
{
  const result = reconcileDesiredState(
    requirements,
    observe("", "staging", false)
  );

  assert.equal(result.pending.length, 3);
  assert.equal(result.allSatisfied, false);
}

// Test 2: validation correction already completed.
{
  const result = reconcileDesiredState(
    requirements,
    observe("LAB-Atlas Research", "staging", true)
  );

  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].ref, "e2");
  assert.equal(result.pending[0].operation, "select");
  assert.equal(result.pending[0].value, "production");
}

// Test 3: all fields satisfied.
{
  const result = reconcileDesiredState(
    requirements,
    observe("LAB-Atlas Research", "production", true)
  );

  assert.equal(result.pending.length, 0);
  assert.equal(result.satisfied.length, 3);
  assert.equal(result.allSatisfied, true);
}

// Test 4: missing field must not be guessed.
{
  const observation = observe(
    "LAB-Atlas Research",
    "production",
    true
  );

  observation.actionableElements =
    observation.actionableElements.filter(
      element => element.ref !== "e2"
    );

  const result = reconcileDesiredState(
    requirements,
    observation
  );

  assert.equal(result.unresolved.length, 1);
  assert.equal(result.allSatisfied, false);
}

// Test 5: ambiguous labels must not be guessed.
{
  const observation = observe(
    "LAB-Atlas Research",
    "production",
    true
  );

  observation.actionableElements.push({
    ref: "e4",
    label: "Workspace Name",
    tag: "input",
    type: "text",
    editable: true,
    currentValue: ""
  });

  const result = reconcileDesiredState(
    requirements,
    observation
  );

  assert.equal(result.unresolved.length, 1);
  assert.equal(result.allSatisfied, false);
}

// Test 6: incorrect checkbox state.
{
  const result = reconcileDesiredState(
    requirements,
    observe("LAB-Atlas Research", "production", false)
  );

  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].operation, "check");
}

console.log("PASS: Desired-state planner (6/6)");
