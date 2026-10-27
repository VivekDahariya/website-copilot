
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { observePage } from "../../src/observer/dom-observer.js";
import { inspectLiveTarget } from "../../src/agent/live-target-identity.js";
import { createActionApproval } from "../../src/agent/action-approval.js";
import { executeAction } from "../../src/executor/action-executor.js";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  async function setup() {
    await page.goto("about:blank");

    await page.setContent(`
      <button aria-label="Submit Preferences"
        onclick="window.executions=(window.executions||0)+1">
        Submit
      </button>
    `);

    const observation = await observePage(page);

    const element = observation.actionableElements.find(
      item => item.label.includes("Submit")
    );

    assert.ok(element);

    return {
      ref: element.ref,
      operation: "click"
    };
  }

  async function approve(action) {
    const target = await inspectLiveTarget(page, action);

    return createActionApproval(action, {
      pageUrl: target.pageUrl,
      targetIdentity: target.targetIdentity
    });
  }

  {
    const action = await setup();
    const approval = await approve(action);

    await executeAction(page, action, { approval });

    assert.equal(await page.evaluate(() => window.executions), 1);
    console.log("PASS: Valid live approval executes");
  }

  {
    const action = await setup();

    await assert.rejects(
      executeAction(page, action, {
        approval: {
          granted: true,
          actionRef: action.ref,
          operation: action.operation
        }
      }),
      /SAFETY_/
    );

    console.log("PASS: Forged approval rejected");
  }

  {
    const action = await setup();
    const approval = await approve(action);

    await page.evaluate(() => {
      document.querySelector("button").setAttribute(
        "aria-label",
        "Delete Preferences"
      );
    });

    await assert.rejects(
      executeAction(page, action, { approval }),
      /SAFETY_/
    );

    console.log("PASS: Changed target rejected");
  }

  {
    const action = await setup();
    const approval = await approve(action);

    await executeAction(page, action, { approval });

    await assert.rejects(
      executeAction(page, action, { approval }),
      /SAFETY_/
    );

    console.log("PASS: Reused approval rejected");
  }

  {
    const action = await setup();

    await assert.rejects(
      executeAction(page, action),
      /SAFETY_/
    );

    console.log("PASS: Missing approval rejected");
  }

  console.log("STEP 74J.6D — LIVE APPROVAL INTEGRATION PASSED");
} finally {
  await browser.close();
}
