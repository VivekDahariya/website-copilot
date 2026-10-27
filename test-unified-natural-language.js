import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  executeNaturalLanguageTask
} from "./src/agent/natural-language-executor.js";

import {
  observePage
} from "./src/observer/dom-observer.js";

import {
  verifyGoal
} from "./src/agent/goal-verifier.js";

const START_URL = "https://www.wikipedia.org/";
const EXPECTED_URL = "https://en.wikipedia.org/wiki/Alan_Turing";
const EXPECTED_SECTION = "Early life and education";

const instruction =
  `On ${START_URL}, search for Alan Turing, open his article, ` +
  `and verify that it contains the section ${EXPECTED_SECTION}.`;

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  await page.goto(START_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  console.log("\n========== STEP 55 ==========");
  console.log("RAW USER INSTRUCTION:");
  console.log(instruction);

  const result = await executeNaturalLanguageTask(
    page,
    instruction
  );

  console.log("\nFULL INTERPRETATION RESULT:");
  console.dir(result, { depth: 6 });

  console.log("\nINTERPRETED TASK:");
  console.dir(result.interpretedTask, { depth: null });

  assert.equal(
    result.interpretedTask?.type,
    "browser_goal",
    "Interpreter must produce a browser_goal."
  );

  const goal = result.interpretedTask.goal;

  assert.equal(
    goal.type,
    "all_of",
    "Interpreter must generate a composite goal."
  );

  assert.ok(
    Array.isArray(goal.conditions),
    "Composite goal must have conditions."
  );

  const destination = goal.conditions.find(
    condition => condition.type === "page_destination"
  );

  const content = goal.conditions.find(
    condition => condition.type === "visible_content"
  );

  assert.ok(
    destination,
    "Missing page_destination condition."
  );

  assert.ok(
    content,
    "Missing visible_content condition."
  );

  assert.equal(
    destination.hostname,
    "en.wikipedia.org"
  );

  assert.equal(
    destination.heading,
    "Alan Turing"
  );

  assert.equal(
    content.text.trim().toLowerCase(),
    EXPECTED_SECTION.toLowerCase()
  );

  console.log("\nEXECUTION STATUS:", result.status);

  assert.equal(
    result.status,
    "verified_complete",
    "Unified execution did not complete."
  );

  assert.equal(
    result.executed,
    true
  );

  assert.equal(
    page.url(),
    EXPECTED_URL,
    "Browser did not reach the correct article."
  );

  const articleHeading = await page
    .getByRole("heading", {
      name: "Alan Turing",
      exact: true
    })
    .first()
    .isVisible();

  const sectionHeading = await page
    .getByRole("heading", {
      name: EXPECTED_SECTION,
      exact: true
    })
    .first()
    .isVisible();

  assert.equal(articleHeading, true);
  assert.equal(sectionHeading, true);

  const observation = await observePage(page);
  const verification = verifyGoal(observation, goal);

  assert.equal(
    verification.completed,
    true,
    "Independent goal verification failed."
  );

  console.log("\n========== VERIFIED RESULT ==========");
  console.log("Final URL:", page.url());
  console.log("Article heading:", articleHeading);
  console.log("Section heading:", sectionHeading);
  console.log("Independent verification:", verification.completed);
  console.log(
    "Actions:",
    result.execution?.result?.steps
  );

  console.log(
    "\nSTEP 55 — UNIFIED NATURAL-LANGUAGE TEST PASSED"
  );

} finally {
  await browser.close();
}
