// Content policy: what CoPilot refuses to do, decided by code and never by the
// language model. It runs before a task starts, and again on every page the
// agent reaches. It works on words, hostnames and the labels a page puts on
// itself; it cannot see pictures, so it will miss some cases and may stop some
// harmless ones. A refusal ends the run with status "refused_by_policy".
//
// Refused:
//   1. finding, opening or downloading explicit sexual content
//   2. sexual content involving minors (never handled, in any wording)
//   3. bypassing paywalls or copy protection (DRM), or downloading from paid
//      streaming services
//   4. pages that label themselves adult-only (RTA label, rating=adult)

const REASONS = {
  sexual_content_minors:
    "CoPilot never handles sexual content involving minors.",
  explicit_sexual_content:
    "CoPilot does not find, open or download explicit sexual content.",
  drm_paywall_circumvention:
    "CoPilot does not bypass paywalls or copy protection, or download from " +
    "paid streaming services. Use the service's own app or download feature.",
  adult_site:
    "This site labels itself adult-only, so CoPilot does not work on it."
};

const refuse = category => ({ allowed: false, category, reason: REASONS[category] });
const ALLOWED = Object.freeze({ allowed: true });

// Hostnames of well-known adult sites. A safety block list, not a handler.
const ADULT_HOSTS = [
  "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com",
  "youporn.com", "spankbang.com", "eporner.com", "brazzers.com",
  "onlyfans.com", "chaturbate.com", "stripchat.com", "fansly.com"
];

const hostIsAdult = host => {
  const name = String(host ?? "").toLowerCase().replace(/^www\./, "");
  return ADULT_HOSTS.some(item => name === item || name.endsWith("." + item));
};

const urlIsAdult = value => {
  try { return hostIsAdult(new URL(String(value)).hostname); }
  catch { return false; }
};

const normalize = text => String(text ?? "")
  .toLowerCase()
  .normalize("NFKD")
  .replace(/[\u0300-\u036f\u200b-\u200f\u2060\ufeff]/g, "")
  .replace(/[^a-z0-9+\s]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const MEDIA = "videos?|vids?|pics?|pictures?|photos?|images?|clips?|movies?|films?|gifs?|selfies|content|tapes?|stories|sites?|websites?";
const MEDIA_FILES = "videos?|vids?|pics?|pictures?|photos?|images?|clips?|movies?|films?|selfies|tapes?";
const MINOR = "child|children|kids?|minors?|underage|under age|pre ?teens?|teen|teens|teenage|teenagers?|schoolgirls?|schoolboys?|toddlers?|jailbait|loli|lolicon|shota";
const EXPLICIT = "porn\\w*|xxx|hentai|nudes?|naked|erotic\\w*|sex ?tapes?|csam|jailbait|loli|lolicon|shota";

const MINORS_RULES = [
  new RegExp(`\\b(?:${MINOR})\\b(?:\\s+\\w+){0,5}?\\s+(?:${EXPLICIT})\\b`),
  new RegExp(`\\b(?:${EXPLICIT})\\b(?:\\s+\\w+){0,5}?\\s+(?:${MINOR})\\b`),
  new RegExp(`\\b(?:${MINOR})\\b(?:\\s+\\w+){0,3}?\\s+(?:sex|sexual)\\s+(?:${MEDIA_FILES})\\b`),
  new RegExp(`\\b(?:sex|sexual)\\s+(?:${MEDIA_FILES})\\b(?:\\s+\\w+){0,4}?\\s+(?:${MINOR})\\b`),
  /\bchild sexual abuse material\b|\bcsam\b/
];

const ACQUIRE =
  "download|save|grab|get|fetch|rip|scrape|collect|find|show|open|watch|stream|play|browse|search|look|view|see|display|pull";
const ADULT_OBJECT =
  "porn\\w*|xxx|hentai|nsfw|nudes|sex ?tapes?|onlyfans|" +
  `(?:nude|naked)\\s+(?:${MEDIA}|girls?|women|men|models?)|` +
  `erotic\\w*\\s+(?:${MEDIA})|adult\\s+(?:${MEDIA})`;

const EXPLICIT_RULES = [
  new RegExp(`\\b(?:${ACQUIRE})\\b(?:\\s+\\w+){0,4}?\\s+(?:${ADULT_OBJECT})\\b`),
  new RegExp(`\\b(?:porn\\w*|xxx|hentai|nudes|sex ?tapes?)\\s+(?:${MEDIA})\\b`)
];

// Reading about the subject is not looking for it, unless something is to be
// saved. "Summarize the article on pornography law" passes.
const INFORMATIONAL =
  /\b(?:article|articles|law|laws|legal|policy|study|studies|research|statistics|history|addiction|ban|bans|regulation|news|definition|meaning|wikipedia|essay|journalism)\b/;
const SAVES = /\b(?:download|save|grab|rip|scrape|fetch)\b/;

const PAYMEDIA =
  "movies?|shows?|episodes?|videos?|series|songs?|tracks?|music|albums?|audiobooks?|books?|films?";
const PAID_SERVICES =
  "netflix|prime video|amazon prime|disney\\+?|disneyplus|hotstar|hbo max|hulu|crunchyroll|spotify|apple music|audible|kindle|youtube premium|peacock|paramount\\+?|apple tv";

const DRM_RULES = [
  /\b(?:bypass|circumvent|get around|defeat|break|crack|remove|skip|unlock|strip|disable)\s+(?:\w+\s+){0,2}(?:paywalls?|drm|copy protections?|subscription wall)\b/,
  new RegExp(`\\b(?:download|rip|record|extract)\\s+(?:\\w+\\s+){0,4}?(?:${PAYMEDIA})\\s+(?:\\w+\\s+){0,3}?(?:from|on|of|in)\\s+(?:${PAID_SERVICES})\\b`),
  new RegExp(`\\b(?:premium|paid|paywalled|members? ?only|subscribers? ?only|locked)\\s+(?:\\w+\\s+){0,2}(?:content|articles?|videos?|photos?|pictures?|courses?|lessons?|episodes?|movies?|songs?|music|books?|ebooks?)\\b(?:\\s+\\w+){0,4}?\\s+(?:for free|without paying|without an? subscription|without an? account|free of charge|for nothing)\\b`),
  /\b(?:pirated|pirate|torrent|torrents|cracked)\s+(?:\w+\s+){0,2}(?:movies?|software|games?|apps?|series|shows?|books?|music)\b/
];

const hostsIn = text =>
  String(text ?? "").toLowerCase().match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) ?? [];

/** Decides whether a task may start. Input: the user's words and start URL. */
export function assessTask({ instruction, startUrl } = {}) {
  const text = normalize(instruction);

  if (MINORS_RULES.some(rule => rule.test(text))) {
    return refuse("sexual_content_minors");
  }

  if (urlIsAdult(startUrl) || hostsIn(instruction).some(hostIsAdult)) {
    return refuse("explicit_sexual_content");
  }

  if (EXPLICIT_RULES.some(rule => rule.test(text)) &&
      (SAVES.test(text) || !INFORMATIONAL.test(text))) {
    return refuse("explicit_sexual_content");
  }

  if (DRM_RULES.some(rule => rule.test(text))) {
    return refuse("drm_paywall_circumvention");
  }

  return ALLOWED;
}

/** Decides whether the page the browser is on may be worked on. */
export async function assessPage(page) {
  let url = "";
  try { url = page.url(); } catch { return ALLOWED; }
  if (urlIsAdult(url)) return refuse("adult_site");

  // The standard label adult sites put on themselves, so that filters can
  // recognise them, and an explicit "adult" rating.
  let labelled = false;
  try {
    labelled = await page.evaluate(() => {
      const label = "rta-5042-1996-1400-1577-rta";
      for (const meta of document.querySelectorAll("meta")) {
        const name = (meta.getAttribute("name") || "").toLowerCase();
        const content = (meta.getAttribute("content") || "").toLowerCase();
        if (content.includes(label)) return true;
        if (name === "rating" && /^adult\b/.test(content)) return true;
      }
      return false;
    });
  } catch {
    // The page could not be read (it is navigating); the next look decides.
    labelled = false;
  }
  return labelled ? refuse("adult_site") : ALLOWED;
}
