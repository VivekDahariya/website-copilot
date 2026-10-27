import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  observePage
} from "./src/observer/dom-observer.js";

import {
  createPageState
} from "./src/agent/page-state.js";

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
      </body>
    </html>
  `);

  const before = await observePage(page);
  const beforeState = createPageState(before);

  await page.locator("#name").fill("Vivek");

  const afterFill = await observePage(page);
  const afterFillState = createPageState(afterFill);

  assert.notEqual(
    beforeState.fingerprint,
    afterFillState.fingerprint,
    "Filling the form must change page state."
  );

  await page.locator("#status").evaluate(element => {
    element.textContent = "Profile saved";
  });

  const afterSave = await observePage(page);
  const afterSaveState = createPageState(afterSave);

  assert.notEqual(
    afterFillState.fingerprint,
    afterSaveState.fingerprint,
    "Changing visible status must change page state."
  );

  assert.equal(
    afterSaveState.fingerprint,
    createPageState(await observePage(page)).fingerprint,
    "Unchanged page must produce a stable fingerprint."
  );

  console.log(
    "BROWSER PAGE STATE TESTS: 3/3 PASSED"
  );

} finally {
  await browser.close();
}
