import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { executeNaturalLanguageTask } from "./src/agent/natural-language-executor.js";

const BASE = "https://workflow-lab.example";
const html = await readFile(
  "tests/step70/workflow.html",
  "utf8"
);

const instruction = `
Open ${BASE}/.
Navigate through Project Settings to Notification Preferences.
Set Project Name to Website CoPilot.
Set Contact Email to test@example.com.
Set Notification Channel to Dashboard.
Continue to the review page.
Confirm the preferences.
Save the preferences.
Finish only when the page says Preferences saved successfully
and shows Project: Website CoPilot,
Email: test@example.com,
Channel: Dashboard.
`.trim();

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  await page.route(`${BASE}/**`, async route => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: html
    });
  });

  console.log("\n========== STEP 70C ==========");
  console.log("AUTONOMOUS MULTI-STEP WORKFLOW");
  console.log("INSTRUCTION:", instruction);

  const result = await executeNaturalLanguageTask(
    page,
    instruction
  );

  console.log("\nAGENT STATUS:", result.status);
  console.log("FINAL URL:", page.url());

  const state = await page.evaluate(() => ({
    successVisible:
      document.querySelector("#success")?.getClientRects().length > 0,

    successHeading:
      document.querySelector("#success h2")?.textContent?.trim(),

    savedDetails:
      document.querySelector("#saved-details")?.textContent?.trim(),

    projectName:
      document.querySelector("#project-name")?.value,

    contactEmail:
      document.querySelector("#contact-email")?.value,

    channel:
      document.querySelector("#channel")?.value,

    confirmed:
      document.querySelector("#confirm")?.checked
  }));

  console.log("\nINDEPENDENT STATE:");
  console.log(JSON.stringify(state, null, 2));

  assert.equal(
    result.status,
    "verified_complete",
    "Agent did not report verified completion"
  );

  assert.equal(
    state.successVisible,
    true,
    "Success section is not visible"
  );

  assert.equal(
    state.successHeading,
    "Preferences saved successfully"
  );

  assert.equal(
    state.projectName,
    "Website CoPilot"
  );

  assert.equal(
    state.contactEmail,
    "test@example.com"
  );

  assert.equal(
    state.channel,
    "Dashboard"
  );

  assert.equal(
    state.confirmed,
    true
  );

  assert.equal(
    state.savedDetails,
    "Project: Website CoPilot | Email: test@example.com | Channel: Dashboard"
  );

  console.log(
    "\nSTEP 70C — AUTONOMOUS WORKFLOW PASSED"
  );

} finally {
  await browser.close();
}
