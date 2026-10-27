
import { verifyGoal } from "./goal-verifier.js";

function flatten(goal) {
  return goal?.type === "all_of"
    ? goal.conditions.flatMap(flatten)
    : [goal];
}

function normalize(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function findMatchingFields(observation, condition) {
  const expectedLabel = normalize(condition.fieldLabel);

  if (!expectedLabel) return [];

  return (observation.actionableElements ?? []).filter(element =>
    normalize(element.label).includes(expectedLabel)
  );
}

export async function verifyPersistence({
  page,
  goal,
  observer,
  allowReload = false,
  workflowCategory = "unknown"
}) {
  const formConditions = flatten(goal).filter(
    condition => condition?.type === "form_state"
  );

  if (formConditions.length === 0) {
    return {
      status: "persistence_unverified",
      reason: "No form-state conditions available."
    };
  }

  if (!allowReload) {
    return {
      status: "persistence_unverified",
      reason: "Reload was not authorized."
    };
  }

  // A caller must positively establish that this is a safe,
  // repeatable settings-style read-back.
  if (workflowCategory !== "repeatable_settings") {
    return {
      status: "persistence_unverified",
      reason: "Workflow is not classified as reload-safe."
    };
  }

  const urlBefore = page.url();

  try {
    // Reloading a POST-backed document may resubmit the form.
    // This GET read-back is permitted only after the caller explicitly
    // authorizes persistence verification for repeatable settings.
    await page.goto(urlBefore, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });

    const observationResult = await observer(page);

    if (observationResult.status !== "ready") {
      return {
        status: "persistence_unverified",
        reason: "Read-back observation unavailable."
      };
    }

    const observation = observationResult.observation;

    if (observation.url !== urlBefore) {
      return {
        status: "persistence_unverified",
        reason: "Reload redirected to another URL."
      };
    }

    const missingFields = formConditions.filter(
      condition =>
        findMatchingFields(observation, condition).length === 0
    );

    if (missingFields.length > 0) {
      return {
        status: "persistence_unverified",
        reason: "Expected fields are absent after reload.",
        missingFields: missingFields.map(
          condition => condition.fieldLabel
        )
      };
    }

    const checks = formConditions.map(condition => ({
      fieldLabel: condition.fieldLabel,
      ...verifyGoal(observation, condition)
    }));

    return {
      status: checks.every(check => check.completed)
        ? "persisted_verified"
        : "persistence_failed",
      checks,
      url: observation.url
    };
  } catch (error) {
    return {
      status: "persistence_unverified",
      reason: error.message
    };
  }
}
