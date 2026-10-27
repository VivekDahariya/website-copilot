
import assert from "node:assert/strict";

import {
  createActionApproval,
  validateActionApproval,
  consumeActionApproval
} from "../../src/agent/action-approval.js";

const action = {
  ref: "save-button",
  operation: "click"
};

const context = {
  pageUrl: "https://settings.example/preferences",
  targetIdentity: "button#save"
};

const approval = createActionApproval(action, context);

assert.equal(
  validateActionApproval(approval, action, context).allowed,
  true
);

console.log("PASS: Matching approval");

assert.equal(
  validateActionApproval(
    approval,
    { ...action, ref: "delete-button" },
    context
  ).allowed,
  false
);

console.log("PASS: Different target rejected");

assert.equal(
  validateActionApproval(
    approval,
    { ...action, operation: "press", value: "Enter" },
    context
  ).allowed,
  false
);

console.log("PASS: Different operation rejected");

assert.equal(
  validateActionApproval(
    approval,
    action,
    { ...context, pageUrl: "https://settings.example/other" }
  ).allowed,
  false
);

console.log("PASS: Different URL rejected");

assert.equal(
  validateActionApproval(
    approval,
    action,
    { ...context, targetIdentity: "button#delete" }
  ).allowed,
  false
);

console.log("PASS: Different element identity rejected");

assert.equal(
  consumeActionApproval(approval, action, context).allowed,
  true
);

assert.equal(
  consumeActionApproval(approval, action, context).allowed,
  false
);

console.log("PASS: Single-use approval");

const forged = {
  ...createActionApproval(action, context)
};

assert.equal(
  validateActionApproval(forged, action, context).allowed,
  false
);

console.log("PASS: Forged approval rejected");

const expired = createActionApproval(action, {
  ...context,
  expiresInMs: 1
});

await new Promise(resolve => setTimeout(resolve, 10));

assert.equal(
  validateActionApproval(expired, action, context).allowed,
  false
);

console.log("PASS: Expired approval rejected");

console.log("STEP 74J.1 — APPROVAL TOKEN TESTS PASSED");
