const GOAL_FIELDS = {
  page_destination: new Set([
    "type",
    "identity",
    "hostname",
    "pathname",
    "pathnamePattern",
    "heading",
    "text"
  ]),
  visible_content: new Set([
    "type",
    "text",
    "hostname",
    "pathname"
  ]),
  visible_form: new Set(["type"]),
  form_state: new Set([
    "type",
    "fieldLabel",
    "expectedValue"
  ]),
  element_count: new Set(["type", "label", "expectedValue"]),
  paragraph_count: new Set(["type", "expectedValue"]),
  modal_closed: new Set(["type"]),
  all_of: new Set([
    "type",
    "conditions"
  ])
};

const MAX_DEPTH = 5;
const MAX_CONDITIONS = 20;

function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function nonEmpty(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0
  );
}

function validate(goal, depth = 0) {
  if (!isObject(goal)) {
    throw new Error("Goal must be an object.");
  }

  if (depth > MAX_DEPTH) {
    throw new Error("Goal nesting depth exceeded.");
  }

  const allowed = GOAL_FIELDS[goal.type];

  if (!allowed) {
    throw new Error(
      `Unsupported goal type: ${String(goal.type)}`
    );
  }

  for (const key of Object.keys(goal)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Unexpected field "${key}" in ${goal.type} goal.`
      );
    }
  }

  if (goal.type === "all_of") {
    if (
      !Array.isArray(goal.conditions) ||
      goal.conditions.length < 1 ||
      goal.conditions.length > MAX_CONDITIONS
    ) {
      throw new Error(
        "all_of requires 1–20 conditions."
      );
    }

    return {
      type: "all_of",
      conditions: goal.conditions.map(
        condition => validate(condition, depth + 1)
      )
    };
  }

  for (const [key, value] of Object.entries(goal)) {
    const validBoolean =
      goal.type === "form_state" &&
      key === "expectedValue" &&
      typeof value === "boolean";

    if (
      key !== "type" &&
      typeof value !== "string" &&
      !validBoolean
    ) {
      throw new Error(
        `${goal.type}.${key} must be a string.`
      );
    }
  }

  if (goal.type === "page_destination") {
    if (
      !nonEmpty(goal.hostname) &&
      !nonEmpty(goal.pathname) &&
      !nonEmpty(goal.pathnamePattern) &&
      !nonEmpty(goal.heading) &&
      !nonEmpty(goal.text) &&
      !nonEmpty(goal.identity)
    ) {
      throw new Error(
        "page_destination requires a destination constraint."
      );
    }

    if (
      nonEmpty(goal.pathname) &&
      nonEmpty(goal.pathnamePattern)
    ) {
      throw new Error(
        "Use pathname or pathnamePattern, not both."
      );
    }

    if (nonEmpty(goal.pathnamePattern)) {
      if (goal.pathnamePattern.length > 200) {
        throw new Error("Pathname pattern too long.");
      }

      try {
        new RegExp(goal.pathnamePattern);
      } catch {
        throw new Error("Invalid pathnamePattern.");
      }
    }
  }

  if (
    goal.type === "visible_content" &&
    !nonEmpty(goal.text)
  ) {
    throw new Error(
      "visible_content requires non-empty text."
    );
  }

  if (goal.type === "paragraph_count") {
    if (!/^\d+$/.test(String(goal.expectedValue ?? '')))
      throw new Error('paragraph_count requires a nonnegative integer count.');
  }

  if (goal.type === "element_count") {
    if (!nonEmpty(goal.label) ||
        !/^\d+$/.test(String(goal.expectedValue ?? ''))) {
      throw new Error('element_count requires a label and nonnegative integer count.');
    }
  }

  if (goal.type === "form_state") {
    if (!nonEmpty(goal.fieldLabel)) {
      throw new Error(
        "form_state requires fieldLabel."
      );
    }

    if (
      typeof goal.expectedValue !== "string" &&
      typeof goal.expectedValue !== "boolean"
    ) {
      throw new Error(
        "form_state requires expectedValue string or boolean."
      );
    }
  }

  return { ...goal };
}


function normalizeGoalIdentity(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeExpectedState(value) {
  if (typeof value === "boolean") {
    return value ? "boolean:true" : "boolean:false";
  }

  return `string:${String(value)}`;
}

function detectGoalContradictions(goal) {
  const formStates = new Map();

  function visit(node) {
    if (node.type === "all_of") {
      for (const condition of node.conditions) {
        visit(condition);
      }
      return;
    }

    if (node.type !== "form_state") {
      return;
    }

    const field = normalizeGoalIdentity(node.fieldLabel);
    const expected = normalizeExpectedState(node.expectedValue);

    if (formStates.has(field)) {
      const previous = formStates.get(field);

      if (previous !== expected) {
        throw new Error(
          `Contradictory form_state goals for "${node.fieldLabel}".`
        );
      }
    } else {
      formStates.set(field, expected);
    }
  }

  visit(goal);
}

export function validateGoalSchema(goal) {
  const validated = validate(goal);
  detectGoalContradictions(validated);
  return validated;
}
