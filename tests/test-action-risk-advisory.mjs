import assert from "node:assert/strict";
import { decideNextAction } from "../src/agent/local-reasoner.js";
import { authorizeBrowserAction } from "../src/agent/action-safety-policy.js";

const oldFetch = globalThis.fetch;
const oldFlag = process.env.COPILOT_ACTION_RISK_V2;
const oldSearch = process.env.COPILOT_DETERMINISTIC_SEARCH;

delete process.env.COPILOT_DETERMINISTIC_SEARCH;

const observation = {
  url: "https://example.test/",
  title: "Example",
  headings: ["Example"],
  visibleBodyText: "Find an article about Grace Hopper",
  actionableElements: [
    {
      ref: "e1",
      tag: "input",
      type: "search",
      label: "Search",
      editable: true,
      currentValue: "",
      options: []
    }
  ]
};

const action = {
  ref: "e1",
  operation: "fill",
  value: "Grace Hopper"
};

async function run(advisoryMode, modelReply) {
  if (advisoryMode) {
    process.env.COPILOT_ACTION_RISK_V2 = "1";
  } else {
    // These safeguards are on by default; "0" is the explicit way to turn one off.
    process.env.COPILOT_ACTION_RISK_V2 = "0";
  }

  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);

    if (advisoryMode) {
      assert.ok(body.format.required.includes("riskAdvisory"));
      assert.match(body.messages[0].content, /riskAdvisory/);
    } else {
      assert.deepEqual(
        body.format.required,
        ["ref", "operation", "value"]
      );
      assert.equal(
        Object.hasOwn(body.format.properties, "riskAdvisory"),
        false
      );
    }

    return {
      ok: true,
      json: async () => ({
        message: { content: JSON.stringify(modelReply) }
      })
    };
  };

  const decision = await decideNextAction(
    "Find Grace Hopper",
    observation,
    [],
    [],
    { type: "page_destination", heading: "Grace Hopper" },
    { completed: false }
  );

  assert.equal(calls, 1);
  return decision;
}

try {
  const legacy = await run(false, action);
  assert.deepEqual(legacy, action);
  console.log("PASS: Default three-field action is unchanged");

  const harmless = await run(true, {
    ...action,
    riskAdvisory: {
      level: "harmless",
      rationale: "Typing into a search field"
    }
  });

  assert.deepEqual(harmless, action);
  assert.equal(harmless.riskAdvisory.level, "harmless");
  assert.equal(
    Object.keys(harmless).includes("riskAdvisory"),
    false
  );
  console.log("PASS: AI risk is attached without changing action shape");

  const invalid = await run(true, {
    ...action,
    riskAdvisory: {
      level: "definitely-safe",
      rationale: "Trust this website"
    }
  });
  assert.equal(invalid.riskAdvisory.level, "uncertain");
  console.log("PASS: Invalid risk is normalized to uncertain");

  const deleteAction = {
    ref: "e7",
    operation: "click",
    value: "",
    riskAdvisory: {
      level: "harmless",
      rationale: "AI says it is safe"
    }
  };

  const safety = authorizeBrowserAction(
    deleteAction,
    { tag: "button", label: "Delete account" }
  );
  assert.equal(safety.allowed, false);
  console.log("PASS: AI harmless label cannot authorize deletion");
} finally {
  globalThis.fetch = oldFetch;

  if (oldFlag === undefined)
    delete process.env.COPILOT_ACTION_RISK_V2;
  else
    process.env.COPILOT_ACTION_RISK_V2 = oldFlag;

  if (oldSearch === undefined)
    delete process.env.COPILOT_DETERMINISTIC_SEARCH;
  else
    process.env.COPILOT_DETERMINISTIC_SEARCH = oldSearch;
}
