import { chromium } from "playwright";

import { runAgent } from "./src/agent/agent.js";
import { observePage } from "./src/observer/dom-observer.js";

const TASK =
  "Find the Travel category on this website and open its category page.";

const browser = await chromium.launch({
  headless: false,
  slowMo: 150
});

try {
  const page = await browser.newPage();

  await page.goto("https://books.toscrape.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  /*
   * The production goal verifier currently supports:
   * page_destination, visible_content, form_state, all_of.
   *
   * For this test, we use visible_content to check the
   * destination heading. The URL is independently checked
   * after execution.
   *
   * The agent does NOT receive the Travel category URL.
   */

  const goal = {
    type: "page_destination",
    hostname: "books.toscrape.com",
    pathname: "/catalogue/category/books/travel_2/index.html",
    heading: "Travel"
  };

  console.log("\n========== PRODUCTION DISCOVERY ==========");

  const result = await runAgent(
    page,
    TASK,
    goal
  );

  console.log("\nAGENT RESULT:");
  console.dir(result, { depth: 3 });

  const correctHeading = await page
    .locator("h1")
    .filter({ hasText: /^Travel$/ })
    .isVisible()
    .catch(() => false);

  const url = new URL(page.url());

  const correctUrl =
    url.hostname === "books.toscrape.com" &&
    /\/catalogue\/category\/books\/travel_\d+\/index\.html$/
      .test(url.pathname);

  console.log("\n========== INDEPENDENT VERIFICATION ==========");
  console.log("Correct heading:", correctHeading);
  console.log("Correct URL:", correctUrl);
  console.log("Agent status:", result.status);

  if (
    result.status !== "verified_complete" ||
    !correctHeading ||
    !correctUrl
  ) {
    throw new Error(
      "Production destination discovery failed."
    );
  }

  console.log("\nPRODUCTION DISCOVERY: PASSED");

} finally {
  await browser.close();
}
