import assert from "node:assert/strict";
import { chromium } from "playwright";

import { observePage } from "./src/observer/dom-observer.js";
import {
  evaluateGoalProgress
} from "./src/agent/goal-progress.js";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  await page.setContent(`
    <html>
      <head><title>Profile</title></head>
      <body>
        <h1>Profile</h1>

        <label for="name">Full Name</label>
        <input id="name" type="text">

        <button id="save">Save</button>
        <p id="status">Not saved</p>

        <script>
          document.querySelector("#save")
            .addEventListener("click", () => {
              document.querySelector("#status")
                .textContent = "Profile saved";
            });
        </script>
      </body>
    </html>
  `);

  const goal = {
    type: "all_of",
    conditions: [
      {
        type: "form_state",
        fieldLabel: "Full Name",
        expectedValue: "Vivek"
      },
      {
        type: "visible_content",
        text: "Profile saved"
      }
    ]
  };

  const before = await observePage(page);

  await page.locator("#name").fill("Vivek");

  const afterFill = await observePage(page);

  const fillProgress = evaluateGoalProgress(
    before,
    afterFill,
    goal
  );

  assert.equal(
    fillProgress.classification,
    "goal_progress"
  );

  assert.equal(fillProgress.completedAfter, 1);

  await page.locator("#save").click();

  const afterSave = await observePage(page);

  const saveProgress = evaluateGoalProgress(
    afterFill,
    afterSave,
    goal
  );

  assert.equal(
    saveProgress.classification,
    "goal_completed"
  );

  assert.equal(saveProgress.goalCompleted, true);

  console.log(
    "BROWSER GOAL PROGRESS: 3/3 PASSED"
  );

} finally {
  await browser.close();
}
