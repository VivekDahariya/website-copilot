import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";

import { runAgent } from "../../src/agent/agent.js";
import { observeReliably } from "../../src/observer/reliable-observer.js";
import { createActionApproval } from "../../src/agent/action-approval.js";

const expectedValue = "Website CoPilot";
const scenarios = [302, 303];

const browser = await chromium.launch({ headless: true });

let passed = 0;

try {
  for (const redirectStatus of scenarios) {
    let stored = "Original Project";
    let posts = 0;
    let gets = 0;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");

      console.log("[HTTP]", req.method, url.pathname + url.search);

      if (req.method === "POST") {
        posts++;

        let body = "";
        for await (const chunk of req) body += chunk;

        stored =
          new URLSearchParams(body).get("projectName") ?? stored;

        res.writeHead(redirectStatus, {
          Location: `/settings?updated=1`
        });

        res.end();
        return;
      }

      gets++;

      const updated = url.searchParams.has("updated");

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });

      res.end(`
        <!doctype html>
        <html>
          <head><title>Settings</title></head>
          <body>
            <h1>Settings</h1>

            ${
              updated
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
      `);
    });

    await new Promise(resolve =>
      server.listen(0, "127.0.0.1", resolve)
    );

    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await browser.newPage();

    try {
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
          element.effectiveType === "submit"
        );

        if (submit) {
          return {
            ref: submit.ref,
            operation: "click"
          };
        }

        throw new Error("No actionable submit control.");
      };

      const result = await runAgent(
        page,
        "Set Project Name to Website CoPilot and submit preferences.",
        goal,
        {
          reasoner,
          observer: observeReliably,

          // Simulated approval is restricted to this local benchmark.
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

      console.log("STATUS:", result.status);
      console.log("POSTS:", posts);
      console.log("GETS:", gets);
      console.log("STORED:", stored);

      assert.equal(result.status, "persisted_complete");
      assert.equal(posts, 1);
      assert.equal(stored, expectedValue);

      passed++;
      console.log(`PASS: Full agent HTTP ${redirectStatus}`);
    } catch (error) {
      console.error(`FAIL: Full agent HTTP ${redirectStatus}`);
      console.error(error.stack ?? error);
    } finally {
      await page.close();
      await new Promise(resolve => server.close(resolve));
    }
  }
} finally {
  await browser.close();
}

console.log("\n========== STEP 74K.11B ==========");
console.log(`Passed: ${passed}/2`);
console.log(`Failed: ${2 - passed}/2`);

if (passed !== 2) process.exitCode = 1;
