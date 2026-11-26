import { describeUnreachableSite } from "../browser/unreachable-site.js";

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

  // Capture the entire explicit hostname, including arbitrarily many
  // valid subdomain labels. Do not reduce docs.example.net to example.net.
  const explicit = text.match(
    // The final hostname boundary is essential: "example.com.au" must not
    // silently turn into "example.com", nor can an unknown trailing suffix
    // make a valid-looking prefix count as the requested destination.
    /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:co\.in|gov\.in|co\.uk|com\.au|org\.uk|ac\.uk|com|org|net|io|in|dev|ai|app|edu|gov)(?![a-z0-9.-])/i
  );

  if (explicit) return explicit[0].toLowerCase();

  // A full address with its scheme is the user's own destination whatever its
  // ending (.xyz, .co, an IP address, localhost). Only used when the
  // plain-text rule above found nothing, so it never changes an existing match.
  const written = text.match(/\bhttps?:\/\/[^\s<>"'`]+/i);
  if (written) {
    try {
      const host = new URL(written[0].replace(/[),.;!?]+$/, "")).hostname.toLowerCase();
      if (host) return host;
    } catch {
      // Not a usable address: fall through to "no explicit site".
    }
  }

  // No built-in list of brand names: a site that is only named, not given
  // as an address, is found through the same web search as any other site.
  return null;
}

// Preserve an explicitly supplied deep link during URL-less discovery.
// A hostname is a destination identity; it is not a substitute for the
// exact page, path, query, or anchor the user asked to open.
function explicitHttpDestination(instruction, targetDomain) {
  const match = String(instruction || "").match(/https?:\/\/[^\s<>"'`]+/i);
  if (!match) return null;

  // Ignore punctuation next to URLs in ordinary prose / parentheses.
  const raw = match[0].replace(/[),.;!?]+$/, "");
  const url = new URL(raw);

  if (!["http:", "https:"].includes(url.protocol) ||
      url.username || url.password ||
      url.hostname.toLowerCase() !== targetDomain) {
    throw new Error("Explicit URL identity or credentials cannot be verified.");
  }

  return url.href;
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

  if (asksForOfficialSite(text)) {
    const publisher = officialSubject(text);
    // Keep the search narrow and neutral. A long task description often
    // over-scores third-party tutorials with keyword-stuffed titles.
    return publisher ? `"${publisher}" official documentation` : fallbackQuery;
  }

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

// An "official" request is about publisher identity, not merely topic relevance.
// If we cannot identify the publisher from the instruction, do not guess.
function asksForOfficialSite(instruction) {
  const text = String(instruction || "");
  return /\bofficial\b/i.test(text) &&
    /\b(?:documentation|docs|website|site|manual|reference)\b/i.test(text);
}

function officialSubject(instruction) {
  if (!asksForOfficialSite(instruction)) return null;
  const text = String(instruction || "");
  const patterns = [
    /\b(?:documentation|docs|website|site|manual|reference)(?:\s+website)?\s+(?:for|of)\s+([a-z][a-z0-9.+-]*)/i,
    /\bofficial\s+(?:documentation|docs|website|site|manual|reference)\s+(?:for|of)\s+([a-z][a-z0-9.+-]*)/i,
    /\bofficial\s+([a-z][a-z0-9.+-]*)\s+(?:documentation|docs|website|site|manual|reference)\b/i
  ];
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1]?.toLowerCase()?.replace(/[^a-z0-9]/g, "");
    if (value && value.length >= 3 &&
        !STOP_WORDS.has(value) &&
        !["official", "documentation", "website", "reference", "browser"].includes(value)) {
      return value;
    }
  }
  return null;
}

// The name a site is registered under: "instagram" for www.instagram.com,
// "evil" for instagram.com.evil.example.
function registeredName(hostname) {
  const labels = String(hostname || "").toLowerCase().replace(/^www\./, "").split(".");
  if (labels.length < 2) return null;
  const suffix = labels.slice(-2).join(".");
  const multipartSuffix = /^(?:co\.in|co\.uk|com\.au|org\.uk|gov\.in|ac\.uk)$/.test(suffix);
  return labels[labels.length - (multipartSuffix ? 3 : 2)] ?? null;
}

function matchesOfficialPublisher(hostname, subject) {
  if (!subject) return false;
  // Check the publisher's registrable-domain label, not any arbitrary
  // subdomain. playwright.dev qualifies; playwright.browserstack.com does not.
  return registeredName(hostname) === subject;
}

// An address that carries a name the user asked for in front of a
// different registered site ("instagram.com.evil.example") imitates that
// site. It is never a candidate, whatever its title says.
function imitatesNamedSite(hostname, keywords) {
  const labels = String(hostname || "").toLowerCase().replace(/^www\./, "").split(".");
  const own = registeredName(hostname);
  return labels.slice(0, -2).some((label, index) =>
    label !== own &&
    keywords.includes(label) &&
    /^(?:com|org|net|io|in|co|dev|app|ai|gov|edu)$/.test(labels[index + 1] ?? ""));
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
  const requiresPublisher = asksForOfficialSite(instruction) && !targetDomain;
  const publisher = requiresPublisher ? officialSubject(instruction) : null;
  const keywords = tokens(instruction);

  // Unknown official publisher: require clarification rather than selecting
  // a highly ranked but unrelated search result.
  if (requiresPublisher && !publisher) return null;

  const candidates = results
    .map((result, index) => {
      const url = normalizedUrl(result.url);
      if (!url) return null;

      const hostname = new URL(url).hostname.toLowerCase();

      if (targetDomain && !matchesDomain(hostname, targetDomain)) {
        return null;
      }
      if (requiresPublisher && !matchesOfficialPublisher(hostname, publisher)) {
        return null;
      }
      if (!targetDomain && imitatesNamedSite(hostname, keywords)) {
        return null;
      }

      const title = String(result.title || "");
      const searchText = (title + " " + hostname + " " + new URL(url).pathname).toLowerCase();

      const score = keywords.filter(
        keyword => searchText.includes(keyword)
      ).length;

      return { url, title, hostname, score, index,
        name: registeredName(hostname) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (!candidates.length) return null;

  if (targetDomain) return candidates[0];

  const best = candidates[0];
  // Matching the requested publisher's domain is necessary, though not
  // proof of ownership. In that case the domain identity requirement, not
  // generic keyword score, is the selection gate.
  if (requiresPublisher) {
    const rival = candidates.find(item =>
      item.hostname !== best.hostname &&
      item.score === best.score
    );
    return rival ? null : best;
  }

  // The user named a site ("open YouTube"): a leading search result that is
  // registered under exactly that name is that site. No built-in list of
  // brands is used; the name comes from the instruction and the result.
  // Only a name used as a place ("open X", "on X", "search X") counts. A
  // name that is merely the topic ("a Playwright tutorial") does not.
  const usedAsPlace = name => new RegExp(
    "\\b(?:open|go\\s+to|visit|launch|browse|search|use|on|in|at|from)\\s+(?:the\\s+)?" +
    name.replace(/[^a-z0-9]/g, "") + "\\b", "i").test(String(instruction || ""));
  const named = candidates.filter(item =>
    item.index < 3 && item.name && keywords.includes(item.name) &&
    usedAsPlace(item.name));
  if (named.length) {
    const first = named.sort((a, b) => a.index - b.index || b.score - a.score)[0];
    const otherName = named.find(item => item.name !== first.name);
    return otherName ? null : first;
  }

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

// True only when the site was found by searching the web. A site the user gave
// as an address, or one that was not found at all, was not searched for.
export function usedWebSearch(discovery) {
  return discovery?.status === "found" &&
    String(discovery.discoveryMethod ?? "").startsWith("search_");
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
      const destinationUrl = explicitHttpDestination(
        instruction, targetDomain
      ) ?? `https://${targetDomain}/`;
      try {
        await page.goto(destinationUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });
      } catch (navigationError) {
        // The address was given by the user: say why it could not be opened.
        const unreachable = new Error(
          describeUnreachableSite(navigationError, destinationUrl)
        );
        unreachable.code = "SITE_UNREACHABLE";
        unreachable.detail = String(navigationError?.message ?? "");
        throw unreachable;
      }

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
    if (error?.code === "SITE_UNREACHABLE") {
      return {
        status: "site_unreachable",
        reason: error.message,
        detail: error.detail
      };
    }
    return {
      status: "needs_clarification",
      reason: "Automatic website discovery failed verification. Please provide the exact URL.",
      detail: String(error?.message || "")
    };
  }
}
