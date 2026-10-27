import { verifyGoal } from "./src/agent/goal-verifier.js";

const goal = {
  type: "all_of",
  conditions: [
    {
      type: "page_destination",
      hostname: "en.wikipedia.org",
      pathname: "/wiki/Alan_Turing",
      heading: "Alan Turing"
    },
    {
      type: "visible_content",
      text: "Early life and education"
    }
  ]
};

const observation = {
  url: "https://en.wikipedia.org/wiki/Alan_Turing",
  title: "Alan Turing - Wikipedia",
  headings: [
    "Alan Turing",
    "Early life and education"
  ],
  visibleBodyText:
    "Alan Turing Early life and education",
  actionableElements: []
};

const complete = verifyGoal(observation, goal);

if (!complete.completed) {
  throw new Error("Complete composite goal was rejected.");
}

console.log("ALL CONDITIONS SATISFIED: PASSED");

const incomplete = verifyGoal(
  {
    ...observation,
    visibleBodyText: "Alan Turing"
  },
  goal
);

if (incomplete.completed) {
  throw new Error(
    "FALSE POSITIVE: Incomplete composite goal accepted."
  );
}

console.log("MISSING CONDITION REJECTED: PASSED");

const wrongPage = verifyGoal(
  {
    ...observation,
    url: "https://en.wikipedia.org/wiki/Ada_Lovelace"
  },
  goal
);

if (wrongPage.completed) {
  throw new Error(
    "FALSE POSITIVE: Wrong destination accepted."
  );
}

console.log("WRONG DESTINATION REJECTED: PASSED");

console.log("\nCOMPOSITE GOAL TESTS: 3/3 PASSED");
