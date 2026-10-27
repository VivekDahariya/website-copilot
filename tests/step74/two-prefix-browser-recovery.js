import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";

import { runAgent } from "../../src/agent/agent.js";
import { decideNextAction } from "../../src/agent/local-reasoner.js";
import { createActionApproval } from "../../src/agent/action-approval.js";

const expected = {
  workspace: "LAB-Atlas Research",
  projectCode: "PRJ-ABC",
  environment: "production",
  notifications: true
};

let stored = null;
let rejectedSubmissions = 0;
let successfulSubmissions = 0;
let llmCalls = 0;

const decisions = [];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderForm(values, error = "") {
  return `
    <!doctype html>
    <html>
    <head>
      <title>Research Workspace Settings</title>
    </head>
    <body>
      <h1>Research Workspace Settings</h1>

      ${error ? `<p role="alert">${escapeHtml(error)}</p>` : ""}

      <form method="POST" action="/save">
        <label for="workspace">Workspace Name</label>
        <input
          id="workspace"
          name="workspace"
          required
          value="${escapeHtml(values.workspace)}"
        />

        <label for="projectCode">Project Code</label>
        <input
          id="projectCode"
          name="projectCode"
          required
          value="${escapeHtml(values.projectCode ?? "ABC")}"
        />

        <label for="environment">Deployment Environment</label>
        <select id="environment" name="environment">
          <option value="development"
            ${values.environment === "development" ? "selected" : ""}>
            Development
          </option>
          <option value="production"
            ${values.environment === "production" ? "selected" : ""}>
            Production
          </option>
        </select>

        <label>
          <input
            type="checkbox"
            name="notifications"
            ${values.notifications ? "checked" : ""}
          />
          Email Notifications
        </label>

        <button type="submit">Save Configuration</button>
      </form>
    </body>
    </html>
  `;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/settings") {
    res.writeHead(200, {
      "Content-Type": "text/html"
    });

    if (stored) {
      res.end(`
        <!doctype html>
        <html>
        <head><title>Workspace Saved</title></head>
        <body>
          <h1>Workspace Saved</h1>
          <p>Configuration saved successfully</p>
          <p>Workspace: ${escapeHtml(stored.workspace)}</p>
          <p>Environment: ${escapeHtml(stored.environment)}</p>
          <p>Notifications: ${stored.notifications ? "Enabled" : "Disabled"}</p>
        </body>
        </html>
      `);
    } else {
      res.end(renderForm({
        workspace: "Default Workspace",
        projectCode: "ABC",
        environment: "development",
        notifications: false
      }));
    }

    return;
  }

  if (req.method === "POST" && url.pathname === "/save") {
    let body = "";

    for await (const chunk of req) {
      body += chunk;
    }

    const data = new URLSearchParams(body);

    const incoming = {
      workspace: data.get("workspace") ?? "",
      projectCode: data.get("projectCode") ?? "",
      environment: data.get("environment") ?? "",
      notifications: data.has("notifications")
    };

    if (
      !incoming.workspace.startsWith("LAB-") ||
      !incoming.projectCode.startsWith("PRJ-")
    ) {
      rejectedSubmissions++;

      res.writeHead(422, {
        "Content-Type": "text/html"
      });

      const errors = [];

      if (!incoming.workspace.startsWith("LAB-")) {
        errors.push(
          "Validation error: Workspace Name must start with LAB-."
        );
      }

      if (!incoming.projectCode.startsWith("PRJ-")) {
        errors.push(
          "Validation error: Project Code must start with PRJ-."
        );
      }

      res.end(renderForm(incoming, errors.join(" ")));
      return;
    }

    if (
      incoming.environment !== "production" ||
      !incoming.notifications
    ) {
      rejectedSubmissions++;

      res.writeHead(422, {
        "Content-Type": "text/html"
      });

      res.end(renderForm(
        incoming,
        "Validation error: Production environment and email notifications are required."
      ));

      return;
    }

    stored = incoming;
    successfulSubmissions++;

    res.writeHead(303, {
      Location: "/settings"
    });

    res.end();
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

const reasoner = async (
  task,
  observation,
  history,
  rejectedActions
) => {
  llmCalls++;

  const started = performance.now();

  const decision = await decideNextAction(
    task,
    observation,
    history,
    rejectedActions
  );

  const durationMs = Math.round(
    performance.now() - started
  );

  decisions.push({
    call: llmCalls,
    decision,
    durationMs
  });

  console.log(
    `[REAL LLM ${llmCalls}]`,
    JSON.stringify(decision),
    `${durationMs}ms`
  );

  return decision;
};

try {
  await page.goto(`${origin}/settings`);

  const task =
    "Configure the research workspace named Atlas Research " +
    "for production deployment, enable email notifications, " +
    "and set Project Code to ABC, then save the settings. If the website rejects the " +
    "configuration, read its validation feedback, correct " +
    "the problem, and try again.";

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

  console.log("\n========== RECOVERY RESULTS ==========");

  console.log("STATUS:", result.status);
  console.log("STEPS:", result.steps);
  console.log("LLM CALLS:", llmCalls);
  console.log("DURATION:", Math.round(performance.now() - started), "ms");
  console.log("REJECTED SUBMISSIONS:", rejectedSubmissions);
  console.log("SUCCESSFUL SUBMISSIONS:", successfulSubmissions);
  console.log("STORED:", stored);
  console.log("DECISIONS:", JSON.stringify(decisions, null, 2));

  assert.equal(result.status, "verified_complete");

  assert.ok(
    rejectedSubmissions >= 1,
    "Expected at least one validation rejection."
  );

  assert.equal(
    successfulSubmissions,
    1,
    "Expected exactly one successful submission."
  );

  assert.deepEqual(
    stored,
    expected,
    "Agent failed to correct the configuration."
  );

  console.log("\nPASS: Two-prefix autonomous browser recovery");
} catch (error) {
  console.error("\nFAIL: Autonomous validation recovery");
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await page.close();
  await browser.close();

  await new Promise(resolve =>
    server.close(resolve)
  );
}
