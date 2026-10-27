function normalize(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export async function discoverProductLinks(page, {
  limit = 10
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("limit must be between 1 and 50.");
  }

  const candidates = await page.evaluate(() => {
    const visible = element => {
      if (
        element.closest(
          "nav,header,footer,[hidden],[aria-hidden='true']"
        )
      ) {
        return false;
      }

      let current = element;

      while (
        current &&
        current.nodeType === Node.ELEMENT_NODE
      ) {
        const style = getComputedStyle(current);

        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse"
        ) {
          return false;
        }

        current = current.parentElement;
      }

      return true;
    };

    const anchors = Array.from(
      document.querySelectorAll("a[href]")
    );

    return anchors
      .filter(visible)
      .map(anchor => {
        const href = anchor.href;

        let parsed;

        try {
          parsed = new URL(href);
        } catch {
          return null;
        }

        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.hostname !== location.hostname
        ) {
          return null;
        }

        if (
          parsed.pathname === location.pathname &&
          parsed.search === location.search
        ) {
          return null;
        }

        const ancestors = [];

        let ancestor = anchor.parentElement;

        for (let depth = 0; ancestor && depth < 5; depth++) {
          if (
            ancestor.tagName === "BODY" ||
            ancestor.tagName === "HTML"
          ) {
            break;
          }

          ancestors.push(ancestor);
          ancestor = ancestor.parentElement;
        }

        const scoreContainer = element => {
          const heading = element.querySelector(
            "h1,h2,h3,h4,h5,h6"
          );

          const image = element.querySelector("img");

          const text = (
            element.textContent || ""
          ).replace(/\s+/g, " ").trim();

          const links = element.querySelectorAll("a[href]");

          let score = 0;

          if (heading) score += 30;
          if (image) score += 15;
          if (/[£₹$€]\s*\d/.test(text)) score += 35;

          if (links.length === 1) {
            score += 20;
          } else if (links.length > 3) {
            score -= 40;
          }

          if (text.length > 1000) score -= 30;

          return score;
        };

        const container = ancestors
          .map(element => ({
            element,
            score: scoreContainer(element)
          }))
          .sort((a, b) => b.score - a.score)[0]?.element
          || anchor.parentElement;

        const heading = container?.querySelector(
          "h1,h2,h3,h4,h5,h6"
        );

        const image = anchor.querySelector("img") ||
          container?.querySelector("img");

        const text = (
          anchor.getAttribute("title") ||
          anchor.getAttribute("aria-label") ||
          heading?.textContent ||
          anchor.textContent ||
          image?.getAttribute("alt") ||
          ""
        ).replace(/\s+/g, " ").trim();

        const containerText = (
          container?.textContent || ""
        ).replace(/\s+/g, " ").trim().slice(0, 500);

        const containerClass =
          typeof container?.className === "string"
            ? container.className
            : "";

        return {
          title: text,
          url: parsed.href,
          path: parsed.pathname,
          containerTag: container?.tagName || "",
          containerClass,
          hasHeading: Boolean(heading),
          hasImage: Boolean(image),
          hasPrice: /[£₹$€]\s*\d/.test(containerText),
          anchorText: anchor.textContent.replace(/\s+/g, " ").trim()
        };
      })
      .filter(Boolean);
  });

  const pathFrequency = new Map();

  for (const candidate of candidates) {
    const segments = candidate.path
      .split("/")
      .filter(Boolean);

    const shape = segments
      .map(segment =>
        /\d/.test(segment) || segment.includes("-")
          ? ":item"
          : segment
      )
      .join("/");

    candidate.pathShape = shape;

    pathFrequency.set(
      shape,
      (pathFrequency.get(shape) || 0) + 1
    );
  }

  const scored = candidates.map(candidate => {
    let score = 0;

    if (candidate.hasPrice) score += 40;
    if (candidate.hasImage) score += 15;
    if (candidate.hasHeading) score += 15;

    if (
      /product|book|item|card|tile/i.test(
        candidate.containerClass
      )
    ) {
      score += 15;
    }

    if (
      /product|book|item|catalogue/i.test(
        candidate.path
      )
    ) {
      score += 10;
    }

    if (
      /next|previous|login|register|contact|about|home|cart|checkout/i.test(
        candidate.title
      )
    ) {
      score -= 100;
    }

    if (
      candidate.title.length >= 4 &&
      candidate.title.length <= 160
    ) {
      score += 10;
    }

    const frequency =
      pathFrequency.get(candidate.pathShape) || 0;

    if (frequency >= 2) score += 10;

    return {
      ...candidate,
      score
    };
  });

  const unique = new Map();

  for (const candidate of scored) {
    const existing = unique.get(candidate.url);

    if (
      !existing ||
      candidate.score > existing.score
    ) {
      unique.set(candidate.url, candidate);
    }
  }

  return Array.from(unique.values())
    .filter(candidate =>
      candidate.score >= 30 &&
      candidate.title.length >= 3
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(candidate => ({
      title: normalize(candidate.title),
      url: candidate.url,
      score: candidate.score,
      evidence: {
        hasPrice: candidate.hasPrice,
        hasImage: candidate.hasImage,
        hasHeading: candidate.hasHeading,
        repeatedPathPattern:
          (pathFrequency.get(candidate.pathShape) || 0) >= 2
      }
    }));
}
