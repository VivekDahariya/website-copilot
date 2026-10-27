import assert from "node:assert/strict";

import {
  assessObservation,
  observeReliably
} from "./src/observer/reliable-observer.js";

const emptyObservation = {
  url: "https://example.com/",
  title: "",
  headings: [],
  actionableElements: [],
  visibleBodyText: ""
};

const readyObservation = {
  url: "https://example.com/",
  title: "Example",
  headings: ["Example"],
  actionableElements: [],
  visibleBodyText: "Example page content"
};

// TEST 1: Empty observation must be rejected.
assert.equal(
  assessObservation(emptyObservation).usable,
  false
);

// TEST 2: A real content page must be accepted.
assert.equal(
  assessObservation(readyObservation).usable,
  true
);

// TEST 3: Recover after two incomplete observations.
let calls = 0;

const recovered = await observeReliably(
  {},
  {
    maxAttempts: 4,
    retryDelayMs: 0,
    observer: async () => {
      calls++;

      return calls < 3
        ? emptyObservation
        : readyObservation;
    }
  }
);

assert.equal(recovered.status, "ready");
assert.equal(recovered.attempts, 3);
assert.equal(calls, 3);

// TEST 4: Never invent success if observations stay empty.
const unavailable = await observeReliably(
  {},
  {
    maxAttempts: 3,
    retryDelayMs: 0,
    observer: async () => emptyObservation
  }
);

assert.equal(
  unavailable.status,
  "observation_unavailable"
);

assert.equal(unavailable.attempts, 3);

// TEST 5: Recover from transient observer errors.
let errorCalls = 0;

const errorRecovery = await observeReliably(
  {},
  {
    maxAttempts: 3,
    retryDelayMs: 0,
    observer: async () => {
      errorCalls++;

      if (errorCalls === 1) {
        throw new Error("Transient navigation error");
      }

      return readyObservation;
    }
  }
);

assert.equal(errorRecovery.status, "ready");
assert.equal(errorRecovery.attempts, 2);

console.log("RELIABLE OBSERVER TESTS: 5/5 PASSED");
