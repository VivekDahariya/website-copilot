import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  createProgressGuard
} from "./src/agent/progress-guard.js";

import {
  observePage
} from "./src/observer/dom-observer.js";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  await page.route("https://loop.test/**", async route => {
    const pathname = new URL(route.request().url()).pathname;

    const isPageA = pathname === "/a";

    const html = isPageA
      ? `
        <html>
          <head><title>Page A</title></head>
          <body>
            <h1>Page A</h1>
            <a href="/b">Go to B</a>
          </body>
        </html>
      `
      : `
        <html>
          <head><title>Page B</title></head>
          <body>
            <h1>Page B</h1>
            <a href="/a">Go to A</a>
          </body>
        </html>
      `;

    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: html
    });
  });

  await page.goto("https://loop.test/a");

  const guard = createProgressGuard(page.url());

  // STEP 1: A -> B

  const observationA1 = await observePage(page);

  const linkB1 = observationA1.actionableElements.find(
    element => element.label === "Go to B"
  );

  assert.ok(linkB1, "Link B missing.");

  const decisionB = {
    ref: linkB1.ref,
    operation: "click",
    value: ""
  };

  assert.equal(
    guard.check(observationA1, linkB1, decisionB).allowed,
    true
  );

  guard.recordAttempt(observationA1, linkB1, decisionB);

  await page.goto("https://loop.test/b");

  guard.recordNavigation(page.url());

  // STEP 2: B -> A (legitimate revisit)

  const observationB = await observePage(page);

  const linkA = observationB.actionableElements.find(
    element => element.label === "Go to A"
  );

  assert.ok(linkA, "Link A missing.");

  const decisionA = {
    ref: linkA.ref,
    operation: "click",
    value: ""
  };

  assert.equal(
    guard.check(observationB, linkA, decisionA).allowed,
    true,
    "First return to A should be permitted."
  );

  guard.recordAttempt(observationB, linkA, decisionA);

  await page.goto("https://loop.test/a");

  guard.recordNavigation(page.url());

  assert.equal(
    guard.getVisitCount("https://loop.test/a"),
    2
  );

  // STEP 3: A -> B again must be rejected.
  // The same action was already attempted on Page A.

  const observationA2 = await observePage(page);

  const linkB2 = observationA2.actionableElements.find(
    element => element.label === "Go to B"
  );

  assert.ok(linkB2, "Link B missing after returning.");

  const repeatedDecision = {
    ref: linkB2.ref,
    operation: "click",
    value: ""
  };

  const repeatedCheck = guard.check(
    observationA2,
    linkB2,
    repeatedDecision
  );

  assert.equal(repeatedCheck.allowed, false);
  assert.equal(repeatedCheck.reason, "repeated_action_same_state");

  console.log(
    "NAVIGATION LOOP REGRESSION: PASSED"
  );

} finally {
  await browser.close();
}
