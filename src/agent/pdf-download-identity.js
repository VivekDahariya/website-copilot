import { validateDownloadFilename } from "./verified-download.js";

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "from",
  "to", "in", "on", "at", "by", "with", "my", "me",
  "your", "its", "this", "that", "there", "please",
  "find", "get", "fetch", "retrieve", "download",
  "save", "saved", "export", "obtain", "open",
  "pdf", "file", "files", "document", "documents",
  "link", "links", "page", "website", "site",
  "official", "latest", "available", "any",
  "as", "is", "it", "then", "now", "want",
  "need", "give", "show", "can", "you"
]);

function stem(word) {
  if (/^install(?:ation|ations|ing|ed|s)?$/.test(word)) {
    return "install";
  }

  if (word.endsWith("ies") && word.length > 5) {
    return word.slice(0, -3) + "y";
  }

  if (word.endsWith("s") &&
      !word.endsWith("ss") &&
      word.length > 4) {
    return word.slice(0, -1);
  }

  return word;
}

function words(value) {
  const normalized = String(value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return new Set(
    (normalized.match(/[a-z0-9]+/g) ?? [])
      .filter(word =>
        !STOP_WORDS.has(word) &&
        (word.length >= 2 || /^\d+$/.test(word))
      )
      .map(stem)
  );
}

function safePathFromHref(href) {
  try {
    return new URL(href, "https://example.invalid").pathname;
  } catch {
    return "";
  }
}

export function isExplicitPdfDownloadRequest(instruction) {
  const text = String(instruction ?? "").trim();

  if (
    /^(?:how|why|where|what|explain|describe|tell me how)\b/i
      .test(text)
  ) {
    return false;
  }

  if (/\bdownload\b/i.test(text)) {
    return true;
  }

  return (
    /\b(?:save|export|retrieve|fetch)\b/i.test(text) &&
    /\b(?:pdf|document|file|report|certificate|marksheet|admit card|receipt)\b/i
      .test(text)
  );
}

export function verifyRequestedPdfIdentity({
  instruction,
  filename,
  linkText = "",
  linkHref = "",
  pageTitle = ""
} = {}) {
  const reject = (reason, extra = {}) => ({
    matched: false,
    reason,
    ...extra
  });

  if (!isExplicitPdfDownloadRequest(instruction)) {
    return reject("NOT_EXPLICIT_DOWNLOAD_REQUEST");
  }

  try {
    validateDownloadFilename(filename);
  } catch {
    return reject("INVALID_OR_UNSUPPORTED_FILENAME");
  }

  const requested = words(instruction);

  if (requested.size === 0) {
    return reject("REQUESTED_DOCUMENT_UNSPECIFIED");
  }

  // The filename, clicked link label and clicked link path
  // are direct evidence about the selected file.
  const targetWords = words([
    filename,
    linkText,
    safePathFromHref(linkHref)
  ].join(" "));

  // Page title is supporting context, never sufficient alone.
  const contextWords = words(pageTitle);

  // A directly selected document cannot contradict a
  // specific semester requested by the user. Page titles
  // must never override conflicting link identifiers.
  const semesterPattern =
    /\b(?:semester|sem)[\s_-]*(\d{1,2})\b/i;

  const requestedSemester = String(instruction)
    .match(semesterPattern)?.[1];

  const directTarget = [
    filename,
    linkText,
    safePathFromHref(linkHref)
  ].join(" ");

  const targetSemester = directTarget
    .match(semesterPattern)?.[1];

  if (
    requestedSemester &&
    targetSemester &&
    Number(requestedSemester) !== Number(targetSemester)
  ) {
    return reject("CONFLICTING_DOCUMENT_IDENTIFIER", {
      requestedSemester,
      targetSemester
    });
  }

  const matchedTargetTerms = [...requested].filter(
    word => targetWords.has(word)
  );

  const matchedTerms = [...requested].filter(
    word =>
      targetWords.has(word) ||
      contextWords.has(word)
  );

  if (matchedTargetTerms.length === 0) {
    return reject("NO_TARGET_SPECIFIC_MATCH", {
      requestedTerms: [...requested],
      matchedTerms
    });
  }

  const requiredCount = requested.size === 1
    ? 1
    : Math.max(2, Math.ceil(requested.size * 0.6));

  if (matchedTerms.length < requiredCount) {
    return reject("INSUFFICIENT_DOCUMENT_MATCH", {
      requestedTerms: [...requested],
      matchedTerms,
      requiredCount
    });
  }

  return {
    matched: true,
    reason: "DOCUMENT_IDENTITY_SUPPORTED",
    requestedTerms: [...requested],
    matchedTerms,
    matchedTargetTerms,
    filename
  };
}
