import assert from "node:assert/strict";
import { chromium } from "playwright";
import { runAgent } from "./src/agent/agent.js";

const BASE = "https://dynamic-multipage.example";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  await page.route(`${BASE}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;

    let html;

    if (pathname === "/") {
      html = `
        <h1>Account Settings</h1>
        <p>Loading navigation...</p>

        <script>
          setTimeout(() => {
            const link = document.createElement("a");
            link.href = "/notifications";
            link.textContent = "Notification Preferences";
            document.body.appendChild(link);
          }, 1200);
        </script>
      `;
    } else if (pathname === "/notifications") {
      html = `
        <h1>Notification Preferences</h1>
        <p id="status">Loading notification settings...</p>

        <script>
          setTimeout(() => {
            const label = document.createElement("label");
            label.htmlFor = "email";
            label.textContent = "Email Notifications";

            const checkbox = document.createElement("input");
            checkbox.id = "email";
            checkbox.type = "checkbox";
            checkbox.checked = true;

            checkbox.addEventListener("change", () => {
              document.querySelector("#status").textContent =
                checkbox.checked
                  ? "Notifications enabled"
                  : "Notifications disabled";
            });

            document.body.appendChild(label);
            document.body.appendChild(checkbox);

            document.querySelector("#status").textContent =
              "Notifications enabled";
          }, 1200);
        </script>
      `;
    } else {
      html = "<h1>Not Found</h1>";
    }

    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html>
        <html>
          <head>
            <title>Dynamic Multi-Page Lab</title>
          </head>
          <body>${html}</body>
        </html>`
    });
  });

  await page.goto(`${BASE}/`);

  const goal = {
    type: "all_of",
    conditions: [
      {
        type: "page_destination",
        hostname: "dynamic-multipage.example",
        pathname: "/notifications"
      },
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
    "Navigate to Notification Preferences, disable Email Notifications, and verify Notifications disabled.",
    goal
  );

  const pathname = new URL(page.url()).pathname;

  const checked = await page
    .locator("#email")
    .isChecked()
    .catch(() => null);

  const status = await page
    .locator("#status")
    .textContent()
    .catch(() => null);

  console.log("\nINDEPENDENT VERIFICATION:");
  console.log("Final URL:", page.url());
  console.log("Checkbox checked:", checked);
  console.log("Status:", status);
  console.log("Agent status:", result.status);

  assert.equal(result.status, "verified_complete");
  assert.equal(pathname, "/notifications");
  assert.equal(checked, false);
  assert.equal(status, "Notifications disabled");

  console.log(
    "\nSTEP 63 — MULTI-PAGE DYNAMIC RECOVERY PASSED"
  );
} finally {
  await browser.close();
}
