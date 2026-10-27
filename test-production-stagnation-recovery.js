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
      <head><title>Recovery Test</title></head>
      <body>
        <h1>Recovery Test</h1>

        <button id="a">Option A</button>
        <button id="b">Option B</button>

        <button
          id="c"
          onclick="
            document.getElementById('result').textContent =
              'Recovery successful'
          "
        >
          Option C
        </button>

        <p id="result"></p>
      </body>
    </html>
  `);

  const goal = {
    type: "visible_content",
    text: "Recovery successful"
  };

  const chosen = [];

  const reasoner = async (_task, observation) => {
    for (const label of [
      "Option A",
      "Option B",
      "Option C"
    ]) {
      if (chosen.includes(label)) {
        continue;
      }

      const element = observation.actionableElements.find(
        item => item.label === label
      );

      if (!element) {
        continue;
      }

      chosen.push(label);

      return {
        ref: element.ref,
        operation: "click",
        value: ""
      };
    }

    return {
      operation: "done",
      ref: "",
      value: ""
    };
  };

  const result = await runAgent(
    page,
    "Find Recovery successful by trying available options.",
    goal,
    { reasoner }
  );

  assert.equal(result.status, "verified_complete");
  assert.equal(result.steps, 3);

  assert.deepEqual(chosen, [
    "Option A",
    "Option B",
    "Option C"
  ]);

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

  assert.equal(
    result.history[2].progress.classification,
    "goal_completed"
  );

  assert.equal(
    await page.locator("#result").innerText(),
    "Recovery successful"
  );

  console.log(
    "PRODUCTION STAGNATION RECOVERY: PASSED"
  );

} finally {
  await browser.close();
}
