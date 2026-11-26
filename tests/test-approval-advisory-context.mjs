import assert from 'node:assert/strict';
import { buildApprovalAdvisoryContext } from '../src/agent/approval-advisory-context.js';

const result = buildApprovalAdvisoryContext({
  instruction: "Find the article, then press Search.",
  pageTitle: "Example page",
  safetyReason: "Keyboard action may submit a form.",
  history: [{
    targetLabel: "Search",
    decision: {
      operation: "fill",
      value: "PRIVATE_TEST_VALUE"
    },
    execution: {
      executionCompleted: true,
      verified: true
    }
  }]
});

assert.match(result.task, /Find the article/);
assert.equal(result.recentActions.length, 1);
assert.equal(result.recentActions[0].operation, "fill");
assert.equal(result.recentActions[0].outcome, "verified");
assert.match(result.safetyReason, /submit a form/);
assert.ok(!JSON.stringify(result).includes("PRIVATE_TEST_VALUE"));

const sensitive = buildApprovalAdvisoryContext({
  instruction: "Enter password ABC123."
});
assert.equal(sensitive.task, "[Sensitive task text withheld]");

assert.deepEqual(
  buildApprovalAdvisoryContext({ history: null }).recentActions,
  []
);

console.log("PASS: Approval context uses task, action history and safety reason without exposing input values");
console.log("PASS: Sensitive task text withheld; empty history handled safely");
