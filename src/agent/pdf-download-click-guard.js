import {
  isExplicitPdfDownloadRequest
} from "./pdf-download-identity.js";

export function getEligiblePdfDownloadClick({
  instruction,
  decision,
  element,
  pageUrl
} = {}) {
  if (!isExplicitPdfDownloadRequest(instruction)) {
    return null;
  }

  if (decision?.operation !== "click") {
    return null;
  }

  if (String(element?.tag ?? "").toLowerCase() !== "a") {
    return null;
  }

  const href = String(element?.href ?? "").trim();

  if (!href) return null;

  let url;

  try {
    url = new URL(href, pageUrl);
  } catch {
    return null;
  }

  if (!["https:", "http:"].includes(url.protocol)) {
    return null;
  }

  if (!/\.pdf$/i.test(url.pathname)) {
    // Some sites generate a real PDF through JavaScript and a
    // blob: download while their anchor points back to the page.
    // Do not allow arbitrary HTML links through the download path.
    let currentUrl;
    try {
      currentUrl = new URL(pageUrl);
    } catch {
      return null;
    }

    const label = String(
      element?.label ?? element?.text ?? ""
    ).trim();

    // Require an explicit, uniquely named link in the user's
    // affirmative request. A generic mention of PDF is insufficient.
    const requestedLabel = String(instruction ?? "").match(
      /\b(?:find\s+and\s+)?click\s+(?:the\s+)?link\s+(?:labeled|labelled|named)\s+["'“‘]([^"'”’]+)["'”’]/i
    )?.[1]?.trim();

    if (
      url.href !== currentUrl.href ||
      !/^download\b.{1,120}\bpdf$/i.test(label) ||
      !requestedLabel ||
      label !== requestedLabel
    ) {
      return null;
    }
  }

  return {
    label: String(
      element?.label ??
      element?.text ??
      ""
    ).trim().slice(0, 300),
    href: url.href
  };
}
