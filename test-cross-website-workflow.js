import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  runAutonomousBookWorkflow
} from "./src/agent/autonomous-workflow.js";

const origin = "https://alternate-shop.example";

const products = [
  {
    slug: "travel-backpack",
    title: "Travel Backpack",
    price: "₹2499",
    stock: 12
  },
  {
    slug: "travel-bottle",
    title: "Travel Bottle",
    price: "₹899",
    stock: 8
  },
  {
    slug: "travel-organizer",
    title: "Travel Organizer",
    price: "₹1299",
    stock: 5
  }
];

const html = body => `
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Alternate Shop</title>
</head>
<body>
  ${body}
</body>
</html>
`;

const homepage = html(`
  <header>
    <h1>Alternate Shop</h1>
  </header>

  <main>
    <nav aria-label="Categories">
      <a href="/collections/travel">Travel</a>
      <a href="/collections/electronics">Electronics</a>
    </nav>
  </main>
`);

const categoryPage = html(`
  <main>
    <h1>Travel</h1>

    <section class="inventory">
      ${products.map(product => `
        <div class="inventory-entry">
          <h2>${product.title}</h2>
          <p>${product.price}</p>

          <a href="/products/${product.slug}">
            View ${product.title}
          </a>
        </div>
      `).join("")}
    </section>
  </main>
`);

function productPage(product) {
  return html(`
    <main>
      <h1>${product.title}</h1>

      <div class="pricing">
        <strong>${product.price}</strong>
      </div>

      <p>In stock (${product.stock} available)</p>
    </main>
  `);
}

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());

    let body;
    let status = 200;

    if (url.pathname === "/") {
      body = homepage;
    } else if (
      url.pathname === "/collections/travel"
    ) {
      body = categoryPage;
    } else if (
      url.pathname.startsWith("/products/")
    ) {
      const slug = url.pathname.split("/").pop();

      const product = products.find(
        item => item.slug === slug
      );

      if (product) {
        body = productPage(product);
      } else {
        status = 404;
        body = html("<h1>Not found</h1>");
      }
    } else {
      status = 404;
      body = html("<h1>Not found</h1>");
    }

    await route.fulfill({
      status,
      contentType: "text/html; charset=utf-8",
      body
    });
  });

  console.log(
    "\n=== CROSS-WEBSITE AUTONOMOUS WORKFLOW ==="
  );

  console.log("Website:", origin);
  console.log("Category: Travel");
  console.log("Requested products: 3");

  const result = await runAutonomousBookWorkflow(
    page,
    {
      startUrl: `${origin}/`,
      category: "Travel",
      limit: 3
    }
  );

  console.log(
    "\n=== WORKFLOW RESULT ==="
  );

  console.log(
    JSON.stringify(result, null, 2)
  );

  assert.equal(
    result.status,
    "verified_complete",
    "The workflow must finish successfully."
  );

  assert.equal(
    result.collected,
    3,
    "All three products must be collected."
  );

  assert.equal(
    result.categoryUrl,
    `${origin}/collections/travel`
  );

  assert.equal(
    result.cheapest.title,
    "Travel Bottle"
  );

  assert.equal(
    result.cheapest.numericPrice,
    899
  );

  assert.deepEqual(
    result.comparison.map(item => item.numericPrice),
    [899, 1299, 2499]
  );

  assert.equal(
    new Set(result.books.map(item => item.url)).size,
    3,
    "Product URLs must be unique."
  );

  console.log(
    "\nCROSS-WEBSITE AUTONOMOUS WORKFLOW: PASSED"
  );

} finally {
  await browser.close();
}
