
import assert from "node:assert/strict";

import {
  authorizeBrowserAction
} from "../../src/agent/action-safety-policy.js";

import {
  createActionApproval,
  consumeActionApproval
} from "../../src/agent/action-approval.js";

const action = {
  ref: "e1",
  operation: "click",
  value: ""
};

const element = {
  label: "Submit Preferences",
  tag: "button"
};

const context = {
  pageUrl: "https://approval-test.example/settings",
  targetIdentity: "button|||||Submit Preferences"
};

const approval = createActionApproval(action, context);

assert.equal(
  authorizeBrowserAction(
    action,
    element,
    approval,
    context
  ).allowed,
  true
);

console.log("PASS: Valid approval accepted");

assert.equal(
  authorizeBrowserAction(
    action,
    element,
    { ...approval },
    context
  ).allowed,
  false
);

console.log("PASS: Forged approval rejected");

assert.equal(
  authorizeBrowserAction(
    action,
    element,
    approval,
    {
      ...context,
      targetIdentity: "different-element"
    }
  ).allowed,
  false
);

console.log("PASS: Target mismatch rejected");

assert.equal(
  authorizeBrowserAction(
    action,
    element,
    approval,
    {
      ...context,
      pageUrl: "https://different.example/"
    }
  ).allowed,
  false
);

console.log("PASS: URL mismatch rejected");

assert.equal(
  consumeActionApproval(
    approval,
    action,
    context
  ).allowed,
  true
);

assert.equal(
  authorizeBrowserAction(
    action,
    element,
    approval,
    context
  ).allowed,
  false
);

console.log("PASS: Consumed approval rejected");

const restricted = {
  label: "Enter password",
  type: "password"
};

const restrictedApproval = createActionApproval(
  action,
  context
);

assert.equal(
  authorizeBrowserAction(
    action,
    restricted,
    restrictedApproval,
    context
  ).allowed,
  false
);

console.log("PASS: Human handover cannot be bypassed");

assert.equal(
  authorizeBrowserAction(
    action,
    element,
    null,
    context
  ).allowed,
  false
);

console.log("PASS: Missing approval rejected");

console.log("STEP 74J.5 — APPROVAL SECURITY TESTS PASSED");
