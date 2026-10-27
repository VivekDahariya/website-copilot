
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runAgent } from "../../src/agent/agent.js";
import { observeReliably } from "../../src/observer/reliable-observer.js";

const browser = await chromium.launch({ headless: true });

const base = "https://async-reliability.example";

const scenarios = [
  {
    name: "Delayed successful save",
    delay: 500,
    fail: false,
    unrelatedChange: false,
    expected: "persisted_complete"
  },
  {
    name: "Server rejects save",
    delay: 100,
    fail: true,
    unrelatedChange: false,
    expected: null
  },
  {
    name: "Unrelated DOM update before save completes",
    delay: 700,
    fail: false,
    unrelatedChange: true,
    expected: "persisted_complete"
  }
];

try {
  for (const scenario of scenarios) {
    const page = await browser.newPage();

    let stored = "Original Project";
    let requests = 0;
    let reloads = 0;

    await page.route(`${base}/**`, async route => {
      const request = route.request();

      if (request.method() === "POST") {
        requests++;

        await new Promise(resolve =>
          setTimeout(resolve, scenario.delay)
        );

        if (scenario.fail) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: '{"success":false}'
          });
          return;
        }

        stored = request.postDataJSON().projectName;

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: '{"success":true}'
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

              <label for="name">Project Name</label>
              <input
                id="name"
                aria-label="Project Name"
                value="${stored}"
              />

              <button
                aria-label="Save Preferences"
                onclick="save()"
              >
                Save Preferences
              </button>

              <p id="status"></p>
              <p id="clock"></p>

              <script>
                async function save() {
                  ${
                    scenario.unrelatedChange
                      ? `setTimeout(() => {
                          document.getElementById("clock").textContent =
                            "Clock updated";
                        }, 50);`
                      : ""
                  }

                  const response = await fetch(
                    "/settings",
                    {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json"
                      },
                      body: JSON.stringify({
                        projectName:
                          document.getElementById("name").value
                      })
                    }
                  );

                  if (response.ok) {
                    document.getElementById("status").textContent =
                      "Preferences saved successfully";
                  } else {
                    document.getElementById("status").textContent =
                      "Unable to save preferences";
                  }
                }
              </script>
            </body>
          </html>
        `
      });
    });

    await page.goto(`${base}/settings`);

    const initialNavigations = reloads;

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

    const reasoner = async (task, observation) => {
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
    };

    const result = await runAgent(
      page,
      "Set Project Name to Website CoPilot and save preferences.",
      goal,
      {
        reasoner,
        observer: observeReliably,
        persistencePolicy: {
          requirePersistence: true,
          allowReload: true,
          workflowCategory: "repeatable_settings"
        }
      }
    );

    console.log(`SCENARIO: ${scenario.name}`);
    console.log(`STATUS: ${result.status}`);
    console.log(`REQUESTS: ${requests}`);
    console.log(`RELOADS: ${reloads - initialNavigations}`);
    console.log(`STORED: ${stored}`);

    if (scenario.expected) {
      assert.equal(
        result.status,
        scenario.expected,
        `${scenario.name}: incorrect completion status`
      );

      assert.equal(
        stored,
        "Website CoPilot",
        `${scenario.name}: value was not persisted`
      );

      assert.equal(
        requests,
        1,
        `${scenario.name}: unexpected duplicate save`
      );
    } else {
      assert.notEqual(
        result.status,
        "persisted_complete",
        `${scenario.name}: false persistence success`
      );

      assert.equal(
        stored,
        "Original Project",
        `${scenario.name}: failed request changed stored data`
      );
    }

    console.log(`PASS: ${scenario.name}`);

    await page.close();
  }

  console.log(
    "STEP 74K.4 — ASYNC RELIABILITY TESTS PASSED"
  );

} finally {
  await browser.close();
}
