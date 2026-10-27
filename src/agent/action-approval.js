
import { randomUUID } from "node:crypto";

const issued = new WeakMap();

function fingerprint(action) {
  return JSON.stringify({
    ref: action?.ref,
    operation: action?.operation,
    value: action?.value ?? null
  });
}

export function createActionApproval(action, {
  pageUrl,
  targetIdentity,
  expiresInMs = 30000
} = {}) {
  if (
    !action ||
    typeof action.ref !== "string" ||
    typeof action.operation !== "string" ||
    typeof pageUrl !== "string" ||
    !pageUrl ||
    typeof targetIdentity !== "string" ||
    !targetIdentity
  ) {
    throw new Error("Approval requires an action, URL, and target identity.");
  }

  if (
    !Number.isFinite(expiresInMs) ||
    expiresInMs <= 0 ||
    expiresInMs > 30000
  ) {
    throw new Error("Invalid approval lifetime.");
  }

  const approval = Object.freeze({
    id: randomUUID(),
    granted: true,
    actionRef: action.ref,
    operation: action.operation
  });

  issued.set(approval, {
    fingerprint: fingerprint(action),
    pageUrl,
    targetIdentity,
    expiresAt: Date.now() + expiresInMs,
    consumed: false
  });

  return approval;
}

export function validateActionApproval(
  approval,
  action,
  {
    pageUrl,
    targetIdentity
  } = {}
) {
  const record = issued.get(approval);

  if (!record) {
    return { allowed: false, reason: "Unknown approval." };
  }

  if (record.consumed) {
    return { allowed: false, reason: "Approval already consumed." };
  }

  if (Date.now() > record.expiresAt) {
    return { allowed: false, reason: "Approval expired." };
  }

  if (
    record.fingerprint !== fingerprint(action) ||
    record.pageUrl !== pageUrl ||
    record.targetIdentity !== targetIdentity
  ) {
    return { allowed: false, reason: "Approval context mismatch." };
  }

  return { allowed: true };
}

export function consumeActionApproval(
  approval,
  action,
  context
) {
  const result = validateActionApproval(
    approval,
    action,
    context
  );

  if (!result.allowed) {
    return result;
  }

  issued.get(approval).consumed = true;

  return { allowed: true };
}
