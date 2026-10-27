import assert from "node:assert/strict";
import { chromium } from "playwright";
import { observeReliably } from "./src/observer/reliable-observer.js";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  await page.route("https://dynamic-lab.example/**", async route => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `
        <!DOCTYPE html>
        <html>
          <head><title>Dynamic Settings Lab</title></head>
          <body>
            <h1>Notification Preferences</h1>
            <p id="loading">Loading settings...</p>
            <a href="/help">Help Center</a>

            <div id="settings"></div>

            <script>
              setTimeout(() => {
                document.querySelector("#settings").innerHTML = \`
                  <label>
                    <input
                      type="checkbox"
                      id="email"
                      checked
                    />
                    Email Notifications
                  </label>
                  <p id="status">Notifications enabled</p>
                \`;

                document.querySelector("#loading").remove();

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

  await page.goto("https://dynamic-lab.example/");

  console.log("\n========== STEP 60 ==========");

  const initial = await observeReliably(page);

  assert.equal(initial.status, "ready");

  const initiallyLoaded = initial.observation.actionableElements.some(
    element => String(element.label || "").includes("Email Notifications")
  );

  console.log("Initial observation ready:", initial.status);
  console.log("Target initially present:", initiallyLoaded);

  assert.equal(
    initiallyLoaded,
    false,
    "Fixture should expose the missing-control problem."
  );

  await page.waitForSelector("#email", { timeout: 5000 });

  const final = await observeReliably(page);

  const finallyLoaded = final.observation.actionableElements.some(
    element => String(element.label || "").includes("Email Notifications")
  );

  console.log("Target eventually present:", finallyLoaded);

  assert.equal(
    finallyLoaded,
    true,
    "Observer should detect the dynamically inserted checkbox."
  );

  console.log(
    "\nSTEP 60 — DELAYED DOM OBSERVATION BASELINE PASSED"
  );
} finally {
  await browser.close();
}
