import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  runAutonomousBookWorkflow
} from "./src/agent/autonomous-workflow.js";

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
    "\n========== AUTONOMOUS WORKFLOW =========="
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

  assert.ok(result.navigationSteps >= 1);

  assert.ok(
    result.categoryUrl.includes(
      "/category/books/travel_"
    )
  );

  for (const book of result.books) {
    assert.ok(book.title);
    assert.ok(book.price);
    assert.ok(book.availability);
    assert.ok(book.url);
  }

  const prices = result.comparison.map(
    book => book.numericPrice
  );

  assert.ok(
    prices.every(Number.isFinite)
  );

  assert.deepEqual(
    prices,
    [...prices].sort((a, b) => a - b)
  );

  assert.equal(
    result.cheapest.numericPrice,
    Math.min(...prices)
  );

  console.log(
    "\nAUTONOMOUS WORKFLOW: PASSED"
  );

} finally {
  await browser.close();
}
