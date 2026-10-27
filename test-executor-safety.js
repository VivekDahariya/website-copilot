import assert from "node:assert/strict";
import { chromium } from "playwright";
import { observePage } from "./src/observer/dom-observer.js";
import { executeAction } from "./src/executor/action-executor.js";

const browser = await chromium.launch({ headless: true });
let passed = 0;

async function test(name, html, label, operation, value, expected, verify) {
  const page = await browser.newPage();

  try {
    await page.setContent(html);
    const observation = await observePage(page);

    const element = observation.actionableElements.find(
      item => item.label === label
    );

    assert.ok(element, `Missing element: ${label}`);

    let error = null;

    try {
      await executeAction(page, {
        ref: element.ref,
        operation,
        value
      });
    } catch (caught) {
      error = caught;
    }

    if (expected === "allowed") {
      assert.equal(error, null, error?.message);
    } else {
      assert.ok(error, "Expected executor to reject action");
      assert.match(error.message, /SAFETY_/);
    }

    await verify(page);

    passed++;
    console.log("PASSED:", name);
  } finally {
    await page.close();
  }
}

try {
  await test(
    "Direct Send Message blocked",
    `<button onclick="window.sent=true">Send Message</button>`,
    "Send Message",
    "click",
    "",
    "blocked",
    async page => {
      assert.equal(await page.evaluate(() => window.sent), undefined);
    }
  );

  await test(
    "Direct Delete Account blocked",
    `<button onclick="window.deleted=true">Delete Account</button>`,
    "Delete Account",
    "click",
    "",
    "blocked",
    async page => {
      assert.equal(await page.evaluate(() => window.deleted), undefined);
    }
  );

  await test(
    "Password filling blocked",
    `<label for="p">Password</label><input id="p" type="password">`,
    "Password",
    "fill",
    "secret",
    "blocked",
    async page => {
      assert.equal(await page.locator("#p").inputValue(), "");
    }
  );

  await test(
    "Unlabelled submit blocked",
    `<form onsubmit="window.submitted=true;return false">
       <button type="submit">Continue</button>
     </form>`,
    "Continue",
    "click",
    "",
    "blocked",
    async page => {
      assert.equal(await page.evaluate(() => window.submitted), undefined);
    }
  );

  await test(
    "Ordinary button allowed",
    `<button onclick="window.clicked=true">Show Details</button>`,
    "Show Details",
    "click",
    "",
    "allowed",
    async page => {
      assert.equal(await page.evaluate(() => window.clicked), true);
    }
  );

  await test(
    "Ordinary form filling allowed",
    `<label for="n">Full Name</label><input id="n">`,
    "Full Name",
    "fill",
    "Vivek",
    "allowed",
    async page => {
      assert.equal(await page.locator("#n").inputValue(), "Vivek");
    }
  );

  console.log(`\nEXECUTOR SAFETY: ${passed}/6 PASSED`);
} finally {
  await browser.close();
}
