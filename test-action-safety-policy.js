import assert from "node:assert/strict";

import {
  classifyBrowserAction,
  authorizeBrowserAction
} from "./src/agent/action-safety-policy.js";

import {
  createActionApproval
} from "./src/agent/action-approval.js";

const cases = [
  {
    name: "Ordinary navigation",
    action: {
      operation: "navigate",
      value: "https://example.com"
    },
    element: {},
    expected: "safe"
  },
  {
    name: "Ordinary form filling",
    action: {
      operation: "fill",
      value: "Vivek"
    },
    element: {
      label: "Full Name"
    },
    expected: "safe"
  },
  {
    name: "Search button",
    action: {
      operation: "click"
    },
    element: {
      label: "Search"
    },
    expected: "safe"
  },
  {
    name: "Send message",
    action: {
      operation: "click"
    },
    element: {
      label: "Send Message"
    },
    expected: "requires_approval"
  },
  {
    name: "Purchase",
    action: {
      operation: "click"
    },
    element: {
      label: "Buy Now"
    },
    expected: "requires_approval"
  },
  {
    name: "Delete",
    action: {
      operation: "click"
    },
    element: {
      label: "Delete Account"
    },
    expected: "requires_approval"
  },
  {
    name: "Password",
    action: {
      operation: "fill",
      value: "secret"
    },
    element: {
      label: "Password",
      type: "password"
    },
    expected: "human_handover"
  },
  {
    name: "OTP",
    action: {
      operation: "fill",
      value: "123456"
    },
    element: {
      label: "Verification Code"
    },
    expected: "human_handover"
  },
  {
    name: "Unknown operation",
    action: {
      operation: "execute_script"
    },
    element: {},
    expected: "blocked"
  }
];

for (const testCase of cases) {
  const result = classifyBrowserAction(
    testCase.action,
    testCase.element
  );

  assert.equal(
    result.classification,
    testCase.expected,
    testCase.name
  );

  console.log("PASSED:", testCase.name);
}

const action = {
  ref: "e7",
  operation: "click"
};

const element = {
  label: "Send Message"
};

assert.equal(
  authorizeBrowserAction(action, element).allowed,
  false
);

const approvalContext = {
  pageUrl: "https://mail.example/inbox",
  targetIdentity: "Send Message"
};

// A plain object that only claims to be granted is not an approval.
assert.equal(
  authorizeBrowserAction(
    action,
    element,
    { granted: true, actionRef: "e7", operation: "click" },
    approvalContext
  ).allowed,
  false
);

// An approval issued for exactly this action, page and target is accepted.
assert.equal(
  authorizeBrowserAction(
    action,
    element,
    createActionApproval(action, approvalContext),
    approvalContext
  ).allowed,
  true
);

// An approval issued for a different action is refused.
assert.equal(
  authorizeBrowserAction(
    action,
    element,
    createActionApproval(
      { ref: "e8", operation: "click" },
      approvalContext
    ),
    approvalContext
  ).allowed,
  false
);

// An approval presented on a different page is refused.
assert.equal(
  authorizeBrowserAction(
    action,
    element,
    createActionApproval(action, approvalContext),
    { ...approvalContext, pageUrl: "https://other.example/" }
  ).allowed,
  false
);

console.log(
  "\nACTION SAFETY POLICY: 12/12 PASSED"
);
