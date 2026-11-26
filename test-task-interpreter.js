import assert from "node:assert/strict";

import {
  interpretTask
} from "./src/agent/task-interpreter.js";

console.log("\nTEST 1 — Real local LLM interpretation");

const result = await interpretTask(
  "Visit https://books.toscrape.com/, compare " +
  "3 Travel products, and find the cheapest."
);

console.log(JSON.stringify(result, null, 2));

assert.equal(result.status, "interpreted");
assert.equal(result.task.type, "product_comparison");
assert.equal(
  result.task.startUrl,
  "https://books.toscrape.com/"
);
assert.equal(result.task.category, "Travel");
assert.equal(result.task.limit, 3);

console.log("TEST 1: PASSED");

console.log("\nTEST 2 — Reject unsafe protocol");

const mockFetch = async () => ({
  ok: true,
  json: async () => ({
    response: JSON.stringify({
      type: "product_comparison",
      startUrl: "javascript:alert(1)",
      category: "Travel",
      limit: 3
    })
  })
});

// An unsafe URL is never accepted or navigated to. With no grounded URL in
// the instruction the interpreter asks for clarification instead of throwing.
const unsafe = await interpretTask(
  "Compare products",
  { fetchImpl: mockFetch }
);

assert.equal(unsafe.status, "needs_clarification");
assert.equal(unsafe.task, undefined);
assert.equal(JSON.stringify(unsafe).includes("javascript:"), false);

// When the user did supply a real URL, a model-supplied unsafe URL cannot
// replace it.
const grounded = await interpretTask(
  "Open https://shop.example/ and compare 3 Travel products",
  { fetchImpl: mockFetch }
);

assert.equal(grounded.status, "interpreted");
assert.equal(grounded.task.startUrl, "https://shop.example/");

console.log("TEST 2: PASSED");

console.log("\nTEST 3 — Missing information");

const clarificationFetch = async () => ({
  ok: true,
  json: async () => ({
    response: JSON.stringify({
      type: "unsupported",
      reason: "Website URL is missing."
    })
  })
});

const clarification = await interpretTask(
  "Compare some products",
  { fetchImpl: clarificationFetch }
);

assert.equal(
  clarification.status,
  "needs_clarification"
);

console.log("TEST 3: PASSED");

console.log("\nTASK INTERPRETER: 3/3 PASSED");
