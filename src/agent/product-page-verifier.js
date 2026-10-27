function normalize(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export async function verifyProductPage(
  page,
  {
    expectedUrl,
    listingTitle
  } = {}
) {
  const actualUrl = normalizedUrl(page.url());
  const expected = normalizedUrl(expectedUrl);

  const errors = [];

  if (!expected || actualUrl !== expected) {
    errors.push("Destination URL mismatch.");
  }

  const snapshot = await page.evaluate(() => {
    const heading = document.querySelector("h1");

    const text = (
      document.querySelector("main") ||
      document.body
    )?.innerText || "";

    return {
      heading: heading?.textContent?.trim() || "",
      text: text.slice(0, 20000),
      title: document.title
    };
  });

  const heading = normalize(snapshot.heading);
  const listing = normalize(listingTitle);

  const isTruncated =
    /(?:\.\.\.|…)$/.test(listing);

  const listingPrefix = listing
    .replace(/(?:\.\.\.|…)$/, "")
    .trim();

  const titleMatches =
    !listing ||
    (
      isTruncated
        ? listingPrefix.length >= 8 &&
          heading.startsWith(listingPrefix)
        : heading === listing ||
          heading.includes(listing) ||
          listing.includes(heading)
    );

  if (!heading) {
    errors.push("Product heading missing.");
  }

  if (!titleMatches) {
    errors.push("Listing title and page heading disagree.");
  }

  const hasPrice =
    /[£₹$€]\s*\d/.test(snapshot.text);

  if (!hasPrice) {
    errors.push("No recognizable product price.");
  }

  return {
    valid: errors.length === 0,
    errors,
    evidence: {
      actualUrl,
      expectedUrl: expected,
      heading: snapshot.heading,
      listingTitle,
      titleMatches,
      hasPrice
    }
  };
}
