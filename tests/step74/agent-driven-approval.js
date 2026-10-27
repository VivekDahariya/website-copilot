
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runAgent } from "../../src/agent/agent.js";
import { observeReliably } from "../../src/observer/reliable-observer.js";
import { createActionApproval } from "../../src/agent/action-approval.js";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  async function setup() {
    await page.goto("about:blank");

    await page.setContent(`
      <html>
        <body>
          <h1>Preferences</h1>
          <button
            aria-label="Submit Preferences"
            onclick="
              window.submitted = true;
              document.getElementById('result').textContent =
                'Preferences submitted successfully';
            "
          >Submit Preferences</button>
          <p id="result"></p>
        </body>
      </html>
    `);
  }

  const goal = {
    type: "visible_content",
    text: "Preferences submitted successfully"
  };

  const instruction =
    "Submit Preferences and finish only when Preferences submitted successfully is visible.";

  async function reasoner(task, observation, history, rejectedActions) {
    const button = observation.actionableElements.find(
      element => /submit preferences/i.test(element.label)
    );

    if (!button) {
      throw new Error("Submit button not observed.");
    }

    return {
      ref: button.ref,
      operation: "click"
    };
  }

  async function runWithApproval(consent) {
    let requests = 0;

    const result = await runAgent(
      page,
      instruction,
      goal,
      {
        reasoner,
        observer: observeReliably,
        approvalProvider: async context => {
          requests++;

          assert.equal(context.action.operation, "click");
          assert.ok(context.targetIdentity);
          assert.equal(context.pageUrl, page.url());

          if (!consent) {
            return null;
          }

          // Simulates an explicit user-consent decision.
          // Production must obtain this decision from a trusted UI.
          return createActionApproval(context.action, {
            pageUrl: context.pageUrl,
            targetIdentity: context.targetIdentity
          });
        }
      }
    );

    return { result, requests };
  }

  {
    await setup();

    const { result, requests } = await runWithApproval(false);

    assert.ok(requests >= 1);
    assert.equal(await page.evaluate(() => !!window.submitted), false);
    assert.equal(result.status, "approval_required");

    console.log("PASS: Denied approval prevents submission");
  }

  {
    await setup();

    const { result, requests } = await runWithApproval(true);

    assert.ok(requests >= 1);
    assert.equal(await page.evaluate(() => !!window.submitted), true);

    assert.ok(
      ["verified_complete", "persisted_complete"].includes(result.status),
      `Unexpected agent status: ${result.status}`
    );

    console.log("PASS: Approved action executes through agent");
  }

  {
    await setup();

    const result = await runAgent(
      page,
      instruction,
      goal,
      {
        reasoner,
        observer: observeReliably
      }
    );

    assert.equal(await page.evaluate(() => !!window.submitted), false);
    assert.equal(result.status, "approval_required");

    console.log("PASS: Missing approval provider blocks submission");
  }

  console.log(
    "STEP 74J.6E — AGENT-DRIVEN APPROVAL PASSED"
  );
} finally {
  await browser.close();
}
