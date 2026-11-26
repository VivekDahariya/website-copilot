// Read-only V2 consistency assessment over V1's privacy-filtered evidence ledger.
// This does NOT independently re-read the DOM, validate field values, select actions,
// authorize completion, or override the production verifier.
const STATUSES = new Set(['agreement', 'disagreement', 'insufficient_evidence']);
const PROOF_KINDS = new Set(['browser_element', 'action_receipt', 'human_handover',
  'confirmed_transition', 'previously_witnessed', 'verifier_boolean', 'unmatched']);
const ELEMENT_REF = /^e\d{1,6}$/;
function safeCount(v) { return Number.isSafeInteger(v) && v >= 0 ? v : 0; }
function isRef(v) { return typeof v === 'string' && ELEMENT_REF.test(v); }
function hasVerifiedReceipt(actions, elementRef) {
  return actions.some(a => a?.executed === true && a?.verified === true &&
    (elementRef === null || (a.elementRef === elementRef)));
}
function summarizeProof(node, finalState, actions) {
  if (node?.matched !== true) return 'missing';
  const kind = PROOF_KINDS.has(node?.proof) ? node.proof : 'unmatched';
  if (kind === 'browser_element') return isRef(node.elementRef) ? 'direct' : 'weak';
  if (kind === 'action_receipt') return hasVerifiedReceipt(actions,
    isRef(node.elementRef) ? node.elementRef : null) ? 'action' : 'weak';
  if (kind === 'confirmed_transition') return finalState.finalTransitionVerified === true &&
    finalState.finalizingActionObserved === true ? 'transition' : 'weak';
  return 'weak';
}
export function assessEvidenceGraphV2(report) {
  const empty = {
    schemaVersion: 2, mode: 'shadow_only', assessment: 'insufficient_evidence',
    scope: 'metadata_consistency_only', requirementsTotal: 0, requirementsMatched: 0,
    proofCoverage: {direct:0, action:0, transition:0, weak:0, missing:0},
    matchedCountDrops: 0, issues: []
  };
  if (!report || typeof report !== 'object') {
    return {...empty, issues:['missing_evidence_graph']};
  }
  const reqs = Array.isArray(report.requirements) ? report.requirements.slice(0,40) : [];
  const actions = Array.isArray(report.actions) ? report.actions.slice(-120) : [];
  const checkpoints = Array.isArray(report.checkpoints) ? report.checkpoints.slice(-120) : [];
  const last = report.lastSnapshot && typeof report.lastSnapshot === 'object'
    ? report.lastSnapshot : null;
  const conditions = Array.isArray(last?.conditions) ? last.conditions.slice(0,40) : [];
  const totals = {...empty.proofCoverage};
  let drops = 0;
  for (let i = 1; i < checkpoints.length; i++) {
    if (safeCount(checkpoints[i]?.matched) < safeCount(checkpoints[i-1]?.matched)) drops++;
  }
  const matched = reqs.filter(r => r?.matched === true).length;
  const issues = [];
  if (!last || safeCount(report.snapshotsSeen) === 0 || reqs.length === 0)
    issues.push('missing_requirement_observations');
  if (last && conditions.length !== reqs.length)
    issues.push('requirement_count_mismatch');
  const ids = new Set();
  for (const [index, req] of reqs.entries()) {
    const expectedId = `r${index+1}`;
    if (req?.id !== expectedId || ids.has(req?.id)) issues.push('invalid_requirement_identity');
    ids.add(req?.id);
    const condition = conditions[index];
    if (condition && (condition.id !== req?.id || condition.matched !== req?.matched))
      issues.push('requirement_state_mismatch');
    if (condition && condition.matched &&
        (condition.proof !== req.lastProof || condition.elementRef !== req.elementRef))
      issues.push('requirement_provenance_mismatch');
    const type = summarizeProof({matched:req?.matched,proof:req?.lastProof,
      elementRef:req?.elementRef}, last ?? {}, actions);
    totals[type]++;
  }
  const completeOnLedger = last?.complete === true;
  const goalVerifiedEvents = safeCount(report.goalVerifiedEvents);
  const protectedViolations = safeCount(report.protectedStateViolations);
  const allMatched = reqs.length > 0 && matched === reqs.length;
  const successful = report.status === 'verified_complete';
  if (successful && last && (!completeOnLedger || !allMatched))
    issues.push('success_without_complete_evidence');
  if (successful && protectedViolations > 0)
    issues.push('success_with_protected_state_alert');
  // An unsuccessful run may have fulfilled a simple goal but failed later due
  // to an approval, transfer, or other workflow constraint. Do not infer a bug.
  if (successful && goalVerifiedEvents === 0)
    issues.push('success_without_goal_verified_event');
  let assessment = 'insufficient_evidence';
  if (issues.some(x => ['requirement_count_mismatch','invalid_requirement_identity',
    'requirement_state_mismatch','requirement_provenance_mismatch',
    'success_without_complete_evidence','success_with_protected_state_alert'].includes(x))) {
    assessment = 'disagreement';
  } else if (successful && allMatched && completeOnLedger && goalVerifiedEvents > 0 &&
    totals.weak === 0 && totals.missing === 0) {
    assessment = 'agreement';
  } else if (!successful && last && !completeOnLedger && !allMatched &&
    reqs.length > 0 && protectedViolations === 0) {
    // There is evidence of incomplete work, but not independent evidence of why
    // the agent failed; don't claim the original failure classification is right.
    assessment = 'insufficient_evidence';
  }
  const uniqueIssues = [...new Set(issues)].slice(0,10);
  if (!STATUSES.has(assessment)) assessment = 'insufficient_evidence';
  return {
    schemaVersion:2, mode:'shadow_only', scope:'metadata_consistency_only',
    assessment, requirementsTotal:reqs.length, requirementsMatched:matched,
    proofCoverage:totals, matchedCountDrops:drops, issues:uniqueIssues
  };
}
