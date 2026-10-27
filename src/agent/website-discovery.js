const KNOWN_SITES = [
  [/\bflipkart\b/i, "flipkart.com"],
  [/\bamazon\b/i, "amazon.in"],
  [/\bgithub\b/i, "github.com"],
  [/\bwikipedia\b/i, "wikipedia.org"],
  [/\blinkedin\b/i, "linkedin.com"],
  [/\byoutube\b/i, "youtube.com"],
  [/\breddit\b/i, "reddit.com"],
  [/\bstackoverflow\b/i, "stackoverflow.com"],
  [/\bmyntra\b/i, "myntra.com"]
];

const PRIVATE_INFORMATION =
  /\b(?:password|passcode|otp|cvv|cvc|secret|api[\s_-]?key|access[\s_-]?token|credit[\s_-]?card|bank[\s_-]?account|aadhaar|passport|phone\s*number|mobile\s*number|email\s*address|home\s*address|date\s*of\s*birth|order\s*(?:id|number)|booking\s*(?:id|reference)|pan[\s_-]?(?:id|number))\b/i;

const STOP_WORDS = new Set(
  (
    "the and for from with into this that find open search website page " +
    "best top cheapest please show tell click visit navigate go on at in " +
    "to of a an me my compare get then using"
  ).split(" ")
);

export function inferTargetDomain(instruction) {
  const text = String(instruction || "");

  const explicit = text.match(
    /\b[a-z0-9-]+\.(?:co\.in|gov\.in|com|org|net|io|in)\b/i
  );

  if (explicit) return explicit[0].toLowerCase();

  for (const [pattern, domain] of KNOWN_SITES) {
    if (pattern.test(text)) return domain;
  }

  return null;
}

export function buildDiscoveryQuery(instruction) {
  const text = String(instruction || "").trim();

  if (!text || text.length > 2000) return null;
  if (PRIVATE_INFORMATION.test(text)) return null;

  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) return null;

  if (/\b(?:\+?\d[\s-]?){8,14}\b/.test(text)) {
    return null;
  }

  const domain = inferTargetDomain(text);

  const excluded = new Set(
    domain
      ? domain.toLowerCase().split(".")
      : []
  );

  const terms = tokens(text)
    .filter(token => !excluded.has(token))
    .filter(token => !/^\d{5,}$/.test(token))
    .slice(0, 6);

  if (!domain && terms.length < 2) {
    return null;
  }

  if (domain && terms.length === 0) {
    return `official website site:${domain}`;
  }

  return [
    ...terms,
    ...(domain ? [`site:${domain}`] : [])
  ].join(" ");
}


function buildFocusedDiscoveryQuery(instruction, fallbackQuery) {
  const text = String(instruction || "");

  const namedSubject = text.match(
    /\b(?:for|about|of)\s+([A-Z][A-Za-z0-9.+-]*(?:\s+[A-Z][A-Za-z0-9.+-]*){0,2})\b/
  );

  if (!namedSubject) return fallbackQuery;

  const subject = namedSubject[1];

  const excluded = new Set([
    ...tokens(subject),
    "its",
    "official",
    "guide",
    "guides",
    "documentation",
    "docs",
    "manual"
  ]);

  const goals = tokens(text)
    .filter(token => !excluded.has(token))
    .slice(0, 3);

  if (!goals.length) return fallbackQuery;

  const documentationIntent =
    /\b(?:guide|guides|documentation|docs|manual)\b/i.test(text);

  return [
    `"${subject}"`,
    ...goals.map(token =>
      token === "installation" ? '"installation"' : token
    ),
    ...(documentationIntent ? ["documentation"] : [])
  ].join(" ");
}

function normalizedUrl(input) {
  try {
    let url = new URL(input);

    if (/(^|\.)bing\.com$/i.test(url.hostname)) {
      if (url.pathname !== "/ck/a") return null;

      const encoded = url.searchParams.get("u");

      if (!/^a1[A-Za-z0-9_-]+$/.test(encoded || "")) {
        return null;
      }

      const decoded = Buffer.from(
        encoded.slice(2),
        "base64url"
      ).toString("utf8");

      url = new URL(decoded);
    }

    if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) {
      const destination = url.searchParams.get("uddg");
      if (!destination) return null;
      url = new URL(destination);
    }

    if (/^(?:www\.)?google\./i.test(url.hostname)) {
      const destination =
        url.searchParams.get("q") ||
        url.searchParams.get("url");

      if (!destination) return null;
      url = new URL(destination);
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }

    if (
      /^(?:www\.)?google\./i.test(url.hostname) ||
      /(^|\.)bing\.com$/i.test(url.hostname) ||
      /(^|\.)duckduckgo\.com$/i.test(url.hostname)
    ) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function tokens(text) {
  return [...new Set(
    String(text || "")
      .toLowerCase()
      .match(/[a-z0-9]{3,}/g) || []
  )].filter(token => !STOP_WORDS.has(token));
}

function matchesDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith("." + domain);
}

export function chooseDiscoveryCandidate(results, instruction) {
  const targetDomain = inferTargetDomain(instruction);
  const keywords = tokens(instruction);

  const candidates = results
    .map((result, index) => {
      const url = normalizedUrl(result.url);
      if (!url) return null;

      const hostname = new URL(url).hostname.toLowerCase();

      if (targetDomain && !matchesDomain(hostname, targetDomain)) {
        return null;
      }

      const title = String(result.title || "");
      const searchText = (title + " " + hostname).toLowerCase();

      const score = keywords.filter(
        keyword => searchText.includes(keyword)
      ).length;

      return { url, title, hostname, score, index };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (!candidates.length) return null;

  if (targetDomain) return candidates[0];

  const best = candidates[0];
  const second = candidates[1];

  if (best.score < 2) return null;

  if (second &&
      second.score === best.score &&
      second.hostname !== best.hostname) {
    return null;
  }

  return best;
}

// Retry only an interrupted search-result navigation.
// The selected URL and all existing destination checks remain unchanged.
async function navigateSearchResult(page, url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });
      return;
    } catch (error) {
      const interrupted = String(error?.message || "")
        .includes("net::ERR_ABORTED");

      if (!interrupted || attempt === 1) {
        throw error;
      }

      // Give a competing navigation a bounded opportunity to settle.
      // This does not bypass a blocked website or CAPTCHA.
      await page.waitForLoadState("domcontentloaded", {
        timeout: 1200
      }).catch(() => {});
    }
  }
}

export async function discoverWebsite(page, instruction) {
  const query = buildDiscoveryQuery(instruction);

  if (!query) {
    return {
      status: "needs_clarification",
      reason: "A specific website URL is required for this task."
    };
  }

  try {
    const targetDomain = inferTargetDomain(instruction);

    // Prefer a website explicitly identified in the user's task.
    // Search engines are unnecessary when the site is already known.
    if (targetDomain) {
      await page.goto(`https://${targetDomain}/`, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });

      const destination = new URL(page.url());

      if (
        !["http:", "https:"].includes(destination.protocol) ||
        !matchesDomain(
          destination.hostname.toLowerCase(),
          targetDomain
        )
      ) {
        throw new Error(
          "Website redirected outside the expected domain."
        );
      }

      const title = await page.title();
      const bodyText = await page.locator("body")
        .innerText({ timeout: 5000 });

      if (
        !title.trim() ||
        bodyText.trim().length < 30 ||
        /verify you are human|unusual traffic|access denied|just a moment/i.test(title)
      ) {
        throw new Error(
          "Website identity or accessibility could not be verified."
        );
      }

      return {
        status: "found",
        url: page.url(),
        title,
        searchQuery: null,
        discoveryMethod: "direct_domain"
      };
    }

    // Search providers are independent fallbacks, not trusted
    // destinations. The candidate and final browser destination
    // must still pass the existing verification checks.
    const focusedQuery =
      buildFocusedDiscoveryQuery(instruction, query);

    const searchProviders = [
      {
        name: "google",
        domain: "google.com",
        url: "https://www.google.com/search?q="
      },
      {
        name: "bing",
        domain: "bing.com",
        url: "https://www.bing.com/search?q="
      },
      {
        name: "duckduckgo",
        domain: "duckduckgo.com",
        url: "https://html.duckduckgo.com/html/?q="
      }
    ];

    let candidate = null;
    let discoveryProvider = null;

    for (const provider of searchProviders) {
      try {
        await page.goto(
          provider.url + encodeURIComponent(focusedQuery),
          {
            waitUntil: "domcontentloaded",
            timeout: 20000
          }
        );

        const searchPage = new URL(page.url());

        if (!matchesDomain(
          searchPage.hostname.toLowerCase(),
          provider.domain
        )) {
          continue;
        }

        // Respect search-engine blocks. No CAPTCHA bypass.
        if (searchPage.pathname.toLowerCase().split("/").some(part => part === "sorry" || part === "captcha")) {
          continue;
        }

        const resultLinks = page.locator(
          'a:has(h3), li.b_algo h2 a, ' +
          'a[data-testid="result-title-a"], a.result__a'
        );

        await resultLinks.first().waitFor({
          state: "attached",
          timeout: 6500
        });

        const results = await resultLinks.evaluateAll(anchors =>
          anchors.slice(0, 30).map(anchor => ({
            url: anchor.href,
            title: (
              anchor.querySelector("h3,h2")?.innerText ||
              anchor.innerText ||
              anchor.textContent ||
              ""
            ).trim()
          }))
        );

        const selected = chooseDiscoveryCandidate(
          results,
          instruction
        );

        if (selected) {
          candidate = selected;
          discoveryProvider = provider.name;
          break;
        }
      } catch {
        // A blocked or unavailable search provider is not
        // permission to guess the requested website.
        continue;
      }
    }

    if (!candidate) {
      return {
        status: "needs_clarification",
        reason: "Could not identify a sufficiently reliable website. Please provide its URL."
      };
    }

    const expectedDomain = inferTargetDomain(instruction);

    await navigateSearchResult(page, candidate.url);

    const finalUrl = new URL(page.url());

    if (!["http:", "https:"].includes(finalUrl.protocol)) {
      throw new Error("Unsupported destination protocol.");
    }

    const verifiedDomain = expectedDomain ||
      new URL(candidate.url).hostname
        .toLowerCase()
        .replace(/^www\./, "");

    if (!matchesDomain(
      finalUrl.hostname.toLowerCase(),
      verifiedDomain
    )) {
      throw new Error(
        "Website redirected outside the selected domain."
      );
    }

    const title = await page.title();
    const bodyText = await page.locator("body")
      .innerText({ timeout: 5000 });

    if (!title.trim() || bodyText.trim().length < 30 ||
        /verify you are human|unusual traffic|access denied|just a moment/i.test(title)) {
      throw new Error("Website identity or accessibility could not be verified.");
    }

    return {
      status: "found",
      url: page.url(),
      title,
      searchQuery: focusedQuery,
      discoveryMethod: "search_" + discoveryProvider
    };
  } catch (error) {
    return {
      status: "needs_clarification",
      reason: "Automatic website discovery failed verification. Please provide the exact URL.",
      detail: String(error?.message || "")
    };
  }
}
