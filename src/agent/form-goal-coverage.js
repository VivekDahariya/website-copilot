/**
 * Guard against accepting a valid but INCOMPLETE model-generated form goal.
 * Only compare explicit, quoted user values and observed dropdown options.
 * No invented fields, values, or browser actions. A failure means clarification,
 * not silently dropping the omitted requirement.
 */
const norm = value => String(value ?? '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

const short = value => norm(value).replace(/s\b/g, '');

function sameField(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // A field's displayed label may say "Comments" while the user says
  // "Comment"; do not equate unrelated short labels.
  const a1 = short(x), b1 = short(y);
  return a1.length >= 5 && a1 === b1;
}

function matchingControls(label, controls, kinds) {
  const target = norm(label);
  if (!target) return [];
  return controls.filter(item =>
    kinds.includes(item.tag) && [item.label, item.name].some(v => sameField(v, target)));
}

function conditions(goal) {
  return goal?.type === 'all_of' ? goal.conditions : [goal];
}

function matchesRequiredFormState(goal, label, value, formControls) {
  let controls = matchingControls(
    label, formControls, ['input','textarea','select']
  );

  // Before browser observation, require an exact
  // model-generated field identity and quoted value.
  if (
    controls.length===0 &&
    formControls.length===0
  ) {
    return conditions(goal).some(item=>
      item?.type==="form_state" &&
      sameField(item.fieldLabel,label) &&
      String(item.expectedValue)===String(value)
    );
  }

  // "TextArea Comment" can refer to the observed
  // textarea labelled "Comments". Only accept a unique
  // textarea matching that explicit name.
  if(
    controls.length===0 &&
    /^textarea\s+/i.test(String(label).trim())
  ) {
    const suffix=String(label).trim()
      .replace(/^textarea\s+/i,"");

    const candidates=formControls.filter(control=>
      control?.tag==="textarea" &&
      [control.label,control.name].some(
        name=>sameField(name,suffix)
      )
    );

    if(candidates.length===1)
      controls=candidates;
  }

  if (controls.length !== 1) return false;
  const control = controls[0];
  return conditions(goal).some(item => item?.type === 'form_state' &&
    String(item.expectedValue) === String(value) &&
    ([control.label, control.name].some(name => sameField(item.fieldLabel, name)) ||
     sameField(item.fieldLabel, label)));
}

/**
 * Identify requirements that are literally and unambiguously specified.
 * When a requirement is recognized but absent, never execute a smaller goal.
 */
export function checkExplicitFormGoalCoverage(instruction, goal, formControls = []) {
  const text = String(instruction ?? '');
  const controls = Array.isArray(formControls) ? formControls : [];
  const requirements = [];

  const enter = /\b(?:enter|type|write|put)\s+(["“])([^"”]{1,300})["”]\s+(?:in|into)\s+(?:the\s+)?([^,.;]+?)(?=\s*,|\s+and\b|\s*\.|$)/gi;
  for (const m of text.matchAll(enter)) {
    requirements.push({kind:'text',label:m[3].trim(),value:m[2]});
  }
  const fill = /\b(?:fill|replace|set)\s+(?:the\s+)?([^,.;]+?)\s+with\s+(["“])([^"”]{1,300})["”]/gi;
  for (const m of text.matchAll(fill)) {
    requirements.push({kind:'text',label:m[1].trim().replace(
      /^entire\s+(?=textarea\b)/i, ""
    ),value:m[3]});
  }


  const setTo = /\bset\s+(?:the\s+)?([^,.;]+?)\s+to\s+(["“])([^"”]{1,300})["”]/gi;
  for (const m of text.matchAll(setTo)) {
    requirements.push({
      kind:"text",
      label:m[1].trim(),
      value:m[3]
    });
  }

  // A requested exact dropdown option must survive model interpretation.
  // Only enforce this when the option is present in one observed select.
  const selects = controls.filter(item => item.tag === 'select');
  const selectMatch = text.match(/\b(?:select|choose|pick)\s+(?:the\s+)?([^,.;]+?)(?=\s*,|\s+and\b|\s*\.|$)/i);
  if (selectMatch) {
    const target = norm(selectMatch[1]);
    const matches = selects.flatMap(control => (control.options ?? [])
      .filter(opt => opt && (norm(opt.label) === target ||
        (norm(opt.label).length >= 7 && target.startsWith(norm(opt.label)))))
      .map(option => ({control,option})));
    if (matches.length === 1) requirements.push({kind:'select',...matches[0]});
  }

  const missing = [];
  for (const requirement of requirements) {
    if (requirement.kind === 'text') {
      if (!matchesRequiredFormState(goal, requirement.label, requirement.value, controls))
        missing.push(requirement.label);
    } else {
      const {control,option} = requirement;
      const present = conditions(goal).some(item => item?.type === 'form_state' &&
        [control.label,control.name].some(v => sameField(item.fieldLabel,v)) &&
        [option.label,option.value].includes(String(item.expectedValue)));
      if (!present) missing.push(control.label || control.name || 'dropdown');
    }
  }
  return {complete:missing.length === 0, checked:requirements.length,
    missing: [...new Set(missing)]};
}
