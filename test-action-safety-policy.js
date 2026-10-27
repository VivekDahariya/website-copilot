import assert from "node:assert/strict";

import {
  classifyBrowserAction,
  authorizeBrowserAction
} from "./src/agent/action-safety-policy.js";

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

assert.equal(
  authorizeBrowserAction(
    action,
    element,
    {
      granted: true,
      actionRef: "e7",
      operation: "click"
    }
  ).allowed,
  true
);

assert.equal(
  authorizeBrowserAction(
    action,
    element,
    {
      granted: true,
      actionRef: "e8",
      operation: "click"
    }
  ).allowed,
  false
);

console.log(
  "\nACTION SAFETY POLICY: 12/12 PASSED"
);
