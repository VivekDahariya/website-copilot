import { chromium } from "playwright";
import { runAgent } from "./src/agent/agent.js";
import { planGoal } from "./src/agent/goal-planner.js";

const TASK =
  "Search Wikipedia for Alan Turing and open his article.";

const browser = await chromium.launch({
  headless: false,
  slowMo: 200
});

try {
  const page = await browser.newPage();

  await page.goto("https://www.wikipedia.org/", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  console.log("\n========== GOAL PLANNING ==========");

  const goal = await planGoal(TASK, page.url());

  console.log("Generated goal:", goal);

  if (goal.type === "unsupported") {
    throw new Error(
      "The goal planner could not derive a verifiable destination."
    );
  }

  const result = await runAgent(page, TASK, goal);

  console.log("\n========== AGENT RESULT ==========");
  console.log(JSON.stringify(result, null, 2));

  if (result.status !== "verified_complete") {
    throw new Error(
      `Agent did not verify task completion: ${result.status}`
    );
  }

  // Independent test assertion, separate from the generated goal.
  const urlCorrect =
    new URL(page.url()).hostname === "en.wikipedia.org" &&
    new URL(page.url()).pathname === "/wiki/Alan_Turing";

  const headingCorrect =
    await page.getByRole("heading", {
      name: "Alan Turing",
      exact: true
    }).first().isVisible().catch(() => false);

  if (!urlCorrect || !headingCorrect) {
    throw new Error(
      "Independent test failed: wrong article opened."
    );
  }

  console.log("\nTASK VERIFICATION: PASSED");

} catch (error) {
  console.error("\nAGENT ERROR:", error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
