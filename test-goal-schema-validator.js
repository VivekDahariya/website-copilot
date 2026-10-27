import assert from "node:assert/strict";

import {
  validateGoalSchema
} from "./src/agent/goal-schema-validator.js";

function rejects(goal, pattern) {
  assert.throws(
    () => validateGoalSchema(goal),
    pattern
  );
}

console.log("\nTEST 1 — Valid form goal");

const form = validateGoalSchema({
  type: "form_state",
  fieldLabel: "Full Name",
  expectedValue: "Vivek"
});

assert.equal(form.expectedValue, "Vivek");
console.log("PASSED");

console.log("\nTEST 2 — Valid composite goal");

const composite = validateGoalSchema({
  type: "all_of",
  conditions: [
    {
      type: "page_destination",
      hostname: "example.com",
      pathname: "/profile"
    },
    {
      type: "visible_content",
      text: "Profile"
    }
  ]
});

assert.equal(composite.conditions.length, 2);
console.log("PASSED");

console.log("\nTEST 3 — Missing form field");

rejects(
  {
    type: "form_state",
    expectedValue: "Vivek"
  },
  /fieldLabel/
);

console.log("PASSED");

console.log("\nTEST 4 — Empty composite");

rejects(
  {
    type: "all_of",
    conditions: []
  },
  /1–20/
);

console.log("PASSED");

console.log("\nTEST 5 — Unknown field");

rejects(
  {
    type: "visible_content",
    text: "Hello",
    forceSuccess: true
  },
  /Unexpected field/
);

console.log("PASSED");

console.log("\nTEST 6 — Unsupported goal");

rejects(
  {
    type: "delete_everything"
  },
  /Unsupported goal type/
);

console.log("PASSED");

console.log("\nTEST 7 — Excessive nesting");

let nested = {
  type: "visible_content",
  text: "Hello"
};

for (let i = 0; i < 7; i++) {
  nested = {
    type: "all_of",
    conditions: [nested]
  };
}

rejects(nested, /nesting depth/);
console.log("PASSED");

console.log("\nTEST 8 — Contradictory pathname constraints");

rejects(
  {
    type: "page_destination",
    pathname: "/profile",
    pathnamePattern: "^/other"
  },
  /pathname or pathnamePattern/
);

console.log("PASSED");

console.log("\nGOAL SCHEMA VALIDATOR: 8/8 PASSED");
