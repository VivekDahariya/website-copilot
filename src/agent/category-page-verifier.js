import {
  discoverProductLinks
} from "./generic-link-discovery.js";

function normalize(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export async function verifyCategoryPage(
  page,
  {
    category,
    startUrl,
    minimumProducts = 2
  } = {}
) {
  if (!category || !startUrl) {
    throw new Error(
      "category and startUrl are required."
    );
  }

  const errors = [];

  const currentUrl = canonicalUrl(page.url());
  const initialUrl = canonicalUrl(startUrl);

  const navigationConfirmed =
    Boolean(currentUrl && initialUrl) &&
    currentUrl !== initialUrl;

  if (!navigationConfirmed) {
    errors.push(
      "Browser has not navigated away from the starting page."
    );
  }

  const snapshot = await page.evaluate(() => {
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const headings = Array.from(
      document.querySelectorAll("h1,h2,h3")
    )
      .filter(visible)
      .map(element =>
        element.textContent.replace(/\s+/g, " ").trim()
      )
      .filter(Boolean);

    const breadcrumb = Array.from(
      document.querySelectorAll(
        '[aria-label*="breadcrumb" i], .breadcrumb'
      )
    )
      .map(element =>
        element.textContent.replace(/\s+/g, " ").trim()
      )
      .join(" ");

    return {
      headings,
      breadcrumb,
      documentTitle: document.title
    };
  });

  const requested = normalize(category);

  const headingMatches = snapshot.headings.some(
    heading => normalize(heading) === requested
  );

  const breadcrumbMatches = normalize(
    snapshot.breadcrumb
  )
    .split(/[›»/>]/)
    .some(part => normalize(part) === requested);

  const categoryIdentityConfirmed =
    headingMatches || breadcrumbMatches;

  if (!categoryIdentityConfirmed) {
    errors.push(
      "Requested category not confirmed by page headings or breadcrumbs."
    );
  }

  const discovered = await discoverProductLinks(
    page,
    {
      limit: Math.min(
        50,
        Math.max(1, minimumProducts)
      )
    }
  );

  const productCandidates = discovered.filter(
    item =>
      item.evidence?.hasPrice &&
      (
        item.evidence?.hasHeading ||
        item.evidence?.hasImage
      )
  );

  const productEvidenceConfirmed =
    productCandidates.length >= minimumProducts;

  if (!productEvidenceConfirmed) {
    errors.push(
      "Insufficient product-listing evidence."
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    evidence: {
      currentUrl,
      initialUrl,
      navigationConfirmed,
      categoryIdentityConfirmed,
      headingMatches,
      breadcrumbMatches,
      productEvidenceConfirmed,
      productCandidates: productCandidates.length,
      minimumProducts,
      headings: snapshot.headings
    }
  };
}
