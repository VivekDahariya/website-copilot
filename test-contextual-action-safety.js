import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  classifyBrowserAction
} from "./src/agent/action-safety-policy.js";

import {
  executeAction
} from "./src/executor/action-executor.js";

console.log("\n========== STEP 66 ==========");

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  let mutations = 0;

  await page.setContent(`
    <form id="payment-checkout" aria-label="Payment">
      <button
        id="continue"
        type="button"
        onclick="window.mutations++"
      >Continue</button>
    </form>

    <form id="ordinary-preferences">
      <label>
        <input id="notifications" type="checkbox" checked>
        Email Notifications
      </label>
    </form>
  `);

  await page.evaluate(() => {
    window.mutations = 0;
  });

  const cases = [
    {
      name: "Ambiguous button in sensitive form",
      action: { ref: "e1", operation: "click", value: "" },
      element: {
        tag: "button",
        type: "button",
        label: "Continue",
        sensitiveFormContext: true
      },
      expected: "requires_approval"
    },
    {
      name: "Ordinary button",
      action: { ref: "e1", operation: "click", value: "" },
      element: {
        tag: "button",
        type: "button",
        label: "Continue",
        sensitiveFormContext: false
      },
      expected: "safe"
    },
    {
      name: "Sensitive form checkbox",
      action: { ref: "e1", operation: "uncheck", value: "" },
      element: {
        tag: "input",
        type: "checkbox",
        label: "Enable Transfer",
        sensitiveFormContext: true
      },
      expected: "requires_approval"
    },
    {
      name: "Ordinary notification checkbox",
      action: { ref: "e1", operation: "uncheck", value: "" },
      element: {
        tag: "input",
        type: "checkbox",
        label: "Email Notifications",
        sensitiveFormContext: false
      },
      expected: "safe"
    }
  ];

  for (const item of cases) {
    assert.equal(
      classifyBrowserAction(
        item.action,
        item.element
      ).classification,
      item.expected,
      item.name
    );

    console.log("PASSED:", item.name);
  }

  // Use the production DOM observer to obtain a real element reference.
  const { observePage } = await import(
    "./src/observer/dom-observer.js"
  );

  const observation = await observePage(page);

  const target = observation.actionableElements.find(
    element => /Continue/i.test(element.label || element.text || "")
  );

  assert.ok(
    target,
    "Production observer must discover the Continue button"
  );

  let caughtError = null;

  try {
    await executeAction(page, {
      ref: target.ref,
      operation: "click",
      value: ""
    });
  } catch (error) {
    caughtError = error;
  }

  mutations = await page.evaluate(() => window.mutations);

  console.log("Executor error:", caughtError?.message ?? "NONE");
  console.log("Side effects:", mutations);

  assert.equal(
    mutations,
    0,
    "Sensitive button must never execute"
  );

  assert.ok(
    caughtError,
    "Executor must reject the sensitive action"
  );

  assert.match(
    caughtError.message,
    /SAFETY_/,
    "Executor must reject for a safety reason"
  );

  console.log("PASSED: Executor blocked sensitive button");

  console.log("\nSTEP 66 — CONTEXTUAL SAFETY: 5/5 PASSED");
} finally {
  await browser.close();
}
