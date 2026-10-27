import {
  getEligiblePdfDownloadClick
} from "./pdf-download-click-guard.js";

import {
  verifyRequestedPdfIdentity
} from "./pdf-download-identity.js";

function tokens(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/([a-z])[\s_-]+(?=\d)/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function selectUniqueDirectPdfAction({
  instruction,
  observation
} = {}) {
  if (!Array.isArray(observation?.actionableElements)) {
    return null;
  }

  const identifiers = tokens(instruction)
    .filter(t => /^[a-z]{1,6}\d{1,5}[a-z]?$/.test(t));

  const candidates = [];

  for (const element of observation.actionableElements) {
    if (typeof element.ref !== "string") continue;

    const selected = getEligiblePdfDownloadClick({
      instruction,
      decision: { operation: "click" },
      element,
      pageUrl: observation.url
    });

    if (!selected) continue;

    let filename;

    try {
      const url = new URL(selected.href);
      filename = decodeURIComponent(
        url.pathname.split("/").pop() ?? ""
      );
    } catch {
      continue;
    }

    const targetTokens = tokens(
      filename + " " + selected.label
    );

    if (identifiers.some(id => !targetTokens.includes(id))) {
      continue;
    }

    const identity = verifyRequestedPdfIdentity({
      instruction,
      filename,
      linkText: selected.label,
      linkHref: selected.href,
      pageTitle: ""
    });

    if (identity?.matched !== true) continue;

    candidates.push({
      ref: element.ref,
      operation: "click"
    });
  }

  // Do not guess when multiple elements match.
  return candidates.length === 1 ? candidates[0] : null;
}
