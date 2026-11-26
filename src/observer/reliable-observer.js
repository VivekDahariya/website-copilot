import { observePage } from "./dom-observer.js";
import { stopPendingNavigation } from "../browser/pending-navigation.js";

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 350;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// One look at the page must not wait forever: while a navigation is pending
// (a script redirected to a server that never answers) page.evaluate does not
// return at all.
function observationTimeoutMs() {
  const configured = Number(process.env.COPILOT_OBSERVE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 500 && configured <= 120000
    ? configured : 12000;
}

async function withTimeLimit(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`The page did not answer within ${Math.round(ms / 100) / 10} s.`);
      error.code = "OBSERVATION_TIMEOUT";
      reject(error);
    }, ms);
  });
  // A late result of the abandoned look must not become an unhandled rejection.
  promise.catch(() => {});
  try { return await Promise.race([promise, limit]); }
  finally { clearTimeout(timer); }
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
      lastObservation = await withTimeLimit(observer(page), observationTimeoutMs());

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
        reason: error.code === "OBSERVATION_TIMEOUT"
          ? "observation_timeout"
          : "observer_error",
        message: error.message
      };
      if (error.code === "OBSERVATION_TIMEOUT") {
        // Stop the load that never finishes so the page can be read again.
        const stopped = await stopPendingNavigation(page);
        console.log(
          "Page did not answer; pending navigation " +
          (stopped ? "stopped." : "could not be stopped.")
        );
      }
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

// A sentence for a person (and the run report) saying why the page could not be
// read. The raw assessment stays available next to it.
export function describeObservationFailure(assessment, url = "") {
  if (String(url).startsWith("chrome-error://")) {
    return "The browser could not load the page: the website did not answer, " +
      "refused the connection or does not exist.";
  }
  const reason = assessment?.reason;
  if (reason === "observation_timeout") {
    return "The page did not answer in time, so CoPilot could not read it.";
  }
  if (reason === "observer_error") {
    const detail = typeof assessment?.message === "string"
      ? assessment.message.split("\n")[0].slice(0, 160).trim()
      : "";
    return "The page could not be read" + (detail ? `: ${detail}` : ".");
  }
  if (reason === "title_only_observation" || reason === "empty_page_observation") {
    return "The page has no readable content (it may still be loading or may be blank).";
  }
  return "The page could not be read.";
}
