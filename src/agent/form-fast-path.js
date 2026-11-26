/**
 * Small, opt-in-to-task-type fast path for independent form edits.
 * A single model call proposes a bounded sequence. The normal runAgent loop
 * still validates, executes, re-observes and independently verifies EACH edit.
 */
import { buildCatalog } from './local-reasoner.js';
import { createFormMutationPolicy } from './form-mutation-policy.js';
import { rejectContradictoryFormAction } from './browser-state-baseline.js';

const FORM_OPS = new Set(['fill', 'select', 'check', 'uncheck']);
const SECRET = /\b(?:password|passcode|otp|captcha|verification.code|cvv|cvc|card.number|upi.pin|secret|token)\b/i;
const CONSEQUENCES = /\b(?:submit|send|purchase|pay|checkout|delete|publish|post|upload|sign.?in|log.?in|transfer|confirm.order|place.order)\b/i;
const NEGATED_CONSEQUENCES = /\b(?:do not|don't|never|without|avoid)\s+(?:(?:\w+\s+){0,2})?(?:submit|send|purchase|pay|checkout|delete|publish|post|upload)\b/gi;
const MAX_BATCH = 5;

function requirements(goal) {
  if (goal?.type === 'form_state') return [goal];
  if (goal?.type === 'all_of' && Array.isArray(goal.conditions) &&
      goal.conditions.every(item => item?.type === 'form_state')) return goal.conditions;
  return [];
}

export function eligibleForFormFastPath({instruction, goal, observation}) {
  const conditions = requirements(goal);
  if (conditions.length < 2 || conditions.length > MAX_BATCH) return false;
  if (conditions.some(item => !item.fieldLabel || item.expectedValue == null ||
      /^(?:unchanged|preserve|same)$/i.test(String(item.expectedValue).trim()))) return false;
  const task = String(instruction || '');
  if (SECRET.test(task) || SECRET.test(JSON.stringify(conditions))) return false;
  if (CONSEQUENCES.test(task.replace(NEGATED_CONSEQUENCES,''))) return false;
  if (!observation?.url || !Array.isArray(observation?.actionableElements)) return false;
  const available = observation.actionableElements.filter(el =>
    (el.editable === true || el.tag === 'select' || ['checkbox','radio'].includes(el.type)) &&
    !SECRET.test([el.label,el.name,el.placeholder,el.type].join(' ')));
  return available.length >= 2;
}

function elementSignature(el) {
  return [el.ref,el.tag,el.type,el.name,el.label,el.placeholder,el.ordinal,
    el.editable,JSON.stringify(el.options ?? null)].map(x => String(x ?? '')).join('\u0001');
}

// Ignore current values and checked flags; these are expected to change.
// A reflow that changes the DOM action catalog invalidates the old plan.
export function formStructureFingerprint(observation) {
  return JSON.stringify({
    url: observation?.url,
    controls: (observation?.actionableElements ?? []).map(elementSignature)
  });
}

export function validateFormBatch(raw, observation, {instruction,goal} = {}) {
  if (!eligibleForFormFastPath({instruction,goal,observation})) return null;
  const actions = raw?.actions;
  if (!Array.isArray(actions) || actions.length < 2 || actions.length > MAX_BATCH) return null;
  const catalog = buildCatalog(observation, [], goal, instruction, 65);
  const byRef = new Map(catalog.map(el => [el.ref,el]));
  const refs = new Set();
  const result = [];
  const mutationGuard = createFormMutationPolicy({goal,instruction});
  mutationGuard.observe(observation);
  for (const action of actions) {
    if (!action || typeof action.ref !== 'string' ||
        typeof action.operation !== 'string' || !FORM_OPS.has(action.operation)) return null;
    if (refs.has(action.ref)) return null;
    const target = byRef.get(action.ref);
    if (!target || !target.allowedOperations.includes(action.operation)) return null;
    if (SECRET.test([target.label,target.type,target.name].join(' '))) return null;
    const liveElement = observation.actionableElements.find(e => e.ref === action.ref);
    if (!liveElement || mutationGuard.reject(observation,liveElement,action) ||
        rejectContradictoryFormAction(goal,liveElement,action)) return null;
    if (['fill','select'].includes(action.operation) &&
        (typeof action.value !== 'string' || !action.value)) return null;
    if (['check','uncheck'].includes(action.operation) &&
        action.value !== '' && action.value !== null && action.value !== undefined) return null;
    refs.add(action.ref);
    result.push({ref:action.ref,operation:action.operation,
      value: ['check','uncheck'].includes(action.operation) ? '' : action.value});
  }
  return result;
}

// Deterministic form planning reuses the already interpreted goal, rather than
// asking the model to turn that goal into the same actions a second time.
// A field is usable only when browser evidence identifies EXACTLY one control.
function normalizedLabel(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function compatibleControl(field, goalLabel) {
  const tag = String(field.tag ?? '').toLowerCase();
  const type = String(field.type ?? '').toLowerCase();
  if (SECRET.test([field.label,field.name,field.placeholder,type].join(' '))) return false;
  if (type === 'checkbox' || type === 'radio') return /^(?:the )?(?:checkbox|check box|radio|radio button)\s+\d+$/i.test(goalLabel);
  return field.editable === true || tag === 'select';
}

function uniqueControl(goalLabel, observation) {
  const wanted = normalizedLabel(goalLabel);
  if (!wanted) return null;
  const controls = (observation.actionableElements ?? [])
    .filter(field => compatibleControl(field, goalLabel));
  const indexed = wanted.match(/^(?:the )?(checkbox|check box|radio|radio button)\s+(\d+)$/);
  if (indexed) {
    const type = indexed[1].startsWith('radio') ? 'radio' : 'checkbox';
    const hits = controls.filter(field => field.type === type &&
      Number(field.ordinal) === Number(indexed[2]));
    return hits.length === 1 ? hits[0] : null;
  }
  const exact = controls.filter(field => [field.label,field.name,field.placeholder]
    .some(text => normalizedLabel(text) === wanted));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const partial = controls.filter(field => [field.label,field.name,field.placeholder]
    .some(text => {
      const observed = normalizedLabel(text);
      return wanted.length >= 4 && observed.length >= 4 &&
        ((' '+observed+' ').includes(' '+wanted+' ') ||
         (' '+wanted+' ').includes(' '+observed+' '));
    }));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return null;
  // Type-based fallback only when the instruction explicitly describes the
  // native control type. Never guess among repeated controls of that type.
  const fallbackType = /\b(?:textarea|text area|multiline)\b/.test(wanted)
    ? 'textarea' : /\b(?:dropdown|drop down|select|combobox)\b/.test(wanted)
      ? 'select' : null;
  if (!fallbackType) return null;
  const candidates = controls.filter(field => field.tag === fallbackType);
  return candidates.length === 1 ? candidates[0] : null;
}

function requestedEdit(condition, observation) {
  const field = uniqueControl(condition.fieldLabel,observation);
  if (!field) return null;
  const expected = String(condition.expectedValue ?? '');
  const type = String(field.type ?? '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    const wanted = normalizedLabel(expected);
    const operation = ['true','checked','yes','on'].includes(wanted) ? 'check' :
      ['false','unchecked','no','off'].includes(wanted) ? 'uncheck' : null;
    return operation ? {ref:field.ref,operation,value:''} : null;
  }
  if (field.tag === 'select') {
    const choices = (field.options ?? []).filter(option =>
      (typeof option === 'string' ? option === expected :
        option.label === expected || option.value === expected));
    if (choices.length !== 1) return null;
    return {ref:field.ref,operation:'select',value:expected};
  }
  return field.editable === true && expected.length > 0
    ? {ref:field.ref,operation:'fill',value:expected} : null;
}

// Some interpreters emit both a shared native checkbox-group name
// (e.g. name="preferences[]") and a user-facing ordinal ("Checkbox 2")
// for ONE requested checkbox edit. The group name is not a uniquely
// actionable field and must never become an extra permission to edit.
// Coalesce it for batch PLANNING only, after confirming a single explicit
// ordinal in the user's instruction and matching browser evidence.
function withoutRedundantCheckboxGroupAlias(conditions, instruction, observation) {
  const mentionedOrdinals = [...String(instruction).matchAll(/\b(?:checkbox|check\s+box)\s*(\d+)\b/gi)]
    .map(match => Number(match[1]));
  if (mentionedOrdinals.length !== 1 ||
      /\b(?:all|every|each)\s+(?:(?:the|available)\s+)?checkbox(?:es)?\b/i.test(instruction))
    return conditions;
  const ordinal = mentionedOrdinals[0];
  const ordinalConditions = conditions.filter(condition =>
    new RegExp(`^(?:the\\s+)?(?:checkbox|check\\s+box)\\s+${ordinal}$`, 'i')
      .test(String(condition.fieldLabel).trim()));
  if (ordinalConditions.length !== 1) return conditions;
  const specific = ordinalConditions[0];
  const desired = checkboxState(specific.expectedValue);
  if (desired == null) return conditions;
  const target = uniqueControl(specific.fieldLabel, observation);
  if (!target || target.type !== 'checkbox') return conditions;
  const groupName = String(target.name || '');
  if (!groupName || !groupName.includes('[') ||
      String(instruction).toLowerCase().includes(groupName.toLowerCase()))
    return conditions;
  const group = (observation.actionableElements ?? [])
    .filter(item => item.type === 'checkbox' && item.name === groupName);
  if (group.length < 2) return conditions;
  return conditions.filter(condition => {
    if (condition === specific) return true;
    const isAlias = String(condition.fieldLabel).trim() === groupName &&
      checkboxState(condition.expectedValue) === desired;
    return !isAlias;
  });
}

function checkboxState(value) {
  const state = normalizedLabel(value);
  if (['true','checked','yes','on'].includes(state)) return true;
  if (['false','unchecked','no','off'].includes(state)) return false;
  return null;
}

export function proposeGroundedFormBatch({instruction,goal,observation}) {
  if (!eligibleForFormFastPath({instruction,goal,observation})) return null;
  const actions=[];
  // Never change the original goal: normal verification still checks it.
  const planningConditions = withoutRedundantCheckboxGroupAlias(
    requirements(goal), instruction, observation);
  for (const condition of planningConditions) {
    const action=requestedEdit(condition,observation);
    if (!action) return null; // No partial permission when a goal is unresolved.
    actions.push(action);
  }
  // The same safety policy used for a Qwen-generated batch is mandatory here.
  return validateFormBatch({actions},observation,{instruction,goal});
}

export function createFormFastPathSession() {
  let actions = [];
  let fingerprint = null;
  let started = false;
  let tried = false;
  return {
    canAttempt() { return !tried && actions.length === 0; },
    markAttempted() { tried = true; },
    start(batch, observation) {
      if (!Array.isArray(batch) || batch.length < 2) return false;
      actions = batch.map(a => ({...a}));
      fingerprint = formStructureFingerprint(observation);
      started = true;
      return true;
    },
    peek(observation) {
      if (!started || !actions.length) return null;
      if (fingerprint !== formStructureFingerprint(observation)) {
        actions = []; started = false; return null;
      }
      const current = actions[0];
      return observation.actionableElements?.some(e => e.ref === current.ref)
        ? {...current} : null;
    },
    accepted(action, before, after) {
      if (!started || !actions.length) return;
      if (actions[0].ref !== action?.ref ||
          actions[0].operation !== action?.operation ||
          actions[0].value !== action?.value ||
          !after || after.url !== before?.url ||
          fingerprint !== formStructureFingerprint(after)) {
        actions = []; started = false; return;
      }
      actions.shift();
      if (!actions.length) started = false;
    },
    discard() { actions = []; started = false; },
    remaining() { return actions.length; }
  };
}

export async function proposeFormBatch({instruction,goal,observation,fetchImpl=fetch,
    model=process.env.COPILOT_OLLAMA_MODEL || 'qwen3:4b',
    endpoint=process.env.COPILOT_OLLAMA_URL || 'http://127.0.0.1:11434/api/chat'}) {
  if (!eligibleForFormFastPath({instruction,goal,observation})) return null;
  const catalog = buildCatalog(observation,[],goal,instruction,65)
    .filter(e => ['fill','select','check','uncheck'].some(op => e.allowedOperations.includes(op)))
    .map(({ref,label,tag,type,ordinal,currentValue,checked,options,allowedOperations}) => ({
      ref,label,tag,type,ordinal,currentValue,checked,options,
      allowedOperations:allowedOperations.filter(op => FORM_OPS.has(op))
    }));
  if (catalog.length < 2) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetchImpl(endpoint,{
      method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
      body:JSON.stringify({model,stream:false,think:false,keep_alive:'10m',
        options:{temperature:0,num_ctx:4096,num_predict:420},
        format:{type:'object',properties:{actions:{type:'array',minItems:2,maxItems:MAX_BATCH,
          items:{type:'object',properties:{ref:{type:'string'},operation:{type:'string',
            enum:['fill','select','check','uncheck']},value:{type:'string'}},
            required:['ref','operation','value']}}},required:['actions']},
        messages:[
          {role:'system',content:'You are a browser FORM EDIT planner. Produce a single JSON object containing actions: an ordered list of 2-5 INDEPENDENT form edits. Choose ONLY refs and operations from the available control catalog. Cover requested incomplete form_state goals, preserve all unrelated controls. No click/press/navigation/submit, no sensitive fields. Use check/uncheck for checkboxes. If edits depend on navigation or another edit revealing controls, do not make a batch. Each action will be revalidated and verified by the browser before the next. JSON only.'},
          {role:'user',content:JSON.stringify({task:instruction,goal,
            page:{url:observation.url,title:observation.title},controls:catalog})}
        ]})
    });
    if (!response.ok) return null;
    const data = await response.json();
    const payload = data?.message?.content;
    if (typeof payload !== 'string') return null;
    return validateFormBatch(JSON.parse(payload),observation,{instruction,goal});
  } catch { return null; }
  finally {clearTimeout(timeout);}
}
