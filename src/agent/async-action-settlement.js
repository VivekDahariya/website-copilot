
import { evaluateGoalProgress } from "./goal-progress.js";
import { getDomRevision, waitForRelevantDomChange } from "../observer/dom-change-watcher.js";

import {
  classifyFinalizingAction
} from "./finalizing-action-classifier.js";

export function isFinalizingAction(
  decision,
  element,
  goal,
  instruction,
  observation
) {
  return classifyFinalizingAction({
    action: decision,
    element,
    goal,
    instruction,
    observation
  }).finalizing;
}


function detectExplicitValidationRejection(before, after) {
  if (!before || !after) return false;

  const previousText = String(before.visibleBodyText ?? "").toLowerCase();
  const currentText = String(after.visibleBodyText ?? "").toLowerCase();

  if (!currentText || currentText === previousText) return false;

  const failurePatterns = [
    /validation error/i,
    /please correct/i,
    /invalid (?:value|input|field|format)/i,
    /required field/i,
    /could not (?:save|submit|update)/i,
    /failed to (?:save|submit|update)/i
  ];

  const newFailureEvidence = failurePatterns.some(
    pattern =>
      pattern.test(currentText) &&
      !pattern.test(previousText)
  );

  if (!newFailureEvidence) return false;

  const hasEditableForm = Array.isArray(after.actionableElements) &&
    after.actionableElements.some(element =>
      element.editable || element.tag === "select"
    );

  return hasEditableForm;
}

export async function settleAsyncAction({
  page,
  observer,
  before,
  goal,
  timeoutMs = 1800
}) {
  const deadline = Date.now() + timeoutMs;

  let lastProgress = null;

  while (true) {
    const revision = await getDomRevision(page);

    const observed = await observer(page);

    if (observed.status === "ready") {
      const progress = evaluateGoalProgress(
        before,
        observed.observation,
        goal
      );

      lastProgress = progress;

      if (
        !progress.goalCompleted &&
        detectExplicitValidationRejection(
          before,
          observed.observation
        )
      ) {
        return {
          status: "explicit_validation_rejection",
          progress,
          observation: observed.observation
        };
      }

      if (
        progress.goalCompleted
      ) {
        return {
          status: "goal_settled",
          progress
        };
      }
    }

    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      return {
        status: "settlement_timeout",
        progress: lastProgress
      };
    }

    await waitForRelevantDomChange(page, {
      timeoutMs: Math.min(remaining, 350),
      sinceRevision: revision
    });
  }
}
