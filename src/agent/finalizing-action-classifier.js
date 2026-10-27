
const STRONG_FINALIZING =
  /\b(save|submit|publish|send|delete|purchase|transfer|commit)\b/i;

const CONTEXTUAL_FINALIZING =
  /\b(apply|confirm|update|finish|complete)\b/i;

const INTERMEDIATE_ACTION =
  /\b(preview|filter|selection|select|sort|search|menu|details|view|open|next|previous|back|cancel)\b/i;

const FINALIZING_INTENT =
  /\b(save|submit|publish|send|delete|purchase|transfer|commit|apply|confirm|update)\b/i;

function flatten(goal) {
  return goal?.type === "all_of"
    ? (goal.conditions ?? []).flatMap(flatten)
    : goal ? [goal] : [];
}

export function classifyFinalizingAction({
  action,
  element = {},
  goal,
  instruction = "",
  observation = null
}) {
  if (!["click", "press"].includes(action?.operation)) {
    return {
      finalizing: false,
      reason: "Not a potentially finalizing interaction."
    };
  }

  const description = [
    element.label,
    element.text,
    element.ariaLabel,
    element.accessibleName,
    element.name,
    element.title
  ].filter(Boolean).join(" ").trim();

  const tag = String(element.tag ?? "").toLowerCase();
  const type = String(
    element.effectiveType ?? element.type ?? ""
  ).toLowerCase();

  const isNavigationLink =
    tag === "a" && Boolean(element.href);

  const hasFinalizingIntent =
    FINALIZING_INTENT.test(instruction);

  const hasCompletionEvidence =
    flatten(goal).some(condition =>
      condition.type === "visible_content"
    );

  const hasNearbyEditableField =
    observation?.actionableElements?.some(candidate =>
      candidate.editable === true &&
      candidate.ref !== element.ref
    ) === true;

  const structuralForm = element.formContext ?? null;

  const hasAssociatedForm =
    structuralForm?.associated === true;

  const structuralSubmit =
    hasAssociatedForm &&
    type === "submit" &&
    ["button", "input"].includes(tag);

  const contextualFormEvidence =
    structuralForm
      ? hasAssociatedForm && structuralForm.fieldCount > 0
      : hasNearbyEditableField;

  if (isNavigationLink) {
    return {
      finalizing: false,
      reason: "Navigation link."
    };
  }

  if (INTERMEDIATE_ACTION.test(description)) {
    return {
      finalizing: false,
      reason: "Intermediate interface action."
    };
  }

  if (STRONG_FINALIZING.test(description)) {
    return {
      finalizing: true,
      reason: "Strong finalizing semantics."
    };
  }

  if (
    structuralSubmit &&
    hasFinalizingIntent
  ) {
    return {
      finalizing: true,
      reason: "Structural submit control matches workflow intent."
    };
  }

  if (
    tag === "button" &&
    type === "submit" &&
    hasFinalizingIntent &&
    !structuralForm
  ) {
    return {
      finalizing: true,
      reason: "Submit control matches workflow intent."
    };
  }

  if (
    CONTEXTUAL_FINALIZING.test(description) &&
    hasFinalizingIntent &&
    hasCompletionEvidence &&
    contextualFormEvidence
  ) {
    return {
      finalizing: true,
      reason: "Contextual finalizing control."
    };
  }

  if (
    !description &&
    hasFinalizingIntent &&
    hasCompletionEvidence &&
    contextualFormEvidence &&
    type === "submit"
  ) {
    return {
      finalizing: true,
      reason: "Unlabeled submit control in finalizing workflow."
    };
  }

  return {
    finalizing: false,
    reason: "Insufficient evidence of finalizing semantics."
  };
}
