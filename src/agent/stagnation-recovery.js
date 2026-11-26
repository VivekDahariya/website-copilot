import { createPageState } from "./page-state.js";

// Only these operations take a value. For every other operation (click,
// right_click, hover, check, ...) a small model often puts free text in the
// value field, such as the element's label, and changes it between
// attempts. That text is not part of what the action is, so it must not
// make a repeated action look like a new one.
const VALUE_OPERATIONS = new Set([
  "fill", "select", "press", "set_range", "drag", "scroll"
]);

function identityValue(decision) {
  return VALUE_OPERATIONS.has(decision?.operation)
    ? decision.value ?? "" : "";
}

export function createStagnationRecovery({
  maxRecoveries = 2
} = {}) {
  if (!Number.isInteger(maxRecoveries) || maxRecoveries < 0) {
    throw new Error("maxRecoveries must be a nonnegative integer.");
  }

  let recoveries = 0;
  const ineffectiveActions = new Map();

  function keyFor(observation) {
    return createPageState(observation).fingerprint;
  }

  function remember(observation, element, decision) {
    const key = keyFor(observation);

    if (!ineffectiveActions.has(key)) {
      ineffectiveActions.set(key, new Set());
    }

    ineffectiveActions.get(key).add(
      JSON.stringify({
        ref: element.ref,
        operation: decision.operation,
        value: identityValue(decision)
      })
    );
  }

  function isIneffective(observation, element, decision) {
    const key = keyFor(observation);

    return ineffectiveActions.get(key)?.has(
      JSON.stringify({
        ref: element.ref,
        operation: decision.operation,
        value: identityValue(decision)
      })
    ) ?? false;
  }

  return {
    remember,
    isIneffective,

    recover() {
      if (recoveries >= maxRecoveries) {
        return {
          allowed: false,
          reason: "recovery_budget_exhausted",
          recoveries
        };
      }

      recoveries += 1;

      return {
        allowed: true,
        recoveries
      };
    },

    getStatus() {
      return {
        recoveries,
        maxRecoveries
      };
    }
  };
}
