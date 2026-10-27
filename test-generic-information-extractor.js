import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  extractGenericInformation
} from "./src/agent/generic-information-extractor.js";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  console.log("\nTEST 1 — Books to Scrape");

  await page.goto(
    "https://books.toscrape.com/catalogue/its-only-the-himalayas_981/index.html",
    { waitUntil: "domcontentloaded" }
  );

  const book = await extractGenericInformation(page);

  console.log(book);

  assert.equal(book.title, "It's Only the Himalayas");
  assert.equal(book.price, "£45.17");
  assert.match(book.availability, /in stock/i);

  console.log("TEST 1: PASSED");

  console.log("\nTEST 2 — Different HTML structure");

  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <title>Independent Product Website</title>
      </head>
      <body>
        <header>Independent Store</header>
        <main>
          <section>
            <div>
              <h1>Wireless Headphones X2</h1>
            </div>
            <section>
              <div>
                <span>Price:</span>
                <strong>₹2,499</strong>
              </div>
              <div>
                <p>In stock (8 available)</p>
              </div>
            </section>
          </section>
        </main>
      </body>
    </html>
  `);

  const product = await extractGenericInformation(page);

  console.log(product);

  assert.equal(
    product.title,
    "Wireless Headphones X2"
  );

  assert.equal(product.price, "₹2,499");

  assert.match(product.availability, /in stock/i);

  console.log("TEST 2: PASSED");

  console.log(
    "\nGENERIC INFORMATION EXTRACTION: 2/2 PASSED"
  );

} finally {
  await browser.close();
}
