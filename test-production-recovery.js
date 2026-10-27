import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runAgent } from "./src/agent/agent.js";

import {
  observeReliably
} from "./src/observer/reliable-observer.js";

import {
  observePage
} from "./src/observer/dom-observer.js";

const browser = await chromium.launch({
  headless: true
});

try {
  // ============================================================
  // SCENARIO A: Delayed content must recover without AI actions.
  // ============================================================

  console.log("\n========== SCENARIO A ==========");

  const pageA = await browser.newPage();

  await pageA.goto("about:blank");

  await pageA.setContent(`
    <html>
      <head>
        <title>Delayed Content Test</title>
      </head>
      <body>
        <script>
          setTimeout(() => {
            document.body.insertAdjacentHTML(
              "beforeend",
              "<h1>Recovered Content</h1>"
            );
          }, 400);
        </script>
      </body>
    </html>
  `);

  const goalA = {
    type: "visible_content",
    text: "Recovered Content"
  };

  let observationCalls = 0;
  let reasonerCalls = 0;

  const resultA = await runAgent(
    pageA,
    "Find Recovered Content on this page.",
    goalA,
    {
      observer: async page => {
        const result = await observeReliably(
          page,
          {
            maxAttempts: 5,
            retryDelayMs: 200,
            observer: async page => {
              observationCalls++;
              return observePage(page);
            }
          }
        );

        return result;
      },

      reasoner: async () => {
        reasonerCalls++;

        throw new Error(
          "AI must not be called for current-page verification."
        );
      }
    }
  );

  assert.equal(resultA.status, "verified_complete");
  assert.equal(resultA.steps, 0);
  assert.equal(reasonerCalls, 0);
  assert.ok(
    observationCalls >= 2,
    "Expected observation recovery to retry."
  );

  console.log("SCENARIO A: PASSED");
  console.log("Observation calls:", observationCalls);

  await pageA.close();

  // ============================================================
  // SCENARIO B: Navigation cycles must be rejected by runAgent.
  // ============================================================

  console.log("\n========== SCENARIO B ==========");

  const pageB = await browser.newPage();

  await pageB.route("https://cycle.test/**", async route => {
    const pathname = new URL(route.request().url()).pathname;

    const html = pathname === "/a"
      ? `
        <html>
          <head><title>Page A</title></head>
          <body>
            <h1>Page A</h1>
            <a href="/b">Go to B</a>
          </body>
        </html>
      `
      : `
        <html>
          <head><title>Page B</title></head>
          <body>
            <h1>Page B</h1>
            <a href="/a">Go to A</a>
          </body>
        </html>
      `;

    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: html
    });
  });

  await pageB.goto("https://cycle.test/a");

  let decisionCalls = 0;

  const controlledReasoner = async (
    task,
    observation
  ) => {
    decisionCalls++;

    const element = observation.actionableElements[0];

    if (!element) {
      throw new Error("No action available.");
    }

    return {
      ref: element.ref,
      operation: "click",
      value: ""
    };
  };

  const resultB = await runAgent(
    pageB,
    "Navigate to a page containing the target phrase.",
    {
      type: "visible_content",
      text: "Target phrase that does not exist"
    },
    {
      reasoner: controlledReasoner
    }
  );

  assert.equal(resultB.status, "planning_stagnation");
  assert.equal(resultB.steps, 2);
  assert.equal(
    new URL(resultB.finalUrl).pathname,
    "/a"
  );

  assert.ok(
    decisionCalls >= 2,
    "Expected the AI to be asked to replan."
  );

  console.log("SCENARIO B: PASSED");
  console.log("Reasoner calls:", decisionCalls);

  await pageB.close();

  console.log(
    "\nPRODUCTION RECOVERY TESTS: 2/2 PASSED"
  );

} finally {
  await browser.close();
}
