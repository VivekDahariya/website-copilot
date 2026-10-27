import assert from "node:assert/strict";

import {
  validateGoalSchema
} from "./src/agent/goal-schema-validator.js";

import {
  runAgent
} from "./src/agent/agent.js";

console.log("\n========== STEP 65 ==========");

const form = (fieldLabel, expectedValue) => ({
  type: "form_state",
  fieldLabel,
  expectedValue
});

const allOf = (...conditions) => ({
  type: "all_of",
  conditions
});

const contradictoryGoals = [
  {
    name: "Opposite checkbox states",
    goal: allOf(
      form("Email Notifications", true),
      form("Email Notifications", false)
    )
  },
  {
    name: "Different text values",
    goal: allOf(
      form("Full Name", "Alice"),
      form("Full Name", "Bob")
    )
  },
  {
    name: "Case-insensitive field identity",
    goal: allOf(
      form("Email Notifications", true),
      form("email notifications", false)
    )
  },
  {
    name: "Nested contradiction",
    goal: allOf(
      form("Email Notifications", true),
      allOf(
        {
          type: "visible_content",
          text: "Settings"
        },
        form("Email Notifications", false)
      )
    )
  }
];

for (const test of contradictoryGoals) {
  assert.throws(
    () => validateGoalSchema(test.goal),
    /Contradictory form_state/,
    test.name
  );

  console.log("PASSED:", test.name);
}

const validGoals = [
  {
    name: "Different fields",
    goal: allOf(
      form("Email Notifications", false),
      form("SMS Notifications", true)
    )
  },
  {
    name: "Identical repeated state",
    goal: allOf(
      form("Email Notifications", false),
      form("Email Notifications", false)
    )
  },
  {
    name: "Mixed destination and form",
    goal: allOf(
      {
        type: "page_destination",
        hostname: "example.com",
        pathname: "/settings"
      },
      form("Email Notifications", false),
      {
        type: "visible_content",
        text: "Notifications disabled"
      }
    )
  }
];

for (const test of validGoals) {
  const validated = validateGoalSchema(test.goal);

  assert.equal(validated.type, "all_of");

  console.log("PASSED:", test.name);
}

let observationCalls = 0;
let reasonerCalls = 0;

const page = {
  url() {
    return "https://validation.example/";
  }
};

const result = await runAgent(
  page,
  "Set contradictory notification preferences",
  contradictoryGoals[0].goal,
  {
    observer: async () => {
      observationCalls++;
      throw new Error("Observer must not run.");
    },
    reasoner: async () => {
      reasonerCalls++;
      throw new Error("Reasoner must not run.");
    }
  }
);

assert.equal(result.status, "invalid_goal");
assert.equal(result.steps, 0);
assert.match(result.reason, /Contradictory form_state/);
assert.equal(observationCalls, 0);
assert.equal(reasonerCalls, 0);

console.log("PASSED: Production agent rejects contradiction");
console.log("Observer calls:", observationCalls);
console.log("Reasoner calls:", reasonerCalls);

console.log("\nSTEP 65 — GOAL CONSISTENCY: 8/8 PASSED");
