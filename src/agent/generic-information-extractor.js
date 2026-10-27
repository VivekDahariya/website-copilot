function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPrice(text) {
  const matches = [...text.matchAll(
    /(?:£|₹|\$|€)\s*\d[\d,]*(?:\.\d{1,2})?/g
  )];

  return matches.length
    ? matches[0][0].replace(/\s+/g, "")
    : null;
}

function extractAvailability(text) {
  const match = text.match(
    /\b(?:in stock|out of stock|available|unavailable|sold out)(?:\s*\(\s*\d+\s+available\s*\))?/i
  );

  return match ? normalizeText(match[0]) : null;
}

function scoreTitle(candidate) {
  let score = 0;

  if (candidate.tag === "H1") score += 100;
  if (candidate.tag === "H2") score += 50;
  if (candidate.tag === "H3") score += 20;

  if (candidate.text.length >= 5) score += 10;
  if (candidate.text.length > 160) score -= 100;

  return score;
}

export async function extractGenericInformation(page) {
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
      .map(element => ({
        tag: element.tagName,
        text: element.textContent
          .replace(/\s+/g, " ")
          .trim()
      }))
      .filter(item => item.text);

    const main =
      document.querySelector("main") ||
      document.querySelector("article") ||
      document.body;

    const text = Array.from(
      main.querySelectorAll("*")
    )
      .filter(element =>
        visible(element) &&
        element.children.length === 0 &&
        !["SCRIPT", "STYLE", "NOSCRIPT"].includes(
          element.tagName
        )
      )
      .map(element =>
        element.textContent.replace(/\s+/g, " ").trim()
      )
      .filter(Boolean)
      .join("\n");

    return {
      url: location.href,
      documentTitle: document.title,
      headings,
      text
    };
  });

  const titleCandidates = snapshot.headings
    .map(item => ({
      ...item,
      score: scoreTitle(item)
    }))
    .sort((a, b) => b.score - a.score);

  const title =
    titleCandidates[0]?.text ||
    normalizeText(snapshot.documentTitle) ||
    null;

  const price = extractPrice(snapshot.text);
  const availability = extractAvailability(snapshot.text);

  return {
    title,
    price,
    availability,
    url: snapshot.url,
    evidence: {
      titleSource: titleCandidates[0]?.tag || "document.title",
      priceFound: Boolean(price),
      availabilityFound: Boolean(availability)
    }
  };
}
