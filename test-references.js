import { chromium } from "playwright";
import {
  observePage,
  resolveElement
} from "./src/observer/dom-observer.js";

const browser = await chromium.launch({ headless: false });

try {
  const page = await browser.newPage();

  await page.goto("https://www.wikipedia.org/", {
    waitUntil: "domcontentloaded"
  });

  const observation = await observePage(page);

  console.log("\n========== ACTION CATALOG ==========");

  for (const element of observation.actionableElements) {
    console.log(
      `${element.ref} | ${element.tag} | ${element.label || "(unlabeled)"}`
    );
  }

  const search = observation.actionableElements.find(
    element =>
      element.tag === "input" &&
      element.editable
  );

  if (!search) {
    throw new Error("Search input not found.");
  }

  const handle = await resolveElement(page, search.ref);

  await handle.fill("Alan Turing");

  const actualValue = await handle.inputValue();

  if (actualValue !== "Alan Turing") {
    throw new Error("Input verification failed.");
  }

  console.log("\n========== REFERENCE VERIFICATION ==========");
  console.log("Resolved:", search.ref);
  console.log("Filled:", actualValue);
  console.log("Verification: PASSED");

} catch (error) {
  console.error("Test failed:", error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
