import { createHash } from "node:crypto";

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return String(value ?? "");
  }
}

function normalizeElement(element) {
  return {
    tag: element.tag || "",
    type: element.type || "",
    label: normalizeText(element.label),
    href: element.href || "",
    currentValue: normalizeText(element.currentValue),
    checked: element.checked ?? null
  };
}

export function createPageState(observation) {
  const state = {
    url: normalizeUrl(observation.url),
    headings: (observation.headings || [])
      .map(heading =>
        normalizeText(
          typeof heading === "string"
            ? heading
            : heading.text || heading.textContent || ""
        )
      ),
    visibleText: normalizeText(
      observation.visibleBodyText
    ).slice(0, 12000),
    elements: (observation.actionableElements || [])
      .map(normalizeElement)
  };

  const fingerprint = createHash("sha256")
    .update(JSON.stringify(state))
    .digest("hex");

  return {
    fingerprint,
    state
  };
}

export function hasPageStateChanged(before, after) {
  return (
    createPageState(before).fingerprint !==
    createPageState(after).fingerprint
  );
}
