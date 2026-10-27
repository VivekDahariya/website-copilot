
import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  observePage
} from "../../src/observer/dom-observer.js";

import {
  inspectLiveTarget,
  buildTargetIdentity
} from "../../src/agent/live-target-identity.js";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  await page.goto("about:blank");

  await page.setContent(`
    <html>
      <body>
        <button aria-label="Submit Preferences">
          Submit
        </button>
      </body>
    </html>
  `);

  const observation = await observePage(page);

  const element = observation.actionableElements.find(
    item => item.label.includes("Submit")
  );

  assert.ok(element, "Submit button not observed.");

  const action = {
    ref: element.ref,
    operation: "click",
    value: ""
  };

  const inspected = await inspectLiveTarget(page, action);

  assert.equal(
    inspected.targetIdentity,
    buildTargetIdentity(inspected.live)
  );

  assert.ok(
    inspected.targetIdentity.includes("Submit Preferences")
  );

  console.log("PASS: Live DOM identity resolved");

  await page.evaluate(() => {
    document.querySelector("button").setAttribute(
      "aria-label",
      "Delete Preferences"
    );
  });

  const changed = await inspectLiveTarget(page, action);

  assert.notEqual(
    inspected.targetIdentity,
    changed.targetIdentity
  );

  console.log("PASS: Changed target identity detected");

  await page.evaluate(() => {
    document.querySelector("button").remove();
  });

  await assert.rejects(
    inspectLiveTarget(page, action),
    /detached|stale|re-observation/i
  );

  console.log("PASS: Detached target rejected");

  console.log(
    "STEP 74J.6C — LIVE TARGET IDENTITY PASSED"
  );
} finally {
  await browser.close();
}
