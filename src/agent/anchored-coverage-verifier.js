// Verify derived requirements against an originally attested,
// immutable baseline. Do not reinterpret the original user instruction.

function fail(reason, label = "unknown") {
  return {
    verified: false,
    issues: [{ label, reason }],
    attestation: null
  };
}

function canonical(requirements) {
  return requirements
    .map(r => JSON.stringify([r.label, r.kind, r.value]))
    .sort();
}

function sameRequirements(a, b) {
  return JSON.stringify(canonical(a)) ===
    JSON.stringify(canonical(b));
}

export function verifyAnchoredRequirementCoverage({
  baseline,
  extraction,
  validationFeedback = ""
}) {
  const original = baseline?.requirements;
  const originalAttestation = baseline?.attestation;

  if (
    !Array.isArray(original) ||
    original.length === 0 ||
    originalAttestation?.verified !== true ||
    originalAttestation?.source !== "independent_verifier" ||
    !Array.isArray(originalAttestation.requirements) ||
    !sameRequirements(original, originalAttestation.requirements)
  ) {
    return fail("baseline_not_independently_attested");
  }

  if (
    !Array.isArray(extraction?.requirements) ||
    !Array.isArray(extraction?.unresolved) ||
    extraction.unresolved.length !== 0
  ) {
    return fail("derived_requirements_unresolved");
  }

  const expected = original.map(r => ({ ...r }));
  const feedback = String(validationFeedback ?? "").trim();

  if (feedback) {
    const clauses = [
      ...feedback.matchAll(/validation error:\s*([^.!?]+)/gi)
    ];

    if (clauses.length === 0) {
      return fail("unsupported_validation_feedback");
    }

    const grouped = new Map();

    for (const clause of clauses) {
      const match = clause[1].trim().match(
        /^(.+?)\s+must start with\s+([A-Za-z0-9_-]+)$/i
      );

      if (!match) {
        return fail("unsupported_validation_constraint");
      }

      const label = match[1].trim();
      const prefix = match[2];
      const key = label.toLowerCase();

      const existing = grouped.get(key) ?? {
        label,
        prefixes: []
      };

      existing.prefixes.push(prefix);
      grouped.set(key, existing);
    }

    for (const { label, prefixes } of grouped.values()) {
      const matching = expected.filter(r =>
        String(r.label).trim().toLowerCase() ===
        label.toLowerCase()
      );

      if (
        matching.length !== 1 ||
        matching[0].kind !== "text" ||
        typeof matching[0].value !== "string"
      ) {
        return fail("validation_field_not_uniquely_matched", label);
      }

      const ordered = [...new Set(prefixes)]
        .sort((a, b) => b.length - a.length);

      const longest = ordered[0];

      if (!ordered.every(prefix =>
        longest.startsWith(prefix)
      )) {
        return fail("contradictory_validation_prefix_constraints", label);
      }

      const requirement = matching[0];
      const originalValue = requirement.value;

      // If the original value already satisfies the most specific
      // prefix, preserve it byte-for-byte.
      if (originalValue.startsWith(longest)) {
        continue;
      }

      // Replace one less-specific required prefix, if present.
      // Never strip repeated prefixes from an already-valid value.
      const existingPrefix = ordered.find(prefix =>
        originalValue.startsWith(prefix)
      );

      requirement.value = longest + (
        existingPrefix
          ? originalValue.slice(existingPrefix.length)
          : originalValue
      );
    }
  }

  if (!sameRequirements(expected, extraction.requirements)) {
    return fail("derived_value_differs_from_attested_intent");
  }

  return {
    verified: true,
    issues: [],
    attestation: {
      verified: true,
      source: "independent_verifier",
      requirements: expected.map(r => ({ ...r }))
    }
  };
}
