import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runAgent } from "../../src/agent/agent.js";
import { observeReliably } from "../../src/observer/reliable-observer.js";
import { createActionApproval } from "../../src/agent/action-approval.js";

const browser = await chromium.launch({ headless: true });

const origin = "https://post-redirect-lab.example";
const expectedValue = "Website CoPilot";

const scenarios = [
  {
    name: "303 redirect after successful POST",
    status: 303,
    expected: "persisted_complete"
  },
  {
    name: "302 redirect after successful POST",
    status: 302,
    expected: "persisted_complete"
  }
];

let passed = 0;
let failed = 0;

try {
  for (const scenario of scenarios) {
    const page = await browser.newPage();

    let stored = "Original Project";
    let posts = 0;
    let gets = 0;

    try {
      await page.route(`${origin}/**`, async route => {
        const request = route.request();
        const url = new URL(request.url());

        console.log(
          "[HTTP]",
          request.method(),
          url.pathname,
          "navigation=" + request.isNavigationRequest()
        );

        if (request.method() === "POST") {
          posts++;

          const body = new URLSearchParams(
            request.postData() ?? ""
          );

          stored = body.get("projectName") ?? stored;

          await route.fulfill({
            status: scenario.status,
            headers: {
              location: "/settings?updated=1"
            },
            body: ""
          });

          return;
        }

        gets++;

        const success = url.searchParams.has("updated");

        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `
            <!doctype html>
            <html>
              <head><title>Settings</title></head>
              <body>
                <h1>Settings</h1>

                ${
                  success
                    ? "<p>Preferences saved successfully</p>"
                    : ""
                }

                <form method="post" action="/settings">
                  <label for="name">Project Name</label>

                  <input
                    id="name"
                    name="projectName"
                    value="${stored}"
                  />

                  <button type="submit" aria-label="Submit Preferences">
                    ✓
                  </button>
                </form>
              </body>
            </html>
          `
        });
      });

      await page.goto(`${origin}/settings`);

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
        "Set Project Name to Website CoPilot, submit preferences, " +
        "and finish when Preferences saved successfully is visible.";

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
          element.formContext?.associated &&
          element.effectiveType === "submit"
        );

        if (submit) {
          return {
            ref: submit.ref,
            operation: "click"
          };
        }

        throw new Error("Submit control unavailable.");
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

      assert.equal(result.status, scenario.expected);
      assert.equal(posts, 1);
      assert.equal(stored, expectedValue);

      passed++;
      console.log(`PASS: ${scenario.name}`);
      console.log(`POST REQUESTS: ${posts}`);
      console.log(`GET REQUESTS: ${gets}`);
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

console.log("\n========== STEP 74K.11B ==========");
console.log(`Passed: ${passed}/${scenarios.length}`);
console.log(`Failed: ${failed}/${scenarios.length}`);

if (failed > 0) {
  process.exitCode = 1;
}
