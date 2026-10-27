import assert from "node:assert/strict";
import { chromium } from "playwright";
import { observePage } from "../../src/observer/dom-observer.js";

const browser = await chromium.launch({ headless: true });

let passed = 0;
let failed = 0;

async function run(name, html, check) {
  const page = await browser.newPage();

  try {
    await page.setContent(html);

    const observation = await observePage(page);
    const result = check(observation.actionableElements);

    assert.equal(result, true);

    passed++;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(error.message);
  } finally {
    await page.close();
  }
}

try {
  await run(
    "Native form submit button",
    `
      <form id="settings" method="post">
        <label for="project">Project Name</label>
        <input id="project" name="projectName">
        <button type="submit">Save</button>
      </form>
    `,
    elements => {
      const button = elements.find(e => e.label === "Save");

      return (
        button?.effectiveType === "submit" &&
        button.formContext.associated === true &&
        button.formContext.id === "settings" &&
        button.formContext.method === "post" &&
        button.formContext.fields.some(
          field =>
            field.name === "projectName" &&
            field.label === "Project Name"
        )
      );
    }
  );

  await run(
    "External button linked through form attribute",
    `
      <form id="preferences">
        <input name="theme" aria-label="Theme">
      </form>
      <button form="preferences" type="submit">
        Apply
      </button>
    `,
    elements => {
      const button = elements.find(e => e.label === "Apply");

      return (
        button?.formContext.associated === true &&
        button.formContext.id === "preferences" &&
        button.effectiveType === "submit" &&
        button.formContext.fields.some(
          field => field.name === "theme"
        )
      );
    }
  );

  await run(
    "Intermediate filter button",
    `
      <section>
        <input aria-label="Search">
        <button type="button">Apply Filter</button>
      </section>
    `,
    elements => {
      const button = elements.find(
        e => e.label === "Apply Filter"
      );

      return (
        button?.effectiveType === "button" &&
        button.formContext.associated === false
      );
    }
  );

  await run(
    "Unlabeled icon-only submit button",
    `
      <form id="profile">
        <input name="displayName" aria-label="Display Name">
        <button type="submit">
          <svg width="20" height="20"></svg>
        </button>
      </form>
    `,
    elements => {
      const button = elements.find(
        e => e.tag === "button"
      );

      return (
        button?.label === "" &&
        button.effectiveType === "submit" &&
        button.formContext.associated === true &&
        button.formContext.id === "profile"
      );
    }
  );

  await run(
    "Default button type inside form",
    `
      <form id="account">
        <input name="username">
        <button>Continue</button>
      </form>
    `,
    elements => {
      const button = elements.find(
        e => e.label === "Continue"
      );

      return (
        button?.effectiveType === "submit" &&
        button.formContext.associated === true
      );
    }
  );

  await run(
    "Explicit non-submit button inside form",
    `
      <form id="editor">
        <input name="title">
        <button type="button">Preview</button>
      </form>
    `,
    elements => {
      const button = elements.find(
        e => e.label === "Preview"
      );

      return (
        button?.effectiveType === "button" &&
        button.formContext.associated === true
      );
    }
  );

} finally {
  await browser.close();
}

console.log("\n========== STEP 74K.10C ==========");
console.log(`Passed: ${passed}/6`);
console.log(`Failed: ${failed}/6`);

if (failed > 0) {
  process.exitCode = 1;
}
