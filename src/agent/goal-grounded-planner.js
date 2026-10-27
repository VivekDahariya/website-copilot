import { verifyGoal } from "./goal-verifier.js";
import { normalizeBooleanState } from "./boolean-state.js";

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function flattenConditions(goal) {
  if (!goal || typeof goal !== "object") return [];

  if (goal.type === "all_of") {
    return (goal.conditions || []).flatMap(flattenConditions);
  }

  return [goal];
}

function matchingControl(elements, fieldLabel) {
  const expected = normalize(fieldLabel);

  return elements
    .filter(element => {
      const label = normalize(element.label);

      return (
        label === expected ||
        label.includes(expected) ||
        expected.includes(label) && label.length >= 3
      );
    })
    .sort((a, b) => {
      const aExact = normalize(a.label) === expected ? 1 : 0;
      const bExact = normalize(b.label) === expected ? 1 : 0;

      return bExact - aExact;
    })[0];
}

export function planGoalGroundedAction(observation, goal) {
  for (const condition of flattenConditions(goal)) {
    if (condition.type !== "form_state") continue;

    if (verifyGoal(observation, condition).completed) {
      continue;
    }

    const element = matchingControl(
      observation.actionableElements || [],
      condition.fieldLabel
    );

    if (!element) continue;

    const expectedValue = String(condition.expectedValue);
    const type = normalize(element.type);
    const tag = normalize(element.tag);

    if (type === "checkbox" || type === "radio") {
      const expectedChecked = normalizeBooleanState(expectedValue);

      if (expectedChecked === null) continue;

      if (element.checked === expectedChecked) continue;

      if (expectedChecked === false && type === "radio") {
        continue;
      }

      return {
        ref: element.ref,
        operation: expectedChecked ? "check" : "uncheck",
        value: ""
      };
    }

    if (tag === "select") {
      return {
        ref: element.ref,
        operation: "select",
        value: expectedValue
      };
    }

    if (element.editable) {
      return {
        ref: element.ref,
        operation: "fill",
        value: expectedValue
      };
    }
  }

  return null;
}
