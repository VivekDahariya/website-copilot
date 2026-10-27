import assert from "node:assert/strict";

import {
  createStagnationDetector
} from "./src/agent/stagnation-detector.js";

const detector = createStagnationDetector({
  noChangeLimit: 2
});

// Test 1: First ineffective action does not trigger stagnation.
let result = detector.record({
  classification: "no_observed_change"
});

assert.equal(result.consecutiveNoChange, 1);
assert.equal(result.stagnating, false);

// Test 2: Second ineffective action triggers stagnation.
result = detector.record({
  classification: "no_observed_change"
});

assert.equal(result.consecutiveNoChange, 2);
assert.equal(result.stagnating, true);

// Test 3: A changed state resets the counter.
result = detector.record({
  classification: "state_changed_without_verified_goal_progress"
});

assert.equal(result.consecutiveNoChange, 0);
assert.equal(result.stagnating, false);

// Test 4: Verified goal progress resets the counter.
detector.record({
  classification: "no_observed_change"
});

result = detector.record({
  classification: "goal_progress"
});

assert.equal(result.consecutiveNoChange, 0);

// Test 5: Goal completion resets the counter.
detector.record({
  classification: "no_observed_change"
});

result = detector.record({
  classification: "goal_completed"
});

assert.equal(result.consecutiveNoChange, 0);

// Test 6: Unknown observation does not prove stagnation.
detector.record({
  classification: "no_observed_change"
});

result = detector.record({
  classification: "post_action_observation_unavailable"
});

assert.equal(result.consecutiveNoChange, 0);
assert.equal(result.stagnating, false);

// Test 7: Manual reset works.
detector.record({
  classification: "no_observed_change"
});

detector.reset();

assert.equal(
  detector.getStatus().consecutiveNoChange,
  0
);

console.log("STAGNATION DETECTOR: 7/7 PASSED");
