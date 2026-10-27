import assert from "node:assert/strict";
import { chromium } from "playwright";
import { executeNaturalLanguageTask } from "./src/agent/natural-language-executor.js";

const BASE = "https://employee-portal.example";

const pages = {
  "/": `
    <!doctype html>
    <html>
      <head><title>Employee Portal</title></head>
      <body>
        <h1>Employee Portal</h1>
        <nav>
          <a href="/directory">Employee Directory</a>
          <a href="/preferences">Employee Settings</a>
          <a href="/support">Support</a>
        </nav>
      </body>
    </html>
  `,

  "/directory": `
    <html><body>
      <h1>Employee Directory</h1>
      <a href="/">Home</a>
    </body></html>
  `,

  "/support": `
    <html><body>
      <h1>Support Center</h1>
      <a href="/">Home</a>
    </body></html>
  `,

  "/preferences": `
    <html><body>
      <h1>Employee Settings</h1>
      <a href="/preferences/profile">Profile</a>
      <a href="/">Home</a>
    </body></html>
  `,

  "/preferences/profile": `
    <!doctype html>
    <html>
      <head><title>Employee Profile</title></head>
      <body>
        <h1>Employee Profile</h1>

        <label for="full-name">Full Name</label>
        <input id="full-name" type="text">

        <label for="city">City</label>
        <select id="city">
          <option value="">Choose a city</option>
          <option value="bilaspur">Bilaspur</option>
          <option value="durg">Durg</option>
          <option value="raipur">Raipur</option>
        </select>

        <label>
          <input id="notifications" type="checkbox">
          Email Notifications
        </label>

        <p id="status">Profile incomplete</p>

        <script>
          const name = document.querySelector("#full-name");
          const city = document.querySelector("#city");
          const notifications = document.querySelector("#notifications");
          const status = document.querySelector("#status");

          function updateStatus() {
            if (
              name.value === "Vivek Dahariya" &&
              city.value === "durg" &&
              notifications.checked
            ) {
              status.textContent = "Profile completed";
            } else {
              status.textContent = "Profile incomplete";
            }
          }

          name.addEventListener("input", updateStatus);
          city.addEventListener("change", updateStatus);
          notifications.addEventListener("change", updateStatus);
        </script>
      </body>
    </html>
  `
};

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  await page.route(`${BASE}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;

    await route.fulfill({
      status: pages[pathname] ? 200 : 404,
      contentType: "text/html; charset=utf-8",
      body: pages[pathname] ?? "<h1>Not Found</h1>"
    });
  });

  const instruction = `
    Open ${BASE}/.
    Navigate to Profile through Employee Settings.
    Set Full Name to Vivek Dahariya.
    Select Durg for City.
    Enable Email Notifications.
    Finish only when the page says Profile completed.
  `;

  console.log("\n========== STEP 56B ==========");
  console.log("UNSEEN INSTRUCTION:", instruction.trim());

  const result = await executeNaturalLanguageTask(
    page,
    instruction
  );

  console.log("\nINTERPRETED TASK:");
  console.dir(result.interpretedTask, { depth: null });

  console.log("\nEXECUTION STATUS:", result.status);
  console.log("FINAL URL:", page.url());

  const finalPath = new URL(page.url()).pathname;

  const name = await page
    .locator("#full-name")
    .inputValue()
    .catch(() => null);

  const city = await page
    .locator("#city")
    .inputValue()
    .catch(() => null);

  const notifications = await page
    .locator("#notifications")
    .isChecked()
    .catch(() => null);

  const status = await page
    .locator("#status")
    .textContent()
    .catch(() => null);

  console.log("\nINDEPENDENT VERIFICATION:");
  console.log("Path:", finalPath);
  console.log("Full Name:", name);
  console.log("City:", city);
  console.log("Email Notifications:", notifications);
  console.log("Status:", status);

  assert.equal(
    result.status,
    "verified_complete",
    `Agent failed: ${JSON.stringify(result)}`
  );

  assert.equal(
    finalPath,
    "/preferences/profile",
    "Incorrect destination"
  );

  assert.equal(
    name,
    "Vivek Dahariya",
    "Incorrect Full Name"
  );

  assert.equal(
    city,
    "durg",
    "Incorrect City"
  );

  assert.equal(
    notifications,
    true,
    "Email Notifications not enabled"
  );

  assert.equal(
    status?.trim(),
    "Profile completed",
    "Final status not achieved"
  );

  console.log(
    "\nSTEP 56B — UNSEEN MULTI-STEP FORM PASSED"
  );
} finally {
  await browser.close();
}
