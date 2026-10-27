
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runAgent } from "../../src/agent/agent.js";
import { observeReliably } from "../../src/observer/reliable-observer.js";
import { createActionApproval } from "../../src/agent/action-approval.js";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  const url = "https://persistence-lab.example/settings";

  let persistedName = "Original Project";
  let fakeSave = false;
  let saveRequests = 0;
  let navigationCount = 0;

  const escapeHtml = value => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  await page.route("https://persistence-lab.example/**", async route => {
    if (route.request().isNavigationRequest()) {
      navigationCount++;
    }

    if (route.request().method() === "POST") {
      saveRequests++;

      const body = route.request().postDataJSON();

      if (!fakeSave) {
        persistedName = body.projectName;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true })
      });

      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `
        <!doctype html>
        <html>
          <head>
            <title>Project Settings</title>
          </head>

          <body>
            <h1>Project Settings</h1>

            <label for="project-name">Project Name</label>

            <input
              id="project-name"
              aria-label="Project Name"
              value="${escapeHtml(persistedName)}"
            />

            <button
              type="button"
              aria-label="Save Preferences"
              onclick="savePreferences()"
            >
              Save Preferences
            </button>

            <p id="result"></p>

            <script>
              async function savePreferences() {
                const projectName =
                  document.getElementById("project-name").value;

                const response = await fetch(
                  "/settings",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ projectName })
                  }
                );

                if (response.ok) {
                  document.getElementById("result").textContent =
                    "Preferences saved successfully";
                }
              }
            </script>
          </body>
        </html>
      `
    });
  });

  const goal = {
    type: "all_of",
    conditions: [
      {
        type: "form_state",
        fieldLabel: "Project Name",
        expectedValue: "Website CoPilot"
      },
      {
        type: "visible_content",
        text: "Preferences saved successfully"
      }
    ]
  };

  const instruction =
    "Set Project Name to Website CoPilot, save preferences, " +
    "and finish only when Preferences saved successfully is visible.";

  async function reasoner(task, observation) {
    const elements = observation.actionableElements;

    const input = elements.find(element =>
      /project name/i.test(element.label) &&
      element.currentValue !== "Website CoPilot"
    );

    if (input) {
      return {
        ref: input.ref,
        operation: "fill",
        value: "Website CoPilot"
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

    throw new Error("No suitable action found.");
  }

  async function runScenario({
    name,
    fake,
    allowReload,
    expectedStatus
  }) {
    fakeSave = fake;
    persistedName = "Original Project";
    saveRequests = 0;
    navigationCount = 0;

    await page.goto(url);

    const navigationCountBeforeAgent = navigationCount;

    let approvalRequests = 0;

    const result = await runAgent(
      page,
      instruction,
      goal,
      {
        reasoner,
        observer: observeReliably,

        approvalProvider: async context => {
          approvalRequests++;

          // Explicit consent is simulated by the test harness.
          // Production must obtain it from a trusted user interface.
          return createActionApproval(context.action, {
            pageUrl: context.pageUrl,
            targetIdentity: context.targetIdentity
          });
        },

        persistencePolicy: {
          requirePersistence: true,
          allowReload,
          workflowCategory: "repeatable_settings"
        }
      }
    );

    assert.equal(
      result.status,
      expectedStatus,
      `${name}: unexpected agent status`
    );

    assert.equal(
      saveRequests,
      1,
      `${name}: agent must send exactly one save request`
    );

    const operations = result.history.map(
      entry => entry.decision.operation
    );

    assert.ok(
      operations.includes("fill"),
      `${name}: agent did not fill the field`
    );

    assert.ok(
      operations.includes("click"),
      `${name}: agent did not click Save`
    );

    assert.equal(
      result.verification.completed,
      true,
      `${name}: success state was not verified`
    );

    assert.equal(
      result.persistence.status,
      expectedStatus === "persisted_complete"
        ? "persisted_verified"
        : expectedStatus,
      `${name}: incorrect persistence verification`
    );

    const navigationsDuringAgent =
      navigationCount - navigationCountBeforeAgent;

    assert.equal(
      navigationsDuringAgent,
      allowReload ? 1 : 0,
      `${name}: unexpected reload behavior`
    );

    if (fake) {
      assert.equal(
        persistedName,
        "Original Project",
        `${name}: fake save unexpectedly persisted data`
      );
    } else {
      assert.equal(
        persistedName,
        "Website CoPilot",
        `${name}: real save did not persist data`
      );
    }

    if (allowReload) {
      const actualValue = await page
        .locator("#project-name")
        .inputValue();

      assert.equal(
        actualValue,
        fake ? "Original Project" : "Website CoPilot",
        `${name}: incorrect value after reload`
      );
    }

    console.log(`PASS: ${name}`);
    console.log(
      JSON.stringify({
        status: result.status,
        persistence: result.persistence.status,
        saveRequests,
        approvalRequests,
        reloads: navigationsDuringAgent,
        storedValue: persistedName
      }, null, 2)
    );
  }

  await runScenario({
    name: "Real save survives authorized reload",
    fake: false,
    allowReload: true,
    expectedStatus: "persisted_complete"
  });

  await runScenario({
    name: "Fake success fails persistence verification",
    fake: true,
    allowReload: true,
    expectedStatus: "persistence_failed"
  });

  await runScenario({
    name: "Unauthorized reload remains blocked",
    fake: false,
    allowReload: false,
    expectedStatus: "persistence_unverified"
  });

  console.log(
    "STEP 74K.2 — AGENT-DRIVEN PERSISTENCE BENCHMARK PASSED"
  );

} finally {
  await browser.close();
}
