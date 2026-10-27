import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  runAutonomousBookWorkflow
} from "./src/agent/autonomous-workflow.js";

import {
  verifyProductPage
} from "./src/agent/product-page-verifier.js";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  console.log("\nTEST 1 — Reject unrelated page");

  await page.setContent(`
    <!doctype html>
    <html>
      <body>
        <h1>Contact Us</h1>
        <main>
          <p>Send us your questions.</p>
        </main>
      </body>
    </html>
  `);

  const unrelated = await verifyProductPage(
    page,
    {
      expectedUrl: "https://example.com/product",
      listingTitle: "Wireless Headphones"
    }
  );

  assert.equal(unrelated.valid, false);

  console.log("TEST 1: PASSED");

  console.log("\nTEST 2 — Real product verification");

  await page.goto(
    "https://books.toscrape.com/catalogue/its-only-the-himalayas_981/index.html",
    { waitUntil: "domcontentloaded" }
  );

  const validProduct = await verifyProductPage(
    page,
    {
      expectedUrl: page.url(),
      listingTitle: "It's Only the Himalayas"
    }
  );

  assert.equal(validProduct.valid, true);

  console.log("TEST 2: PASSED");

  console.log("\nTEST 3 — Generic autonomous workflow");

  const result = await runAutonomousBookWorkflow(
    page,
    {
      startUrl: "https://books.toscrape.com/",
      category: "Travel",
      limit: 3
    }
  );

  console.log(JSON.stringify(result, null, 2));

  assert.equal(
    result.status,
    "verified_complete"
  );

  assert.equal(result.collected, 3);

  assert.equal(result.comparison.length, 3);

  assert.equal(
    result.cheapest.title,
    "It's Only the Himalayas"
  );

  console.log("TEST 3: PASSED");

} finally {
  await browser.close();
}

console.log(
  "\nGENERIC PRODUCTION WORKFLOW: 3/3 PASSED"
);
