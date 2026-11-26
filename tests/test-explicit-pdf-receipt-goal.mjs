import assert from "node:assert/strict";

import {
  createExplicitPdfReceiptGoal
} from "../src/agent/natural-language-executor.js";

import {
  validateGoalSchema
} from "../src/agent/goal-schema-validator.js";

import {
  validateTaskContract
} from "../src/agent/task-contract.js";

import {
  verifyGoal
} from "../src/agent/goal-verifier.js";

const instruction =
  'Find the PDF link described as "Forced download, never opens in the viewer". ' +
  'Click it to download the PDF. Verify from available browser download ' +
  'evidence that the PDF was successfully downloaded, including its filename. ' +
  'Do not download any other files or visit unrelated websites. ' +
  'If the download cannot be verified, report that explicitly.';

const goal = createExplicitPdfReceiptGoal(instruction);

assert.deepEqual(goal, { type: "download_receipt" });

assert.deepEqual(
  validateGoalSchema(goal),
  goal
);

validateTaskContract({
  type: "browser_goal",
  instruction,
  goal
});

console.log("PASS: Explicit download receives a valid receipt goal");

const premature = verifyGoal({
  title: "PDF Download",
  url: "https://example.org/sample.pdf",
  text: "Forced download, never opens in the viewer",
  actionableElements: [{
    tag: "a",
    label: "Forced download",
    href: "https://example.org/sample.pdf"
  }]
}, goal);

assert.equal(
  premature.completed,
  false,
  "Visible PDF evidence must not complete a download"
);

console.log("PASS: Visible link cannot establish download success");

assert.equal(
  createExplicitPdfReceiptGoal(
    "Do not download the PDF. Just explain what it contains."
  ),
  null
);

assert.equal(
  createExplicitPdfReceiptGoal(
    "Find a PDF link, but do not download anything."
  ),
  null
);

console.log("PASS: Prohibited downloads cannot activate receipt routing");

assert.equal(
  createExplicitPdfReceiptGoal(
    "Use Wikipedia to find Grace Hopper and explain her work."
  ),
  null
);

assert.equal(
  createExplicitPdfReceiptGoal(
    "Click Here to open a new tab, then switch back."
  ),
  null
);

console.log("PASS: Reading and tab workflows remain outside PDF routing");

assert.throws(
  () => validateGoalSchema({
    type: "download_receipt",
    expectedValue: "sample.pdf"
  }),
  /Unexpected field/
);

console.log("PASS: Receipt goal rejects invented fields");
