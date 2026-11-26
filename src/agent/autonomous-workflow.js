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

// Preserve the currency identity from each source listing. A numeric sort
// across different currencies would make a false claim about the cheapest item.
export function buildProductPriceComparison(books) {
  const comparison = books.map(book => {
    const match = String(book.price ?? "").trim().match(
      /^([£₹$€])\s*(\d[\d,]*(?:\.\d{1,2})?)$/
    );
    const numericPrice = match
      ? Number(match[2].replace(/,/g, ""))
      : null;
    return {
      title: book.title,
      price: book.price,
      numericPrice: Number.isFinite(numericPrice) ? numericPrice : null,
      currency: match?.[1] ?? null,
      availability: book.availability,
      url: book.url
    };
  });

  const currencies = [...new Set(
    comparison.map(item => item.currency).filter(Boolean)
  )].sort();
  const comparable = currencies.length === 1 &&
    comparison.length > 0 &&
    comparison.every(item => item.numericPrice !== null);

  if (!comparable) {
    return {
      comparable: false,
      currencies,
      comparison,
      cheapest: null,
      reason: currencies.length > 1
        ? "Products use different currencies; no exchange rates were verified."
        : "One or more product prices are not reliably comparable."
    };
  }

  comparison.sort((a, b) => a.numericPrice - b.numericPrice);
  return { comparable: true, currencies, comparison, cheapest: comparison[0] };
}


function normalizeProductTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Accept only unique, exact-title links actually observed on the
// starting website. No web search, guessed path, or cross-origin URL.
export function resolveNamedProductLinks(
  observedLinks, requestedNames, startUrl
) {
  let source;
  try {
    source = new URL(startUrl);
    if (!["http:", "https:"].includes(source.protocol))
      return null;
  } catch {
    return null;
  }

  if (!Array.isArray(observedLinks) ||
      !Array.isArray(requestedNames) ||
      requestedNames.length !== 2) {
    return null;
  }

  const resolved = [];

  for (const name of requestedNames) {
    const urls = new Set();

    for (const item of observedLinks) {
      const labels = [
        item?.title,
        item?.label
      ];

      if (!labels.some(value =>
        normalizeProductTitle(value) ===
        normalizeProductTitle(name)
      )) continue;

      try {
        const url = new URL(item.href, source);
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.origin !== source.origin ||
          url.username ||
          url.password
        ) continue;

        urls.add(url.href);
      } catch {
        continue;
      }
    }

    if (urls.size !== 1) return null;

    resolved.push({
      title: name,
      url: [...urls][0]
    });
  }

  if (resolved[0].url === resolved[1].url)
    return null;

  return resolved;
}

export function buildNamedPriceDifference(pricing) {
  if (
    pricing?.comparable !== true ||
    pricing.comparison?.length !== 2 ||
    pricing.currencies?.length !== 1
  ) return null;

  const [first, second] = pricing.comparison;
  const cents = Math.round(
    Math.abs(first.numericPrice - second.numericPrice) * 100
  );

  return {
    currency: pricing.currencies[0],
    amount: cents / 100,
    display: pricing.currencies[0] +
      (cents / 100).toFixed(2),
    tied: cents === 0
  };
}

async function runNamedProductComparison(
  page, startUrl, productNames
) {
  if (
    !Array.isArray(productNames) ||
    productNames.length !== 2
  ) {
    throw new Error(
      "Named comparison requires exactly two products."
    );
  }

  const memory = createWorkflowMemory();

  await page.goto(startUrl, {
    waitUntil: "domcontentloaded"
  });

  // Extract real link identities from the current DOM, not guesses
  // constructed from product names.
  const observedLinks = await page.locator("a[href]")
    .evaluateAll(anchors => anchors.map(anchor => ({
      title: anchor.getAttribute("title") || "",
      label: (anchor.textContent || "").trim(),
      href: anchor.href
    })));

  const links = resolveNamedProductLinks(
    observedLinks, productNames, startUrl
  );

  if (!links) {
    return {
      status: "named_product_links_unverified",
      requestedNames: productNames,
      books: [],
      reason: "Both exact product links could not be uniquely verified on the starting page."
    };
  }

  for (const link of links) {
    await page.goto(link.url, {
      waitUntil: "domcontentloaded"
    });

    const verification = await verifyProductPage(
      page,
      {
        expectedUrl: link.url,
        listingTitle: link.title
      }
    );

    if (!verification.valid) {
      return {
        status: "product_page_verification_failed",
        failedProduct: link.title,
        verification,
        books: memory.getAll()
      };
    }

    const record = await extractGenericInformation(page);

    const validation = validateExtraction(record, {
      expectedUrl: link.url,
      requiredFields: [
        "title", "price", "availability"
      ]
    });

    if (!validation.valid ||
        normalizeProductTitle(record.title) !==
          normalizeProductTitle(link.title)) {
      return {
        status: "extraction_validation_failed",
        failedProduct: link.title,
        validation,
        books: memory.getAll()
      };
    }

    memory.add(record);
  }

  const books = memory.getAll();

  if (
    books.length !== 2 ||
    new Set(
      books.map(book => normalizeProductTitle(book.title))
    ).size !== 2
  ) {
    return {
      status: "comparison_evidence_incomplete",
      books
    };
  }

  const pricing = buildProductPriceComparison(books);
  const priceDifference =
    buildNamedPriceDifference(pricing);

  if (!priceDifference) {
    return {
      status: "currency_comparison_unavailable",
      requestedNames: productNames,
      books,
      comparison: pricing.comparison,
      reason: pricing.reason
    };
  }

  return {
    status: "verified_complete",
    comparisonMode: "named_products",
    requestedNames: productNames,
    requested: 2,
    collected: 2,
    books,
    comparison: pricing.comparison,
    cheapest: priceDifference.tied
      ? null : pricing.cheapest,
    priceDifference
  };
}

export async function runAutonomousBookWorkflow(
  page,
  {
    // No built-in website or category: the caller supplies both.
    startUrl,
    category,
    limit = 3,
    productNames = null,
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

  if (Array.isArray(productNames)) {
    return runNamedProductComparison(
      page, startUrl, productNames
    );
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

  const pricing = buildProductPriceComparison(books);

  if (!pricing.comparable) {
    return {
      status: "currency_comparison_unavailable",
      category,
      categoryUrl,
      requested: limit,
      collected: books.length,
      navigationSteps: navigation.steps,
      books,
      currencies: pricing.currencies,
      comparison: pricing.comparison,
      cheapest: null,
      reason: pricing.reason
    };
  }

  const { comparison } = pricing;

  return {
    status: "verified_complete",
    category,
    categoryUrl,
    requested: limit,
    collected: books.length,
    navigationSteps: navigation.steps,
    books,
    comparison,
    cheapest: pricing.cheapest
  };
}
