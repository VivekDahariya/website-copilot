import { verifyGoal } from "./src/agent/goal-verifier.js";

const observation = {
  url: "https://example.com/profile",
  title: "User Profile",
  visibleBodyText: "User Profile Account Settings",
  headings: [
    "User Profile",
    "Account Settings"
  ],
  actionableElements: [
    {
      ref: "e1",
      tag: "input",
      label: "Full Name",
      editable: true,
      currentValue: "Vivek"
    },
    {
      ref: "e2",
      tag: "button",
      label: "Save Changes",
      editable: false,
      currentValue: null
    }
  ]
};

const tests = [
  {
    name: "Destination verification",
    goal: {
      type: "page_destination",
      hostname: "example.com",
      pathname: "/profile",
      heading: "User Profile"
    }
  },
  {
    name: "Visible content verification",
    goal: {
      type: "visible_content",
      text: "Account Settings"
    }
  },
  {
    name: "Form state verification",
    goal: {
      type: "form_state",
      fieldLabel: "Full Name",
      expectedValue: "Vivek"
    }
  }
];

let passed = 0;

for (const test of tests) {
  const result = verifyGoal(observation, test.goal);

  console.log(`\n${test.name}`);
  console.log(result);

  if (!result.completed) {
    throw new Error(`${test.name} failed.`);
  }

  passed++;
}

console.log(`\nGOAL VERIFIER TESTS: ${passed}/${tests.length} PASSED`);
