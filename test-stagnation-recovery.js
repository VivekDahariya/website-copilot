import assert from "node:assert/strict";

import {
  createStagnationRecovery
} from "./src/agent/stagnation-recovery.js";

const recovery = createStagnationRecovery({
  maxRecoveries: 2
});

const observation = {
  url: "https://example.test/",
  headings: ["Example"],
  visibleBodyText: "Example page",
  actionableElements: [
    { ref: "e1", tag: "button", label: "A" },
    { ref: "e2", tag: "button", label: "B" }
  ]
};

const elementA = observation.actionableElements[0];
const elementB = observation.actionableElements[1];

const actionA = {
  ref: "e1",
  operation: "click",
  value: ""
};

const actionB = {
  ref: "e2",
  operation: "click",
  value: ""
};

// Test 1: Initially, neither action is ineffective.
assert.equal(
  recovery.isIneffective(observation, elementA, actionA),
  false
);

// Test 2: Remember an ineffective action.
recovery.remember(observation, elementA, actionA);

assert.equal(
  recovery.isIneffective(observation, elementA, actionA),
  true
);

// Test 3: A different action remains available.
assert.equal(
  recovery.isIneffective(observation, elementB, actionB),
  false
);

// Test 4: State-specific exclusion.
const changedObservation = {
  ...observation,
  visibleBodyText: "Updated example page"
};

assert.equal(
  recovery.isIneffective(changedObservation, elementA, actionA),
  false
);

// Test 5: First recovery permitted.
assert.equal(recovery.recover().allowed, true);

// Test 6: Second recovery permitted.
assert.equal(recovery.recover().allowed, true);

// Test 7: Third recovery rejected.
const exhausted = recovery.recover();

assert.equal(exhausted.allowed, false);
assert.equal(exhausted.reason, "recovery_budget_exhausted");

console.log("STAGNATION RECOVERY: 7/7 PASSED");
