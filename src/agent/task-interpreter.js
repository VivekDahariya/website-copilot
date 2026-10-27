import { buildRepositoryDestinationGoal } from "./repository-result-planner.js";
import {
  validateGoalSchema
} from "./goal-schema-validator.js";
import { deriveExplicitOutcomeGoal } from "./explicit-goal-repair.js";

const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";
const MODEL = process.env.COPILOT_OLLAMA_MODEL || "qwen3:4b";

function extractJSON(text) {
  if (typeof text !== "string") {
    throw new Error("LLM returned non-text output.");
  }

  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start < 0 || end <= start) {
      throw new Error("No JSON object in LLM response.");
    }

    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function validateTask(task) {
  if (
    !task ||
    typeof task !== "object" ||
    Array.isArray(task)
  ) {
    throw new Error("Invalid task object.");
  }

  if (task.type === "product_comparison") {
    if (
      typeof task.startUrl !== "string" ||
      typeof task.category !== "string"
    ) {
      throw new Error(
        "Product comparison requires startUrl and category."
      );
    }

    const url = new URL(task.startUrl);

    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Unsupported URL protocol.");
    }

    if (
      !Number.isInteger(task.limit) ||
      task.limit < 1 ||
      task.limit > 10
    ) {
      throw new Error("Product limit must be 1–10.");
    }

    if (!task.category.trim()) {
      throw new Error("Category cannot be empty.");
    }

    return {
      type: "product_comparison",
      startUrl: url.href,
      category: task.category.trim(),
      limit: task.limit
    };
  }

  if (task.type === "browser_goal") {
    if (
      typeof task.instruction !== "string" ||
      !task.instruction.trim() ||
      !task.goal ||
      typeof task.goal !== "object" ||
      Array.isArray(task.goal)
    ) {
      throw new Error("Invalid browser goal.");
    }

    const allowedGoalTypes = new Set([
      "page_destination",
      "visible_content",
      "visible_form",
      "form_state",
      "element_count",
      "paragraph_count",
      "modal_closed",
      "all_of"
    ]);

    if (!allowedGoalTypes.has(task.goal.type)) {
      throw new Error("Unsupported browser goal type.");
    }

    let startUrl;

    if (task.startUrl !== undefined) {
      const parsed = new URL(task.startUrl);

      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Unsupported URL protocol.");
      }

      startUrl = parsed.href;
    }

    return {
      type: "browser_goal",
      instruction: task.instruction.trim(),
      goal: validateGoalSchema(normalizeGeneratedGoal(task.goal)),
      ...(startUrl ? { startUrl } : {})
    };
  }

  throw new Error(
    `Unsupported interpreted task: ${String(task.type)}`
  );
}




function requestedNavigationIdentity(instruction) {
  const text = String(instruction)
    .replace(/https?:\/\/[^\s,;<>]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const clean = value => String(value || "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+(?:through|from|via|using)\b.*$/i, "")
    .trim();

  const valid = value =>
    value.length >= 3 &&
    value.length <= 80 &&
    value.split(/\s+/).length <= 8 &&
    !/^(?:his|her|their|its|this|that|it|them|him)$/i.test(value);

  const patterns = [
    // "Navigate to the JavaScript Array documentation page"
    /\b(?:navigate to|open|visit)\s+(?:the\s+)?(.+?)\s+(?:documentation|tutorial|author)\s+page\b/i,

    // "Find and open the Python Tutorial"
    /\bfind and open\s+(?:the\s+)?(.+?\b(?:tutorial|documentation|guide))(?=\s+(?:from|through|via|on)\b|[.,;]|$)/i,

    // "Navigate to the form demonstration page"
    /\b(?:navigate to|open|visit)\s+(?:the\s+)?(.+?)\s+page\b/i,

    // "Find Albert Einstein through the website's author links"
    /\bfind\s+(?:the\s+)?(.+?)\s+(?:through|via|using)\b/i,

    // "Find the Forms example"
    /\bfind\s+(?:the\s+)?(.+?)\s+example\b/i,

    // "Open the HTML Forms tutorial"
    /\bopen\s+(?:the\s+)?(.+?)\s+tutorial\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const candidate = clean(match[1]);

    if (valid(candidate) &&
        !/\b(?:and then|verify|finish when|confirm)\b/i.test(candidate)) {
      return candidate;
    }
  }

  return null;
}


function explicitDestinationHeading(instruction) {
  const text = String(instruction || "");

  const match = text.match(
    /\b(?:verify|confirm|finish when|finish only when)\b[\s\S]*?\b(?:the\s+)?(.+?)\s+heading\s+(?:is\s+)?visible\b/i
  );

  return match
    ? match[1].replace(/^.*?\b(?:that|the)\s+/i, "").trim()
    : null;
}

function normalizeDestinationIdentity(value) {
  return String(value || "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+(?:page|article|tutorial page|documentation page)$/i, "")
    .trim();
}

function navigationOnlyDestination(goal, instruction) {
  const text = String(instruction || "").trim();

  // Navigation-only instructions must not inherit invented
  // literal-text or form-state requirements from the model.
  const explicitVerification =
    /\b(?:verify|confirm|ensure|check|finish when|finish only when|stop when)\b/i.test(text);

  const explicitMutation =
    /\b(?:fill|enter|type|submit|select|check|uncheck|enable|disable|change|update|save|delete|remove)\b/i.test(text);

  if (explicitVerification || explicitMutation ||
    /\b(?:who|where|which|why|how)\b/i.test(text)) return null;

  const navigationRequested =
    /\b(?:find|open|navigate|visit|go to)\b/i.test(text);

  if (!navigationRequested) return null;

  let requested = null;

  // "Find and open the Python Tutorial from the documentation homepage"
  const findAndOpen = text.match(
    /\bfind and open\s+(?:the\s+)?(.+?)(?=\s+(?:from|through|via|on)\b|[.!?]|$)/i
  );

  // "Find the Forms example and navigate to the form demonstration page"
  const findThenNavigate = text.match(
    /\bfind\s+(?:the\s+)?(.+?)\s+and\s+(?:navigate|open|go)\b/i
  );

  // "Navigate to the XYZ page"
  const navigateTo = text.match(
    /\b(?:navigate to|open|visit|go to)\s+(?:the\s+)?(.+?)(?=[.!?]|$)/i
  );

  if (findAndOpen) {
    requested = findAndOpen[1];
  } else if (findThenNavigate) {
    requested = findThenNavigate[1];
  } else if (navigateTo) {
    requested = navigateTo[1];
  }

  if (!requested) return null;

  const identity = String(requested)
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+(?:page|article|example)$/i, "")
    .trim();

  if (
    !identity || identity.length > 80 ||
    /^(?:his|her|their|its|this|that|it|them|him)$/i.test(identity) ||
    /https?:|webpage:|\b(?:who|where|which|why|how)\b/i.test(identity)
  ) return null;

  const conditions = goal?.type === "all_of"
    ? goal.conditions
    : [goal];

  const destination = conditions.find(
    condition => condition?.type === "page_destination"
  );

  return {
    type: "page_destination",
    ...(destination?.hostname
      ? { hostname: destination.hostname }
      : {}),
    identity
  };
}

function explicitVisibleFormGoal(instruction) {
  const text = String(instruction || "");

  const formRequested = /\bform\s+demonstration\b/i.test(text);

  const visibilityRequired =
    /\b(?:finish when|finish only when|verify|confirm|ensure)\b[\s\S]*?\bform\s+demonstration\s+is\s+visible\b/i.test(text);

  if (!formRequested || !visibilityRequired) return null;

  return { type: "visible_form" };
}

function enforceNavigationGoal(goal, instruction) {
  const text = String(instruction);
  const visibleForm = explicitVisibleFormGoal(text);
  if (visibleForm) return visibleForm;


  // For simple repository navigation, derive goal constraints from
  // the user's instruction rather than an invented model heading.
  const repositoryGoal = buildRepositoryDestinationGoal(text);

  if (repositoryGoal) return repositoryGoal;

  const navigationOnly = navigationOnlyDestination(goal, text);
  if (navigationOnly) return navigationOnly;

  const navigationRequested =
    /\b(?:navigate|open|visit|find|go to)\b/i.test(text) &&
    /\b(?:page|article|tutorial|documentation|guide|author|example)\b/i
      .test(text);

  if (!navigationRequested ||
      /\b(?:who|where|which|why|how)\b/i.test(text)) return goal;

  const conditions = goal.type === "all_of"
    ? goal.conditions
    : [goal];

  const destination = conditions.find(
    condition => condition?.type === "page_destination"
  );

  const preserve = conditions.filter(
    condition => condition?.type === "form_state"
  );

  // A user-requested form change must remain a form change.
  // Navigation-only tasks must not inherit invented form actions.

  const explicitHeading = text.match(
    /\b(?:verify|confirm|finish when)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+heading\s+(?:is\s+)?visible\b/i
  );

  const heading = explicitHeading
    ? explicitHeading[1]
        .replace(/^.*?\b(?:the)\s+(?=[A-Z])/i, "")
        .replace(/\s+author$/i, "")
        .trim()
    : null;

  const identity = requestedNavigationIdentity(text);

  // An explicit final-state instruction takes precedence over
  // intermediate navigation labels. Do not add an identity
  // requirement that the user did not ask to verify.
  const explicitFinalState =
    /\b(?:finish only when|finish when|stop when)\b/i.test(text);

  if (explicitFinalState && !heading) {
    return goal;
  }

  // Explicitly requested headings take priority when reliably
  // extracted. Otherwise use the destination named by the user.
  const requested = heading || identity;

  if (!requested) return goal;

  const revised = {
    type: "page_destination",
    ...(destination?.hostname
      ? { hostname: destination.hostname }
      : {}),
    ...(heading
      ? { heading }
      : { identity: requested })
  };

  // Preserve only independently requested visible-content checks.
  const visible = conditions.filter(condition =>
    condition?.type === "visible_content" &&
    typeof condition.text === "string" &&
    text.toLowerCase().includes(condition.text.trim().toLowerCase())
  );

  const combined = [revised, ...preserve, ...visible];

  return combined.length === 1
    ? combined[0]
    : { type: "all_of", conditions: combined };
}

function groundDestinationPaths(goal, instruction) {
  if (goal.type === "all_of") {
    return {
      ...goal,
      conditions: goal.conditions.map(
        condition => groundDestinationPaths(condition, instruction)
      )
    };
  }

  if (goal.type !== "page_destination") {
    return goal;
  }

  const grounded = { ...goal };

  const suppliedUrls = [
    ...instruction.matchAll(/https?:\/\/[^\s,;<>]+/gi)
  ].flatMap(match => {
    try {
      return [new URL(match[0].replace(/[.)]+$/, ""))];
    } catch {
      return [];
    }
  });

  if (typeof grounded.pathname === "string") {
    const pathnameGrounded = suppliedUrls.some(
      url =>
        url.pathname === grounded.pathname &&
        (
          !grounded.hostname ||
          url.hostname.toLowerCase() ===
            grounded.hostname.toLowerCase()
        )
    );

    if (!pathnameGrounded) {
      delete grounded.pathname;
    }
  }

  // A generated regex cannot be verified against a literal
  // pathname supplied by the user without inventing scope.
  // Remove it unless it appears literally in the instruction.
  if (
    typeof grounded.pathnamePattern === "string" &&
    !instruction.includes(grounded.pathnamePattern)
  ) {
    delete grounded.pathnamePattern;
  }

  return grounded;
}

function hasDestinationEvidence(goal) {
  if (goal.type === "all_of") {
    return goal.conditions.every(hasDestinationEvidence);
  }

  if (goal.type !== "page_destination") {
    return true;
  }

  return [
    goal.hostname,
    goal.pathname,
    goal.pathnamePattern,
    goal.heading,
    goal.text
  ].some(
    value =>
      typeof value === "string" &&
      value.trim().length > 0
  );
}

function interpretExplicitComparison(instruction) {
  const urlMatch = instruction.match(
    /https?:\/\/[^\s,;<>]+/i
  );

  const countMatch = instruction.match(
    /\b(?:compare|comparison of|find|check|evaluate)\s+(\d+)\b/i
  );

  const categoryMatch = instruction.match(
    /\b(\d+)\s+([a-z][a-z\s-]*?)\s+(?:products?|items?|books?)\b/i
  );

  const comparisonIntent =
    /\b(?:compare|comparison|cheapest|lowest price)\b/i.test(
      instruction
    );

  if (
    !comparisonIntent ||
    !urlMatch ||
    !countMatch ||
    !categoryMatch
  ) {
    return null;
  }

  const category = categoryMatch[2].trim();

  if (!category) {
    return null;
  }

  const limit = Number(countMatch[1]);

  return validateTask({
    type: "product_comparison",
    startUrl: urlMatch[0].replace(/[.)]+$/, ""),
    category,
    limit
  });
}


function normalizeGeneratedGoal(goal) {
  if (!goal || typeof goal !== "object" || Array.isArray(goal)) {
    return goal;
  }

  const normalized = { ...goal };

  // JSON Schema output can still put "conditions" under form_state.
  // Recover ONLY explicitly supplied complete field goals; never invent
  // labels/values, silently discard unknown properties, or accept nesting.
  if (normalized.type === "form_state" &&
      Array.isArray(normalized.conditions) &&
      normalized.conditions.length > 0 &&
      normalized.conditions.every(item =>
        item && typeof item === "object" && !Array.isArray(item) &&
        item.type === "form_state" &&
        !Object.hasOwn(item, "conditions")
      )) {
    const hasField = typeof normalized.fieldLabel === "string" &&
      normalized.fieldLabel.trim().length > 0;
    const hasValue = typeof normalized.expectedValue === "string" ||
      typeof normalized.expectedValue === "boolean";
    const rootKeys = Object.keys(normalized).filter(key =>
      !["type", "conditions", "fieldLabel", "expectedValue"].includes(key)
    );
    if (rootKeys.length === 0 && hasField === hasValue) {
      const conditions = [
        ...(hasField ? [{
          type: "form_state",
          fieldLabel: normalized.fieldLabel,
          expectedValue: normalized.expectedValue
        }] : []),
        ...normalized.conditions
      ];
      return { type: "all_of", conditions };
    }
  }

  if (normalized.type !== "all_of") return normalized;

  // Accept a common LLM alias without changing the strict goal schema.
  if (!Object.hasOwn(normalized, "conditions") &&
      Array.isArray(normalized.goals)) {
    normalized.conditions = normalized.goals;
    delete normalized.goals;
  }

  if (Array.isArray(normalized.conditions)) {
    normalized.conditions = normalized.conditions.map(normalizeGeneratedGoal);
  }

  return normalized;
}

export function groundFormGoal(goal, formControls = [], instruction = '') {
  if (!goal || !Array.isArray(formControls) || !formControls.length) return goal;
  if (goal.type === 'all_of') return {
    ...goal,
    conditions: goal.conditions.map(item => groundFormGoal(item, formControls, instruction))
  };
  if (goal.type !== 'form_state') return goal;

  const normalize = v => String(v ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const target = normalize(goal.fieldLabel);
  const fields = formControls.filter(item =>
    item.type !== 'password' && item.type !== 'hidden' &&
    !['submit','button','reset'].includes(item.type));
  if (!fields.length) return goal;

  let chosen = fields.find(f => normalize(f.label) === target);
  if (!chosen) {
    const partial = fields.filter(f => target.length > 2 && (
      normalize(f.label).includes(target) ||
      (normalize(f.name) === target && f.name)
    ));
    if (partial.length === 1) chosen = partial[0];
  }
  // Semantic fallback is used ONLY for unique controls of that kind.
  if (!chosen) {
    let kind = null;
    if (/\b(textarea|text area|writing area|large writing|paragraph|introduction|description)\b/i.test(goal.fieldLabel))
      kind = f => f.tag === 'textarea';
    else if (/\b(dropdown|select|option|choice|menu)\b/i.test(goal.fieldLabel))
      kind = f => f.tag === 'select';
    else if (/\b(name|text input|text field)\b/i.test(goal.fieldLabel))
      kind = f => f.tag === 'input' && (!f.type || f.type === 'text');
    if (kind) {
      let available = fields.filter(kind);
      if (/\b(name|text input|text field)\b/i.test(goal.fieldLabel)) {
        // Search boxes and datalist dropdowns are not generic name inputs.
        available = available.filter(f =>
          !/\b(search|query|datalist|dropdown|filter)\b/i.test(
            [f.label, f.name].filter(Boolean).join(' ')
          )
        );
      }
      if (available.length === 1) chosen = available[0];
    }
  }
  if (!chosen || !chosen.label) return goal;

  let expectedValue = goal.expectedValue;
  if (chosen.tag === 'select' &&
      /\b(second|2nd)\s+(?:option|choice|item)\b/i.test(instruction)) {
    const options = Array.isArray(chosen.options) ? chosen.options.filter(
      (item, index, all) =>
        all.length === 1 ||
        (item.value !== '' && !/^(?:choose|select|open this|please select)\b/i.test(item.label))
    ) : [];
    // Count choices, not empty placeholder entries. Do not invent an
    // option when the menu has fewer than two actual choices.
    if (options.length >= 2) expectedValue = options[1].label;
  }
  // Select labels sometimes contain all option text and newlines; the
  // stable first line identifies the field without incorporating choices.
  const groundedLabel = chosen.tag === 'select'
    ? chosen.label.split(/[\r\n]+/).map(s => s.trim()).find(Boolean) || chosen.label
    : chosen.label;
  return { ...goal, fieldLabel: groundedLabel, expectedValue };
}

// Ollama's JSON mode guarantees JSON syntax, not this application's schema.
// Normalize only recognizable goal envelopes; never invent a goal or a value.
export function normalizeModelTaskEnvelope(candidate, userInstruction) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return null;

  const taskTypes = new Set(["browser_goal", "product_comparison", "unsupported"]);
  const goalTypes = new Set([
    "page_destination", "visible_content", "visible_form", "form_state", "all_of"
  ]);

  if (taskTypes.has(candidate.type)) return candidate;
  if (candidate.type !== undefined && candidate.type !== null) {
    // Recognized standalone goal, NOT an unsupported task type.
    if (goalTypes.has(candidate.type))
      return {type: "browser_goal", instruction: userInstruction, goal: candidate};
    return null;
  }

  if (candidate.task && typeof candidate.task === "object")
    return normalizeModelTaskEnvelope(candidate.task, userInstruction);

  if (candidate.goal && typeof candidate.goal === "object" &&
      !Array.isArray(candidate.goal) && goalTypes.has(candidate.goal.type)) {
    return { ...candidate, type: "browser_goal", instruction: userInstruction };
  }
  return null;
}

// Check that an instruction to modify visible form controls is not
// silently turned into a navigation-only goal by a well-formed model reply.
export function requiresFormStateGoal(instruction, formControls = []) {
  if (!Array.isArray(formControls) || formControls.length === 0) return false;
  const request = String(instruction || "");
  const mutation = /\b(?:fill|type|enter|write|put|select|choose|pick|tick|uncheck|check|set|use)\b/i.test(request);
  const fieldReference = /\b(?:form|field|input|textarea|text|writing\s+area|name|option|dropdown|checkbox|radio|menu|box)\b/i.test(request);
  return mutation && fieldReference;
}

function hasFormStateGoal(goal) {
  if (!goal || typeof goal !== "object") return false;
  if (goal.type === "form_state") return true;
  if (goal.type === "all_of") return Array.isArray(goal.conditions) &&
    goal.conditions.some(condition => condition?.type === "form_state");
  return false;
}


// Generic, conservatively grounded intent corrections. These operate on the
// whole user instruction, not on the initial URL or isolated keyword fragments.
function repairObviousGoal(goal, instruction, formControls = [], currentUrl = '') {
  const explicit = deriveExplicitOutcomeGoal(instruction, formControls);
  if (explicit) return explicit;
  const text = String(instruction || '');
  const controls = Array.isArray(formControls) ? formControls : [];
  const select = controls.filter(c => c.tag === 'select');
  const numbers = controls.filter(c => c.tag === 'input' && c.type === 'number');
  if (/\b(?:close|dismiss|hide)\b[^.]*\b(?:modal|popup|pop-up)\b/i.test(text))
    return {type:'modal_closed'};
  const paragraphMatch = text.match(
    /\b(?:at least|minimum(?: of)?)\s+(\d+|one|two|three|four|five)\s+(?:content\s+)?paragraphs?\b/i
  );
  if (paragraphMatch && /\bscroll\b/i.test(text)) {
    const words={one:1,two:2,three:3,four:4,five:5};
    return {type:'paragraph_count',
      expectedValue:String(words[paragraphMatch[1].toLowerCase()] ?? Number(paragraphMatch[1]))};
  }
  const countMatch = text.match(/\bexactly\s+(\d+|one|two|three|four|five)\s+["']?([a-z][a-z\s-]{1,45}?)["']?\s+buttons?\s+(?:remain|remains|are left|left)\b/i);
  if (countMatch) {
    const wordCounts = {one:1,two:2,three:3,four:4,five:5};
    const count = wordCounts[countMatch[1].toLowerCase()] ?? Number(countMatch[1]);
    return {type:'element_count', label:countMatch[2].trim(), expectedValue:String(count)};
  }
  const wantedNumber = text.match(/\b(?:enter|fill|set|type)\s+(-?\d+(?:\.\d+)?)\s+(?:into|in)\s+(?:the\s+)?(?:number|numeric)\b/i);
  if (wantedNumber && numbers.length === 1) return {
    type: 'form_state', fieldLabel: numbers[0].label || 'number',
    expectedValue: wantedNumber[1]
  };
  const wantedOption = text.match(/\b(?:select|choose|set|make sure|confirm that)\b[^.]*?\boption\s*(\d+)\b/i);
  if (wantedOption && select.length === 1 &&
      /\b(?:select|dropdown|option)\b/i.test(text)) {
    return {type:'form_state', fieldLabel:select[0].label || 'dropdown',
      expectedValue:wantedOption[1]};
  }
  // A user asking to operate an in-place widget must not get a fabricated
  // page_destination whose heading is merely the current URL.
  const nonNavigation = /\b(?:scroll|right.click|drag|download|upload|press (?:the )?[a-z] key|sort|modal|popup|slider|birth date|date of birth|read the|return only|count|exactly \d+)\b/i.test(text);
  if (nonNavigation && goal?.type === 'page_destination' &&
      String(goal.heading || '').includes(currentUrl)) return null;
  return goal;
}
export async function interpretTask(
  instruction,
  {
    model = MODEL,
    fetchImpl = fetch,
    currentUrl = null,
    formControls = []
  } = {}
) {
  if (
    typeof instruction !== "string" ||
    !instruction.trim()
  ) {
    throw new Error("Instruction must be non-empty.");
  }

  const explicitTask = interpretExplicitComparison(
    instruction
  );

  if (explicitTask) {
    return {
      status: "interpreted",
      task: explicitTask
    };
  }

  // Ollama JSON mode only enforces valid JSON syntax. A compact JSON
  // schema also constrains the task envelope, avoiding long malformed
  // replies and most redundant full-model interpretation retries.
  // Application-side validation remains the source of truth.
  const goalFields = {
    type: { type: "string", enum: [
      "page_destination", "visible_content", "visible_form", "form_state", "element_count", "paragraph_count", "modal_closed", "all_of"
    ] },
    heading: { type: "string" },
    identity: { type: "string" },
    hostname: { type: "string" },
    pathname: { type: "string" },
    pathnamePattern: { type: "string" },
    text: { type: "string" },
    fieldLabel: { type: "string" },
    label: { type: "string" },
    expectedValue: { type: ["string", "boolean"] }
  };
  const individualGoal = {
    type: "object",
    properties: goalFields,
    required: ["type"],
    additionalProperties: false
  };
  const responseSchema = {
    type: "object",
    properties: {
      type: { type: "string", enum: ["browser_goal", "unsupported"] },
      goal: {
        ...individualGoal,
        properties: {
          ...goalFields,
          conditions: {
            type: "array", minItems: 1, maxItems: 20,
            description: "ONLY for goal.type=all_of; NEVER for form_state. Each form field is a separate form_state item.",
            items: individualGoal
          }
        }
      },
      reason: { type: "string" }
    },
    required: ["type"],
    additionalProperties: false
  };

  const systemPrompt = `Interpret the user's instruction as a VERIFIABLE browser goal.
You interpret intent, not browser actions. The currentUrl is context, NEVER
part of the user's instruction. Do not invent a URL or unrelated subject.

Return a single JSON object with type browser_goal and goal, or type unsupported
with a short reason when essential information is missing. No explanations,
markdown or instruction echo. Choose:
- page_destination: heading or identity of the actual final page, not search text.
- form_state: exact control label and expectedValue, one condition per field.
- element_count: label of repeated element and expectedValue as a number string (e.g. exactly one Delete button).
- If user asks to modify form fields, NEVER return page_destination merely
  because the form is already open. Use form_state or all_of form_state.
- all_of: conditions for multiple required states; no nested all_of.
  ONLY all_of may contain conditions. Never attach conditions to form_state.
- visible_content: user-required visible text; visible_form: requested form.

Resolve indirect descriptions into a specific entity only when confident;
otherwise request clarification. Never replace the requested subject.
For formControls use exact labels and observed option labels, excluding
placeholder options when counting. When user requests an introduction, write
short relevant content as expectedValue, never a password or secret.
Checkbox states can be true/false. Don't generate extra requirements.
NEVER add a submission goal for 'don't submit' or 'don't send'.
Keep the user's no-submit and other prohibitions binding.
An exploratory request such as 'find something interesting about AI' is valid.
Do not invent an exact user quote from freely authored text.`;


  let parsed = null;
  let previousResponse = "";
  let lastParseError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const requestPrompt = attempt === 0
      ? JSON.stringify({
          userInstruction: instruction,
          formEditsRequired: requiresFormStateGoal(instruction, formControls),
          currentUrl: /^https?:\/\//i.test(String(currentUrl || ""))
            ? currentUrl
            : null,
          formControls: Array.isArray(formControls) ? formControls.slice(0, 25) : []
        })
      : [
          requiresFormStateGoal(instruction, formControls)
            ? "CORRECTION: Your previous response did not match the required task schema. The user explicitly asks you to EDIT form controls. Return a browser_goal with form_state conditions for every requested field. A page_destination goal is incorrect. Do not submit."
            : "Your previous response did not match the required task schema. Return only valid JSON.",
          "For browser_goal, include goal.type and required goal properties.",
          "Use all_of.conditions for multiple form fields, one form_state each.",
          "ONLY all_of may contain conditions; form_state contains ONLY type, fieldLabel, expectedValue.",
          String(lastParseError?.message ?? ""),
          "Do not invent URLs or actions. Preserve no-submit constraints.",
          "",
          "ORIGINAL USER REQUEST:",
          instruction,
          "CURRENT URL (CONTEXT ONLY):",
          String(currentUrl ?? ""),
          "AVAILABLE NON-SECRET FORM CONTROLS:",
          JSON.stringify(Array.isArray(formControls) ? formControls.slice(0, 25) : []),
          "",
          "PREVIOUS INVALID RESPONSE:",
          previousResponse.slice(0, 1200)
        ].join("\n");

    const response = await fetchImpl(OLLAMA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        prompt: requestPrompt,
        stream: false,
        think: false,
        keep_alive: "10m",
        format: process.env.COPILOT_INTERPRETER_JSON === "1"
          ? "json"
          : responseSchema,
        options: {
          temperature: 0,
          num_ctx: 4096,
          // Bound excessive invalid output without clipping ordinary goals.
          num_predict: 1024
        }
      })
    });

    if (!response.ok) {
      throw new Error(
        `Ollama request failed: HTTP ${response.status}`
      );
    }

    const payload = await response.json();
    if (process.env.COPILOT_PERF === "1") {
      console.log("[PERF] interpret", {
        promptTokens: payload.prompt_eval_count,
        generatedTokens: payload.eval_count,
        loadMs: Math.round((payload.load_duration ?? 0) / 1e6),
        promptMs: Math.round((payload.prompt_eval_duration ?? 0) / 1e6),
        generationMs: Math.round((payload.eval_duration ?? 0) / 1e6)
      });
    }

    if (
      typeof payload.response !== "string" ||
      !payload.response.trim()
    ) {
      lastParseError = new Error(
        "Ollama returned an empty response."
      );
      previousResponse = "";
      continue;
    }

    previousResponse = payload.response;

    try {
      parsed = extractJSON(previousResponse);

      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new SyntaxError(
          "LLM response must be a JSON object."
        );
      }

      const normalized = normalizeModelTaskEnvelope(parsed, instruction);
      if (!normalized) {
        lastParseError = new Error(
          "The model returned JSON without a recognizable task type or goal."
        );
        parsed = null;
        continue;
      }
      if (normalized.type === "browser_goal" &&
          (!normalized.goal || typeof normalized.goal !== "object" ||
           Array.isArray(normalized.goal))) {
        lastParseError = new Error("The model returned a browser task without a goal.");
        parsed = null;
        continue;
      }
      if (normalized.type === "browser_goal") {
        const goal = normalizeGeneratedGoal(normalized.goal);
        if (requiresFormStateGoal(instruction, formControls) &&
            !hasFormStateGoal(goal)) {
          lastParseError = new Error(
            "Model returned a non-form goal for an explicit form-editing request."
          );
          parsed = null;
          continue;
        }
        try {
          // Check the REAL application schema during retries, not after
          // retries have been exhausted. Invalid JSON structure can then
          // receive corrective model feedback instead of ending the run.
          validateGoalSchema(goal);
        } catch (error) {
          lastParseError = error;
          parsed = null;
          continue;
        }
        parsed = { ...normalized, goal };
      } else {
        parsed = normalized;
      }
      break;
    } catch (error) {
      if (!(error instanceof SyntaxError) &&
          error.message !== "No JSON object in LLM response.") {
        throw error;
      }

      lastParseError = error;
      parsed = null;
    }
  }

  if (parsed === null) {
    // The 4B model occasionally nests conditions under form_state despite
    // the JSON schema. Recover only an outcome explicitly grounded in the
    // user's text; never invent unspecified actions or expected values.
    const explicit = deriveExplicitOutcomeGoal(instruction, formControls);
    if (explicit) {
      return { status:'interpreted', task:validateTask({
        type:'browser_goal', instruction, goal:explicit
      }) };
    }
    return {
      status: "needs_clarification",
      reason:
        "The local model could not produce a valid browser task " +
        "after two attempts. " +
        String(lastParseError?.message ?? "")
    };
  }

  const userUrls = [
    ...instruction.matchAll(/https?:\/\/[^\s,;<>]+/gi)
  ].map(match => match[0].replace(/[.)]+$/, ""));

  if (parsed.startUrl !== undefined) {
    const candidate = typeof parsed.startUrl === "string"
      ? parsed.startUrl.trim()
      : "";

    let parsedStartUrl = null;

    if (candidate) {
      try {
        parsedStartUrl = new URL(candidate);
      } catch {
        // The model may return placeholders or malformed URLs.
        // Never navigate to those values.
      }
    }

    if (
      !parsedStartUrl ||
      !["http:", "https:"].includes(parsedStartUrl.protocol)
    ) {
      if (userUrls.length === 1) {
        // The browser location was already supplied as grounded
        // context. Do not let a malformed AI URL override it.
        delete parsed.startUrl;
      } else {
        return {
          status: "needs_clarification",
          reason: "The model did not provide a valid grounded URL."
        };
      }
    } else {
      parsed.startUrl = parsedStartUrl.href;
    }
  }

  if (
    parsed.startUrl !== undefined &&
    !userUrls.some(url => {
      try {
        return new URL(url).href === new URL(parsed.startUrl).href;
      } catch {
        return false;
      }
    })
  ) {
    // An LLM may echo the already-open page despite instructions not
    // to invent startUrl. Drop the echo; never navigate to a fabricated URL.
    const sameAsOpenPage = (() => {
      try { return new URL(parsed.startUrl).href === new URL(currentUrl).href; }
      catch { return false; }
    })();
    if (sameAsOpenPage) delete parsed.startUrl;
    else return {
      status: "needs_clarification",
      reason: "The model supplied a URL not present in the request."
    };
  }

  if (parsed.type === "unsupported") {
    return {
      status: "needs_clarification",
      reason:
        typeof parsed.reason === "string"
          ? parsed.reason
          : "Request cannot be interpreted safely."
    };
  }

  if (parsed.type === "browser_goal") {
    // The user-facing instruction is immutable; generated paraphrases
    // cannot replace or weaken "do not submit" and similar constraints.
    parsed.instruction = instruction;
    const repairedGoal = repairObviousGoal(parsed.goal, instruction, formControls, currentUrl);
    if (!repairedGoal) return {
      status: 'needs_clarification',
      reason: 'The model misinterpreted an in-page operation as navigation. No unrelated clicks were performed.'
    };
    const normalized = normalizeGeneratedGoal(repairedGoal);

    const grounded = groundDestinationPaths(
      normalized,
      instruction
    );

    const malformedIdentity = condition => {
      if (condition?.type === "all_of")
        return condition.conditions?.some(malformedIdentity);
      if (condition?.type !== "page_destination") return false;
      const identity = String(condition.identity ?? "").trim();
      return Boolean(identity) && (
        /^(?:webpage|current\s*(?:page|url))\s*:/i.test(identity) ||
        /https?:\/\/|^www\./i.test(identity) ||
        /^(?:his|her|their|this|that|it|him|them)$/i.test(identity)
      );
    };
    if (malformedIdentity(grounded)) {
      return {
        status: "needs_clarification",
        reason: "The generated destination was not a valid topic or page identity."
      };
    }

    if (!hasDestinationEvidence(grounded)) {
      return {
        status: "needs_clarification",
        reason:
          "The generated destination had no grounded " +
          "verification constraints."
      };
    }


      parsed.goal = groundFormGoal(
        enforceNavigationGoal(grounded, instruction),
        formControls,
        instruction
      );

    // Preserve explicit heading-based completion requirements.
    // Do not retain redundant body-text conditions generated by the LLM.
    const explicitHeading = instruction.match(
      /\b(?:finish when|finish only when|verify|confirm|ensure)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+heading\s+(?:is\s+)?visible\b/i
    );

    if (explicitHeading) {
      const heading = explicitHeading[1]
        .trim()
        .replace(/\s+author$/i, "")
        .trim();

      const conditions = parsed.goal.type === "all_of"
        ? parsed.goal.conditions
        : [parsed.goal];

      const destination = conditions.find(
        condition => condition.type === "page_destination"
      );

      if (destination) {
        const revisedDestination = {
          ...destination,
          heading
        };

        delete revisedDestination.identity;

        const preserved = conditions.filter(
          condition =>
            condition.type === "form_state" ||
            (
              condition.type === "visible_content" &&
              condition.text?.trim().toLowerCase() !== heading.toLowerCase()
            )
        );

        parsed.goal = preserved.length
          ? {
              type: "all_of",
              conditions: [revisedDestination, ...preserved]
            }
          : revisedDestination;
      }
    }

  }

  // An invalid model-generated goal must never crash the dashboard.
  // Don't attempt any browser actions when verification is ill-defined.
  try {
    return {
      status: "interpreted",
      task: validateTask(parsed)
    };
  } catch (error) {
    return {
      status: "needs_clarification",
      reason: "The local model returned an invalid browser goal: " +
        String(error?.message ?? "unknown validation error")
    };
  }
}
