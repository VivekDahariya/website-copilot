import { chromium } from "playwright";

import {
  discoverProductLinks
} from "./src/agent/generic-link-discovery.js";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

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

  console.log("\n=== RAW DOM EVIDENCE ===");

  const evidence = await page.evaluate(() => {
    return Array.from(
      document.querySelectorAll("a[href]")
    ).map(anchor => {
      const parent = anchor.parentElement;

      return {
        href: anchor.href,
        anchorText: anchor.textContent.trim(),
        parentClass: parent?.className,
        parentText: parent?.textContent
          ?.replace(/\s+/g, " ")
          .trim(),
        heading: parent
          ?.querySelector("h2")
          ?.textContent
          ?.trim(),
        price: parent
          ?.querySelector("p")
          ?.textContent
          ?.trim()
      };
    });
  });

  console.log(
    JSON.stringify(evidence, null, 2)
  );

  console.log("\n=== DISCOVERY ENGINE OUTPUT ===");

  const candidates = await discoverProductLinks(
    page,
    { limit: 10 }
  );

  console.log(
    JSON.stringify(candidates, null, 2)
  );

  console.log("\n=== DIAGNOSTIC SUMMARY ===");

  console.log({
    rawLinks: evidence.length,
    discoveredLinks: candidates.length,
    priceBearingCandidates:
      candidates.filter(
        item => item.evidence?.hasPrice
      ).length,
    candidatesWithHeadings:
      candidates.filter(
        item => item.evidence?.hasHeading
      ).length
  });

} finally {
  await browser.close();
}
