const DEFAULT_NO_CHANGE_LIMIT = 2;

export function createStagnationDetector({
  noChangeLimit = DEFAULT_NO_CHANGE_LIMIT
} = {}) {
  if (!Number.isInteger(noChangeLimit) || noChangeLimit < 1) {
    throw new Error("noChangeLimit must be a positive integer.");
  }

  let consecutiveNoChange = 0;

  return {
    record(progress) {
      const classification = progress?.classification;

      if (classification === "no_observed_change") {
        consecutiveNoChange += 1;
      } else if (
        classification === "goal_completed" ||
        classification === "goal_progress" ||
        classification ===
          "state_changed_without_verified_goal_progress" ||
        classification === "goal_regressed"
      ) {
        consecutiveNoChange = 0;
      } else {
        // Unknown observations cannot prove stagnation.
        consecutiveNoChange = 0;
      }

      return {
        consecutiveNoChange,
        stagnating: consecutiveNoChange >= noChangeLimit,
        reason:
          consecutiveNoChange >= noChangeLimit
            ? "consecutive_actions_without_observed_change"
            : null
      };
    },

    getStatus() {
      return {
        consecutiveNoChange,
        stagnating: consecutiveNoChange >= noChangeLimit
      };
    },

    reset() {
      consecutiveNoChange = 0;
    }
  };
}
