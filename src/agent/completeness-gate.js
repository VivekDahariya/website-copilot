// Conservative gate between form reconciliation and submission.
//
// IMPORTANT:
// This module cannot establish extraction completeness itself.
// An attestation must come from an independent verification process.
// Never derive an attestation solely from the extractor's own output.

export function evaluateFormCompleteness({
  extraction,
  attestation = null
}) {
  if (
    !extraction ||
    !Array.isArray(extraction.requirements) ||
    !Array.isArray(extraction.unresolved) ||
    !extraction.reconciliation
  ) {
    return {
      status: "unresolved",
      submissionEligible: false,
      reason: "invalid_extraction"
    };
  }

  const { requirements, unresolved, reconciliation } = extraction;

  if (
    unresolved.length > 0 ||
    reconciliation.unresolved?.length > 0
  ) {
    return {
      status: "unresolved",
      submissionEligible: false,
      reason: "unresolved_requirements"
    };
  }

  if (requirements.length === 0) {
    return {
      status: "unverified",
      submissionEligible: false,
      reason: "no_requirements_extracted"
    };
  }

  // A completeness attestation must cover the same requirement set.
  // This comparison prevents accidental reuse of an attestation for
  // a different extraction. It does not prove semantic completeness.
  const requirementKeys = requirements
    .map(item => JSON.stringify([
      item.label, item.kind, item.value
    ]))
    .sort();

  const attestedKeys = Array.isArray(attestation?.requirements)
    ? attestation.requirements
        .map(item => JSON.stringify([
          item.label, item.kind, item.value
        ]))
        .sort()
    : null;

  const attestationMatches =
    attestation?.verified === true &&
    attestation?.source === "independent_verifier" &&
    attestedKeys !== null &&
    JSON.stringify(requirementKeys) === JSON.stringify(attestedKeys);

  if (!attestationMatches) {
    return {
      status: "unverified",
      submissionEligible: false,
      reason: "completeness_not_independently_verified"
    };
  }

  if (reconciliation.pending?.length > 0) {
    return {
      status: "pending",
      submissionEligible: false,
      reason: "required_changes_pending",
      nextAction: reconciliation.pending[0]
    };
  }

  if (reconciliation.allSatisfied !== true) {
    return {
      status: "unverified",
      submissionEligible: false,
      reason: "form_state_not_confirmed"
    };
  }

  return {
    status: "complete",
    submissionEligible: true,
    reason: "requirements_satisfied_and_attested"
  };
}
