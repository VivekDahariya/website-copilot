import { verifyCategoryPage } from "./category-page-verifier.js";
import { runAgent } from "./agent.js";
import { createWorkflowMemory } from "./workflow-memory.js";

import {
  extractBookLinks
} from "./information-extractor.js";

import {
  extractGenericInformation
} from "./generic-information-extractor.js";

import {
  discoverProductLinks
} from "./generic-link-discovery.js";

import {
  verifyProductPage
} from "./product-page-verifier.js";

import {
  validateExtraction
} from "./extraction-validator.js";

function parsePrice(price) {
  const value = Number(
    String(price).replace(/[^\d.]/g, "")
  );

  return Number.isFinite(value) ? value : null;
}

export async function runAutonomousBookWorkflow(
  page,
  {
    startUrl = "https://books.toscrape.com/",
    category = "Travel",
    limit = 3,
    reasoner
  } = {}
) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10
  ) {
    throw new Error("limit must be between 1 and 10.");
  }

  if (
    !/^[a-z][a-z\s-]*$/i.test(category)
  ) {
    throw new Error("Invalid category.");
  }

  const memory = createWorkflowMemory();

  await page.goto(startUrl, {
    waitUntil: "domcontentloaded"
  });

  const task =
    `Find the ${category} category on this website ` +
    `and open its category page.`;

// For this test website, the category's URL has
  // a numeric suffix. We verify the page by heading
  // and category path rather than assuming that suffix.
  const goal = {
    type: "page_destination",
    hostname: new URL(startUrl).hostname,
    pathnamePattern: "^/(?!$).+",
    heading: category
  };

  const agentOptions = reasoner
    ? { reasoner }
    : {};

  const navigation = await runAgent(
    page,
    task,
    goal,
    agentOptions
  );

  if (navigation.status !== "verified_complete") {
    return {
      status: "navigation_failed",
      navigation,
      books: []
    };
  }

  const categoryUrl = page.url();


  const categoryVerification = await verifyCategoryPage(
    page,
    {
      category,
      startUrl,
      minimumProducts: limit
    }
  );

  if (!categoryVerification.valid) {
    return {
      status: "category_verification_failed",
      category,
      categoryUrl: page.url(),
      verification: categoryVerification
    };
  }

  const links = await discoverProductLinks(page, { limit });

  if (links.length < limit) {
    return {
      status: "insufficient_books",
      categoryUrl,
      expected: limit,
      found: links.length,
      books: []
    };
  }

  for (const link of links) {
    await page.goto(link.url, {
      waitUntil: "domcontentloaded"
    });



    const pageVerification = await verifyProductPage(
      page,
      {
        expectedUrl: link.url,
        listingTitle: link.title
      }
    );

    if (!pageVerification.valid) {
      return {
        status: "product_page_verification_failed",
        categoryUrl,
        failedUrl: link.url,
        verification: pageVerification,
        books: memory.getAll()
      };
    }

    const record = await extractGenericInformation(page);

    const validation = validateExtraction(record, {
      expectedUrl: link.url,
      requiredFields: [
        "title",
        "price",
        "availability"
      ]
    });

    if (!validation.valid) {
      return {
        status: "extraction_validation_failed",
        categoryUrl,
        failedUrl: link.url,
        validation,
        books: memory.getAll()
      };
    }

    memory.add(record);
  }

  const books = memory.getAll();

  const comparison = books
    .map(book => ({
      title: book.title,
      price: book.price,
      numericPrice: parsePrice(book.price),
      availability: book.availability,
      url: book.url
    }))
    .sort((a, b) =>
      (a.numericPrice ?? Infinity) -
      (b.numericPrice ?? Infinity)
    );

  return {
    status: "verified_complete",
    category,
    categoryUrl,
    requested: limit,
    collected: books.length,
    navigationSteps: navigation.steps,
    books,
    comparison,
    cheapest: comparison[0] ?? null
  };
}
