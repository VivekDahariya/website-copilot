import assert from "node:assert/strict";

import {
  interpretTask
} from "./src/agent/task-interpreter.js";

function mockResponse(task) {
  return async () => ({
    ok: true,
    json: async () => ({
      response: JSON.stringify(task)
    })
  });
}

async function interpret(instruction, task) {
  return interpretTask(instruction, {
    fetchImpl: mockResponse(task)
  });
}

const result = await interpret(
  "Open https://example.com/ and find the Security Guide.",
  {
    type: "browser_goal",
    startUrl: "https://example.com/",
    instruction: "Find the Security Guide",
    goal: {
      type: "page_destination",
      hostname: "example.com",
      pathname: "/help/security-guide",
      heading: "Security Guide"
    }
  }
);

assert.equal(result.status, "interpreted");
assert.equal(
  result.task.goal.pathname,
  undefined,
  "Invented pathname was not removed."
);
assert.equal(
  result.task.goal.heading,
  "Security Guide"
);

console.log("PASSED: Invented pathname removed");

const explicit = await interpret(
  "Open https://example.com/help/security.",
  {
    type: "browser_goal",
    startUrl: "https://example.com/help/security",
    instruction: "Open the security page",
    goal: {
      type: "page_destination",
      hostname: "example.com",
      pathname: "/help/security"
    }
  }
);

assert.equal(explicit.status, "interpreted");
assert.equal(
  explicit.task.goal.pathname,
  "/help/security"
);

console.log("PASSED: Explicit pathname preserved");

const composite = await interpret(
  "Open https://example.com/ and find the Security Guide.",
  {
    type: "browser_goal",
    startUrl: "https://example.com/",
    instruction: "Find Security Guide",
    goal: {
      type: "all_of",
      conditions: [
        {
          type: "page_destination",
          hostname: "example.com",
          pathname: "/invented",
          heading: "Security Guide"
        },
        {
          type: "visible_content",
          text: "two-factor authentication"
        }
      ]
    }
  }
);

assert.equal(composite.status, "interpreted");
assert.equal(
  composite.task.goal.conditions[0].pathname,
  undefined
);

console.log("PASSED: Composite destination grounded");

console.log(
  "\nSTEP 56A.3 — DESTINATION GROUNDING: 3/3 PASSED"
);
