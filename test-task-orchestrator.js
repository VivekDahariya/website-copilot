import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  executeTask
} from "./src/agent/task-orchestrator.js";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  console.log(
    "\nTEST 1 — General browser goal"
  );

  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <title>Profile Editor</title>
      </head>
      <body>
        <main>
          <h1>Profile Editor</h1>
          <label for="name">Full Name</label>
          <input id="name" type="text">
        </main>
      </body>
    </html>
  `);

  const formResult = await executeTask(
    page,
    {
      type: "browser_goal",
      instruction:
        "Fill the Full Name field with Vivek.",
      goal: {
        type: "form_state",
        fieldLabel: "Full Name",
        expectedValue: "Vivek"
      }
    }
  );

  assert.equal(
    formResult.status,
    "verified_complete"
  );

  assert.equal(
    await page.locator("#name").inputValue(),
    "Vivek"
  );

  console.log("TEST 1: PASSED");

  console.log(
    "\nTEST 2 — Product comparison"
  );

  const comparisonResult = await executeTask(
    page,
    {
      type: "product_comparison",
      startUrl: "https://books.toscrape.com/",
      category: "Travel",
      limit: 3
    }
  );

  assert.equal(
    comparisonResult.status,
    "verified_complete"
  );

  assert.equal(
    comparisonResult.result.collected,
    3
  );

  assert.equal(
    comparisonResult.result.cheapest.title,
    "It's Only the Himalayas"
  );

  console.log("TEST 2: PASSED");

  console.log(
    "\nTEST 3 — Reject unsupported tasks"
  );

  await assert.rejects(
    () => executeTask(
      page,
      { type: "unknown_workflow" }
    ),
    /Unsupported task type/
  );

  console.log("TEST 3: PASSED");

  console.log(
    "\nTASK ORCHESTRATOR: 3/3 PASSED"
  );

} finally {
  await browser.close();
}
