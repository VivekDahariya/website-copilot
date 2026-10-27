import assert from "node:assert/strict";
import {
  classifyBrowserAction,
  authorizeBrowserAction
} from "./src/agent/action-safety-policy.js";

let passed = 0;

function test(name, action, element, expected) {
  const decision = classifyBrowserAction(action, element);
  const authorization = authorizeBrowserAction(action, element);

  assert.equal(
    decision.classification,
    expected,
    `${name}: unexpected classification`
  );

  assert.equal(
    authorization.allowed,
    expected === "safe",
    `${name}: unexpected authorization`
  );

  passed++;
  console.log(`PASSED: ${name}`);
}

const click = {
  ref: "e1",
  operation: "click",
  value: ""
};

const ordinaryLink = (label, href) => ({
  tag: "a",
  type: "",
  label,
  text: label,
  href
});

console.log("\n========== STEP 59 ==========");

// 1. Ordinary navigation
test(
  "Open Account Settings",
  click,
  ordinaryLink("Account Settings", "/account"),
  "safe"
);

// 2. Ordinary navigation
test(
  "Open Privacy Settings",
  click,
  ordinaryLink("Privacy Settings", "/preferences"),
  "safe"
);

// 3. Ordinary navigation
test(
  "Open Notification Preferences",
  click,
  ordinaryLink(
    "Notification Preferences",
    "/account/notifications"
  ),
  "safe"
);

// 4. Dangerous link
test(
  "Delete account link",
  click,
  ordinaryLink("Delete Account", "/account/delete"),
  "requires_approval"
);

// 5. Dangerous link
test(
  "Payment link",
  click,
  ordinaryLink("Make Payment", "/payment/confirm"),
  "requires_approval"
);

// 6. Dangerous link
test(
  "Transfer money link",
  click,
  ordinaryLink("Transfer Money", "/transfer"),
  "requires_approval"
);

// 7. Dangerous link
test(
  "Unsubscribe link",
  click,
  ordinaryLink("Unsubscribe", "/unsubscribe"),
  "requires_approval"
);

// 8. Destructive button
test(
  "Delete account button",
  click,
  {
    tag: "button",
    type: "button",
    label: "Delete Account",
    text: "Delete Account",
    href: ""
  },
  "requires_approval"
);

// 9. Consequential form submit
test(
  "Publish button",
  click,
  {
    tag: "button",
    type: "submit",
    label: "Publish",
    text: "Publish",
    href: ""
  },
  "requires_approval"
);

// 10. Sensitive credential field
test(
  "Password field",
  {
    ref: "e2",
    operation: "fill",
    value: "example"
  },
  {
    tag: "input",
    type: "password",
    label: "Password"
  },
  "human_handover"
);

// 11. OTP field
test(
  "OTP field",
  {
    ref: "e3",
    operation: "fill",
    value: "123456"
  },
  {
    tag: "input",
    type: "text",
    label: "Verification Code"
  },
  "human_handover"
);

// 12. Ordinary checkbox reversal
test(
  "Disable ordinary notifications",
  {
    ref: "e4",
    operation: "uncheck",
    value: ""
  },
  {
    tag: "input",
    type: "checkbox",
    label: "Email Notifications"
  },
  "safe"
);

// 13. Sensitive checkbox reversal
test(
  "Disable privacy protection",
  {
    ref: "e5",
    operation: "uncheck",
    value: ""
  },
  {
    tag: "input",
    type: "checkbox",
    label: "Privacy Settings"
  },
  "requires_approval"
);

// 14. Unknown operation
test(
  "Unknown browser operation",
  {
    ref: "e6",
    operation: "execute_script",
    value: ""
  },
  {
    tag: "button",
    label: "Run"
  },
  "blocked"
);

console.log(
  `\nSTEP 59 — NAVIGATION SAFETY REGRESSION: ${passed}/14 PASSED`
);
