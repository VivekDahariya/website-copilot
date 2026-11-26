// Shadow evidence snapshots of the EXISTING verifier. No additional verification,
// DOM access, action selection, goal rewriting, or completion decisions.
// Never export a user's instruction, field label/value, URL, or page content.
const CONDITION_TYPES = new Set([
  'form_state','visible_content','page_destination','visible_form',
  'element_count','paragraph_count','modal_closed'
]);
const PROOF_KINDS = new Set([
  'browser_element','action_receipt','human_handover',
  'confirmed_transition','previously_witnessed','verifier_boolean','unmatched'
]);
function leafGoals(goal, acc = []) {
  if (acc.length >= 40) return acc;
  if (goal?.type === 'all_of' && Array.isArray(goal.conditions)) {
    for (const condition of goal.conditions) leafGoals(condition, acc);
  } else { acc.push(goal); }
  return acc;
}
function ref(value) {
  return typeof value === 'string' && /^e\d{1,6}$/.test(value) ? value : null;
}
function type(value) {
  return CONDITION_TYPES.has(value) ? value : 'other';
}
export function makeEvidenceSnapshot(goal, verification, step, phase = 'pre_action') {
  const leaves = leafGoals(goal);
  const results = Array.isArray(verification?.evidence?.conditions)
    ? verification.evidence.conditions : [];
  return {
    type: 'evidence_snapshot',
    step: Number.isSafeInteger(step) && step >= 0 ? step : 0,
    phase: phase === 'post_action' ? 'post_action' : 'pre_action',
    complete: verification?.completed === true,
    finalizingActionObserved: verification?.evidence?.finalizingActionObserved === true,
    finalTransitionVerified: verification?.evidence?.finalStateTransitionVerified === true,
    explicitFailureEvidence: verification?.evidence?.explicitFailureEvidence === true,
    requirements: leaves.map((goalLeaf, index) => {
      const result = results[index] ?? (leaves.length === 1 ? verification : null);
      const evidence = result?.evidence ?? {};
      let proof = 'unmatched';
      if (result?.completed === true) {
        if (evidence.verifiedByManualHandover === true) proof = 'human_handover';
        else if (evidence.confirmedByFinalTransition === true) proof = 'confirmed_transition';
        else if (evidence.verifiedBySuccessfulSelectAction === true) proof = 'action_receipt';
        else if (ref(evidence.matchedReference)) proof = 'browser_element';
        else if (evidence.previouslyWitnessed === true) proof = 'previously_witnessed';
        else proof = 'verifier_boolean';
      }
      return {
        id: `r${index + 1}`,
        kind: type(goalLeaf?.type),
        matched: result?.completed === true,
        elementRef: ref(evidence.matchedReference),
        proof: PROOF_KINDS.has(proof) ? proof : 'unmatched'
      };
    })
  };
}
