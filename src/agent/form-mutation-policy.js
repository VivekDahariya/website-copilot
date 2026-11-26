/**
 * A run-scoped preservation boundary for form controls.
 *
 * Browser evidence, not a model's completion claim, owns the initial state.
 * The policy never infers permission to mutate an unrelated field merely
 * because the page's stated form goal was eventually satisfied.
 */
const CHANGE_OPERATIONS = new Set(['fill', 'select', 'check', 'uncheck']);

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function formField(element) {
  const kind = String(element?.type ?? '').toLowerCase();
  return element && (
    kind === 'checkbox' || kind === 'radio' ||
    String(element.tag ?? '').toLowerCase() === 'select' ||
    element.editable === true
  );
}

function identityElements(observation) {
  const duplicates = new Map();
  return (observation?.actionableElements ?? [])
    .filter(formField)
    .map(element => {
      const kind = String(element.type || element.tag || '').toLowerCase();
      const stableKey = element.stableKey
        ? `stable:${element.stableKey}`
        : `field:${kind}|${normalize(element.name)}|${normalize(element.label)}|${normalize(element.placeholder)}`;
      const ordinal = (duplicates.get(stableKey) ?? 0) + 1;
      duplicates.set(stableKey, ordinal);
      return {element, key: `${stableKey}#${ordinal}`};
    });
}

function stateOf(element) {
  if (['checkbox','radio'].includes(String(element.type ?? '').toLowerCase())) {
    return {type:'checked', value:element.checked};
  }
  if (String(element.type ?? '').toLowerCase() === 'password' ||
      element.currentValue === '[REDACTED]') {
    return {type:'private', value:null};
  }
  if (element.currentValueTruncated === true) {
    return {type:'incomplete', value:null};
  }
  return {type:'value', value:element.currentValue};
}

function goalConditions(goal) {
  if (goal?.type === 'all_of') return goal.conditions?.flatMap(goalConditions) ?? [];
  return goal?.type === 'form_state' ? [goal] : [];
}

function isExplicitPreservation(instruction) {
  const text = normalize(instruction);
  return /\b(?:leave|keep)\s+(?:(?:all|every)\s+)?(?:the\s+)?(?:other|remaining|rest|unmentioned|unrelated)\s+(?:form\s+)?(?:fields?|controls?|inputs?|checkboxes?|values?)\s+(?:unchanged|intact|as is)\b/.test(text) ||
    /\b(?:do not|don t|never|without)\s+(?:change|modify|touch|edit|alter|updat\w*)\s+(?:any\s+)?(?:other|remaining|unrelated|unmentioned)\b/.test(text) ||
    /\b(?:only|just)\s+(?:change|modify|edit|fill|check|select|update)\b/.test(text);
}

function matchTarget(label, element) {
  const wanted = normalize(label);
  if (!wanted) return false;
  const labels = [element.label, element.name, element.placeholder]
    .map(normalize).filter(Boolean);
  if (labels.some(actual => actual === wanted ||
      (wanted.length >= 4 && (` ${actual} `).includes(` ${wanted} `)) ||
      (actual.length >= 4 && (` ${wanted} `).includes(` ${actual} `)))) return true;
  const indexed = wanted.match(/^(?:the\s+)?(checkbox|check box|radio|radio button)\s+(\d+)$/);
  if (indexed && Number(element.ordinal) === Number(indexed[2])) {
    const type = String(element.type ?? '').toLowerCase();
    return indexed[1].startsWith('radio') ? type === 'radio' : type === 'checkbox';
  }
  return false;
}

function resolveCondition(condition, items) {
  const field = normalize(condition.fieldLabel);
  if (!field) return null;
  const matches = items.filter(({element}) => matchTarget(field,element));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null;

  // When a model describes the control type plus its purpose (e.g.
  // "TextArea Comment"), use the unique observed native control of that
  // type. Never use this fallback when multiple candidates exist.
  const type = /\b(?:textarea|text area|multiline|comment box)\b/.test(field)
    ? 'textarea' : /\b(?:dropdown|drop down|select|combobox)\b/.test(field)
      ? 'select' : null;
  if (!type) return null;
  const candidates = items.filter(({element}) =>
    type === 'textarea'
      ? element.tag === 'textarea'
      : element.tag === 'select'
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function requestedKeys(conditions, observation) {
  const items = identityElements(observation);
  const permitted = new Set();
  const assignments = new Map();
  const targets = new Map();
  const unresolvedLabels = [];
  for (const condition of conditions) {
    const selected = resolveCondition(condition,items);
    if (!selected) {
      unresolvedLabels.push(String(condition.fieldLabel ?? ''));
      continue;
    }
    const expected = normalize(condition.expectedValue);
    if (assignments.has(selected.key) && assignments.get(selected.key) !== expected) {
      // Conflicting model instructions cannot authorize this control.
      permitted.delete(selected.key);
      targets.delete(selected.key);
      unresolvedLabels.push(String(condition.fieldLabel ?? ''));
      continue;
    }
    assignments.set(selected.key,expected);
    permitted.add(selected.key);
    targets.set(selected.key,condition);
  }
  return {permitted,targets,unresolved:unresolvedLabels.length>0,unresolvedLabels};
}

function conditionForKey(goal, observation, key) {
  for (const condition of goalConditions(goal)) {
    const target = requestedKeys([condition],observation);
    if (!target.unresolved && target.permitted.has(key)) return condition;
  }
  return null;
}


// An explicit native radio selection may deselect the previously
// selected peer. This exception applies ONLY to that deselection.
//
// Requirements:
// - exactly one authorized radio goal within the group;
// - a specific numbered Radio N goal requiring "checked";
// - that target changed from unchecked to checked;
// - exactly one previously checked peer changed to unchecked;
// - all other radio-group states remain consistent;
// - no separately requested or protected radio is excused.
//
// Everything else remains subject to the original preservation policy.
function authorizedNativeRadioDeselection31H({
  key,before,after,initial,observation,scope
}) {
  if (
    before?.type!=="checked" ||
    before.value!==true ||
    after?.type!=="checked" ||
    after.value!==false ||
    scope.targets.has(key)
  ) return false;

  const items=identityElements(observation);
  const changed=items.find(item=>item.key===key);

  if (
    !changed ||
    changed.element.type!=="radio" ||
    !String(changed.element.name??"").trim()
  ) return false;

  const group=String(changed.element.name).trim();

  const peers=items.filter(item=>
    item.element.type==="radio" &&
    String(item.element.name??"").trim()===group
  );

  if(peers.length<2)return false;

  // Never equate explicitly distinguishable form owners.
  const owner=item=>{
    const f=item.element.formContext;
    if(!f?.associated)return null;

    const id=String(f.id??"").trim();
    const name=String(f.name??"").trim();

    return id ? "id:"+id :
      name ? "name:"+name : null;
  };

  const knownOwners=[
    ...new Set(peers.map(owner).filter(Boolean))
  ];

  if(knownOwners.length>1)return false;

  const authorized=peers.filter(item=>
    scope.targets.has(item.key)
  );

  if(authorized.length!==1)return false;

  const target=authorized[0];

  if(target.key===key)return false;

  const condition=scope.targets.get(target.key);
  const field=normalize(condition?.fieldLabel);
  const ordinal=/^radio (\d+)$/.exec(field);

  if (
    !ordinal ||
    Number(target.element.ordinal)!==Number(ordinal[1]) ||
    !["checked","true","yes","on"].includes(
      normalize(condition.expectedValue)
    )
  ) return false;

  if(peers.some(item=>{
    const previous=initial.get(item.key);
    const current=stateOf(item.element);

    return previous?.type!=="checked" ||
      typeof previous.value!=="boolean" ||
      current.type!=="checked" ||
      typeof current.value!=="boolean";
  }))return false;

  const formerlySelected=peers.filter(item=>
    initial.get(item.key).value===true
  );

  const nowSelected=peers.filter(item=>
    item.element.checked===true
  );

  return (
    formerlySelected.length===1 &&
    formerlySelected[0].key===key &&
    nowSelected.length===1 &&
    nowSelected[0].key===target.key &&
    initial.get(target.key).value===false
  );
}

// A click on a submit control, or Enter in a field, sends the form. The page
// that comes back may legitimately no longer contain the form.
export function isSubmitAction(action, element) {
  if (action?.operation === 'click') {
    return ['submit', 'image'].includes(String(element?.type ?? '').toLowerCase());
  }
  return action?.operation === 'press' && /^(?:enter|numpadenter)$/i.test(String(action?.value ?? ''));
}

export function createFormMutationPolicy({goal, instruction = '', directScope = null}) {
  const conditions = goalConditions(goal);
  // Direct-instruction mode has no goal conditions. Existing form state is
  // still protected; permission comes from the instruction-grounded scope.
  const direct = directScope && typeof directScope.reject === 'function'
    ? directScope : null;
  const active = Boolean(direct) || conditions.length > 0 ||
    isExplicitPreservation(instruction);
  const initialByUrl = new Map();
  const directPermitted = new Set();

  return {
    observe(observation) {
      if (!active) return;
      const url = String(observation?.url ?? '');
      if (!initialByUrl.has(url)) {
        initialByUrl.set(url, new Map(identityElements(observation).map(
          ({key,element}) => [key,stateOf(element)]
        )));
      }
    },
    // After a submit, controls that are gone (the form was replaced by a
    // confirmation page) can no longer be changed, so they are no longer
    // compared. Controls that are still there are still compared.
    acknowledgeSubmit(observation) {
      if (!active) return;
      const initial = initialByUrl.get(String(observation?.url ?? ''));
      if (!initial) return;
      const present = new Set(identityElements(observation).map(({key}) => key));
      for (const key of [...initial.keys()]) if (!present.has(key)) initial.delete(key);
    },
    reject(observation, element, action) {
      if (!active || !formField(element)) return null;
      const mutates = CHANGE_OPERATIONS.has(action?.operation) ||
        (['checkbox','radio'].includes(String(element.type ?? '').toLowerCase()) &&
         ['click','press'].includes(action?.operation)) ||
        (element.editable === true && action?.operation === 'press');
      if (!mutates) return null;
      const current = identityElements(observation).find(item => item.element.ref === action.ref);
      if (!current) return 'unresolved_form_control_identity';
      if (direct) {
        const refusal = direct.reject(element, action, {
          strict: isExplicitPreservation(instruction)
        });
        if (refusal) return refusal;
        directPermitted.add(current.key);
        // Checking a native radio deselects its previously selected peer.
        if (String(element.type ?? '').toLowerCase() === 'radio' &&
            String(element.name ?? '').trim()) {
          for (const peer of identityElements(observation)) {
            if (peer.element.type === 'radio' &&
                String(peer.element.name ?? '').trim() === String(element.name).trim()) {
              directPermitted.add(peer.key);
            }
          }
        }
        return null;
      }
      const scope = requestedKeys(conditions,observation);
      // An unresolved OTHER field must not block a grounded authorized edit.
      // It also must not grant permission to mutate an unknown control.
      if (!scope.permitted.has(current.key)) return 'unrequested_form_field_change';
      const target = conditionForKey(goal,observation,current.key);
      if (!target) return 'unrequested_form_field_change';
      if (normalize(target.expectedValue) === 'unchanged') return 'protected_unchanged_field';
      if (['checkbox','radio'].includes(String(element.type ?? '').toLowerCase())) {
        const expected = normalize(target.expectedValue);
        const wantChecked = ['true','checked','yes','on'].includes(expected) ? true :
          ['false','unchecked','no','off'].includes(expected) ? false : null;
        if (wantChecked !== null &&
            ((action.operation === 'check' && !wantChecked) ||
             (action.operation === 'uncheck' && wantChecked)))
          return 'reverses_required_checkbox_state';
      }
      return null;
    },
    verify(observation) {
      if (!active) return {verified:true, issues:[]};
      const url = String(observation?.url ?? '');
      const initial = initialByUrl.get(url);
      if (!initial) return {verified:false, issues:[{reason:'initial_form_snapshot_missing'}]};
      const scope = requestedKeys(conditions,observation);
      // Completion still requires independent goal verification. Preserve
      // unrelated controls regardless of whether a model label is unresolved.
      const permittedMutable = new Set([...scope.permitted, ...directPermitted]);
      for (const condition of conditions) {
        if (normalize(condition.expectedValue) === 'unchanged') {
          const protectedTarget = requestedKeys([condition], observation);
          for (const key of protectedTarget.permitted) permittedMutable.delete(key);
        }
      }
      const actual = new Map(identityElements(observation).map(
        ({key,element}) => [key,stateOf(element)]
      ));
      const issues=[];
      for (const [key,before] of initial) {
        if (permittedMutable.has(key)) continue;
        const after=actual.get(key);
        if (!after) { issues.push({field:key,reason:'protected_field_missing'}); continue; }
        if (before.type === 'private' && after.type === 'private') continue;
        if (before.type === 'incomplete' || after.type === 'incomplete') {
          issues.push({field:key,reason:'protected_field_state_unverifiable'});
          continue;
        }
        if (
          (before.type !== after.type || before.value !== after.value) &&
          !authorizedNativeRadioDeselection31H({
            key,before,after,initial,observation,scope
          })
        ) {
          issues.push({field:key,reason:'protected_field_changed'});
        }
      }
      return {verified:issues.length===0,issues};
    }
  };
}
