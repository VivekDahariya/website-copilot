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
    return null;
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
