/**
 * Task contract validation boundary (Zod 4).
 * This runs AFTER the existing semantic goal repairs and legacy goal validator.
 * It does not rewrite task goals, change form action permissions, or execute code.
 */
import { z } from 'zod';

const nonblank = z.string().min(1).refine(s => s.trim().length > 0);
const expectedValue = z.union([z.string(), z.boolean()]);
const pageDestination = z.object({
  type:z.literal('page_destination'),
  identity:z.string().optional(),hostname:z.string().optional(),
  pathname:z.string().optional(),pathnamePattern:z.string().optional(),
  heading:z.string().optional(),text:z.string().optional()
}).strict();
const visibleContent = z.object({
  type:z.literal('visible_content'),text:nonblank,
  hostname:z.string().optional(),pathname:z.string().optional()
}).strict();
const visibleForm = z.object({type:z.literal('visible_form')}).strict();
const formState = z.object({
  type:z.literal('form_state'),fieldLabel:nonblank,expectedValue
}).strict();
const elementCount = z.object({
  type:z.literal('element_count'),label:nonblank,expectedValue:z.string().regex(/^\d+$/)
}).strict();
const paragraphCount = z.object({
  type:z.literal('paragraph_count'),expectedValue:z.string().regex(/^\d+$/)
}).strict();
const modalClosed = z.object({type:z.literal('modal_closed')}).strict();
const downloadReceipt = z.object({
  type:z.literal('download_receipt')
}).strict();
let goalSchema;
const allOf = z.object({
  type:z.literal('all_of'),
  conditions:z.array(z.lazy(()=>goalSchema)).min(1).max(20)
}).strict();
goalSchema = z.discriminatedUnion('type',[
  pageDestination,visibleContent,visibleForm,formState,
  elementCount,paragraphCount,modalClosed,downloadReceipt,allOf
]);

export const taskContractSchema = z.discriminatedUnion('type',[
  z.object({
    type:z.literal('browser_goal'),instruction:nonblank,goal:goalSchema,
    startUrl:z.string().url().optional()
  }).strict(),
  z.object({
    type:z.literal('product_comparison'),startUrl:z.string().url(),
    category:nonblank.optional(),
    titles:z.array(nonblank).length(2).optional(),
    limit:z.number().int().min(1).max(10)
  }).strict()
]);

function normalizedCheckboxState(value) {
  const v=String(value ?? '').trim().toLowerCase();
  return ['true','checked','yes','on'].includes(v) ? true :
    ['false','unchecked','no','off'].includes(v) ? false : null;
}

function flatConditions(goal) {
  return goal?.type === 'all_of' ? goal.conditions.flatMap(flatConditions) : [goal];
}

/**
 * The model sometimes emits a shared HTML checkbox name as well as the
 * explicit human-facing ordinal for ONE request. Never infer which member
 * of that group is intended from the shared name. Validate consistency,
 * but leave the original goal unchanged so established verification stays on.
 */
export function validateCheckboxAliasContract(goal,instruction,formControls=[]) {
  if (!Array.isArray(formControls) || formControls.length < 2) return;
  const conditions=flatConditions(goal).filter(c=>c?.type==='form_state');
  const ordinals=[...String(instruction||'').matchAll(/\b(?:checkbox|check\s+box)\s*(\d+)\b/gi)]
    .map(m=>Number(m[1]));
  if (ordinals.length !== 1) return; // multiple targets are NOT safe to coalesce
  const ordinal=ordinals[0];
  const wanted=conditions.filter(c=>
    new RegExp(`^(?:the\\s+)?(?:checkbox|check\\s+box)\\s+${ordinal}$`,'i')
      .test(String(c.fieldLabel).trim()));
  if (wanted.length !== 1) return;
  const expected=normalizedCheckboxState(wanted[0].expectedValue);
  if (expected===null) return; // unchanged is a constraint, not a boolean edit
  const checkboxes=formControls.filter(f=>String(f.type).toLowerCase()==='checkbox');
  const target=checkboxes.filter(f=>Number(f.ordinal)===ordinal);
  if (target.length !== 1 || !target[0].name) return;
  const group=checkboxes.filter(f=>f.name===target[0].name);
  if (group.length < 2) return;
  const aliasConditions=conditions.filter(c=>
    String(c.fieldLabel).trim().toLowerCase()===String(target[0].name).toLowerCase());
  for (const alias of aliasConditions) {
    const aliasState=normalizedCheckboxState(alias.expectedValue);
    if (aliasState !== null && aliasState !== expected) {
      throw new Error('Conflicting checkbox group and explicit ordinal requirements.');
    }
  }
}

/** Keep existing immutable user instruction and all existing goal objects. */
export function validateTaskContract(task,{formControls=[]}={}) {
  const result=taskContractSchema.safeParse(task);
  if (!result.success) {
    const issue=result.error.issues[0];
    throw new Error('Task contract invalid: '+(issue?.path?.join('.')||'task')+
      ' ('+(issue?.message||'invalid value')+')');
  }
  if (task.type==='product_comparison') {
    const hasCategory =
      typeof task.category==='string' &&
      task.category.trim().length>0;
    const hasTitles =
      Array.isArray(task.titles) &&
      task.titles.length===2;

    if (hasCategory===hasTitles ||
        (hasTitles && task.limit!==2)) {
      throw new Error(
        'Comparison requires either category or exactly two titles.'
      );
    }
  }

  if (task.type==='browser_goal') {
    validateCheckboxAliasContract(task.goal,task.instruction,formControls);
  }
  return task;
}
