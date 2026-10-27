import { chromium } from "playwright";
import { observePage } from "./src/observer/dom-observer.js";

const browser = await chromium.launch({
  headless: false
});

try {
  const page = await browser.newPage();

  await page.goto("https://www.wikipedia.org/", {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });

  const observation = await observePage(page);

  console.log("\n========== WEBSITE OBSERVATION ==========");
  console.log("URL:", observation.url);
  console.log("Title:", observation.title);
  console.log("Total interactive elements:", observation.totalElements);
  console.log("Actionable elements:", observation.actionableElements.length);

  console.log("\n========== ACTION CATALOG ==========");

  for (const element of observation.actionableElements) {
    console.log(
      `[${element.id}] ${element.tag} | ${element.label || "(unlabeled)"} | editable=${element.editable}`
    );
  }

  if (observation.actionableElements.length === 0) {
    throw new Error("No actionable elements detected.");
  }

  console.log("\nObserver verification: PASSED");
} catch (error) {
  console.error("Observer test failed:", error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
