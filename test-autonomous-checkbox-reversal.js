import assert from "node:assert/strict";
import { chromium } from "playwright";
import { executeNaturalLanguageTask } from "./src/agent/natural-language-executor.js";

const BASE = "https://notification-lab.example";

const instruction = `
Open ${BASE}/.
Navigate to Notification Preferences through Account Settings.
Disable Email Notifications.
Finish only when the page says Notifications disabled.
`.trim();

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  await page.route(`${BASE}/**`, async route => {
    const url = new URL(route.request().url());

    let html;

    if (url.pathname === "/") {
      html = `
        <h1>Notification Lab</h1>
        <nav>
          <a href="/dashboard">Dashboard</a>
          <a href="/account">Account Settings</a>
          <a href="/help">Help Center</a>
        </nav>
      `;
    } else if (url.pathname === "/account") {
      html = `
        <h1>Account Settings</h1>
        <nav>
          <a href="/account/profile">Profile</a>
          <a href="/account/notifications">Notification Preferences</a>
          <a href="/account/security">Security Guide</a>
        </nav>
      `;
    } else if (url.pathname === "/account/notifications") {
      html = `
        <h1>Notification Preferences</h1>

        <label for="email-notifications">
          Email Notifications
        </label>

        <input
          id="email-notifications"
          type="checkbox"
          checked
        >

        <p id="status">Notifications enabled</p>

        <script>
          const checkbox =
            document.querySelector("#email-notifications");

          const status =
            document.querySelector("#status");

          checkbox.addEventListener("change", () => {
            status.textContent = checkbox.checked
              ? "Notifications enabled"
              : "Notifications disabled";
          });
        </script>
      `;
    } else {
      html = `
        <h1>Other Page</h1>
        <p>No notification preferences here.</p>
      `;
    }

    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html>
        <html>
          <head>
            <title>Notification Lab</title>
          </head>
          <body>${html}</body>
        </html>`
    });
  });

  console.log("\n========== STEP 58 ==========");
  console.log("UNSEEN INSTRUCTION:", instruction);

  const result = await executeNaturalLanguageTask(
    page,
    instruction
  );

  console.log("\nEXECUTION STATUS:", result.status);
  console.log("FINAL URL:", page.url());

  const pathname = new URL(page.url()).pathname;

  const checkboxChecked = await page
    .locator("#email-notifications")
    .isChecked()
    .catch(() => null);

  const statusText = await page
    .locator("#status")
    .textContent()
    .catch(() => null);

  console.log("\nINDEPENDENT VERIFICATION:");
  console.log("Path:", pathname);
  console.log("Email Notifications:", checkboxChecked);
  console.log("Status:", statusText);

  assert.equal(
    result.status,
    "verified_complete",
    "The autonomous agent did not verify completion."
  );

  assert.equal(
    pathname,
    "/account/notifications",
    "The agent did not reach Notification Preferences."
  );

  assert.equal(
    checkboxChecked,
    false,
    "Email Notifications should be disabled."
  );

  assert.equal(
    statusText?.trim(),
    "Notifications disabled",
    "The page did not confirm the disabled state."
  );

  console.log(
    "\nSTEP 58 — AUTONOMOUS CHECKBOX REVERSAL PASSED"
  );
} finally {
  await browser.close();
}
