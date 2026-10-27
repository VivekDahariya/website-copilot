import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  discoverProductLinks
} from "./src/agent/generic-link-discovery.js";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  console.log("\nTEST 1 — Books to Scrape");

  await page.goto(
    "https://books.toscrape.com/catalogue/category/books/travel_2/index.html",
    { waitUntil: "domcontentloaded" }
  );

  const books = await discoverProductLinks(page, {
    limit: 3
  });

  console.log(books);

  assert.equal(books.length, 3);

  for (const book of books) {
    assert.ok(book.title);
    assert.ok(book.url.includes("books.toscrape.com"));
  }

  console.log("TEST 1: PASSED");

  console.log("\nTEST 2 — Different website layout");

  await page.setContent(`
    <!doctype html>
    <html>
      <body>
        <main>
          <div class="inventory">
            <div class="inventory-entry">
              <h2>Wireless Headphones X2</h2>
              <p>₹2,499</p>
              <a href="/shop/wireless-headphones-x2">
                View headphones
              </a>
            </div>

            <div class="inventory-entry">
              <h2>Mechanical Keyboard K8</h2>
              <p>₹3,999</p>
              <a href="/shop/mechanical-keyboard-k8">
                View keyboard
              </a>
            </div>

            <div class="inventory-entry">
              <h2>Gaming Mouse M5</h2>
              <p>₹1,299</p>
              <a href="/shop/gaming-mouse-m5">
                View mouse
              </a>
            </div>
          </div>

          <nav>
            <a href="/about">About</a>
            <a href="/contact">Contact</a>
          </nav>
        </main>
      </body>
    </html>
  `);

  const products = await discoverProductLinks(page, {
    limit: 3
  });

  console.log(products);

  assert.equal(products.length, 3);

  assert.ok(
    products.some(item =>
      item.title.includes("Wireless Headphones")
    )
  );

  assert.ok(
    products.some(item =>
      item.title.includes("Mechanical Keyboard")
    )
  );

  assert.ok(
    products.some(item =>
      item.title.includes("Gaming Mouse")
    )
  );

  console.log("TEST 2: PASSED");

  console.log(
    "\nGENERIC LINK DISCOVERY: 2/2 PASSED"
  );

} finally {
  await browser.close();
}
