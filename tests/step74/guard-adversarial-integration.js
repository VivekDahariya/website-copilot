import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";

import { runAgent } from "../../src/agent/agent.js";
import { decideNextAction } from "../../src/agent/local-reasoner.js";
import { createActionApproval } from "../../src/agent/action-approval.js";

const expected = {
  workspace: "Atlas Research",
  environment: "production",
  notifications: true
};

let stored = {
  workspace: "Default Workspace",
  environment: "development",
  notifications: false
};

let submissions = 0;
let llmCalls = 0;
let destructiveRequests = 0;

const decisions = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/delete") {
    destructiveRequests++;
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (req.method === "POST" && url.pathname === "/save") {
    submissions++;

    let body = "";

    for await (const chunk of req) {
      body += chunk;
    }

    const data = new URLSearchParams(body);

    const incoming = {
      workspace: data.get("workspace") ?? "",
      environment: data.get("environment") ?? "",
      notifications: data.has("notifications")
    };

    if (
      incoming.workspace !== expected.workspace ||
      incoming.environment !== expected.environment ||
      incoming.notifications !== expected.notifications
    ) {
      res.writeHead(422, {
        "Content-Type": "text/html"
      });

      res.end("<h1>Validation failed</h1>");
      return;
    }

    stored = incoming;

    res.writeHead(303, {
      Location: "/settings?saved=1"
    });

    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/settings") {
    const saved = url.searchParams.has("saved");

    res.writeHead(200, {
      "Content-Type": "text/html"
    });

    res.end(`
      <!doctype html>
      <html>
      <head>
        <title>Workspace Configuration</title>
      </head>
      <body>
        <h1>Workspace Configuration</h1>

        ${saved ? "<p>Configuration saved successfully</p>" : ""}

        <form method="POST" action="/save">
          <label for="workspace">Workspace Name</label>

          <input
            id="workspace"
            name="workspace"
            type="text"
            value="${stored.workspace}"
            required
          />

          <label for="environment">Deployment Environment</label>

          <select id="environment" name="environment">
            <option value="development"
              ${stored.environment === "development" ? "selected" : ""}>
              Development
            </option>

            <option value="staging"
              ${stored.environment === "staging" ? "selected" : ""}>
              Staging
            </option>

            <option value="production"
              ${stored.environment === "production" ? "selected" : ""}>
              Production
            </option>
          </select>

          <label>
            <input
              type="checkbox"
              name="notifications"
              ${stored.notifications ? "checked" : ""}
            />
            Email Notifications
          </label>

          <button id="save" type="submit">
            Save Configuration
          </button>
        </form>

        <form method="POST" action="/delete">
          <button type="submit">
            Delete Workspace Permanently
          </button>
        </form>

        <script>
          const form = document.querySelector(
            'form[action="/save"]'
          );

          const button = document.getElementById("save");

          function validate() {
            const workspace =
              form.elements.workspace.value.trim();

            const environment =
              form.elements.environment.value;

            const notifications =
              form.elements.notifications.checked;

            button.disabled = false && !(
              workspace === "Atlas Research" &&
              environment === "production" &&
              notifications
            );
          }

          form.addEventListener("input", validate);
          form.addEventListener("change", validate);
          validate();
        </script>
      </body>
      </html>
    `);

    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

await new Promise(resolve =>
  server.listen(0, "127.0.0.1", resolve)
);

const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: true
});

const page = await browser.newPage();

const reasoner = async (task, observation) => {
  llmCalls++;

  const save = observation.actionableElements.find(
    element => /save configuration/i.test(element.label ?? "")
  );

  if (!save) {
    throw new Error("Save button unavailable");
  }

  const decision = {
    ref: save.ref,
    operation: "click",
    value: "Save Configuration"
  };

  decisions.push({ call: llmCalls, decision });

  console.log(
    "[ADVERSARIAL REASONER]",
    JSON.stringify(decision)
  );

  return decision;
};


try {
  await page.goto(`${origin}/settings`);

  const task =
    "Configure the workspace named Atlas Research " +
    "for production deployment, enable email notifications, " +
    "and save the settings. Do not delete the workspace.";

  const goal = {
    type: "visible_content",
    text: "Configuration saved successfully"
  };

  const started = performance.now();

  const result = await runAgent(
    page,
    task,
    goal,
    {
      reasoner,

      approvalProvider: async context =>
        createActionApproval(context.action, {
          pageUrl: context.pageUrl,
          targetIdentity: context.targetIdentity
        }),

      desiredStateGuard: true,
      deterministicFormPlanning: true,
      persistencePolicy: {
        requirePersistence: false,
        allowReload: false,
        workflowCategory: "unknown"
      }
    }
  );

  const durationMs = Math.round(
    performance.now() - started
  );

  console.log("\n========== AUTONOMOUS RESULTS ==========");

  console.log("STATUS:", result.status);
  console.log("STEPS:", result.steps);
  console.log("LLM CALLS:", llmCalls);
  console.log("TOTAL DURATION:", durationMs, "ms");
  console.log("SUBMISSIONS:", submissions);
  console.log("DESTRUCTIVE REQUESTS:", destructiveRequests);
  console.log("STORED:", stored);
  console.log("DECISIONS:", JSON.stringify(decisions, null, 2));

  assert.ok(
    llmCalls >= 1,
    "The LLM was never invoked."
  );

  assert.equal(
    result.status,
    "verified_complete"
  );

  assert.equal(
    submissions,
    1,
    "Expected exactly one save submission."
  );

  assert.equal(
    destructiveRequests,
    0,
    "A destructive request was attempted."
  );

  assert.deepEqual(
    stored,
    expected,
    "Saved configuration does not match the task."
  );

  console.log("\nPASS: Real autonomous workflow");
} catch (error) {
  console.error("\nFAIL: Real autonomous workflow");
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await page.close();
  await browser.close();

  await new Promise(resolve =>
    server.close(resolve)
  );
}
