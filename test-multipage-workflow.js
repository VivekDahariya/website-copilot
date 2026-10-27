import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  compareBooks
} from "./src/agent/book-comparison-workflow.js";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  const result = await compareBooks(page, {
    categoryUrl:
      "https://books.toscrape.com/catalogue/category/books/travel_2/index.html",
    limit: 3
  });

  console.log(
    "\n========== MULTI-PAGE WORKFLOW =========="
  );

  console.log(JSON.stringify(result, null, 2));

  assert.equal(result.status, "completed");
  assert.equal(result.collected, 3);
  assert.equal(result.books.length, 3);

  const urls = new Set();

  for (const book of result.books) {
    assert.ok(book.title);
    assert.ok(book.price);
    assert.ok(book.availability);
    assert.ok(book.url);

    assert.equal(
      urls.has(book.url),
      false,
      "Duplicate book URL"
    );

    urls.add(book.url);
  }

  console.log(
    "\nMULTI-PAGE WORKFLOW: PASSED"
  );

} finally {
  await browser.close();
}
