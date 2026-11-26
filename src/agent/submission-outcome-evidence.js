/**
 * A conservative, source-grounded confirmation for native form submissions.
 * An authorized click is NOT itself proof of a completed submission.
 * Require pre-submit form conditions, an actual native submit control, and
 * fresh success evidence in a changed browser document. No website allowlist.
 */
const norm = s => String(s ?? '').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();

const successHeading = /\b(?:form\s+submitted|(?:submission|request|application|message|response|order|payment)\s+(?:received|successful|completed|submitted)|success(?:fully)?|thank\s+you|all\s+done|sent\s+successfully|saved\s+successfully)\b/i;
const successText = /\b(?:received|submitted|thank\s+you|success(?:fully)?|(?:has|have|was|were)\s+(?:been\s+)?(?:sent|saved|submitted)|submission\s+complete)\b/i;
const failureHeading = /\b(?:failure|failed|error|invalid|denied|rejected|not\s+submitted|not\s+saved|validation|sign\s+in|log\s+in|access\s+denied)\b/i;
const failureText = /\b(?:submission\s+(?:failed|rejected)|failed\s+to\s+submit|could\s+not\s+submit|not\s+submitted|validation\s+error|please\s+correct|invalid\s+(?:input|field|value)|access\s+denied)\b/i;

export function verifySubmittedFormOutcome({instruction, action, element, before, after, preActionVerification}) {
  const fail = reason => ({verified:false,reason});
  const request = String(instruction ?? '');
  if (!/\bsubmit\b/i.test(request) ||
      /\b(?:do\s+not|don't|dont|never|without|avoid)\s+(?:\w+\s+){0,2}submitt?(?:ing)?\b/i.test(request))
    return fail('submit_not_explicitly_requested');
  if (!['click','press'].includes(action?.operation)) return fail('not_a_submit_action');
  const tag=norm(element?.tag);
  const type=norm(element?.effectiveType || element?.type);
  if (!['button','input'].includes(tag) || type !== 'submit' ||
      element?.formContext?.associated !== true)
    return fail('not_a_native_associated_submit');
  const conditions=preActionVerification?.evidence?.conditions;
  if (preActionVerification?.evidence?.requiresFinalizingAction !== true ||
      !Array.isArray(conditions) || conditions.length === 0 ||
      !conditions.every(condition=>condition?.completed === true))
    return fail('pre_submit_requirements_unverified');
  if (!before || !after) return fail('missing_browser_evidence');
  let initial, final;
  try { initial=new URL(before.url); final=new URL(after.url); }
  catch {return fail('invalid_page_url');}
  if (!['http:','https:'].includes(initial.protocol) ||
      !['http:','https:'].includes(final.protocol) ||
      initial.origin !== final.origin)
    return fail('unexpected_navigation_origin');
  const priorHeading=norm((before.headings ?? []).join(' '));
  const newHeading=norm((after.headings ?? []).join(' '));
  const beforeBody=norm(before.visibleBodyText);
  const afterBody=norm(after.visibleBodyText);
  const changedDocument = before.url !== after.url ||
    (newHeading !== priorHeading &&
      !(after.actionableElements ?? []).some(e => e.formContext?.associated === true));
  if (!changedDocument) return fail('no_confirmed_document_transition');
  if (failureHeading.test(newHeading) || failureText.test(afterBody))
    return fail('explicit_negative_outcome');
  // A new success heading is primary evidence. Otherwise require a new
  // confirmation message in the destination, not generic site chrome.
  const headingProof = successHeading.test(newHeading) &&
    !successHeading.test(priorHeading);
  const textProof = successText.test(afterBody) && !successText.test(beforeBody);
  if (!headingProof && !textProof) return fail('no_positive_confirmation');
  return {verified:true,kind:'form_submission_confirmation',
    initialUrl:before.url,finalUrl:after.url,
    headingProof,textProof,
    confirmationHeading:(after.headings ?? []).find(h=>successHeading.test(norm(h))) ?? null};
}
