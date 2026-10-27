import { chromium } from "playwright";
import { observePage } from "./src/observer/dom-observer.js";
import { decideNextAction } from "./src/agent/local-reasoner.js";
import { executeAction } from "./src/executor/action-executor.js";
import { selectRelevantElements } from "./src/agent/element-ranker.js";

const START_URL = "https://books.toscrape.com/";
const TASK =
  "Find the Travel category on this website and open its category page.";

const MAX_STEPS = 6;

const browser = await chromium.launch({
  headless: false,
  slowMo: 150
});

try {
  const page = await browser.newPage();

  await page.goto(START_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  const history = [];
  const visited = new Set([page.url()]);

  console.log("\n========== DESTINATION DISCOVERY ==========");
  console.log("TASK:", TASK);

  let completed = false;

  for (let step = 1; step <= MAX_STEPS; step++) {
    const observation = await observePage(page);

    console.log(`\nSTEP ${step}`);
    console.log("URL:", observation.url);
    console.log("Title:", observation.title);

    // Independent completion condition.
    // This is deliberately not supplied to the LLM.
    const correctCategory = await page
      .locator("h1")
      .filter({ hasText: /^Travel$/ })
      .isVisible()
      .catch(() => false);

    const correctWebsite =
      new URL(page.url()).hostname === "books.toscrape.com";

    const correctPath =
      /\/catalogue\/category\/books\/travel_\d+\/index\.html$/
        .test(new URL(page.url()).pathname);

    if (
      correctCategory &&
      correctWebsite &&
      correctPath
    ) {
      completed = true;
      console.log("DESTINATION VERIFIED");
      break;
    }

    const relevantElements = selectRelevantElements(
      TASK,
      observation.actionableElements
    );

    console.log(
      "Relevant candidates:",
      relevantElements.map(element => ({
        ref: element.ref,
        label: element.label,
        score: element.relevanceScore
      }))
    );

    const decision = await decideNextAction(
      TASK,
      {
        ...observation,
        actionableElements: relevantElements
      },
      history,
      []
    );

    console.log("Decision:", decision);

    if (decision.operation === "done") {
      throw new Error(
        "Model claimed completion before verification."
      );
    }

    const element = observation.actionableElements.find(
      item => item.ref === decision.ref
    );

    if (!element) {
      throw new Error("Invalid element reference.");
    }

    if (
      ["click", "press"].includes(decision.operation) &&
      /buy now|place order|checkout|delete|send message|payment/i
        .test(element.label)
    ) {
      throw new Error("Sensitive action blocked.");
    }

    const previousUrl = page.url();

    const execution = await executeAction(
      page,
      decision
    );

    history.push({
      step,
      decision,
      execution
    });

    console.log("Execution:", execution);

    if (
      page.url() !== previousUrl &&
      visited.has(page.url())
    ) {
      throw new Error(
        "Navigation loop detected: revisited an earlier page."
      );
    }

    visited.add(page.url());
  }

  console.log("\n========== DISCOVERY RESULT ==========");
  console.log("Final URL:", page.url());
  console.log("Actions:", history.length);
  console.log("Verified:", completed);

  if (!completed) {
    throw new Error(
      "Destination discovery failed."
    );
  }

  console.log("\nUNKNOWN DESTINATION DISCOVERY: PASSED");

} finally {
  await browser.close();
}
