import { chromium } from "playwright";
import { observePage } from "./src/observer/dom-observer.js";
import { verifyGoal } from "./src/agent/goal-verifier.js";

const browser = await chromium.launch({
  headless: true
});

try {
  const page = await browser.newPage();

  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Secret Phrase</title>
      </head>
      <body>
        <h1>Search</h1>
        <label for="query">Search query</label>
        <input
          id="query"
          type="text"
          value="Secret Phrase"
        >
        <button>Search</button>
      </body>
    </html>
  `);

  const observation = await observePage(page);

  const result = verifyGoal(observation, {
    type: "visible_content",
    text: "Secret Phrase"
  });

  console.log("Visible-content result:", result);

  if (result.completed) {
    throw new Error(
      "FALSE POSITIVE: Input value counted as page content."
    );
  }

  console.log("FALSE-POSITIVE REGRESSION: PASSED");

} finally {
  await browser.close();
}
