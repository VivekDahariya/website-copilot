import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runAgent } from "./src/agent/agent.js";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  await page.setContent(`
    <html>
      <head>
        <title>Profile Editor</title>
      </head>

      <body>
        <h1>Profile Editor</h1>

        <label for="name">Full Name</label>
        <input id="name" type="text">
      </body>
    </html>
  `);

  const goal = {
    type: "form_state",
    fieldLabel: "Full Name",
    expectedValue: "Vivek"
  };

  const reasoner = async (_task, observation) => {
    const input = observation.actionableElements.find(
      element => element.label === "Full Name"
    );

    assert.ok(input);

    return {
      ref: input.ref,
      operation: "fill",
      value: "Vivek"
    };
  };

  const result = await runAgent(
    page,
    "Fill the Full Name field with Vivek.",
    goal,
    { reasoner }
  );

  assert.equal(result.status, "verified_complete");

  assert.equal(result.steps, 1);

  assert.equal(result.history.length, 1);

  assert.equal(
    result.history[0].progress.classification,
    "goal_completed"
  );

  assert.equal(
    result.history[0].progress.goalCompleted,
    true
  );

  assert.equal(
    await page.locator("#name").inputValue(),
    "Vivek"
  );

  console.log(
    "PRODUCTION GOAL PROGRESS: PASSED"
  );

} finally {
  await browser.close();
}
