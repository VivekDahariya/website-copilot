import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { observePage } from "../src/observer/dom-observer.js";
import { executeAction } from "../src/executor/action-executor.js";
import { buildApprovalAdvisoryContext } from
  "../src/agent/approval-advisory-context.js";

const context = buildApprovalAdvisoryContext({
  instruction: "Search for Grace Hopper",
  safetyReason: "Keyboard action may submit a form.",
  riskAdvisory: {
    level: "harmless",
    rationale: "Read-only search navigation"
  }
});

assert.equal(context.modelRisk.level, "harmless");
assert.match(context.modelRisk.rationale, /search navigation/);

const sensitive = buildApprovalAdvisoryContext({
  riskAdvisory: {
    level: "uncertain",
    rationale: "Use secret token ABC123"
  }
});
assert.equal(
  sensitive.modelRisk.rationale,
  "[Sensitive rationale withheld]"
);
console.log("PASS: AI risk context forwarded and sanitized");

const agentSource = readFileSync(
  new URL("../src/agent/agent.js", import.meta.url), "utf8"
);
assert.ok(agentSource.includes("!verifiedLiveSearchEnter &&"));
assert.ok(!agentSource.includes("searchEnterNeedsLiveInspection"));
assert.ok(
  agentSource.indexOf("let verifiedLiveSearchEnter = false") <
  agentSource.indexOf("const candidate = await approvalProvider")
);
console.log("PASS: Live preflight precedes human approval");

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"]
});

async function probe(name, method, target, extra, safe) {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html>
      <form method="${method}" action="${target}"
        onsubmit="window.submits=(window.submits||0)+1;event.preventDefault()">
        <input type="search" name="search" aria-label="Search">
        <button type="submit">Search</button>
        ${extra}
      </form>`);

    const observation = await observePage(page);
    const field = observation.actionableElements.find(
      element => element.type === "search"
    );
    assert.ok(field);

    const action = {
      ref: field.ref,
      operation: "press",
      value: "Enter"
    };

    if (safe) {
      const result = await executeAction(page, action, {
        preflightOnly: true
      });
      assert.equal(result.classification, "safe");
      assert.equal(result.verifiedSearchContext, true);
      assert.equal(result.sensitiveFormContext, false);
    } else {
      await assert.rejects(
        executeAction(page, action, { preflightOnly: true }),
        /SAFETY_/
      );
    }

    assert.equal(
      await page.evaluate(() => window.submits || 0),
      0,
      "Preflight must not execute the action"
    );

    console.log("PASS:", name);
  } finally {
    await page.close();
  }
}

try {
  await probe("GET search is eligible for automatic execution",
    "get", "/search", "", true);

  await probe("POST search still requires approval",
    "post", "/search", "", false);

  await probe("GET form with unrelated input requires approval",
    "get", "/search", '<input name="email">', false);

  await probe("GET form with password requires approval",
    "get", "/search", '<input type="password" name="password">', false);

  await probe("GET destructive endpoint requires approval",
    "get", "/delete", "", false);
} finally {
  await browser.close();
}
