
import assert from "node:assert/strict";
import { verifyPersistence } from "../../src/agent/persistence-verifier.js";

const goal = {
  type: "form_state",
  fieldLabel: "Project Name",
  expectedValue: "Website CoPilot"
};

function makeFixture({
  fields = [],
  redirect = false,
  observerStatus = "ready"
} = {}) {
  let reloads = 0;

  const page = {
    url() {
      return redirect && reloads > 0
        ? "https://example.test/other"
        : "https://example.test/settings";
    },

    async reload() {
      reloads++;
    }
  };

  const observer = async () => ({
    status: observerStatus,
    observation: {
      url: page.url(),
      actionableElements: fields,
      visibleBodyText: "Project Settings"
    }
  });

  return {
    page,
    observer,
    get reloads() {
      return reloads;
    }
  };
}

function projectField(value) {
  return {
    ref: "project",
    tag: "input",
    type: "text",
    label: "Project Name",
    editable: true,
    currentValue: value
  };
}

async function check(name, fixture, options, expectedStatus, expectedReloads) {
  const result = await verifyPersistence({
    page: fixture.page,
    goal,
    observer: fixture.observer,
    ...options
  });

  assert.equal(result.status, expectedStatus, name);
  assert.equal(fixture.reloads, expectedReloads, `${name}: reload count`);

  console.log("PASS:", name, "=>", result.status);
}

await check(
  "Unauthorized reload",
  makeFixture({ fields: [projectField("Website CoPilot")] }),
  { allowReload: false, workflowCategory: "repeatable_settings" },
  "persistence_unverified",
  0
);

await check(
  "Unknown workflow category",
  makeFixture({ fields: [projectField("Website CoPilot")] }),
  { allowReload: true },
  "persistence_unverified",
  0
);

await check(
  "Unsafe workflow category",
  makeFixture({ fields: [projectField("Website CoPilot")] }),
  { allowReload: true, workflowCategory: "payment" },
  "persistence_unverified",
  0
);

await check(
  "Missing field",
  makeFixture(),
  { allowReload: true, workflowCategory: "repeatable_settings" },
  "persistence_unverified",
  1
);

await check(
  "Redirect after reload",
  makeFixture({
    fields: [projectField("Website CoPilot")],
    redirect: true
  }),
  { allowReload: true, workflowCategory: "repeatable_settings" },
  "persistence_unverified",
  1
);

await check(
  "Unavailable observation",
  makeFixture({
    fields: [projectField("Website CoPilot")],
    observerStatus: "unavailable"
  }),
  { allowReload: true, workflowCategory: "repeatable_settings" },
  "persistence_unverified",
  1
);

await check(
  "Persisted value",
  makeFixture({ fields: [projectField("Website CoPilot")] }),
  { allowReload: true, workflowCategory: "repeatable_settings" },
  "persisted_verified",
  1
);

await check(
  "Conflicting persisted value",
  makeFixture({ fields: [projectField("Original")] }),
  { allowReload: true, workflowCategory: "repeatable_settings" },
  "persistence_failed",
  1
);

console.log("STEP 74E — PERSISTENCE SAFETY TESTS PASSED");
