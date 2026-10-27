
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { runAgent } from "../../src/agent/agent.js";

const browser = await chromium.launch({ headless: true });

const goal = {
  type: "form_state",
  fieldLabel: "Project Name",
  expectedValue: "Website CoPilot"
};

async function runScenario({
  persistent,
  requirePersistence,
  allowReload
}) {
  const context = await browser.newContext();
  const page = await context.newPage();

  let storedValue = "Original";
  let reloadCount = 0;

  const host = persistent
    ? "agent-persistence-real.example"
    : "agent-persistence-fake.example";

  await page.route("**/settings", async route => {
    reloadCount++;

    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `
        <!doctype html>
        <html>
        <body>
          <label for="project">Project Name</label>
          <input id="project" value="${storedValue}">
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
      body: "OK"
    });
  });

  const observer = async activePage => ({
    status: "ready",
    attempts: 1,
    observation: {
      url: activePage.url(),
      title: "Project Settings",
      headings: ["Project Settings"],
      visibleBodyText:
        await activePage.locator("body").innerText(),
      actionableElements: [
        {
          ref: "project",
          tag: "input",
          type: "text",
          label: "Project Name",
          editable: true,
          currentValue:
            await activePage.locator("#project").inputValue()
        }
      ]
    }
  });

  try {
    await page.goto(`https://${host}/settings`);

    await page.locator("#project").fill("Website CoPilot");
    await page.locator("#save").click();

    await page.getByText(
      "Preferences saved successfully"
    ).waitFor();

    const result = await runAgent(
      page,
      "Verify the Project Name field on this page",
      goal,
      {
        observer,
        originalInstruction:
          "Verify the Project Name field on this page",
        persistencePolicy: {
          requirePersistence,
          allowReload,
          workflowCategory: "repeatable_settings"
        }
      }
    );

    return {
      status: result.status,
      persistence: result.persistence?.status,
      reloadCount
    };
  } finally {
    await context.close();
  }
}

try {
  const real = await runScenario({
    persistent: true,
    requirePersistence: true,
    allowReload: true
  });

  const fake = await runScenario({
    persistent: false,
    requirePersistence: true,
    allowReload: true
  });

  const unauthorized = await runScenario({
    persistent: true,
    requirePersistence: true,
    allowReload: false
  });

  const optional = await runScenario({
    persistent: true,
    requirePersistence: false,
    allowReload: false
  });

  console.log("REAL:", real);
  console.log("FAKE:", fake);
  console.log("UNAUTHORIZED:", unauthorized);
  console.log("OPTIONAL:", optional);

  assert.equal(real.status, "persisted_complete");
  assert.equal(fake.status, "persistence_failed");
  assert.equal(unauthorized.status, "persistence_unverified");
  assert.equal(optional.status, "verified_complete");

  assert.equal(unauthorized.reloadCount, 1);
  assert.equal(optional.reloadCount, 1);

  console.log("STEP 74H — AGENT PERSISTENCE STATUS PASSED");
} finally {
  await browser.close();
}
