import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";

import { runAgent } from "../../src/agent/agent.js";
import { observeReliably } from "../../src/observer/reliable-observer.js";
import { createActionApproval } from "../../src/agent/action-approval.js";

const expected = {
  projectName: "Website CoPilot",
  environment: "production",
  notifications: true
};

let stored = {
  projectName: "Original Project",
  environment: "development",
  notifications: false
};

let submissions = 0;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/save") {
    submissions++;

    let body = "";
    for await (const chunk of req) body += chunk;

    const data = new URLSearchParams(body);

    const incoming = {
      projectName: data.get("projectName") ?? "",
      environment: data.get("environment") ?? "",
      notifications: data.has("notifications")
    };

    if (
      !incoming.projectName ||
      incoming.environment !== "production" ||
      !incoming.notifications
    ) {
      res.writeHead(422, {
        "Content-Type": "text/html"
      });
      res.end("<h1>Validation failed</h1>");
      return;
    }

    stored = incoming;

    res.writeHead(303, {
      Location: "/settings?updated=1"
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/settings") {
    const updated = url.searchParams.has("updated");

    res.writeHead(200, {
      "Content-Type": "text/html"
    });

    res.end(`
      <!doctype html>
      <html>
        <head><title>Project Settings</title></head>
        <body>
          <h1>Project Settings</h1>

          ${
            updated
              ? "<p>Preferences saved successfully</p>"
              : ""
          }

          <form method="post" action="/save">
            <label for="project">Project Name</label>
            <input
              id="project"
              name="projectName"
              required
              value="${stored.projectName}"
            />

            <label for="environment">Environment</label>
            <select
              id="environment"
              name="environment"
              required
            >
              <option value="development"
                ${stored.environment === "development" ? "selected" : ""}>
                Development
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
              Enable Notifications
            </label>

            <button
              id="submit"
              type="submit"
              disabled
            >
              Save Preferences
            </button>
          </form>

          <script>
            const form = document.querySelector("form");
            const button = document.getElementById("submit");

            function validate() {
              const name = form.elements.projectName.value.trim();
              const environment = form.elements.environment.value;
              const notifications = form.elements.notifications.checked;

              button.disabled = !(
                name &&
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
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.goto(`${origin}/settings`);

  const goal = {
    type: "all_of",
    conditions: [
      {
        type: "form_state",
        fieldLabel: "Project Name",
        expectedValue: expected.projectName
      },
      {
        type: "visible_content",
        text: "Preferences saved successfully"
      }
    ]
  };

  const reasoner = async (task, observation) => {
    const elements = observation.actionableElements;

    const project = elements.find(element =>
      /project name/i.test(element.label)
    );

    if (project?.currentValue !== expected.projectName) {
      return {
        ref: project.ref,
        operation: "fill",
        value: expected.projectName
      };
    }

    const environment = elements.find(element =>
      /environment/i.test(element.label)
    );

    if (
      environment &&
      environment.currentValue !== expected.environment
    ) {
      return {
        ref: environment.ref,
        operation: "select",
        value: expected.environment
      };
    }

    const notifications = elements.find(element =>
      /enable notifications/i.test(element.label)
    );

    if (
      notifications &&
      !notifications.checked
    ) {
      return {
        ref: notifications.ref,
        operation: "check"
      };
    }

    const submit = elements.find(element =>
      /save preferences/i.test(element.label)
    );

    if (submit) {
      return {
        ref: submit.ref,
        operation: "click"
      };
    }

    throw new Error("No suitable action.");
  };

  const result = await runAgent(
    page,
    "Configure the project for production, enable notifications, and save.",
    goal,
    {
      reasoner,
      observer: observeReliably,

      approvalProvider: async context =>
        createActionApproval(context.action, {
          pageUrl: context.pageUrl,
          targetIdentity: context.targetIdentity
        }),

      persistencePolicy: {
        requirePersistence: true,
        allowReload: true,
        workflowCategory: "repeatable_settings"
      }
    }
  );

  console.log("STATUS:", result.status);
  console.log("SUBMISSIONS:", submissions);
  console.log("STORED:", stored);

  assert.equal(result.status, "persisted_complete");
  assert.equal(submissions, 1);
  assert.deepEqual(stored, expected);

  console.log("PASS: Complex form workflow");
} catch (error) {
  console.error("FAIL: Complex form workflow");
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await page.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
