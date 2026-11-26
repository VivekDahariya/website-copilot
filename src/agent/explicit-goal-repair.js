// 74K53: Recover only unambiguous, verifiable end states expressed by the
// user. The interpreter still handles unrestricted natural-language tasks.
const NUMBER_WORDS = { one:1, two:2, three:3, four:4, five:5 };
const ORDINALS = { first:1, second:2, third:3, fourth:4, fifth:5 };
function numberOf(value) {
  const lower = String(value).toLowerCase();
  return NUMBER_WORDS[lower] ?? (Number.isInteger(Number(lower)) ? Number(lower) : null);
}
function ordinalOf(value) {
  const lower = String(value).toLowerCase();
  return ORDINALS[lower] ?? Number(lower.replace(/(?:st|nd|rd|th)$/i, ''));
}

/**
 * Recover only explicit numbered checkbox state directives, independently of
 * the model's potentially incomplete list of form goals. No website labels.
 */
export function extractExplicitCheckboxConditions(instruction) {
  const text = String(instruction ?? '');
  const byIndex = new Map();
  const ordinal = '(?:first|second|third|fourth|fifth|\\d+(?:st|nd|rd|th)?)';
  const checkbox = '(?:checkbox|check\\s*box)';
  const action = new RegExp(`\\b(check|tick|uncheck|untick)\\s+(?:the\\s+)?(?:(${ordinal})\\s+${checkbox}|${checkbox}\\s*(\\d{1,2}))\\b`, 'gi');
  const preserve = new RegExp(`\\b(?:leave|keep)\\s+(?:the\\s+)?(?:(${ordinal})\\s+${checkbox}|${checkbox}\\s*(\\d{1,2}))\\s+(?:unchanged|as\\s+is|as\\s+it\\s+is)\\b`, 'gi');
  function accept(match, raw, expectedValue) {
    // Negated action requests do not become goals to perform the action.
    const preceding = text.slice(Math.max(0, match.index - 40), match.index);
    if (/\b(?:do\s+not|don't|dont|never|without|avoid)\s*$/i.test(preceding)) return;
    const index = ordinalOf(raw);
    if (!Number.isInteger(index) || index < 1 || index > 30) return;
    byIndex.set(index, {type:'form_state', fieldLabel:`Checkbox ${index}`, expectedValue});
  }
  for (const match of text.matchAll(action)) {
    accept(match, match[2] ?? match[3], /^(uncheck|untick)$/i.test(match[1]) ? 'unchecked':'checked');
  }
  for (const match of text.matchAll(preserve)) {
    accept(match, match[1] ?? match[2], 'unchanged');
  }
  return [...byIndex.values()];
}

export function deriveExplicitOutcomeGoal(instruction, formControls = []) {
  const text = String(instruction ?? '');
  // A prohibited action must never be accidentally promoted into the goal.
  // Leave complex positive/negative combinations to the model and validator.
  if (/\b(?:do\s+not|don't|dont|never|without)\s+(?:select|choose|check|uncheck|tick|untick|click)\b/i.test(text))
    return null;

  // "Click Add once and verify exactly one Delete button is present."
  const count = text.match(/\bexactly\s+(one|two|three|four|five|\d+)\s+["'“”]?([a-z][a-z\s-]{0,45}?)["'“”]?\s+buttons?\s+(?:is|are|remains?|(?:is\s+)?present|(?:are\s+)?left)\b/i);
  if (count && /\b(?:verify|confirm|ensure|leave|remain|present|left)\b/i.test(text)) {
    const amount = numberOf(count[1]);
    if (amount !== null && amount >= 0 && amount <= 100)
      return {type:'element_count', label:count[2].trim().replace(/["'“”]/g,''), expectedValue:String(amount)};
  }

  // Preserve explicit checkbox states even when the model omits them.
  // The interpreter merges these with other field goals rather than dropping
  // unrelated requested edits.
  const conditions = extractExplicitCheckboxConditions(text);
  if (conditions.length) {
    return conditions.length === 1 ? conditions[0] : {type:'all_of', conditions};
  }

  // A final dropdown selection is the terminal goal even when its navigation
  // step precedes it ("Open Dropdown, then select Option 2").
  const option = text.match(/\b(?:select|choose|pick|set)\s+(?:the\s+)?option\s*(\d{1,2})\b/i);
  if (option && /\b(?:dropdown|drop-down|select|option)\b/i.test(text)) {
    const selects = formControls.filter(control => control.tag === 'select');
    const label = selects.length === 1 && selects[0].label
      ? selects[0].label : 'dropdown';
    return {type:'form_state',fieldLabel:label,expectedValue:option[1]};
  }

  return null;
}
