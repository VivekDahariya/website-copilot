import assert from "node:assert/strict";
import { chromium } from "playwright";
import { observePage } from "./src/observer/dom-observer.js";
import { executeAction } from "./src/executor/action-executor.js";

const browser = await chromium.launch({ headless: true });
let passed = 0;

async function test({
  name,
  html,
  label,
  operation,
  value = "",
  blocked = false,
  verify
}) {
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

    if (blocked) {
      assert.ok(error, "Expected blocked action");
      assert.match(error.message, /SAFETY_/);
    } else {
      assert.equal(error, null, error?.message);
    }

    await verify(page);

    passed++;
    console.log("PASSED:", name);
  } finally {
    await page.close();
  }
}

try {
  await test({
    name: "Ordinary dropdown selection",
    html: `
      <label for="city">City</label>
      <select id="city">
        <option value="raipur">Raipur</option>
        <option value="durg">Durg</option>
      </select>
    `,
    label: "City",
    operation: "select",
    value: "durg",
    verify: async page => {
      assert.equal(
        await page.locator("#city").inputValue(),
        "durg"
      );
    }
  });

  await test({
    name: "Ordinary checkbox",
    html: `
      <label>
        <input id="updates" type="checkbox">
        Show updates
      </label>
    `,
    label: "Show updates",
    operation: "check",
    verify: async page => {
      assert.equal(
        await page.locator("#updates").isChecked(),
        true
      );
    }
  });

  await test({
    name: "Ordinary keyboard typing",
    html: `
      <label for="search">Search</label>
      <input id="search">
    `,
    label: "Search",
    operation: "press",
    value: "a",
    verify: async page => {
      assert.equal(
        await page.locator("#search").inputValue(),
        "a"
      );
    }
  });

  await test({
    name: "Enter key requires approval",
    html: `
      <label for="search">Search</label>
      <input id="search">
    `,
    label: "Search",
    operation: "press",
    value: "Enter",
    blocked: true,
    verify: async page => {
      assert.equal(
        await page.locator("#search").inputValue(),
        ""
      );
    }
  });

  await test({
    name: "Sensitive dropdown blocked",
    html: `
      <label for="account">Delete Account</label>
      <select id="account">
        <option value="no">No</option>
        <option value="yes">Yes</option>
      </select>
    `,
    label: "Delete Account",
    operation: "select",
    value: "yes",
    blocked: true,
    verify: async page => {
      assert.equal(
        await page.locator("#account").inputValue(),
        "no"
      );
    }
  });

  await test({
    name: "Sensitive checkbox blocked",
    html: `
      <label>
        <input id="transfer" type="checkbox">
        Confirm Transfer
      </label>
    `,
    label: "Confirm Transfer",
    operation: "check",
    blocked: true,
    verify: async page => {
      assert.equal(
        await page.locator("#transfer").isChecked(),
        false
      );
    }
  });

  console.log(`\nACTION CATALOG: ${passed}/6 PASSED`);
} finally {
  await browser.close();
}
