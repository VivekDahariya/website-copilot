import {
  extractBookInformation,
  extractBookLinks
} from "./information-extractor.js";

import {
  createWorkflowMemory
} from "./workflow-memory.js";

export async function compareBooks(
  page,
  {
    categoryUrl,
    limit = 3
  }
) {
  if (!categoryUrl) {
    throw new Error("categoryUrl is required.");
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("limit must be between 1 and 10.");
  }

  const memory = createWorkflowMemory();

  await page.goto(categoryUrl, {
    waitUntil: "domcontentloaded"
  });

  await page.locator(
    "article.product_pod"
  ).first().waitFor();

  const links = await extractBookLinks(page, limit);

  if (links.length < limit) {
    throw new Error(
      `Expected ${limit} books, found ${links.length}.`
    );
  }

  for (const link of links) {
    await page.goto(link.url, {
      waitUntil: "domcontentloaded"
    });

    await page.locator(
      ".product_main h1"
    ).waitFor();

    const record = await extractBookInformation(page);

    if (!record.title || !record.price) {
      throw new Error(
        `Incomplete extraction at ${link.url}`
      );
    }

    memory.add(record);
  }

  return {
    status: "completed",
    categoryUrl,
    requested: limit,
    collected: memory.count(),
    books: memory.getAll()
  };
}
