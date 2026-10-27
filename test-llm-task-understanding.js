import assert from "node:assert/strict";

import {
  interpretTask
} from "./src/agent/task-interpreter.js";

const cases = [
  {
    name: "Paraphrased product comparison",
    instruction:
      "At https://books.toscrape.com/ I want to know " +
      "which of the first four Mystery books costs the least.",
    expected: {
      status: "interpreted",
      type: "product_comparison",
      category: "Mystery",
      limit: 4
    }
  },
  {
    name: "Alternative category",
    instruction:
      "Look through https://books.toscrape.com/ and " +
      "figure out the lowest-priced option among " +
      "five Science Fiction books.",
    expected: {
      status: "interpreted",
      type: "product_comparison",
      category: "Science Fiction",
      limit: 5
    }
  },
  {
    name: "Form filling",
    instruction:
      "On the current page, enter Vivek into the " +
      "field labelled Full Name.",
    expected: {
      status: "interpreted",
      type: "browser_goal",
      goalType: "form_state",
      fieldLabel: "Full Name",
      expectedValue: "Vivek"
    }
  },
  {
    name: "Missing website",
    instruction:
      "Find the cheapest among four Travel products.",
    expected: {
      status: "needs_clarification"
    }
  },
  {
    name: "Missing category",
    instruction:
      "Visit https://books.toscrape.com/ and compare " +
      "three products from a category I haven't chosen yet.",
    expected: {
      status: "needs_clarification"
    }
  }
];

let passed = 0;
let failed = 0;

for (const testCase of cases) {
  console.log(`\nTEST — ${testCase.name}`);

  try {
    const result = await interpretTask(
      testCase.instruction
    );

    console.log(
      JSON.stringify(result, null, 2)
    );

    assert.equal(
      result.status,
      testCase.expected.status
    );

    if (result.status === "interpreted") {
      assert.equal(
        result.task.type,
        testCase.expected.type
      );

      if (result.task.type === "product_comparison") {
        assert.equal(
          result.task.category,
          testCase.expected.category
        );

        assert.equal(
          result.task.limit,
          testCase.expected.limit
        );
      }

      if (result.task.type === "browser_goal") {
        assert.equal(
          result.task.startUrl,
          undefined,
          "Model invented a URL for the current page."
        );

        assert.equal(
          result.task.goal.type,
          testCase.expected.goalType
        );

        assert.equal(
          result.task.goal.fieldLabel,
          testCase.expected.fieldLabel
        );

        assert.equal(
          result.task.goal.expectedValue,
          testCase.expected.expectedValue
        );
      }
    }

    console.log("PASSED");
    passed++;
  } catch (error) {
    console.log("FAILED:", error.message);
    failed++;
  }
}

console.log("\n=== LLM TASK UNDERSTANDING ===");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${cases.length}`);

if (failed > 0) {
  process.exitCode = 1;
}
