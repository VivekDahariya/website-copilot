import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  verifyCategoryPage
} from "./src/agent/category-page-verifier.js";

import {
  runAutonomousBookWorkflow
} from "./src/agent/autonomous-workflow.js";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  console.log("\nTEST 1 — Reject starting page");

  await page.goto(
    "https://books.toscrape.com/",
    { waitUntil: "domcontentloaded" }
  );

  const homepage = await verifyCategoryPage(
    page,
    {
      category: "Travel",
      startUrl: page.url(),
      minimumProducts: 2
    }
  );

  assert.equal(homepage.valid, false);
  assert.equal(
    homepage.evidence.navigationConfirmed,
    false
  );

  console.log("TEST 1: PASSED");

  console.log(
    "\nTEST 2 — Different category URL structure"
  );

  await page.route(
    "https://demo.example/collections/travel",
    async route => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `
          <!doctype html>
          <html>
            <head><meta charset="UTF-8">
              <title>Travel Collection</title>
            </head>
            <body>
              <main>
                <h1>Travel</h1>

                <section class="inventory">
                  <div class="inventory-entry">
                    <h2>Travel Backpack</h2>
                    <p>₹2,499</p>
                    <a href="/products/travel-backpack">
                      View backpack
                    </a>
                  </div>

                  <div class="inventory-entry">
                    <h2>Travel Bottle</h2>
                    <p>₹899</p>
                    <a href="/products/travel-bottle">
                      View bottle
                    </a>
                  </div>

                  <div class="inventory-entry">
                    <h2>Travel Organizer</h2>
                    <p>₹1,299</p>
                    <a href="/products/travel-organizer">
                      View organizer
                    </a>
                  </div>
                </section>
              </main>
            </body>
          </html>
        `
      });
    }
  );

  await page.goto(
    "https://demo.example/collections/travel"
  );

  const alternative = await verifyCategoryPage(
    page,
    {
      category: "Travel",
      startUrl: "https://demo.example/",
      minimumProducts: 3
    }
  );

  console.log(
    JSON.stringify(alternative, null, 2)
  );

  assert.equal(alternative.valid, true);
  assert.equal(
    alternative.evidence.productCandidates,
    3
  );

  console.log("TEST 2: PASSED");

  console.log(
    "\nTEST 3 — Reject incorrect category identity"
  );

  const wrongCategory = await verifyCategoryPage(
    page,
    {
      category: "Electronics",
      startUrl: "https://demo.example/",
      minimumProducts: 3
    }
  );

  assert.equal(wrongCategory.valid, false);

  console.log("TEST 3: PASSED");

  console.log(
    "\nTEST 4 — Real autonomous workflow"
  );

  const result = await runAutonomousBookWorkflow(
    page,
    {
      startUrl: "https://books.toscrape.com/",
      category: "Travel",
      limit: 3
    }
  );

  assert.equal(
    result.status,
    "verified_complete",
    JSON.stringify(result, null, 2)
  );

  assert.equal(result.collected, 3);

  assert.equal(
    result.cheapest.title,
    "It's Only the Himalayas"
  );

  console.log("TEST 4: PASSED");

} finally {
  await browser.close();
}

console.log(
  "\nGENERIC CATEGORY NAVIGATION: 4/4 PASSED"
);
