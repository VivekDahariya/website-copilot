import { extractDesiredState } from "./intent-extractor.js";
import {
  explicitLiteralGroundingIssues
} from "./explicit-literal-grounding.js";

function key(requirement) {
  return JSON.stringify([
    requirement.label,
    requirement.kind,
    requirement.value
  ]);
}

function canonical(requirements) {
  return requirements.map(key).sort();
}

function sameRequirements(a, b) {
  return JSON.stringify(canonical(a)) ===
    JSON.stringify(canonical(b));
}

function parsePrefixConstraints(validationFeedback) {
  const feedback = String(validationFeedback ?? "");

  return [...feedback.matchAll(
    /validation error:\s*([^.!?]+?)\s+must start with\s+([A-Za-z0-9_-]+)/gi
  )].map(match => ({
    label: match[1].trim(),
    prefix: match[2]
  }));
}

function explicitConstraintIssues(validationFeedback, requirements) {
  const issues = [];
  const constraints = parsePrefixConstraints(validationFeedback);

  for (const { label, prefix } of constraints) {
    const matches = requirements.filter(item =>
      item.label.trim().toLowerCase() === label.toLowerCase()
    );

    if (
      matches.length !== 1 ||
      matches[0].kind !== "text" ||
      typeof matches[0].value !== "string" ||
      !matches[0].value.startsWith(prefix)
    ) {
      issues.push({
        label,
        reason: "validation_prefix_not_satisfied"
      });
    }
  }

  return issues;
}

function remainingUnresolved(independent, validationFeedback) {
  const constraints = parsePrefixConstraints(validationFeedback);

  return independent.unresolved.filter(item => {
    const label = String(item.label ?? "").trim().toLowerCase();
    const reason = String(item.reason ?? "").toLowerCase();

    const matchingConstraints = constraints.filter(constraint =>
      constraint.label.toLowerCase() === label
    );

    if (matchingConstraints.length === 0) return true;

    // Only clear an unresolved entry explicitly about a prefix rule.
    if (!reason.includes("start with")) return true;

    const matches = independent.requirements.filter(requirement =>
      requirement.label.trim().toLowerCase() === label
    );

    return !(
      matches.length === 1 &&
      matches[0].kind === "text" &&
      typeof matches[0].value === "string" &&
      matchingConstraints.every(constraint =>
        reason.includes(constraint.prefix.toLowerCase()) &&
        matches[0].value.startsWith(constraint.prefix)
      )
    );
  });
}

export async function verifyRequirementCoverage({
  instruction,
  observation,
  extraction,
  validationFeedback = "",
  independentExtractor = extractDesiredState
}) {
  if (
    typeof instruction !== "string" ||
    !instruction.trim() ||
    !Array.isArray(extraction?.requirements) ||
    !Array.isArray(extraction?.unresolved)
  ) {
    return {
      verified: false,
      issues: [{ label: "unknown", reason: "invalid_input" }],
      attestation: null
    };
  }

  if (
    extraction.requirements.length === 0 ||
    extraction.unresolved.length > 0
  ) {
    return {
      verified: false,
      issues: [{ label: "unknown", reason: "incomplete_primary_extraction" }],
      attestation: null
    };
  }

  const literalIssues = explicitLiteralGroundingIssues({
    instruction,
    requirements: extraction.requirements,
    validationFeedback
  });

  if (literalIssues.length > 0) {
    return {
      verified: false,
      issues: literalIssues,
      attestation: null
    };
  }

  // Separate interpretation: this call does not receive the primary
  // extractor's requirements or its proposed field values.
  let independent;

  try {
    independent = await independentExtractor(
      instruction,
      observation,
      validationFeedback
    );
  } catch {
    return {
      verified: false,
      issues: [{ label: "unknown", reason: "independent_extractor_failed" }],
      attestation: null
    };
  }

  if (
    !independent ||
    !Array.isArray(independent.requirements) ||
    !Array.isArray(independent.unresolved) ||
    !Array.isArray(independent.reconciliation?.unresolved)
  ) {
    return {
      verified: false,
      issues: [{ label: "unknown", reason: "invalid_independent_result" }],
      attestation: null
    };
  }

  const issues = [];

  const unresolved = remainingUnresolved(
    independent,
    validationFeedback
  );

  if (
    independent.requirements.length === 0 ||
    unresolved.length > 0 ||
    independent.reconciliation.unresolved.length > 0
  ) {
    issues.push({
      label: "unknown",
      reason: "independent_interpretation_unresolved"
    });
  }

  if (!sameRequirements(
    extraction.requirements,
    independent.requirements
  )) {
    issues.push({
      label: "unknown",
      reason: "independent_interpretation_mismatch"
    });
  }

  issues.push(
    ...explicitConstraintIssues(
      validationFeedback,
      extraction.requirements
    )
  );

  const verified = issues.length === 0;

  return {
    verified,
    issues,
    attestation: verified
      ? {
          verified: true,
          source: "independent_verifier",
          requirements: extraction.requirements.map(item => ({
            label: item.label,
            kind: item.kind,
            value: item.value
          }))
        }
      : null
  };
}
