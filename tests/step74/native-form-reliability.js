import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runAgent } from "../../src/agent/agent.js";
import { observeReliably } from "../../src/observer/reliable-observer.js";
import { createActionApproval } from "../../src/agent/action-approval.js";

const browser = await chromium.launch({ headless: true });

const base = "https://native-form-lab.example";
const expectedValue = "Website CoPilot";

const scenarios = [
  {
    name: "Native form persists successfully",
    delay: 250,
    fail: false,
    expectedStatus: "persisted_complete"
  },
  {
    name: "Delayed native form persists successfully",
    delay: 750,
    fail: false,
    expectedStatus: "persisted_complete"
  },
  {
    name: "Rejected native form does not claim success",
    delay: 100,
    fail: true,
    expectedStatus: "action_outcome_unverified"
  }
];

let passed = 0;
let failed = 0;

const escapeHtml = value => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

try {
  for (const scenario of scenarios) {
    const page = await browser.newPage();

    let stored = "Original Project";
    let submissions = 0;
    let reloads = 0;

    try {
      await page.route(`${base}/**`, async route => {
        const request = route.request();

        console.log(
          "[HTTP TRACE]",
          scenario.name,
          request.method(),
          request.url(),
          "navigation=" + request.isNavigationRequest()
        );

        if (request.method() === "POST") {
          submissions++;

          await new Promise(resolve =>
            setTimeout(resolve, scenario.delay)
          );

          if (scenario.fail) {
            await route.fulfill({
              status: 500,
              contentType: "text/html",
              body: "<h1>Unable to save preferences</h1>"
            });
            return;
          }

          const body = new URLSearchParams(
            request.postData() ?? ""
          );

          stored = body.get("projectName") ?? stored;

          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: `
              <!doctype html>
              <html>
                <head><title>Settings</title></head>
                <body>
                  <h1>Settings</h1>
                  <p>Preferences saved successfully</p>
                  <label for="name">Project Name</label>
                  <input
                    id="name"
                    name="projectName"
                    value="${escapeHtml(stored)}"
                  />
                </body>
              </html>
            `
          });

          return;
        }

        reloads++;

        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `
            <!doctype html>
            <html>
              <head><title>Settings</title></head>
              <body>
                <h1>Settings</h1>

                <form method="post" action="/settings">
                  <label for="name">Project Name</label>

                  <input
                    id="name"
                    name="projectName"
                    value="${escapeHtml(stored)}"
                  />

                  <button
                    type="submit"
                    aria-label="Submit Preferences"
                  >
                    ✓
                  </button>
                </form>
              </body>
            </html>
          `
        });
      });

      await page.goto(`${base}/settings`);

      const initialReloads = reloads;

      const goal = {
        type: "all_of",
        conditions: [
          {
            type: "form_state",
            fieldLabel: "Project Name",
            expectedValue
          },
          {
            type: "visible_content",
            text: "Preferences saved successfully"
          }
        ]
      };

      const instruction =
        "Set Project Name to Website CoPilot and submit preferences. " +
        "Finish only when Preferences saved successfully is visible.";

      const reasoner = async (task, observation) => {
        const elements = observation.actionableElements;

        const input = elements.find(element =>
          /project name/i.test(element.label) &&
          element.currentValue !== expectedValue
        );

        if (input) {
          return {
            ref: input.ref,
            operation: "fill",
            value: expectedValue
          };
        }

        const submit = elements.find(element =>
          element.formContext?.associated === true &&
          element.effectiveType === "submit" &&
          ["button", "input"].includes(element.tag)
        );

        if (submit) {
          return {
            ref: submit.ref,
            operation: "click"
          };
        }

        throw new Error("No appropriate form control found.");
      };

      const result = await runAgent(
        page,
        instruction,
        goal,
        {
          reasoner,
          observer: observeReliably,
          approvalProvider: async context =>
            createActionApproval(context.action, {
              pageUrl: context.pageUrl,
              targetIdentity: context.targetIdentity
            }),
          persistencePolicy: {
            requirePersistence: true,
            allowReload: true,
            workflowCategory: "repeatable_settings"
          }
        }
      );

      assert.equal(
        result.status,
        scenario.expectedStatus,
        `Unexpected status: ${result.status}`
      );

      assert.equal(
        submissions,
        1,
        "Submission must execute exactly once."
      );

      if (!scenario.fail) {
        assert.equal(stored, expectedValue);
        assert.ok(
          reloads > initialReloads,
          "Successful persistence requires a reload."
        );
      } else {
        assert.equal(stored, "Original Project");
      }

      passed++;
      console.log(`PASS: ${scenario.name}`);
      console.log(`STATUS: ${result.status}`);
      console.log(`SUBMISSIONS: ${submissions}`);
      console.log(`RELOADS: ${reloads - initialReloads}`);
    } catch (error) {
      failed++;
      console.error(`FAIL: ${scenario.name}`);
      console.error(error.stack ?? error);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log("\n========== STEP 74K.11A ==========");
console.log(`Passed: ${passed}/${scenarios.length}`);
console.log(`Failed: ${failed}/${scenarios.length}`);

if (failed > 0) {
  process.exitCode = 1;
}
