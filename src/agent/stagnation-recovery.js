import { createPageState } from "./page-state.js";

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
        value: decision.value ?? ""
      })
    );
  }

  function isIneffective(observation, element, decision) {
    const key = keyFor(observation);

    return ineffectiveActions.get(key)?.has(
      JSON.stringify({
        ref: element.ref,
        operation: decision.operation,
        value: decision.value ?? ""
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
