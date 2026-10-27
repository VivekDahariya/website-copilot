import { chromium } from "playwright";

import { planGoal } from "./src/agent/goal-planner.js";
import { runAgent } from "./src/agent/agent.js";
import { verifyGoal } from "./src/agent/goal-verifier.js";
import { observePage } from "./src/observer/dom-observer.js";

const TASK =
  "Search Wikipedia for Alan Turing, open his article, " +
  "and verify that it contains the section Early life and education.";

const EXPECTED_URL =
  "https://en.wikipedia.org/wiki/Alan_Turing";

const EXPECTED_SECTION =
  "Early life and education";

const browser = await chromium.launch({
  headless: false,
  slowMo: 150
});

try {
  const page = await browser.newPage();

  await page.goto("https://www.wikipedia.org/", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  console.log("\n========== COMPOSITE INTEGRATION ==========");
  console.log("TASK:", TASK);

  // 1. Generate the goal using the local LLM.
  const goal = await planGoal(TASK, page.url());

  console.log("\nGENERATED GOAL:");
  console.dir(goal, { depth: null });

  // 2. Validate the generated goal independently.
  if (goal.type !== "all_of") {
    throw new Error(
      `Expected all_of goal, received ${goal.type}`
    );
  }

  if (
    !Array.isArray(goal.conditions) ||
    goal.conditions.length < 2
  ) {
    throw new Error(
      "Composite goal must contain at least two conditions."
    );
  }

  const destination = goal.conditions.find(
    condition => condition.type === "page_destination"
  );

  const content = goal.conditions.find(
    condition => condition.type === "visible_content"
  );

  if (!destination) {
    throw new Error(
      "Generated goal is missing destination verification."
    );
  }

  if (!content) {
    throw new Error(
      "Generated goal is missing content verification."
    );
  }

  if (
    destination.hostname !== "en.wikipedia.org" ||
    destination.pathname !== "/wiki/Alan_Turing" ||
    destination.heading !== "Alan Turing"
  ) {
    throw new Error(
      "Generated destination is incorrect."
    );
  }

  if (
    content.text.trim().toLowerCase() !==
    EXPECTED_SECTION.toLowerCase()
  ) {
    throw new Error(
      `Incorrect section target: ${JSON.stringify(content.text)}`
    );
  }

  console.log("\nGOAL GENERATION: PASSED");

  // 3. Execute autonomously.
  const result = await runAgent(
    page,
    TASK,
    goal
  );

  console.log("\nAGENT RESULT:");
  console.dir(result, { depth: 3 });

  // 4. Independently verify the browser state.
  const correctUrl =
    page.url() === EXPECTED_URL;

  const articleHeading = await page
    .getByRole("heading", {
      name: "Alan Turing",
      exact: true
    })
    .first()
    .isVisible()
    .catch(() => false);

  const sectionHeading = await page
    .getByRole("heading", {
      name: EXPECTED_SECTION,
      exact: true
    })
    .first()
    .isVisible()
    .catch(() => false);

  const observation = await observePage(page);
  const compositeVerification =
    verifyGoal(observation, goal);

  console.log("\n========== INDEPENDENT VERIFICATION ==========");

  console.log("Correct URL:", correctUrl);
  console.log("Article heading:", articleHeading);
  console.log("Section heading:", sectionHeading);
  console.log(
    "Composite verification:",
    compositeVerification.completed
  );

  if (
    result.status !== "verified_complete" ||
    !correctUrl ||
    !articleHeading ||
    !sectionHeading ||
    !compositeVerification.completed
  ) {
    throw new Error(
      "Composite workflow failed independent verification."
    );
  }

  console.log("\nCOMPOSITE INTEGRATION: PASSED");

} finally {
  await browser.close();
}
