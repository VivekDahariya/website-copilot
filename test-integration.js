import { chromium } from "playwright";
import { runAgent } from "./src/agent/agent.js";
import { planGoal } from "./src/agent/goal-planner.js";

const tests = [
  {
    name: "Wikipedia navigation",
    startUrl: "https://www.wikipedia.org/",
    task: "Search Wikipedia for Alan Turing and open his article.",
    expectedGoalType: "page_destination",
    verify: async page => {
      const url = new URL(page.url());

      return (
        url.hostname === "en.wikipedia.org" &&
        url.pathname === "/wiki/Alan_Turing" &&
        await page.getByRole("heading", {
          name: "Alan Turing",
          exact: true
        }).first().isVisible().catch(() => false)
      );
    }
  },
  {
    name: "Visible content",
    startUrl: "https://example.com/",
    task: "Find the text This domain is for use in documentation examples on this page.",
    expectedGoalType: "visible_content",
    expectedText:
      "This domain is for use in documentation examples",
    verify: async page =>
      await page.locator("body")
        .getByText(
          "This domain is for use in documentation examples",
          { exact: false }
        )
        .first()
        .isVisible()
        .catch(() => false)
  },
  {
    name: "Form state",
    startUrl: null,
    task: "Fill the Full Name field with Vivek.",
    expectedGoalType: "form_state",
    verify: async page =>
      await page.locator("#full-name").inputValue() === "Vivek"
  }
];

const browser = await chromium.launch({
  headless: false,
  slowMo: 150
});

const results = [];

try {
  for (const test of tests) {
    console.log("\n====================================");
    console.log("INTEGRATION TEST:", test.name);
    console.log("====================================");

    const page = await browser.newPage();

    try {
      if (test.startUrl) {
        await page.goto(test.startUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });
      } else {
        await page.setContent(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <title>Profile Editor</title>
          </head>
          <body>
            <h1>Profile Editor</h1>
            <label for="full-name">Full Name</label>
            <input id="full-name" type="text" value="">
          </body>
          </html>
        `);
      }

      const goal = await planGoal(test.task, page.url());

      console.log("Generated goal:", goal);

      if (goal.type !== test.expectedGoalType) {
        throw new Error(
          `Expected ${test.expectedGoalType}, got ${goal.type}`
        );
      }

      if (
        test.expectedText &&
        goal.text !== test.expectedText
      ) {
        throw new Error(
          `Incorrect extracted text: ${JSON.stringify(goal.text)}`
        );
      }

      const startingUrl = page.url();

      const result = await runAgent(
        page,
        test.task,
        goal
      );

      console.log("Agent status:", result.status);

      const independentlyVerified =
        await test.verify(page);

      if (
        test.expectedText &&
        (page.url() !== startingUrl || result.steps !== 0)
      ) {
        throw new Error(
          "Current-page search performed unnecessary actions."
        );
      }

      if (
        result.status !== "verified_complete" ||
        !independentlyVerified
      ) {
        throw new Error(
          "Agent completion or independent verification failed."
        );
      }

      console.log("TEST PASSED:", test.name);

      results.push({
        test: test.name,
        status: "PASSED",
        steps: result.steps
      });

    } catch (error) {
      console.error("TEST FAILED:", error.message);

      results.push({
        test: test.name,
        status: "FAILED",
        error: error.message
      });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

console.log("\n========== INTEGRATION SUMMARY ==========");

console.table(results);

const passed = results.filter(
  result => result.status === "PASSED"
).length;

console.log(
  `INTEGRATION TESTS: ${passed}/${tests.length} PASSED`
);

if (passed !== tests.length) {
  process.exitCode = 1;
}
