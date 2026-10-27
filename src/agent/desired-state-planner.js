// Deterministic reconciliation of interpreted intent with observed DOM.
// This module does not execute actions, submit forms, or call an LLM.

const normalize = value =>
  String(value ?? "").trim().toLowerCase();

function sameValue(actual, desired) {
  return String(actual ?? "") === String(desired ?? "");
}

function findElement(requirement, elements) {
  const candidates = elements.filter(element => {
    if (requirement.kind === "checkbox") {
      return element.type === "checkbox";
    }

    if (requirement.kind === "select") {
      return element.tag === "select";
    }

    return Boolean(element.editable) &&
      element.tag !== "select" &&
      element.type !== "checkbox";
  });

  // Require an unambiguous match. Never guess between similar fields.
  const matches = candidates.filter(element =>
    normalize(element.label) === normalize(requirement.label)
  );

  return matches.length === 1 ? matches[0] : null;
}

export function reconcileDesiredState(
  requirements,
  observation
) {
  if (!Array.isArray(requirements)) {
    throw new TypeError("Requirements must be an array");
  }

  const elements = observation?.actionableElements ?? [];
  const pending = [];
  const satisfied = [];
  const unresolved = [];

  for (const requirement of requirements) {
    const element = findElement(requirement, elements);

    if (!element) {
      unresolved.push({
        requirement,
        reason: "field_missing_or_ambiguous"
      });
      continue;
    }

    const actual = requirement.kind === "checkbox"
      ? Boolean(element.checked)
      : element.currentValue;

    const desired = requirement.value;

    const matches = requirement.kind === "checkbox"
      ? actual === desired
      : sameValue(actual, desired);

    if (matches) {
      satisfied.push({
        requirement,
        ref: element.ref,
        actual
      });
      continue;
    }

    const operation = requirement.kind === "checkbox"
      ? desired ? "check" : "uncheck"
      : requirement.kind === "select"
        ? "select"
        : "fill";

    pending.push({
      ref: element.ref,
      operation,
      value: requirement.kind === "checkbox"
        ? desired ? "on" : "off"
        : String(desired),
      requirement
    });
  }

  return {
    pending,
    satisfied,
    unresolved,
    allSatisfied:
      requirements.length > 0 &&
      pending.length === 0 &&
      unresolved.length === 0
  };
}
