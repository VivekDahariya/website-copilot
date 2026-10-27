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

  // Ordinal checkbox controls have no HTML labels on many demo pages.
  // Protect "leave unchanged" with a recorded initial state, not a guess.
  const conditions = [];
  const checkboxPattern = /\b(check|tick|uncheck|untick)\s+(?:the\s+)?(first|second|third|fourth|fifth|\d+(?:st|nd|rd|th)?)\s+checkbox\b/gi;
  for (const match of text.matchAll(checkboxPattern)) {
    const index = ordinalOf(match[2]);
    if (!Number.isInteger(index) || index < 1 || index > 30) continue;
    conditions.push({type:'form_state',fieldLabel:`Checkbox ${index}`,
      expectedValue:/^(uncheck|untick)$/i.test(match[1]) ? 'unchecked' : 'checked'});
  }
  const unchangedPattern = /\b(?:leave|keep)\s+(?:the\s+)?(first|second|third|fourth|fifth|\d+(?:st|nd|rd|th)?)\s+checkbox\s+(?:unchanged|as\s+is|as\s+it\s+is)\b/gi;
  for (const match of text.matchAll(unchangedPattern)) {
    const index = ordinalOf(match[1]);
    if (!Number.isInteger(index) || index < 1 || index > 30) continue;
    conditions.push({type:'form_state',fieldLabel:`Checkbox ${index}`,expectedValue:'unchanged'});
  }
  if (conditions.length) {
    const unique = new Map(conditions.map(item => [item.fieldLabel, item]));
    return unique.size === 1 ? [...unique.values()][0] : {type:'all_of', conditions:[...unique.values()]};
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
