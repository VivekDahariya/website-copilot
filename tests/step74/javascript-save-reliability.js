import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";

import { runAgent } from "../../src/agent/agent.js";
import { observeReliably } from "../../src/observer/reliable-observer.js";
import { createActionApproval } from "../../src/agent/action-approval.js";

const expectedValue = "Website CoPilot";

const scenarios = [
  {
    name: "Successful JavaScript save",
    delay: 100,
    reject: false,
    fakeSuccess: false,
    expectedStatus: "persisted_complete"
  },
  {
    name: "Delayed JavaScript save",
    delay: 750,
    reject: false,
    fakeSuccess: false,
    expectedStatus: "persisted_complete"
  },
  {
    name: "Rejected JavaScript save",
    delay: 100,
    reject: true,
    fakeSuccess: false,
    expectedStatus: "action_outcome_unverified"
  },
  {
    name: "Misleading success without persistence",
    delay: 100,
    reject: false,
    fakeSuccess: true,
    expectedStatus: "persistence_failed"
  }
];

const browser = await chromium.launch({ headless: true });

let passed = 0;
let failed = 0;

try {
  for (const scenario of scenarios) {
    let stored = "Original Project";
    let saves = 0;
    let reads = 0;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");

      console.log(
        "[HTTP]",
        scenario.name,
        req.method,
        url.pathname
      );

      if (req.method === "POST" && url.pathname === "/api/save") {
        saves++;

        let body = "";

        for await (const chunk of req) {
          body += chunk;
        }

        const data = JSON.parse(body);

        await new Promise(resolve =>
          setTimeout(resolve, scenario.delay)
        );

        if (scenario.reject) {
          res.writeHead(500, {
            "Content-Type": "application/json"
          });

          res.end(JSON.stringify({
            error: "Save rejected"
          }));

          return;
        }

        if (!scenario.fakeSuccess) {
          stored = data.projectName;
        }

        res.writeHead(200, {
          "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
          success: true
        }));

        return;
      }

      if (req.method === "GET" && url.pathname === "/settings") {
        reads++;

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8"
        });

        res.end(`
          <!doctype html>
          <html>
            <head><title>Settings</title></head>
            <body>
              <h1>Settings</h1>

              <label for="project">Project Name</label>

              <input
                id="project"
                value="${stored}"
              />

              <button id="save" type="button">
                Save Preferences
              </button>

              <p id="message"></p>

              <script>
                document.getElementById("save")
                  .addEventListener("click", async () => {
                    const projectName =
                      document.getElementById("project").value;

                    try {
                      const response = await fetch("/api/save", {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json"
                        },
                        body: JSON.stringify({ projectName })
                      });

                      if (!response.ok) {
                        throw new Error("Save rejected");
                      }

                      document.getElementById("message")
                        .textContent =
                          "Preferences saved successfully";
                    } catch {
                      document.getElementById("message")
                        .textContent = "Save failed";
                    }
                  });
              </script>
            </body>
          </html>
        `);

        return;
      }

      res.writeHead(404);
      res.end("Not found");
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

        const save = elements.find(element =>
          /save preferences/i.test(element.label)
        );

        if (save) {
          return {
            ref: save.ref,
            operation: "click"
          };
        }

        throw new Error("Save button unavailable.");
      };

      const result = await runAgent(
        page,
        "Set Project Name to Website CoPilot and save preferences.",
        goal,
        {
          reasoner,
          observer: observeReliably,

          // Approval is simulated only inside this benchmark.
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
      console.log("SAVES:", saves);
      console.log("READS:", reads);
      console.log("STORED:", stored);

      assert.equal(
        result.status,
        scenario.expectedStatus,
        "Unexpected agent status"
      );

      assert.equal(
        saves,
        1,
        "Save must execute exactly once"
      );

      if (!scenario.reject && !scenario.fakeSuccess) {
        assert.equal(stored, expectedValue);
      } else {
        assert.equal(stored, "Original Project");
      }

      passed++;
      console.log(`PASS: ${scenario.name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL: ${scenario.name}`);
      console.error(error.stack ?? error);
    } finally {
      await page.close();

      await new Promise(resolve =>
        server.close(resolve)
      );
    }
  }
} finally {
  await browser.close();
}

console.log("\n========== STEP 74K.11C ==========");
console.log(`Passed: ${passed}/${scenarios.length}`);
console.log(`Failed: ${failed}/${scenarios.length}`);

if (failed > 0) {
  process.exitCode = 1;
}
