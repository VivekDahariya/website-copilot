import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  executeNaturalLanguageTask
} from "./src/agent/natural-language-executor.js";

const browser = await chromium.launch({
  headless: true
});

const page = await browser.newPage();

try {
  console.log(
    "\nTEST 1 — Natural-language product comparison"
  );

  const instruction =
    "Visit https://books.toscrape.com/, " +
    "compare 3 Travel products, " +
    "and find the cheapest.";

  const result = await executeNaturalLanguageTask(
    page,
    instruction
  );

  console.log(
    "\nUNIFIED EXECUTION RESULT"
  );

  console.log(
    JSON.stringify(
      {
        status: result.status,
        interpretedTask: result.interpretedTask,
        collected: result.execution.result.collected,
        cheapest: result.execution.result.cheapest
      },
      null,
      2
    )
  );

  assert.equal(
    result.status,
    "verified_complete"
  );

  assert.equal(
    result.interpretedTask.type,
    "product_comparison"
  );

  assert.equal(
    result.execution.result.collected,
    3
  );

  assert.equal(
    result.execution.result.cheapest.title,
    "It's Only the Himalayas"
  );

  console.log("TEST 1: PASSED");

  console.log(
    "\nTEST 2 — Clarification prevents execution"
  );

  const clarificationFetch = async () => ({
    ok: true,
    json: async () => ({
      response: JSON.stringify({
        type: "unsupported",
        reason: "Website URL is missing."
      })
    })
  });

  const beforeUrl = page.url();

  const clarification = await executeNaturalLanguageTask(
    page,
    "Compare some products",
    {
      interpreterOptions: {
        fetchImpl: clarificationFetch
      }
    }
  );

  assert.equal(
    clarification.status,
    "needs_clarification"
  );

  assert.equal(
    clarification.executed,
    false
  );

  assert.equal(
    page.url(),
    beforeUrl
  );

  console.log("TEST 2: PASSED");

  console.log(
    "\nNATURAL-LANGUAGE EXECUTOR: 2/2 PASSED"
  );
} finally {
  await browser.close();
}
