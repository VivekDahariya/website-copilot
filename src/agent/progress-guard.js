import { createPageState } from "./page-state.js";

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value || "";
  }
}

function actionKey(element, decision) {
  return JSON.stringify({
    operation: decision.operation,
    label: element.label || "",
    href: element.href || "",
    value: decision.value || ""
  });
}

export function createProgressGuard(initialUrl) {
  const visitedUrls = new Map();
  const attemptedActions = new Set();

  const MAX_VISITS_PER_URL = 2;

  function recordVisit(url) {
    const normalized = normalizeUrl(url);

    visitedUrls.set(
      normalized,
      (visitedUrls.get(normalized) || 0) + 1
    );
  }

  recordVisit(initialUrl);

  return {
    check(observation, element, decision) {
      const { fingerprint } = createPageState(observation);

      const key = JSON.stringify({
        fingerprint,
        action: actionKey(element, decision)
      });

      if (attemptedActions.has(key)) {
        return {
          allowed: false,
          reason: "repeated_action_same_state"
        };
      }

      if (
        decision.operation === "click" &&
        element.href
      ) {
        try {
          const destination = normalizeUrl(
            new URL(element.href, observation.url).href
          );

          const visits = visitedUrls.get(destination) || 0;

          if (visits >= MAX_VISITS_PER_URL) {
            return {
              allowed: false,
              reason: "navigation_visit_limit"
            };
          }
        } catch {
          // Let the executor validate unsupported links.
        }
      }

      return {
        allowed: true,
        reason: null
      };
    },

    recordAttempt(observation, element, decision) {
      const { fingerprint } = createPageState(observation);

      attemptedActions.add(
        JSON.stringify({
          fingerprint,
          action: actionKey(element, decision)
        })
      );
    },

    recordNavigation(url) {
      recordVisit(url);
    },

    hasVisited(url) {
      return visitedUrls.has(normalizeUrl(url));
    },

    getVisitCount(url) {
      return visitedUrls.get(normalizeUrl(url)) || 0;
    }
  };
}
