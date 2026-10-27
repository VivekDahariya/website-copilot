
function normalize(value) {
  return String(value ?? "").trim();
}

export function detectNavigationIntent(task) {
  const text = normalize(task);

  return (
    /\b(?:navigate|open|visit|go to|find and open|search for|follow|reach)\b/i.test(text) &&
    /\b(?:page|article|tutorial|documentation|guide|category|profile|author|section|website|site)\b/i.test(text)
  );
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);

    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    url.hash = "";

    return url.href;
  } catch {
    return null;
  }
}

function destinationConditions(goal) {
  if (!goal || typeof goal !== "object") {
    return [];
  }

  if (goal.type === "page_destination") {
    return [goal];
  }

  if (goal.type === "all_of" && Array.isArray(goal.conditions)) {
    return goal.conditions.flatMap(destinationConditions);
  }

  return [];
}

export function createNavigationIntentGuard(
  task,
  startUrl,
  originalInstruction = task
) {
  const navigationRequired = detectNavigationIntent(
    originalInstruction
  );

  const initialUrl = canonicalUrl(startUrl);

  let navigationObserved = false;

  return {
    navigationRequired,

    observe(url) {
      if (!navigationRequired) {
        return;
      }

      const currentUrl = canonicalUrl(url);

      if (
        initialUrl &&
        currentUrl &&
        currentUrl !== initialUrl
      ) {
        navigationObserved = true;
      }
    },

    canComplete(
      goalVerified,
      observation = null,
      goal = null
    ) {
      // Never override a failed goal verification.
      if (goalVerified !== true) {
        return false;
      }

      // Explicitly verified final-state workflows may navigate
      // through client-side UI states without changing the URL.
      //
      // Require a verified non-destination condition as well as
      // explicit final-state language. This prevents a matching
      // hostname alone from completing a navigation-only task.
      const explicitFinalState =
        /\b(?:finish only when|finish when|stop when)\b/i
          .test(originalInstruction);

      const hasFinalStateCondition = (() => {
        const visit = condition => {
          if (!condition || typeof condition !== "object") {
            return false;
          }

          if (condition.type === "all_of") {
            return Array.isArray(condition.conditions) &&
              condition.conditions.some(visit);
          }

          return condition.type === "visible_content" ||
            condition.type === "visible_form";
        };

        return visit(goal);
      })();

      if (explicitFinalState && hasFinalStateCondition) {
        return true;
      }

      // Non-navigation tasks do not need navigation evidence.
      if (!navigationRequired) {
        return true;
      }

      if (!navigationObserved || !observation) {
        return false;
      }

      const currentUrl = canonicalUrl(observation.url);

      if (
        !initialUrl ||
        !currentUrl ||
        currentUrl === initialUrl
      ) {
        return false;
      }

      // The primary verifier has already checked the complete
      // goal, including destination, content and form state.
      //
      // This guard only enforces that navigation occurred.
      // It must not reinterpret or override verified goal evidence.
      return true;
    },

    getStatus() {
      return {
        navigationRequired,
        navigationObserved,
        destination: null,
        startUrl
      };
    }
  };
}
