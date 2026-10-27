import assert from "node:assert/strict";
import { chromium } from "playwright";
import { runAgent } from "./src/agent/agent.js";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  await page.route("https://dynamic-agent.example/**", async route => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `
        <!DOCTYPE html>
        <html>
          <head><title>Dynamic Agent Lab</title></head>
          <body>
            <h1>Notification Preferences</h1>
            <p>Loading settings...</p>

            <script>
              setTimeout(() => {
                document.body.insertAdjacentHTML(
                  "beforeend",
                  '<label><input id="email" type="checkbox" checked> Email Notifications</label>' +
                  '<p id="status">Notifications enabled</p>'
                );

                document.querySelector("#email")
                  .addEventListener("change", event => {
                    document.querySelector("#status").textContent =
                      event.target.checked
                        ? "Notifications enabled"
                        : "Notifications disabled";
                  });
              }, 1200);
            </script>
          </body>
        </html>
      `
    });
  });

  await page.goto("https://dynamic-agent.example/");

  const goal = {
    type: "all_of",
    conditions: [
      {
        type: "form_state",
        fieldLabel: "Email Notifications",
        expectedValue: false
      },
      {
        type: "visible_content",
        text: "Notifications disabled"
      }
    ]
  };

  const result = await runAgent(
    page,
    "Disable Email Notifications and verify Notifications disabled.",
    goal
  );

  const checked = await page.locator("#email").isChecked();
  const status = await page.locator("#status").textContent();

  assert.equal(result.status, "verified_complete");
  assert.equal(checked, false);
  assert.equal(status, "Notifications disabled");

  console.log(
    "\nSTEP 60 — AUTONOMOUS DYNAMIC PAGE RECOVERY PASSED"
  );
} finally {
  await browser.close();
}
