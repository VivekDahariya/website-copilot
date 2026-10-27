import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  executeNaturalLanguageTask
} from "./src/agent/natural-language-executor.js";

const BASE = "https://generalization-test.example";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  await page.route(`${BASE}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;

    const pages = {
      "/": `
        <html>
          <head><title>Atlas Workspace</title></head>
          <body>
            <h1>Atlas Workspace</h1>
            <nav>
              <a href="/company">Company</a>
              <a href="/resources">Resources</a>
              <a href="/help">Help Center</a>
            </nav>
          </body>
        </html>
      `,

      "/company": `
        <html>
          <head><title>Company</title></head>
          <body>
            <h1>Company</h1>
            <a href="/">Home</a>
            <a href="/company/team">Our Team</a>
          </body>
        </html>
      `,

      "/resources": `
        <html>
          <head><title>Resources</title></head>
          <body>
            <h1>Resources</h1>
            <a href="/resources/guides">Guides</a>
          </body>
        </html>
      `,

      "/help": `
        <html>
          <head><title>Help Center</title></head>
          <body>
            <h1>Help Center</h1>
            <a href="/help/account">Account Help</a>
            <a href="/help/security">Security Guide</a>
          </body>
        </html>
      `,

      "/help/account": `
        <html>
          <head><title>Account Help</title></head>
          <body>
            <h1>Account Help</h1>
            <p>Manage your profile and account preferences.</p>
          </body>
        </html>
      `,

      "/help/security": `
        <html>
          <head><title>Security Guide</title></head>
          <body>
            <h1>Security Guide</h1>
            <p>Enable two-factor authentication to protect your account.</p>
          </body>
        </html>
      `
    };

    await route.fulfill({
      status: pages[pathname] ? 200 : 404,
      contentType: "text/html",
      body: pages[pathname] ?? "<h1>Not Found</h1>"
    });
  });

  const instruction =
    `Open ${BASE}/, find the Security Guide through ` +
    `the Help Center, and verify that it explains ` +
    `two-factor authentication.`;

  console.log("\n========== STEP 56A ==========");
  console.log("INSTRUCTION:", instruction);

  const result = await executeNaturalLanguageTask(
    page,
    instruction
  );

  console.log("\nINTERPRETED TASK:");
  console.dir(result.interpretedTask, { depth: null });

  console.log("\nRESULT STATUS:", result.status);

  assert.equal(
    result.status,
    "verified_complete",
    `Execution failed: ${JSON.stringify(result)}`
  );

  assert.equal(
    page.url(),
    `${BASE}/help/security`,
    "Agent reached the wrong destination."
  );

  const heading = await page
    .getByRole("heading", {
      name: "Security Guide",
      exact: true
    })
    .isVisible();

  assert.equal(heading, true);

  const content = await page.locator("body").innerText();

  assert.match(
    content,
    /two-factor authentication/i
  );

  console.log("\nFINAL URL:", page.url());
  console.log("HEADING VERIFIED:", heading);
  console.log("CONTENT VERIFIED:", true);
  console.log(
    "ACTIONS:",
    result.execution?.result?.steps
  );

  console.log(
    "\nSTEP 56A — UNSEEN NAVIGATION PASSED"
  );

} finally {
  await browser.close();
}
