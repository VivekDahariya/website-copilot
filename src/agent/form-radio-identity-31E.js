// Reconcile an explicitly numbered radio instruction with a
// model-generated native radio-group identity.
//
// Fail closed unless:
// - exactly one numbered radio instruction exists;
// - the browser has exactly one named radio group;
// - the group contains the requested ordinal;
// - exactly one existing goal describes that group and ordinal.
//
// Never add missing requirements or authorize unrelated fields.

export function reconcileExplicitRadioGoal31E(
  goal,instruction,formControls=[]
) {
  if (
    goal?.type!=="all_of" ||
    !Array.isArray(goal.conditions) ||
    !Array.isArray(formControls)
  ) return goal;

  const directives=[
    ...String(instruction??"").matchAll(
      /\bselect\s+radio\s+(\d{1,2})\s+in\s+(?:the\s+)?([a-z][a-z\s]{1,60}?)\s+group\b/gi
    )
  ];

  if(directives.length!==1)return goal;

  const ordinal=Number(directives[0][1]);
  const radioLabel=`Radio ${ordinal}`;

  const radios=formControls.filter(c=>
    c?.type==="radio" &&
    typeof c.name==="string" &&
    c.name.trim()
  );

  const names=[
    ...new Set(radios.map(c=>c.name.trim()))
  ];

  if(
    names.length!==1 ||
    !Number.isInteger(ordinal) ||
    ordinal<1 ||
    ordinal>radios.length
  )return goal;

  const groupName=names[0];
  const norm=value=>String(value??"")
    .trim().toLowerCase();

  const nativeValue=
    groupName.replace(/\[\]$/,"")+ordinal;

  const matches=goal.conditions.filter(c=>
    c?.type==="form_state" &&
    norm(c.fieldLabel)===norm(groupName) &&
    norm(c.expectedValue)===norm(nativeValue)
  );

  if(matches.length!==1)return goal;

  const target=matches[0];

  if(goal.conditions.some(c=>
    c!==target &&
    c?.type==="form_state" &&
    norm(c.fieldLabel)===norm(radioLabel)
  ))return goal;

  return {
    ...goal,
    conditions:goal.conditions.map(c=>
      c===target
        ?{
            ...c,
            fieldLabel:radioLabel,
            expectedValue:"checked"
          }
        :c
    )
  };
}
