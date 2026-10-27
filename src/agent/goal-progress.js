import { verifyGoal } from "./goal-verifier.js";
import { createPageState } from "./page-state.js";

function evaluateConditions(observation, goal) {
  if (goal?.type === "all_of") {
    const conditions = goal.conditions || [];

    return conditions.map(condition => ({
      type: condition.type,
      completed: verifyGoal(observation, condition).completed
    }));
  }

  return [{
    type: goal?.type || "unknown",
    completed: verifyGoal(observation, goal).completed
  }];
}

export function evaluateGoalProgress(before, after, goal) {
  const beforeState = createPageState(before);
  const afterState = createPageState(after);

  const beforeVerification = verifyGoal(before, goal);
  const afterVerification = verifyGoal(after, goal);

  const beforeConditions = evaluateConditions(before, goal);
  const afterConditions = evaluateConditions(after, goal);

  const completedBefore = beforeConditions.filter(
    condition => condition.completed
  ).length;

  const completedAfter = afterConditions.filter(
    condition => condition.completed
  ).length;

  const stateChanged =
    beforeState.fingerprint !== afterState.fingerprint;

  const goalCompleted =
    afterVerification.completed === true;

  const goalProgress =
    completedAfter > completedBefore;

  const goalRegressed =
    completedAfter < completedBefore;

  let classification;

  if (goalCompleted && !beforeVerification.completed) {
    classification = "goal_completed";
  } else if (goalProgress) {
    classification = "goal_progress";
  } else if (goalRegressed) {
    classification = "goal_regressed";
  } else if (stateChanged) {
    classification = "state_changed_without_verified_goal_progress";
  } else {
    classification = "no_observed_change";
  }

  return {
    classification,
    stateChanged,
    goalProgress,
    goalRegressed,
    goalCompleted,
    completedBefore,
    completedAfter,
    totalConditions: afterConditions.length,
    beforeFingerprint: beforeState.fingerprint,
    afterFingerprint: afterState.fingerprint
  };
}
