import assert from "node:assert/strict";
import { evaluateFormCompleteness } from
  "../../src/agent/completeness-gate.js";

const requirements = [
  { label: "Project Name", kind: "text", value: "Orion" },
  { label: "Visibility", kind: "select", value: "private" }
];

function extraction({
  pending = [],
  unresolved = [],
  allSatisfied = true,
  requirementsOverride = requirements
} = {}) {
  return {
    requirements: requirementsOverride,
    unresolved,
    reconciliation: {
      pending,
      unresolved: [],
      allSatisfied
    }
  };
}

function attestation(items = requirements) {
  return {
    verified: true,
    source: "independent_verifier",
    requirements: items
  };
}

// 1. No attestation: fail closed.
{
  const result = evaluateFormCompleteness({
    extraction: extraction()
  });
  assert.equal(result.status, "unverified");
  assert.equal(result.submissionEligible, false);
}

// 2. Complete, matching attestation.
{
  const result = evaluateFormCompleteness({
    extraction: extraction(),
    attestation: attestation()
  });
  assert.equal(result.status, "complete");
  assert.equal(result.submissionEligible, true);
}

// 3. Pending field.
{
  const result = evaluateFormCompleteness({
    extraction: extraction({
      pending: [{ ref: "e2", operation: "select", value: "private" }],
      allSatisfied: false
    }),
    attestation: attestation()
  });
  assert.equal(result.status, "pending");
  assert.equal(result.submissionEligible, false);
}

// 4. Explicitly unresolved requirement.
{
  const result = evaluateFormCompleteness({
    extraction: extraction({
      unresolved: [{ label: "Visibility", reason: "Ambiguous" }]
    }),
    attestation: attestation()
  });
  assert.equal(result.status, "unresolved");
  assert.equal(result.submissionEligible, false);
}

// 5. Incomplete extraction cannot reuse full attestation.
{
  const partial = [requirements[0]];
  const result = evaluateFormCompleteness({
    extraction: extraction({
      requirementsOverride: partial
    }),
    attestation: attestation()
  });
  assert.equal(result.status, "unverified");
  assert.equal(result.submissionEligible, false);
}

// 6. Empty extraction must never authorize submission.
{
  const result = evaluateFormCompleteness({
    extraction: extraction({
      requirementsOverride: []
    }),
    attestation: attestation([])
  });
  assert.equal(result.status, "unverified");
  assert.equal(result.submissionEligible, false);
}

// 7. Untrusted attestation source rejected.
{
  const result = evaluateFormCompleteness({
    extraction: extraction(),
    attestation: {
      ...attestation(),
      source: "intent_extractor"
    }
  });
  assert.equal(result.status, "unverified");
  assert.equal(result.submissionEligible, false);
}

// 8. Invalid input rejected.
{
  const result = evaluateFormCompleteness({
    extraction: null
  });
  assert.equal(result.status, "unresolved");
  assert.equal(result.submissionEligible, false);
}

console.log("PASS: Completeness gate (8/8)");
