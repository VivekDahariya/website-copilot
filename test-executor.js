import { chromium } from "playwright";
import { observePage } from "./src/observer/dom-observer.js";
import { executeAction } from "./src/executor/action-executor.js";

const browser = await chromium.launch({ headless: false });

try {
  const page = await browser.newPage();

  await page.goto("https://www.wikipedia.org/", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  const observation = await observePage(page);

  const input = observation.actionableElements.find(
    element =>
      element.tag === "input" &&
      element.editable &&
      element.label.toLowerCase().includes("search")
  );

  if (!input) {
    throw new Error("Search input not found.");
  }

  console.log("\nSTEP 1 — FILL SEARCH");

  const fillResult = await executeAction(page, {
    ref: input.ref,
    operation: "fill",
    value: "Alan Turing"
  });

  console.log(fillResult);

  if (!fillResult.verified) {
    throw new Error("Search input verification failed.");
  }

  const button = observation.actionableElements.find(
    element =>
      element.tag === "button" &&
      element.label.toLowerCase() === "search"
  );

  if (!button) {
    throw new Error("Search button not found.");
  }

  console.log("\nSTEP 2 — SUBMIT SEARCH");

  const clickResult = await executeAction(page, {
    ref: button.ref,
    operation: "click"
  });

  console.log(clickResult);

  await page.waitForURL(
    url => url.hostname.endsWith("wikipedia.org") &&
      url.pathname.includes("Alan_Turing"),
    { timeout: 15000 }
  );

  const heading = page.getByRole("heading", {
    name: "Alan Turing",
    exact: true
  }).first();

  await heading.waitFor({
    state: "visible",
    timeout: 15000
  });

  console.log("\n========== TASK VERIFICATION ==========");
  console.log("Final URL:", page.url());
  console.log("Heading:", await heading.innerText());
  console.log("Task verification: PASSED");

} catch (error) {
  console.error("\nExecutor test failed:", error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
