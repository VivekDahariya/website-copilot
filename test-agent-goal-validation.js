import assert from "node:assert/strict";
import { runAgent } from "./src/agent/agent.js";

console.log("\\n========== STEP 64 ==========");

let observationCalls = 0;
let reasonerCalls = 0;

const page = {
  url() {
    return "https://validation.example/";
  }
};

const observer = async () => {
  observationCalls++;
  throw new Error("Observer must not run for invalid goals.");
};

const reasoner = async () => {
  reasonerCalls++;
  throw new Error("Reasoner must not run for invalid goals.");
};

const invalidGoals = [
  {
    name: "Unsupported destination field",
    goal: {
      type: "page_destination",
      expectedUrl: "https://validation.example/profile"
    },
    reason: /Unexpected field/
  },
  {
    name: "Missing destination constraint",
    goal: {
      type: "page_destination"
    },
    reason: /destination constraint/
  },
  {
    name: "Missing form label",
    goal: {
      type: "form_state",
      expectedValue: "Enabled"
    },
    reason: /fieldLabel/
  },
  {
    name: "Unsupported goal type",
    goal: {
      type: "unknown_operation"
    },
    reason: /Unsupported goal type/
  },
  {
    name: "Empty composite goal",
    goal: {
      type: "all_of",
      conditions: []
    },
    reason: /conditions/
  },
  {
    name: "Invalid nested condition",
    goal: {
      type: "all_of",
      conditions: [
        {
          type: "visible_content",
          text: "Ready"
        },
        {
          type: "page_destination",
          expectedUrl: "https://validation.example/profile"
        }
      ]
    },
    reason: /Unexpected field/
  }
];

for (const test of invalidGoals) {
  const result = await runAgent(
    page,
    "Attempt an invalid task",
    test.goal,
    { observer, reasoner }
  );

  assert.equal(result.status, "invalid_goal", test.name);
  assert.equal(result.steps, 0, test.name);
  assert.match(result.reason, test.reason, test.name);
  assert.deepEqual(result.history, [], test.name);

  console.log("PASSED:", test.name);
}

assert.equal(observationCalls, 0);
assert.equal(reasonerCalls, 0);

console.log("Observer calls:", observationCalls);
console.log("Reasoner calls:", reasonerCalls);

console.log(
  "\\nSTEP 64 — AGENT GOAL VALIDATION: 6/6 PASSED"
);
