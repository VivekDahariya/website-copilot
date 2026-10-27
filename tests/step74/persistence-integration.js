
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { verifyPersistence } from "../../src/agent/persistence-verifier.js";

const browser = await chromium.launch({ headless: true });

const goal = {
  type: "form_state",
  fieldLabel: "Project Name",
  expectedValue: "Website CoPilot"
};

async function runScenario(persistent) {
  const context = await browser.newContext();
  const page = await context.newPage();

  let storedValue = "Original";

  const host = persistent
    ? "persistence-real.example"
    : "persistence-fake.example";

  await page.route("**/settings", async route => {
    const safeValue = storedValue
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;");

    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `
        <!doctype html>
        <html>
          <body>
            <h1>Project Settings</h1>

            <label for="project">Project Name</label>
            <input id="project" value="${safeValue}">

            <button id="save">Save Preferences</button>
            <p id="status"></p>

            <script>
              document.getElementById("save").onclick = async () => {
                const value = document.getElementById("project").value;

                ${persistent
                  ? `await fetch("/persist", {
                       method: "POST",
                       body: value
                     });`
                  : ""
                }

                document.getElementById("status").textContent =
                  "Preferences saved successfully";
              };
            </script>
          </body>
        </html>
      `
    });
  });

  await page.route("**/persist", async route => {
    if (persistent) {
      storedValue = route.request().postData() ?? storedValue;
    }

    await route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "OK"
    });
  });

  const observer = async activePage => {
    const currentValue =
      await activePage.locator("#project").inputValue();

    return {
      status: "ready",
      observation: {
        url: activePage.url(),
        visibleBodyText: await activePage.locator("body").innerText(),
        actionableElements: [
          {
            ref: "project-field",
            tag: "input",
            type: "text",
            label: "Project Name",
            editable: true,
            currentValue
          }
        ]
      }
    };
  };

  try {
    await page.goto(`https://${host}/settings`);

    await page.locator("#project").fill("Website CoPilot");
    await page.locator("#save").click();

    await page.getByText("Preferences saved successfully").waitFor();

    const result = await verifyPersistence({
      page,
      goal,
      observer,
      allowReload: true,
      workflowCategory: "repeatable_settings"
    });

    return result;
  } finally {
    await context.close();
  }
}

try {
  const real = await runScenario(true);
  const fake = await runScenario(false);

  console.log("REAL SAVE:", real.status);
  console.log("FAKE SAVE:", fake.status);

  assert.equal(real.status, "persisted_verified");
  assert.equal(fake.status, "persistence_failed");

  console.log("STEP 74C — PERSISTENCE INTEGRATION PASSED");
} finally {
  await browser.close();
}
