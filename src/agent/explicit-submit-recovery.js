/**
 * Recover a single explicit, native form submit target only after the model
 * has failed to plan and all requested pre-submit form conditions are verified.
 * This returns a candidate; the agent's existing preservation, progress,
 * safety classification, approval provider and executor still own execution.
 */

const normalized = value => String(value ?? '').trim().toLowerCase();

export function recoverExplicitSubmitAction({instruction, goal, observation, verification, history = []}) {
  const source = String(instruction ?? '');
  // Explicit consent must come from the user, never from a model's goal.
  if (!/\bsubmit\b/i.test(source)) return null;
  if (/\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not|without|avoid)\s+(?:\w+\s+){0,2}submitt?(?:ing)?\b/i.test(source) ||
      /\b(?:do\s+not|don't|dont|never|must\s+not|should\s+not|without|avoid)\s+(?:\w+\s+){0,2}submit\b/i.test(source)) return null;
  if (verification?.completed === true ||
      verification?.evidence?.requiresFinalizingAction !== true ||
      verification?.evidence?.finalizingActionObserved === true) return null;

  const conditions = goal?.type === 'all_of' ? goal.conditions : [goal];
  if (!Array.isArray(conditions) || !conditions.length ||
      conditions.some(c => c?.type !== 'form_state')) return null;
  const conditionEvidence = verification?.evidence?.conditions;
  if (!Array.isArray(conditionEvidence) ||
      conditionEvidence.length !== conditions.length ||
      !conditionEvidence.every(c => c?.completed === true)) return null;
  // Only after at least one form edit has been independently executed.
  if (!history.some(entry => entry?.execution?.executionCompleted === true &&
      ['fill','select','check','uncheck'].includes(entry.decision?.operation))) return null;

  const controls = (observation?.actionableElements ?? []).filter(element => {
    const tag = normalized(element.tag);
    const type = normalized(element.effectiveType || element.type);
    return ['button', 'input'].includes(tag) && type === 'submit' &&
      element.formContext?.associated === true;
  });
  if (controls.length !== 1 || !controls[0]?.ref) return null;

  return {ref: controls[0].ref, operation: 'click', value: ''};
}
