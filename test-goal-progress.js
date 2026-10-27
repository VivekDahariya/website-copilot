import assert from "node:assert/strict";

import {
  evaluateGoalProgress
} from "./src/agent/goal-progress.js";

function observation({
  url = "https://site.test/profile",
  text = "Profile",
  name = "",
  heading = "Profile"
} = {}) {
  return {
    url,
    title: heading,
    headings: [heading],
    visibleBodyText: text,
    actionableElements: [
      {
        ref: "e1",
        tag: "input",
        type: "text",
        label: "Full Name",
        editable: true,
        currentValue: name
      }
    ]
  };
}

const formGoal = {
  type: "form_state",
  fieldLabel: "Full Name",
  expectedValue: "Vivek"
};

// TEST 1: Completing a form goal.
const formProgress = evaluateGoalProgress(
  observation({ name: "" }),
  observation({ name: "Vivek" }),
  formGoal
);

assert.equal(
  formProgress.classification,
  "goal_completed"
);

// TEST 2: Unrelated visible-content change.
const unrelated = evaluateGoalProgress(
  observation({ text: "Advertisement A" }),
  observation({ text: "Advertisement B" }),
  formGoal
);

assert.equal(
  unrelated.classification,
  "state_changed_without_verified_goal_progress"
);

// TEST 3: No change.
const unchanged = evaluateGoalProgress(
  observation(),
  observation(),
  formGoal
);

assert.equal(
  unchanged.classification,
  "no_observed_change"
);

// TEST 4: Composite goal makes partial progress.
const compositeGoal = {
  type: "all_of",
  conditions: [
    {
      type: "form_state",
      fieldLabel: "Full Name",
      expectedValue: "Vivek"
    },
    {
      type: "visible_content",
      text: "Profile saved"
    }
  ]
};

const partial = evaluateGoalProgress(
  observation({
    name: "",
    text: "Profile"
  }),
  observation({
    name: "Vivek",
    text: "Profile"
  }),
  compositeGoal
);

assert.equal(
  partial.classification,
  "goal_progress"
);

assert.equal(
  partial.completedAfter,
  1
);

// TEST 5: Composite goal completes.
const completed = evaluateGoalProgress(
  observation({
    name: "Vivek",
    text: "Profile"
  }),
  observation({
    name: "Vivek",
    text: "Profile saved"
  }),
  compositeGoal
);

assert.equal(
  completed.classification,
  "goal_completed"
);

// TEST 6: Previously satisfied condition regresses.
const regressed = evaluateGoalProgress(
  observation({
    name: "Vivek",
    text: "Profile"
  }),
  observation({
    name: "",
    text: "Profile"
  }),
  compositeGoal
);

assert.equal(
  regressed.classification,
  "goal_regressed"
);

// TEST 7: Search-box preparation is not falsely
// classified as verified destination progress.
const destinationGoal = {
  type: "page_destination",
  hostname: "en.wikipedia.org",
  pathname: "/wiki/Alan_Turing",
  heading: "Alan Turing"
};

const searchPreparation = evaluateGoalProgress(
  observation({
    url: "https://www.wikipedia.org/",
    name: ""
  }),
  observation({
    url: "https://www.wikipedia.org/",
    name: "Alan Turing"
  }),
  destinationGoal
);

assert.equal(
  searchPreparation.classification,
  "state_changed_without_verified_goal_progress"
);

console.log("GOAL PROGRESS TESTS: 7/7 PASSED");
