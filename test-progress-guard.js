import assert from "node:assert/strict";

import {
  createProgressGuard
} from "./src/agent/progress-guard.js";

function observation(url, value = "") {
  return {
    url,
    headings: ["Test Page"],
    visibleBodyText: "Test content",
    actionableElements: [
      {
        ref: "e1",
        tag: "input",
        type: "text",
        label: "Full Name",
        currentValue: value
      }
    ]
  };
}

const guard = createProgressGuard("https://site.test/profile");

const before = observation("https://site.test/profile");

const element = before.actionableElements[0];

const fill = {
  ref: "e1",
  operation: "fill",
  value: "Vivek"
};

// First action is allowed.
assert.equal(
  guard.check(before, element, fill).allowed,
  true
);

// Record the attempt.
guard.recordAttempt(before, element, fill);

// Same action, same state: rejected.
assert.equal(
  guard.check(before, element, fill).reason,
  "repeated_action_same_state"
);

// Page state changed after filling.
const after = observation(
  "https://site.test/profile",
  "Vivek"
);

// Same action, changed state: allowed by progress guard.
// Other agent checks may still reject redundant fills.
assert.equal(
  guard.check(after, after.actionableElements[0], fill).allowed,
  true
);

// URL visit protection remains active.
guard.recordNavigation("https://site.test/home");

guard.recordNavigation("https://site.test/profile");

assert.equal(
  guard.getVisitCount("https://site.test/profile"),
  2
);

const homeObservation = observation(
  "https://site.test/home"
);

const homeLink = {
  ref: "e2",
  tag: "a",
  label: "Profile",
  href: "/profile"
};

const clickProfile = {
  ref: "e2",
  operation: "click",
  value: ""
};

assert.equal(
  guard.check(
    homeObservation,
    homeLink,
    clickProfile
  ).reason,
  "navigation_visit_limit"
);

console.log("STATE-AWARE PROGRESS GUARD: PASSED");
