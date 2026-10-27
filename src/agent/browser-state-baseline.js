// Record form invariants from the first observation of each URL.
// Never treat "unchanged" as a hard-coded true or false value.
export function createBrowserStateBaseline() {
  const initialStates = new Map();
  return {
    enrich(observation) {
      const url = String(observation?.url ?? '');
      const elements = observation?.actionableElements ?? [];
      if (!initialStates.has(url)) {
        const initial = new Map();
        for (const element of elements) {
          if (['checkbox','radio'].includes(String(element.type).toLowerCase()) &&
              typeof element.checked === 'boolean' && element.stableKey) {
            initial.set(element.stableKey, element.checked);
          }
        }
        initialStates.set(url, initial);
      }
      const initial = initialStates.get(url);
      return {
        ...observation,
        actionableElements: elements.map(element => ({
          ...element,
          initialChecked: element.stableKey && initial.has(element.stableKey)
            ? initial.get(element.stableKey) : null
        }))
      };
    }
  };
}

function normalized(s) { return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' '); }
export function rejectContradictoryFormAction(goal, element, candidate) {
  if (!['check','uncheck','fill','select'].includes(candidate?.operation)) return null;
  const conditions = goal?.type === 'all_of' ? goal.conditions : [goal];
  const label = normalized(element?.label);
  const ordinal = element?.ordinal;
  const targets = conditions.filter(c => c?.type === 'form_state' && (
    normalized(c.fieldLabel) === label ||
    (Number.isInteger(ordinal) && normalized(c.fieldLabel) === `checkbox ${ordinal}`)
  ));
  const unchanged = targets.some(c => normalized(c.expectedValue) === 'unchanged');
  if (unchanged) return 'protected_unchanged_field';
  if (element?.type === 'checkbox' || element?.type === 'radio') {
    const target = targets.find(c => /^(checked|unchecked|true|false)$/i.test(String(c.expectedValue)));
    if (target) {
      const checked = /^(checked|true)$/i.test(String(target.expectedValue));
      if ((checked && candidate.operation === 'uncheck') ||
          (!checked && candidate.operation === 'check')) return 'reverses_required_checkbox_state';
    }
  }
  if (String(element?.type).toLowerCase() === 'password' &&
      candidate.operation === 'fill' && element.hasValue === true)
    return 'password_already_entered';
  return null;
}
