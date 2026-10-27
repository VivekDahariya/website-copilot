// Conservative navigation-only goal derived from observed discovery.
// The existing agent verifier still decides actual task completion.

const BLOCKED_INTENTS =
  /\b(?:read|explain|summari[sz]e|download|save|export|print|upload|submit|fill|type|enter|select|change|modify|delete|remove|purchase|buy|send|extract|answer|compare|translate|copy|screenshot|analy[sz]e)\b/i;

const MULTI_STEP =
  /\b(?:and then|then|after that|followed by|once you|also)\b/i;

const NAVIGATION_START =
  /^(?:please\s+)?(?:find|locate|open|visit|navigate to|go to|find and open)\b/i;

const IGNORED_WORDS = new Set(
  (
    "please find locate open visit navigate go to and the a an " +
    "for about of on at in from its official website web site " +
    "guide guides documentation docs tutorial tutorials manual " +
    "page pages article articles instruction instructions " +
    "link links using through"
  ).split(" ")
);

function words(value) {
  return String(value ?? "")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

export async function buildVerifiedDiscoveredNavigationGoal(
  page,
  instruction,
  discovery
) {
  if (discovery?.status !== "found" || !discovery.url) {
    return null;
  }

  const text = String(instruction ?? "").trim();

  if (!NAVIGATION_START.test(text)) return null;
  if (BLOCKED_INTENTS.test(text)) return null;
  if (MULTI_STEP.test(text)) return null;

  const match = text.match(
    /\b(?:for|about|of)\s+([A-Z][A-Za-z0-9.+-]*)\b/
  );

  if (!match) return null;

  const subject = match[1].toLowerCase();

  const terms = [...new Set(
    words(text)
      .filter(word => word.length >= 3)
      .filter(word => !IGNORED_WORDS.has(word))
  )];

  if (terms.length < 2 || terms.length > 6) return null;
  if (!terms.includes(subject)) return null;

  let expected;
  let actual;

  try {
    expected = new URL(discovery.url);
    actual = new URL(page.url());
  } catch {
    return null;
  }

  if (expected.protocol !== "https:") return null;
  if (actual.href !== expected.href) return null;

  // Require the requested subject to match a whole domain label,
  // not an arbitrary substring of an unrelated hostname.
  const hostname = actual.hostname.toLowerCase();
  const labels = hostname.split(".");

  if (!labels.includes(subject)) return null;

  if (
    labels.some(label =>
      ["google", "bing", "duckduckgo"].includes(label)
    )
  ) {
    return null;
  }

  if (
    /\b(?:guide|documentation|docs|tutorial|manual|instructions)\b/i
      .test(text) &&
    actual.pathname === "/"
  ) {
    return null;
  }

  try {
    // Some client-rendered websites initially expose a generic title
    // before updating it to the destination-specific title.
    // Wait only for independently observed discovery title evidence.
    let title = (await page.title()).trim();
    const expectedTitle = String(discovery.title ?? "")
      .trim()
      .toLowerCase();

    if (expectedTitle && title.toLowerCase() !== expectedTitle) {
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250));

        // Do not accept title evidence from a different page.
        if (page.url() !== actual.href) return null;

        title = (await page.title()).trim();

        if (title.toLowerCase() === expectedTitle) break;
      }

      // A page that never matches remains unverified.
      if (title.toLowerCase() !== expectedTitle) return null;
    }

    const heading = (
      await page.locator("h1").first().innerText({
        timeout: 2000
      })
    ).trim();

    const body = (
      await page.locator("body").innerText({
        timeout: 3000
      })
    ).trim();

    if (!title || !heading || body.length < 50) {
      return null;
    }

    if (
      /\b(?:captcha|access denied|verify you are human|unusual traffic)\b/i
        .test(title + " " + heading)
    ) {
      return null;
    }

    if (
      discovery.title &&
      title.toLowerCase() !==
        String(discovery.title).trim().toLowerCase()
    ) {
      return null;
    }

    // Restrict the shortcut to an H1 supported by the page title.
    // Other valid pages can still use the normal agent path.
    if (
      !title.toLowerCase().includes(heading.toLowerCase())
    ) {
      return null;
    }

    const evidence = new Set(
      words(title + " " + heading + " " + actual.pathname)
    );

    if (!terms.every(term => evidence.has(term))) {
      return null;
    }

    return {
      type: "page_destination",
      hostname: actual.hostname,
      pathname: actual.pathname,
      heading
    };
  } catch {
    return null;
  }
}
