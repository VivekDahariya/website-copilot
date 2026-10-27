/**
 * Reconcile browser actions against the currently observed form state.
 *
 * No website-specific field names or values.
 * No persistent assumptions about completed fields.
 */

export function reconcileFormActions(observation) {
  const elements = observation.actionableElements ?? [];

  return elements.map(element => {
    const allowedOperations = [];

    if (element.type === "checkbox") {
      if (element.checked === true) {
        allowedOperations.push("uncheck");
      } else {
        allowedOperations.push("check");
      }
    } else if (element.tag === "select") {
      allowedOperations.push("select");
    } else if (element.editable) {
      allowedOperations.push("fill");

      if (element.currentValue) {
        allowedOperations.push("press");
      }
    } else {
      allowedOperations.push("click");
    }

    return {
      ...element,
      allowedOperations
    };
  });
}

export function isRedundantFormAction(action, observation) {
  const element = observation.actionableElements?.find(
    item => item.ref === action.ref
  );

  if (!element) return true;

  if (
    element.type === "checkbox" &&
    action.operation === "check" &&
    element.checked === true
  ) {
    return true;
  }

  if (
    element.type === "checkbox" &&
    action.operation === "uncheck" &&
    element.checked === false
  ) {
    return true;
  }

  if (
    (action.operation === "fill" ||
      action.operation === "select") &&
    element.currentValue === action.value
  ) {
    return true;
  }

  return false;
}
