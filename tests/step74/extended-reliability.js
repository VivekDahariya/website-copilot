
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { runAgent } from "../../src/agent/agent.js";

const browser = await chromium.launch({ headless: true });

const cases = [
  {
    name: "Slow server",
    delay: 2500,
    flash: false,
    navigate: false,
    icon: false
  },
  {
    name: "Transient success message",
    delay: 100,
    flash: true,
    navigate: false,
    icon: false
  },
  {
    name: "Navigation after save",
    delay: 100,
    flash: false,
    navigate: true,
    icon: false
  },
  {
    name: "Icon-only finalizing action",
    delay: 2500,
    flash: false,
    navigate: false,
    icon: true
  }
];

const results = [];

try {
  for (const test of cases) {
    const page = await browser.newPage();

    const base = "https://extended-reliability.example";

    let stored = "Original Project";
    let requests = 0;
    let reloads = 0;

    await page.route(`${base}/**`, async route => {
      const request = route.request();

      if (request.method() === "POST") {
        requests++;

        await new Promise(resolve =>
          setTimeout(resolve, test.delay)
        );

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
            <head><title>Project Settings</title></head>
            <body>
              <h1>Project Settings</h1>

              <label for="project">Project Name</label>
              <input
                id="project"
                aria-label="Project Name"
                value="${stored}"
              />

              <button
                id="save"
                ${test.icon ? 'aria-label="Apply"' : 'aria-label="Save Preferences"'}
                onclick="save()"
              >
                ${test.icon ? "✓" : "Save Preferences"}
              </button>

              <p id="status"></p>

              <script>
                async function save() {
                  const response = await fetch("/settings", {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                      projectName:
                        document.getElementById("project").value
                    })
                  });

                  if (!response.ok) return;

                  document.getElementById("status").textContent =
                    "Preferences saved successfully";

                  ${
                    test.flash
                      ? `setTimeout(() => {
                          document.getElementById("status").textContent = "";
                        }, 100);`
                      : ""
                  }

                  ${
                    test.navigate
                      ? `setTimeout(() => {
                          location.href = "/complete";
                        }, 50);`
                      : ""
                  }
                }
              </script>
            </body>
          </html>
        `
      });
    });

    await page.goto(`${base}/settings`);

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

      const button = elements.find(element =>
        /save preferences|apply|✓/i.test(
          [element.label, element.text].filter(Boolean).join(" ")
        )
      );

      if (button) {
        return {
          ref: button.ref,
          operation: "click"
        };
      }

      throw new Error("No suitable action found");
    };

    let result;

    try {
      result = await runAgent(
        page,
        "Set Project Name to Website CoPilot and save preferences.",
        goal,
        {
          reasoner,
          persistencePolicy: {
            requirePersistence: true,
            allowReload: true,
            workflowCategory: "repeatable_settings"
          }
        }
      );
    } catch (error) {
      result = {
        status: "uncaught_error",
        reason: error.message
      };
    }

    const record = {
      scenario: test.name,
      status: result.status,
      requests,
      reloads: reloads - 1,
      stored,
      reason: result.reason ?? null
    };

    results.push(record);

    console.log("\nSCENARIO:", test.name);
    console.log(JSON.stringify(record, null, 2));

    await page.close();
  }

  console.log("\n========== STEP 74K.6 SUMMARY ==========");

  for (const result of results) {
    console.log(
      `${result.scenario}: ${result.status} | requests=${result.requests}`
    );
  }

  assert.equal(
    results.length,
    cases.length,
    "Not all scenarios executed"
  );

  console.log("STEP 74K.6 DIAGNOSTIC RUN COMPLETED");

} finally {
  await browser.close();
}
