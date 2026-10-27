import assert from "node:assert/strict";
import { extractDesiredState } from
  "../../src/agent/intent-extractor.js";

function observation(name = "", environment = "staging", checked = false) {
  return {
    actionableElements: [
      {
        ref: "e1",
        label: "Workspace Name",
        tag: "input",
        type: "text",
        editable: true,
        currentValue: name
      },
      {
        ref: "e2",
        label: "Deployment Environment",
        tag: "select",
        type: "select-one",
        currentValue: environment,
        options: [
          { value: "staging", label: "Staging" },
          { value: "production", label: "Production" }
        ]
      },
      {
        ref: "e3",
        label: "Email Notifications",
        tag: "input",
        type: "checkbox",
        checked
      },
      {
        ref: "e4",
        label: "Delete Workspace Permanently",
        tag: "button",
        type: "button",
        editable: false
      }
    ]
  };
}

const instruction =
  "Configure the workspace named Atlas Research for production deployment, " +
  "enable email notifications, and save the settings. Do not delete anything.";

async function run(name, fn) {
  const start = Date.now();

  try {
    await fn();
    console.log(`PASS: ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    throw error;
  }
}

await run("Extract initial intent", async () => {
  const result = await extractDesiredState(
    instruction,
    observation()
  );

  assert.deepEqual(
    result.requirements.find(r => r.label === "Workspace Name"),
    {
      label: "Workspace Name",
      kind: "text",
      value: "Atlas Research"
    }
  );

  assert.equal(
    result.requirements.find(
      r => r.label === "Deployment Environment"
    )?.value,
    "production"
  );

  assert.equal(
    result.requirements.find(
      r => r.label === "Email Notifications"
    )?.value,
    true
  );

  assert.equal(result.reconciliation.pending.length, 3);
});

await run("Interpret explicit validation correction", async () => {
  const result = await extractDesiredState(
    instruction,
    observation("Atlas Research", "production", true),
    "Validation error: Workspace name must start with LAB-. " +
    "Please correct the workspace name and save again."
  );

  assert.equal(
    result.requirements.find(
      r => r.label === "Workspace Name"
    )?.value,
    "LAB-Atlas Research"
  );

  assert.equal(result.reconciliation.pending.length, 1);
  assert.equal(result.reconciliation.pending[0].ref, "e1");
});

await run("Recognize already satisfied form", async () => {
  const result = await extractDesiredState(
    instruction,
    observation("LAB-Atlas Research", "production", true),
    "Validation error: Workspace name must start with LAB-."
  );

  assert.equal(result.reconciliation.pending.length, 0);
  assert.equal(result.reconciliation.allSatisfied, true);
});

console.log("\nPASS: Intent extraction (3/3)");
