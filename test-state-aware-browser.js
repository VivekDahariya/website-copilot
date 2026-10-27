import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  observePage
} from "./src/observer/dom-observer.js";

import {
  createProgressGuard
} from "./src/agent/progress-guard.js";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  await page.setContent(`
    <html>
      <body>
        <h1>Profile</h1>
        <label for="name">Full Name</label>
        <input id="name" type="text">
      </body>
    </html>
  `);

  const guard = createProgressGuard(page.url());

  const before = await observePage(page);

  const inputBefore = before.actionableElements.find(
    element => element.label === "Full Name"
  );

  assert.ok(inputBefore);

  const decision = {
    ref: inputBefore.ref,
    operation: "fill",
    value: "Vivek"
  };

  assert.equal(
    guard.check(before, inputBefore, decision).allowed,
    true
  );

  guard.recordAttempt(before, inputBefore, decision);

  assert.equal(
    guard.check(before, inputBefore, decision).reason,
    "repeated_action_same_state"
  );

  await page.locator("#name").fill("Vivek");

  const after = await observePage(page);

  const inputAfter = after.actionableElements.find(
    element => element.label === "Full Name"
  );

  assert.equal(
    guard.check(after, inputAfter, decision).allowed,
    true
  );

  console.log(
    "STATE-AWARE BROWSER REGRESSION: PASSED"
  );

} finally {
  await browser.close();
}
