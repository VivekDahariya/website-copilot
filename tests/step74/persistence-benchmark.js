
import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });

async function runScenario(persistent) {
  const context = await browser.newContext();
  const page = await context.newPage();

  const url = persistent
    ? "https://persistence-real.example/settings"
    : "https://persistence-fake.example/settings";

  let storedValue = "Original";

  await page.route("**/settings", async route => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `
        <!doctype html>
        <html>
        <body>
          <h1>Project Settings</h1>

          <label>
            Project Name
            <input id="project" value="${storedValue}">
          </label>

          <button id="save">Save Preferences</button>

          <p id="status"></p>

          <script>
            document.getElementById("save").onclick = () => {
              const value =
                document.getElementById("project").value;

              ${persistent
                ? `fetch("/persist", {
                    method: "POST",
                    body: value
                  }).then(() => {
                    document.getElementById("status")
                      .textContent = "Preferences saved successfully";
                  });`
                : `document.getElementById("status")
                    .textContent = "Preferences saved successfully";`
              }
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

  await page.goto(url);

  await page.locator("#project").fill("Website CoPilot");

  await page.locator("#save").click();

  await page.getByText("Preferences saved successfully").waitFor();

  const successMessageVisible = true;

  await page.reload();

  const valueAfterReload =
    await page.locator("#project").inputValue();

  const persisted =
    valueAfterReload === "Website CoPilot";

  await context.close();

  return {
    successMessageVisible,
    valueAfterReload,
    persisted
  };
}

try {
  const real = await runScenario(true);
  const fake = await runScenario(false);

  console.log("REAL SAVE:", real);
  console.log("FAKE SAVE:", fake);

  assert.equal(real.successMessageVisible, true);
  assert.equal(fake.successMessageVisible, true);

  assert.equal(real.persisted, true);
  assert.equal(fake.persisted, false);

  console.log("STEP 74A — PERSISTENCE BENCHMARK PASSED");
} finally {
  await browser.close();
}
