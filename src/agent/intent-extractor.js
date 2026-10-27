import { reconcileDesiredState } from "./desired-state-planner.js";

const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const MODEL = process.env.COPILOT_OLLAMA_MODEL || "qwen3:4b";

const SYSTEM_PROMPT = `
You are a browser-agent intent interpreter.

Convert the user's instruction into desired form-field states.

Rules:
1. Only use fields present in the observed field catalog.
2. Match fields by their labels and types.
3. Do not invent missing user preferences.
4. Preserve the user's original intended values.
5. If explicit website validation feedback requires a correction,
   apply the correction only to the affected field.
6. Do not change unrelated fields.
7. Do not interpret buttons, links, or destructive actions as fields.
8. Never produce actions such as click, submit, delete, or navigate.
9. For checkboxes, use JSON booleans.
10. For selects, use an available option value when supplied.
11. If a required value cannot be determined, omit that requirement.
12. Return JSON only, with no Markdown.

Output schema:
{
  "requirements": [
    {
      "label": "exact observed label",
      "kind": "text|select|checkbox",
      "value": "string or boolean"
    }
  ],
  "unresolved": [
    {
      "label": "field label or unknown",
      "reason": "brief explanation"
    }
  ]
}
`;

function fieldCatalog(observation) {
  return (observation?.actionableElements ?? [])
    .filter(element =>
      element.type === "checkbox" ||
      element.tag === "select" ||
      (element.editable && element.tag !== "select")
    )
    .map(element => ({
      label: element.label,
      kind: element.type === "checkbox"
        ? "checkbox"
        : element.tag === "select"
          ? "select"
          : "text",
      currentValue: element.currentValue ?? "",
      checked: element.checked ?? false,
      options: element.options ?? []
    }));
}

function validateRequirements(result, catalog) {
  const requirements = [];
  const unresolved = Array.isArray(result.unresolved)
    ? result.unresolved
    : [];

  const seen = new Set();

  for (const requirement of result.requirements ?? []) {
    const matches = catalog.filter(field =>
      field.label === requirement.label &&
      field.kind === requirement.kind
    );

    if (matches.length !== 1) {
      unresolved.push({
        label: requirement.label ?? "unknown",
        reason: "Field missing or ambiguous"
      });
      continue;
    }

    if (seen.has(requirement.label)) {
      unresolved.push({
        label: requirement.label,
        reason: "Duplicate requirement"
      });
      continue;
    }

    if (
      requirement.kind === "checkbox" &&
      typeof requirement.value !== "boolean"
    ) {
      unresolved.push({
        label: requirement.label,
        reason: "Checkbox value must be boolean"
      });
      continue;
    }

    if (
      requirement.kind !== "checkbox" &&
      typeof requirement.value !== "string"
    ) {
      unresolved.push({
        label: requirement.label,
        reason: "Field value must be a string"
      });
      continue;
    }

    const options = matches[0].options;

    if (
      requirement.kind === "select" &&
      options.length > 0 &&
      !options.some(option =>
        (typeof option === "string" ? option : option.value) ===
        requirement.value
      )
    ) {
      unresolved.push({
        label: requirement.label,
        reason: "Value not present in select options"
      });
      continue;
    }

    seen.add(requirement.label);
    requirements.push({
      label: requirement.label,
      kind: requirement.kind,
      value: requirement.value
    });
  }

  return { requirements, unresolved };
}


function applyExplicitPrefixConstraint(result, feedback, instruction = "") {
  const text = String(feedback ?? "");

  const matches = [
    ...text.matchAll(
      /validation error:\s*([^.!?]+?)\s+must start with\s+([A-Za-z0-9_-]+)/gi
    )
  ];

  if (matches.length === 0) return result;

  const groups = new Map();

  for (const match of matches) {
    const label = match[1].trim();
    const key = label.toLowerCase();

    if (!groups.has(key)) {
      groups.set(key, { label, prefixes: [] });
    }

    groups.get(key).prefixes.push(match[2]);
  }

  const requirements = result.requirements.map(
    item => ({ ...item })
  );

  const unresolved = [...(result.unresolved ?? [])];

  // Detect contradictions before changing any requirement.
  for (const { label, prefixes } of groups.values()) {
    for (let i = 0; i < prefixes.length; i++) {
      for (let j = i + 1; j < prefixes.length; j++) {
        const a = prefixes[i];
        const b = prefixes[j];

        if (!a.startsWith(b) && !b.startsWith(a)) {
          return {
            ...result,
            unresolved: [
              ...unresolved,
              {
                label,
                reason: "contradictory_validation_prefix_constraints"
              }
            ]
          };
        }
      }
    }
  }

  for (const { label, prefixes } of groups.values()) {
    const ordered = [...new Set(prefixes)]
      .sort((a, b) => b.length - a.length);

    const canonical = ordered[0];

    const candidates = requirements.filter(item =>
      item.label.trim().toLowerCase() ===
        label.toLowerCase() &&
      item.kind === "text" &&
      typeof item.value === "string"
    );

    if (candidates.length !== 1) {
      unresolved.push({
        label,
        reason: "validation_constraint_field_ambiguous"
      });
      continue;
    }

    const requirement = candidates[0];
    let value = requirement.value;

    if (value.startsWith(canonical)) {
      value = value.slice(canonical.length);
    } else {
      const existingPrefix = ordered.find(prefix =>
        value.startsWith(prefix)
      );

      if (existingPrefix) {
        value = value.slice(existingPrefix.length);
      }
    }

    // Preserve an explicitly requested value that already
    // satisfies the website's required prefix.
    const originalValue = requirement.value;

    const explicitlyRequestedAndValid =
      originalValue.startsWith(canonical) &&
      String(instruction).includes(originalValue);

    if (explicitlyRequestedAndValid) {
      requirement.value = originalValue;
    } else {
      let changed = true;

      while (changed) {
        changed = false;

        for (const prefix of ordered) {
          if (value.startsWith(prefix)) {
            value = value.slice(prefix.length);
            changed = true;
            break;
          }
        }
      }

      requirement.value = canonical + value;
    }

    // Clear only prefix-related unresolved feedback that
    // the canonical value now demonstrably satisfies.
    for (let i = unresolved.length - 1; i >= 0; i--) {
      const item = unresolved[i];

      const sameField =
        String(item.label ?? "").trim().toLowerCase() ===
        label.toLowerCase();

      const reason = String(item.reason ?? "").toLowerCase();

      const prefixRelated =
        reason.includes("start with") &&
        ordered.some(prefix =>
          reason.includes(prefix.toLowerCase())
        );

      if (sameField && prefixRelated) {
        unresolved.splice(i, 1);
      }
    }
  }

  return {
    ...result,
    requirements,
    unresolved
  };
}
export async function extractDesiredState(
  instruction,
  observation,
  validationFeedback = ""
) {
  const catalog = fieldCatalog(observation);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  let response;

  try {
    response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: false,
        format: {
          type: "object",
          additionalProperties: false,
          required: ["requirements", "unresolved"],
          properties: {
            requirements: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "kind", "value"],
                properties: {
                  label: { type: "string" },
                  kind: {
                    type: "string",
                    enum: ["text", "select", "checkbox"]
                  },
                  value: {
                    anyOf: [
                      { type: "string" },
                      { type: "boolean" }
                    ]
                  }
                }
              }
            },
            unresolved: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "reason"],
                properties: {
                  label: { type: "string" },
                  reason: { type: "string" }
                }
              }
            }
          }
        },
        options: {
          temperature: 0,
          num_ctx: 4096
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              "Extract the desired final values for the form fields.",
              "Do not repeat the input. Produce the required output schema.",
              "",
              "USER INSTRUCTION:",
              instruction,
              "",
              "WEBSITE VALIDATION FEEDBACK:",
              validationFeedback || "(none)",
              "",
              "AVAILABLE FORM FIELDS:",
              JSON.stringify(catalog, null, 2)
            ].join("\\n")
          }
        ]
      })
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status}`);
  }

  const payload = await response.json();
  const content = payload?.message?.content;

  if (!content) {
    throw new Error("LLM returned empty intent response");
  }

  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("LLM returned invalid intent JSON");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.requirements)
  ) {
    console.error("\n========== INTENT SCHEMA DEBUG ==========");
    console.error("RAW MODEL RESPONSE:", content);
    console.error("PARSED RESPONSE:", JSON.stringify(parsed, null, 2));
    console.error("=========================================\n");

    throw new Error("LLM returned invalid intent schema");
  }

  const validated = validateRequirements(parsed, catalog);

  const corrected = applyExplicitPrefixConstraint(validated, validationFeedback, instruction);

  return {
    ...corrected,
    reconciliation: reconcileDesiredState(
      corrected.requirements,
      observation
    )
  };
}


export function deriveDesiredStateFromBaseline(
  baseline,
  observation,
  validationFeedback = "",
  originalInstruction = ""
) {
  if (
    !Array.isArray(baseline?.requirements) ||
    baseline.requirements.length === 0
  ) {
    throw new Error("Invalid immutable intent baseline");
  }

  const originalRequirements = baseline.requirements.map(
    requirement => ({ ...requirement })
  );

  const corrected = applyExplicitPrefixConstraint(
    {
      requirements: originalRequirements,
      unresolved: []
    },
    validationFeedback,
    originalInstruction
  );

  return {
    ...corrected,
    reconciliation: reconcileDesiredState(
      corrected.requirements,
      observation
    )
  };
}
