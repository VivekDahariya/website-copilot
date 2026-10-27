import assert from "node:assert/strict";
import { chromium } from "playwright";
import { executeNaturalLanguageTask } from "./src/agent/natural-language-executor.js";

const BASE = "https://workflow-test.example";

const pages = {
  "/": `
    <!doctype html>
    <html>
      <head><title>Workspace</title></head>
      <body>
        <h1>Workspace</h1>
        <nav>
          <a href="/settings">Settings</a>
          <a href="/help">Help</a>
        </nav>
      </body>
    </html>
  `,

  "/settings": `
    <!doctype html>
    <html>
      <head><title>Settings</title></head>
      <body>
        <h1>Settings</h1>
        <a href="/settings/profile">Profile Preferences</a>
        <a href="/">Home</a>
      </body>
    </html>
  `,

  "/settings/profile": `
    <!doctype html>
    <html>
      <head><title>Profile Preferences</title></head>
      <body>
        <h1>Profile Preferences</h1>

        <label for="name">Full Name</label>
        <input id="name">

        <label for="city">City</label>
        <select id="city">
          <option value="">Choose city</option>
          <option value="raipur">Raipur</option>
          <option value="durg">Durg</option>
        </select>

        <label>
          <input id="updates" type="checkbox">
          Show updates
        </label>

        <p id="status">Preferences not completed</p>

        <script>
          const name = document.querySelector("#name");
          const city = document.querySelector("#city");
          const updates = document.querySelector("#updates");
          const status = document.querySelector("#status");

          function updateStatus() {
            if (
              name.value === "Vivek" &&
              city.value === "durg" &&
              updates.checked
            ) {
              status.textContent = "Preferences completed";
            } else {
              status.textContent = "Preferences not completed";
            }
          }

          name.addEventListener("input", updateStatus);
          city.addEventListener("change", updateStatus);
          updates.addEventListener("change", updateStatus);
        </script>
      </body>
    </html>
  `,

  "/help": `
    <!doctype html>
    <html>
      <head><title>Help</title></head>
      <body><h1>Help Center</h1></body>
    </html>
  `
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
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
    Navigate to Profile Preferences through Settings.
    Fill Full Name with Vivek.
    Select Durg as the city.
    Enable Show updates.
    Finish only when the page says Preferences completed.
  `;

  console.log("\nSTEP 52 — AUTONOMOUS MULTI-STEP CHALLENGE");
  console.log("Instruction:", instruction.trim());

  const result = await executeNaturalLanguageTask(
    page,
    instruction
  );

  console.log("\nAGENT RESULT:");
  console.dir(result, { depth: 6 });

  console.log("\nFINAL BROWSER STATE:");
  console.log("URL:", page.url());
  console.log("Name:", await page.locator("#name").inputValue().catch(() => null));
  console.log("City:", await page.locator("#city").inputValue().catch(() => null));
  console.log("Updates:", await page.locator("#updates").isChecked().catch(() => null));
  console.log("Status:", await page.locator("#status").textContent().catch(() => null));

  assert.equal(
    new URL(page.url()).pathname,
    "/settings/profile",
    "Agent did not reach Profile Preferences"
  );

  assert.equal(
    await page.locator("#name").inputValue(),
    "Vivek",
    "Agent did not fill Full Name"
  );

  assert.equal(
    await page.locator("#city").inputValue(),
    "durg",
    "Agent did not select Durg"
  );

  assert.equal(
    await page.locator("#updates").isChecked(),
    true,
    "Agent did not enable updates"
  );

  assert.equal(
    (await page.locator("#status").textContent()).trim(),
    "Preferences completed",
    "Agent did not achieve the final goal"
  );

  console.log("\nSTEP 52: AUTONOMOUS MULTI-STEP CHALLENGE PASSED");
} finally {
  await browser.close();
}
