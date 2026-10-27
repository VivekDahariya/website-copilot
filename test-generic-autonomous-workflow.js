import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  runAutonomousBookWorkflow
} from "./src/agent/autonomous-workflow.js";

import {
  validateExtraction
} from "./src/agent/extraction-validator.js";

console.log("\nTEST 1 — Reject incomplete records");

const invalid = validateExtraction(
  {
    title: "Example",
    price: null,
    availability: "",
    url: "https://example.com/product"
  },
  {
    expectedUrl: "https://example.com/product"
  }
);

assert.equal(invalid.valid, false);
assert.ok(invalid.errors.length >= 2);

console.log("TEST 1: PASSED");

console.log("\nTEST 2 — Reject mismatched URLs");

const mismatched = validateExtraction(
  {
    title: "Example Product",
    price: "£12.50",
    availability: "In stock",
    url: "https://example.com/wrong"
  },
  {
    expectedUrl: "https://example.com/correct"
  }
);

assert.equal(mismatched.valid, false);

assert.ok(
  mismatched.errors.some(
    error => error.includes("URL does not match")
  )
);

console.log("TEST 2: PASSED");

console.log("\nTEST 3 — Reject invalid prices");

const invalidPrice = validateExtraction(
  {
    title: "Example Product",
    price: "Contact us",
    availability: "In stock",
    url: "https://example.com/product"
  },
  {
    expectedUrl: "https://example.com/product"
  }
);

assert.equal(invalidPrice.valid, false);

console.log("TEST 3: PASSED");

console.log("\nTEST 4 — Real autonomous workflow");

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  const result = await runAutonomousBookWorkflow(
    page,
    {
      startUrl: "https://books.toscrape.com/",
      category: "Travel",
      limit: 3
    }
  );

  console.log(
    JSON.stringify(result, null, 2)
  );

  assert.equal(
    result.status,
    "verified_complete"
  );

  assert.equal(result.collected, 3);

  assert.equal(
    result.comparison.length,
    3
  );

  assert.equal(
    result.cheapest.title,
    "It's Only the Himalayas"
  );

  for (const record of result.books) {
    const validation = validateExtraction(record, {
      expectedUrl: record.url
    });

    assert.equal(validation.valid, true);
  }

  console.log("TEST 4: PASSED");

} finally {
  await browser.close();
}

console.log(
  "\nGENERIC AUTONOMOUS WORKFLOW: 4/4 PASSED"
);
