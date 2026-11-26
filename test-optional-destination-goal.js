import assert from "node:assert/strict";

import {
  verifyGoal
} from "./src/agent/goal-verifier.js";

import {
  validateGoalSchema
} from "./src/agent/goal-schema-validator.js";

const observation = {
  url: "https://example.com/help/security",
  title: "Security Guide - Help Center",
  headings: ["Security Guide"],
  visibleBodyText:
    "Enable two-factor authentication to protect your account.",
  actionableElements: []
};

function check(name, goal, expected) {
  const validated = validateGoalSchema(goal);
  const result = verifyGoal(observation, validated);

  assert.equal(
    result.completed,
    expected,
    `${name}: ${JSON.stringify(result)}`
  );

  console.log("PASSED:", name);
}

check(
  "Hostname + pathname without heading",
  {
    type: "page_destination",
    hostname: "example.com",
    pathname: "/help/security"
  },
  true
);

check(
  "Heading only",
  {
    type: "page_destination",
    heading: "Security Guide"
  },
  true
);

check(
  "Text only",
  {
    type: "page_destination",
    text: "two-factor authentication"
  },
  true
);

check(
  "All specified constraints",
  {
    type: "page_destination",
    hostname: "example.com",
    pathname: "/help/security",
    heading: "Security Guide",
    text: "two-factor authentication"
  },
  true
);

check(
  "Wrong pathname must fail",
  {
    type: "page_destination",
    hostname: "example.com",
    pathname: "/help/account"
  },
  false
);

check(
  "Wrong heading must fail",
  {
    type: "page_destination",
    hostname: "example.com",
    heading: "Account Help"
  },
  false
);

check(
  "Wrong content must fail",
  {
    type: "page_destination",
    hostname: "example.com",
    text: "Password reset completed"
  },
  false
);

check(
  "Regex pathname",
  {
    type: "page_destination",
    hostname: "example.com",
    pathnamePattern: "^/help/.*$"
  },
  true
);

check(
  "Composite destination + content",
  {
    type: "all_of",
    conditions: [
      {
        type: "page_destination",
        hostname: "example.com",
        pathname: "/help/security"
      },
      {
        type: "visible_content",
        text: "two-factor authentication"
      }
    ]
  },
  true
);

// A heading alone is not enough when neither the title nor the path
// corroborates it.
assert.equal(
  verifyGoal(
    { ...observation, title: "Welcome - Example" },
    validateGoalSchema({
      type: "page_destination",
      heading: "Security Guide"
    })
  ).completed,
  false
);

console.log("PASSED: Heading without title or path corroboration fails");

assert.equal(
  verifyGoal(observation, {
    type: "page_destination"
  }).completed,
  false
);

console.log("PASSED: Empty destination rejected");

console.log(
  "\\nSTEP 56A — OPTIONAL DESTINATION GOALS: 10/10 PASSED"
);
