/**
 * One bounded, evidence-grounded recovery when model planning produced no
 * executable action and the user explicitly requested a numbered checkbox.
 * This cannot submit forms, invent selectors, or accept completion claims.
 */
import { extractExplicitCheckboxConditions } from './explicit-goal-repair.js';
import { verifyGoal } from './goal-verifier.js';

function normalized(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function formConditions(goal) {
  const conditions = goal?.type === 'all_of' ? goal.conditions : [goal];
  return (conditions ?? []).filter(c => c?.type === 'form_state');
}

export function recoverExplicitBooleanAction({instruction, goal, observation}) {
  const directives = extractExplicitCheckboxConditions(instruction);
  if (!directives.length || !observation?.actionableElements?.length) return null;
  const conditions = formConditions(goal);
  const controls = observation.actionableElements.filter(e =>
    e.type === 'checkbox' && Number.isInteger(e.ordinal) &&
    typeof e.checked === 'boolean'
  );

  const candidates = [];
  for (const directive of directives) {
    const sameGoal = conditions.filter(c =>
      normalized(c.fieldLabel) === normalized(directive.fieldLabel) &&
      normalized(c.expectedValue) === normalized(directive.expectedValue)
    );
    // Fail closed if the interpreted goal omits the explicit requirement or
    // conflicts with it. A model goal alone never authorizes recovery.
    if (sameGoal.length !== 1) continue;
    // Recovery is allowed only when every OTHER goal condition has already
    // been independently satisfied. This is a missing-final-step recovery,
    // never an alternative planner for the initial or ambiguous workflow.
    const allConditions = goal?.type === 'all_of' ? goal.conditions : [goal];
    if (!allConditions.every(c => c === sameGoal[0] ||
        verifyGoal(observation,c).completed === true)) continue;
    const expected = normalized(directive.expectedValue);
    if (expected !== 'checked' && expected !== 'unchecked') continue;
    if (verifyGoal(observation, directive).completed) continue;
    const targetOrdinal = Number(directive.fieldLabel.match(/\b(\d+)$/)?.[1]);
    const matches = controls.filter(e => e.ordinal === targetOrdinal);
    if (matches.length !== 1) continue;
    const control = matches[0];
    const wantChecked = expected === 'checked';
    if (control.checked === wantChecked) continue;
    candidates.push({ref:control.ref,operation:wantChecked?'check':'uncheck',value:''});
  }
  // Never guess when there are multiple incomplete boolean directives.
  return candidates.length === 1 ? candidates[0] : null;
}
