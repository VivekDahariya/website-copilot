// Detects a human-verification challenge (CAPTCHA) that only a person can pass.
//
// The signal is the page itself, never a word in its text: a page ABOUT
// CAPTCHAs, or a login form that mentions one in its help text, is not a wall.
// What counts is a challenge frame from a standard provider that is visible,
// whose response field has not been filled, or the classic interstitial page.
// These providers are a small, fixed standard, so naming them is not a
// site-specific handler.

const CHALLENGE_FRAMES = [
  /^https:\/\/www\.(?:google\.com|recaptcha\.net)\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)/i,
  /^https:\/\/(?:[a-z0-9-]+\.)?hcaptcha\.com\//i,
  /^https:\/\/challenges\.cloudflare\.com\//i,
  /^https:\/\/(?:[a-z0-9-]+\.)?(?:arkoselabs|funcaptcha)\.com\//i
];

// A challenge fills one of these when a person has solved it.
const RESPONSE_FIELDS = [
  'textarea[name="g-recaptcha-response"]',
  'textarea[name="h-captcha-response"]',
  'input[name="h-captcha-response"]',
  'input[name="cf-turnstile-response"]',
  'input[name="fc-token"]'
].join(", ");

const INTERSTITIAL_TITLE = new RegExp(
  "\\b(?:just a moment|attention required|checking your browser|" +
  "verify(?:ing)? (?:that )?you(?: are|'re) (?:a )?human|" +
  "are you a (?:human|robot)|human verification)\\b", "i");

const MAX_WALL_CONTROLS = 4;
const MAX_WALL_TEXT = 1200;

// A wall is a page with almost nothing on it for a person to use. A short form
// that happens to hold a challenge is a form: it has fields of its own.
export function looksLikeWallPage(observation) {
  const elements = observation?.actionableElements ?? [];
  const text = String(observation?.visibleBodyText ?? "").length;
  const hasOwnFields = elements.some(element =>
    element.editable === true || element.tag === "select" || element.tag === "textarea");
  return elements.length <= MAX_WALL_CONTROLS && text < MAX_WALL_TEXT && !hasOwnFields;
}

async function visibleChallengeFrame(page) {
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const url = frame.url();
    if (!CHALLENGE_FRAMES.some(pattern => pattern.test(url))) continue;
    // An invisible challenge asks nothing of the person.
    if (/[?&]size=invisible\b/i.test(url)) continue;
    try {
      const owner = await frame.frameElement();
      const box = await owner.boundingBox();
      if (box && box.width >= 30 && box.height >= 30 && await owner.isVisible()) {
        return new URL(url).hostname;
      }
    } catch {
      // A frame that disappears while it is measured is not a visible one.
    }
  }
  return null;
}

async function challengeSolved(page) {
  try {
    return await page.evaluate(selector =>
      [...document.querySelectorAll(selector)]
        .some(field => String(field.value ?? "").trim().length > 0),
    RESPONSE_FIELDS);
  } catch {
    return false;
  }
}

// kind: "interstitial" (the page is the wall), "widget" (a form holds an
// unsolved challenge), or null.
export async function detectChallenge(page, observation) {
  try {
    if (!page || page.isClosed()) return { kind: null };
    const provider = await visibleChallengeFrame(page);
    const solved = await challengeSolved(page);
    if (solved) return { kind: null, solved: true };
    const wallPage = looksLikeWallPage(observation);
    const titled = INTERSTITIAL_TITLE.test(String(observation?.title ?? ""));
    if ((provider || titled) && wallPage) {
      return { kind: "interstitial", provider, titled };
    }
    if (provider) return { kind: "widget", provider };
    return { kind: null };
  } catch {
    return { kind: null };
  }
}
