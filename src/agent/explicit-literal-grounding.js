// Check explicitly quoted field assignments without using an LLM.
// Other kinds of instructions remain the responsibility of semantic extraction.

function normalizeLabel(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^the /, "")
    .replace(/ (field|input)$/, "");
}

export function explicitLiteralGroundingIssues({
  instruction,
  requirements,
  validationFeedback = ""
}) {
  const issues = [];

  // Examples:
  // Set Workspace Name to "Atlas Research"
  // Enter Project Code as 'ABC'
  const instructionText = String(instruction ?? "");

  const quotedAssignments = [
    ...instructionText.matchAll(
      /\b(?:set|enter|fill|type)\s+([A-Za-z][A-Za-z0-9 _-]{0,80}?)\s+(?:to|as|with)\s*(["'])(.*?)\2/gi
    )
  ].map(match => ({
    label: match[1],
    value: match[3]
  }));

  // Conservatively recognize unquoted assignments with a
  // clear command boundary. Do not infer arbitrary prose values.
  const unquotedAssignments = [
    ...instructionText.matchAll(
      /\b(?:set|enter|fill|type)\s+([A-Za-z][A-Za-z0-9 _-]{0,80}?)\s+(?:to|as|with)\s+([A-Za-z0-9][A-Za-z0-9 _-]{0,119}?)(?=,\s*(?:(?:and|then)\s+)?(?:set|enter|fill|type|save|submit)\b|\s+(?:and|then)\s+(?:set|enter|fill|type|save|submit)\b|[.;]|$)/gi
    )
  ].map(match => ({
    label: match[1],
    value: match[2].trim()
  }));

  const assignments = [
    ...quotedAssignments,
    ...unquotedAssignments
  ];

  if (assignments.length === 0) return issues;

  const literals = new Map();

  for (const match of assignments) {
    const label = normalizeLabel(match.label);
    const value = match.value;

    if (literals.has(label) && literals.get(label) !== value) {
      issues.push({
        label,
        reason: "conflicting_explicit_literal_assignments"
      });
    } else {
      literals.set(label, value);
    }
  }

  const constraints = [
    ...String(validationFeedback ?? "").matchAll(
      /validation error:\s*([^.!?]+?)\s+must start with\s+([A-Za-z0-9_-]+)/gi
    )
  ];

  for (const [label, literal] of literals) {
    const matches = (requirements ?? []).filter(
      item => normalizeLabel(item.label) === label
    );

    if (
      matches.length !== 1 ||
      matches[0].kind !== "text" ||
      typeof matches[0].value !== "string"
    ) {
      issues.push({
        label,
        reason: "explicit_literal_field_missing_or_ambiguous"
      });
      continue;
    }

    const prefixes = [
      ...new Set(
        constraints
          .filter(match => normalizeLabel(match[1]) === label)
          .map(match => match[2])
      )
    ].sort((a, b) => b.length - a.length);

    let expected = literal;

    if (prefixes.length > 0) {
      const longest = prefixes[0];

      if (!prefixes.every(prefix => longest.startsWith(prefix))) {
        issues.push({
          label,
          reason: "contradictory_validation_prefix_constraints"
        });
        continue;
      }

      if (!literal.startsWith(longest)) {
        const existing = prefixes.find(prefix =>
          literal.startsWith(prefix)
        );

        expected = longest + (
          existing
            ? literal.slice(existing.length)
            : literal
        );
      }
    }

    if (matches[0].value !== expected) {
      issues.push({
        label,
        reason: "explicit_literal_value_mismatch",
        expected,
        extracted: matches[0].value
      });
    }
  }

  return issues;
}
