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
      <head><title>Stagnation Test</title></head>
      <body>
        <h1>Stagnation Test</h1>
        <button id="a">Do Nothing A</button>
        <button id="b">Do Nothing B</button>
      </body>
    </html>
  `);

  const goal = {
    type: "visible_content",
    text: "This text does not exist"
  };

  let calls = 0;

  const reasoner = async (_task, observation) => {
    calls += 1;

    const label =
      calls === 1
        ? "Do Nothing A"
        : "Do Nothing B";

    const button = observation.actionableElements.find(
      element => element.label === label
    );

    assert.ok(button, `Missing button: ${label}`);

    return {
      ref: button.ref,
      operation: "click",
      value: ""
    };
  };

  const result = await runAgent(
    page,
    "Find the missing text by interacting with this page.",
    goal,
    { reasoner }
  );

  assert.equal(result.status, "stagnation_detected");
  assert.equal(result.steps, 2);
  assert.equal(result.history.length, 2);

  assert.equal(
    result.history[0].progress.classification,
    "no_observed_change"
  );

  assert.equal(
    result.history[1].progress.classification,
    "no_observed_change"
  );

  assert.equal(
    result.history[1].stagnation.stagnating,
    true
  );

  console.log("PRODUCTION STAGNATION: PASSED");

} finally {
  await browser.close();
}
