import { verifyGoal } from "./goal-verifier.js";
import {
  classifyFinalizingAction
} from "./finalizing-action-classifier.js";

function flatten(goal) {
  return goal?.type === "all_of"
    ? goal.conditions.flatMap(flatten)
    : [goal];
}

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function createWorkflowGoalVerifier(goal, instruction = '') {
  // Actions such as "Submit" are not field values.
  const actionLabels = /^(submit|save|send|publish|delete|purchase|transfer|checkout|confirm|post|order)$/i;

  const conditions = flatten(goal).filter(condition =>
    !(
      condition?.type === "form_state" &&
      actionLabels.test(String(condition.fieldLabel ?? "").trim()) &&
      normalize(condition.fieldLabel) === normalize(condition.expectedValue)
    )
  );

  const witnessed = new Set();
  const verifiedSelections = new Map();
  const verifiedHandovers = new Map();

  // A prohibition is not a request to perform an action.
  // For example, "Do not submit" must not require submission.
  const positiveInstruction = String(instruction).replace(
    /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not|without)\s+(?:the\s+)?(?:save|submit|publish|send|delete|purchase|transfer|saving|submitting|publishing|sending|deleting|purchasing|transferring)\b/gi,
    ""
  );

  const requiresFinalizingAction =
    !conditions.some(condition => ['element_count','paragraph_count'].includes(condition?.type)) &&
    /\b(?:save|submit|publish|send|delete|purchase|transfer)\b/i
      .test(positiveInstruction);

  let finalizingActionObserved = false;
  let lastObservation = null;
  let finalStateTransitionVerified = false;

  const finalConditions = conditions.filter(
    condition => condition.type === "visible_content"
  );

  function finalStateSatisfied(observation) {
    if (!observation || finalConditions.length === 0) return false;

    return finalConditions.every(
      condition => verifyGoal(observation, condition).completed === true
    );
  }

  return {
    recordHumanHandover(action, element, proof) {
      if (
        proof?.verified !== true ||
        action?.operation !== "fill" ||
        String(element?.type ?? "").toLowerCase() !== "password"
      ) return;

      conditions.forEach((condition, index) => {
        if (condition?.type !== "form_state") return;

        const expectedLabel = normalize(condition.fieldLabel);
        const actualLabel = normalize(element.label);

        if (
          expectedLabel &&
          actualLabel.includes(expectedLabel)
        ) {
          verifiedHandovers.set(index, {
            ref: action.ref,
            label: actualLabel,
            url: proof.url
          });
        }
      });
    },

    recordAction(action, element, execution) {
      if (execution?.executionCompleted !== true) return;

      // Reuse Playwright's verified selection evidence.
      // This supports option labels such as "Two" whose HTML value is "2".
      if (action?.operation === "select") {
        conditions.forEach((condition, index) => {
          if (condition.type !== "form_state") return;

          const fieldLabel = normalize(condition.fieldLabel);
          const actualLabel = normalize(element?.label);

          if (!fieldLabel || !actualLabel.includes(fieldLabel)) return;

          if (
            normalize(action.value) === normalize(condition.expectedValue) &&
            execution.verified === true
          ) {
            witnessed.add(index);
            verifiedSelections.set(index, {
              ref: action.ref,
              url: lastObservation?.url,
              observedValue: null
            });
          } else {
            verifiedSelections.delete(index);
            witnessed.delete(index);
          }
        });
      }

      const description = [
        element?.label,
        element?.text,
        element?.ariaLabel,
        action?.value
      ].filter(Boolean).join(" ");

      const finalizing = classifyFinalizingAction({
        action,
        element,
        goal,
        instruction,
        observation: lastObservation
      }).finalizing;

      if (
        finalizing &&
        ["click", "press"].includes(action?.operation)
      ) {
        finalizingActionObserved = true;

        // Existing success evidence cannot prove this action succeeded.
        finalStateTransitionVerified = false;

        // Only a later observation may establish a new final state.
        this.awaitingFinalState = !finalStateSatisfied(lastObservation);
      }
    },
    verify(observation) {
      if (
        finalizingActionObserved &&
        this.awaitingFinalState === true &&
        finalStateSatisfied(observation)
      ) {
        finalStateTransitionVerified = true;
        this.awaitingFinalState = false;
      }

      lastObservation = observation;

      const results = conditions.map((condition, index) => {
        const result = verifyGoal(observation, condition);

          const handover = verifiedHandovers.get(index);

          if (handover && condition.type === "form_state") {
            const currentElement =
              observation.actionableElements?.find(
                item => item.ref === handover.ref
              );

            if (
              observation.url === handover.url &&
              currentElement &&
              String(currentElement.type ?? "").toLowerCase()
                === "password" &&
              normalize(currentElement.label) === handover.label
            ) {
              witnessed.add(index);

              return {
                completed: true,
                evidence: {
                  matchedReference: handover.ref,
                  verifiedByManualHandover: true,
                  secretValueExposed: false
                }
              };
            }

            verifiedHandovers.delete(index);
          }


        const selection = verifiedSelections.get(index);

        if (
          condition.type === "form_state" &&
          !result.completed &&
          selection &&
          observation.url === selection.url
        ) {
          const currentElement = observation.actionableElements?.find(
            element => element.ref === selection.ref
          );

          if (currentElement) {
            const currentValue = String(
              currentElement.currentValue ?? ""
            );

            if (selection.observedValue === null) {
              selection.observedValue = currentValue;
            }

            if (currentValue === selection.observedValue) {
              witnessed.add(index);
              return {
                completed: true,
                evidence: {
                  ...result.evidence,
                  verifiedBySuccessfulSelectAction: true,
                  observedValue: currentValue
                }
              };
            }

            verifiedSelections.delete(index);
            witnessed.delete(index);
          }
        }

        if (
          condition.type === "form_state" &&
          result.completed
        ) {
          witnessed.add(index);
        }

        if (
          condition.type !== "form_state" ||
          result.completed ||
          !witnessed.has(index)
        ) {
          return result;
        }

        const expectedValue = normalize(
          condition.expectedValue
        );

        const visibleText = normalize(
          observation.visibleBodyText
        );

        const confirmedByCurrentPage =
          expectedValue.length > 0 &&
          visibleText.includes(expectedValue);

        const confirmedByFinalTransition =
          finalizingActionObserved &&
          finalStateTransitionVerified &&
          finalStateSatisfied(observation);

        return {
          completed:
            confirmedByCurrentPage || confirmedByFinalTransition,
          evidence: {
            previouslyWitnessed: true,
            confirmedByCurrentPage,
            confirmedByFinalTransition,
            expectedField: condition.fieldLabel,
            expectedValue: condition.expectedValue
          }
        };
      });

      const visibleText = normalize(
        observation.visibleBodyText
      );

      const explicitFailureEvidence = [
        /\bno changes have been saved\b/,
        /\bchanges (?:have )?not been saved\b/,
        /\bnot saved\b/,
        /\bsave failed\b/,
        /\bfailed to save\b/,
        /\bunsaved changes\b/
      ].some(pattern => pattern.test(visibleText));

      return {
        completed:
          !explicitFailureEvidence &&
          (!requiresFinalizingAction || (
            finalizingActionObserved &&
            finalStateTransitionVerified
          )) &&
          results.every(
            result => result.completed === true
          ),
        evidence: {
          conditions: results,
          explicitFailureEvidence,
          requiresFinalizingAction,
          finalizingActionObserved,
          finalStateTransitionVerified
        }
      };
    }
  };
}
