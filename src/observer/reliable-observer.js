import { observePage } from "./dom-observer.js";

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 350;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function assessObservation(observation) {
  if (!observation || typeof observation !== "object") {
    return {
      usable: false,
      reason: "missing_observation"
    };
  }

  const title = String(observation.title || "").trim();

  const headings = Array.isArray(observation.headings)
    ? observation.headings
    : [];

  const elements = Array.isArray(observation.actionableElements)
    ? observation.actionableElements
    : [];

  const bodyText = String(
    observation.visibleBodyText || ""
  ).trim();

  // A page can legitimately have no buttons or links.
  // A title alone is not sufficient evidence of loaded content.
  const hasVisibleContent =
    headings.length > 0 ||
    bodyText.length > 0;

  if (hasVisibleContent) {
    return {
      usable: true,
      reason: "visible_content_available"
    };
  }

  if (elements.length > 0) {
    return {
      usable: true,
      reason: "actionable_elements_available"
    };
  }

  return {
    usable: false,
    reason: title
      ? "title_only_observation"
      : "empty_page_observation"
  };
}

export async function observeReliably(
  page,
  {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    observer = observePage
  } = {}
) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer.");
  }

  let lastObservation = null;
  let lastAssessment = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      lastObservation = await observer(page);

      lastAssessment = assessObservation(lastObservation);

      if (lastAssessment.usable) {
        return {
          status: "ready",
          attempts: attempt,
          observation: lastObservation,
          assessment: lastAssessment
        };
      }
    } catch (error) {
      lastAssessment = {
        usable: false,
        reason: "observer_error",
        message: error.message
      };
    }

    if (attempt < maxAttempts) {
      await sleep(retryDelayMs);
    }
  }

  return {
    status: "observation_unavailable",
    attempts: maxAttempts,
    observation: lastObservation,
    assessment: lastAssessment
  };
}
