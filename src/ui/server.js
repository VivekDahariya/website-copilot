import { getPageId } from "../agent/page-identity.js";
import { fileURLToPath } from "node:url";
import { createVerifiedDownloadRegistry } from "../agent/verified-download-registry.js";
import {
  captureRequestedPdfAndRegister
} from "../agent/approved-pdf-delivery.js";
import {
  extractVerifiedPdfResult
} from "../agent/pdf-delivery-result.js";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import {
  createAgentRunControl
} from "../agent/agent-run-control.js";

import {
  executeNaturalLanguageTask
} from "../agent/natural-language-executor.js";

import {
  createConversationalApprovalProvider
} from "../agent/conversational-approval.js";

const PORT = Number(process.env.PORT || 4317);
const HOST = "127.0.0.1";

let browser = null;
let running = false;
let pending = null;
let stopRequested = false;
let activeRunControl = null;
let activeObservedUrl = null;
let activeObservedTabId = null;
let manualActionInFlight = null;
let securePasswordHandover = null;
let securePasswordSubmissionBusy = false;

const clients = new Set();

const screenshotTickets = new Map();

const downloadDirectory = fileURLToPath(
  new URL("../../workspace/downloads/", import.meta.url)
);

const verifiedDownloadRegistry = createVerifiedDownloadRegistry({
  directory: downloadDirectory
});
const SNAPSHOT_TTL_MS = 3000;

async function snapshotPageState(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    if (!root) return null;

    let tracker = window.__copilotSnapshotTracker;

    if (!tracker || tracker.root !== root) {
      tracker?.observer?.disconnect();

      tracker = {
        root,
        revision: 0,
        observer: null
      };

      tracker.observer = new MutationObserver(() => {
        tracker.revision++;
      });

      tracker.observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });

      window.__copilotSnapshotTracker = tracker;
    }

    if (tracker.observer.takeRecords().length) {
      tracker.revision++;
    }

    return JSON.stringify({
      url: location.href,
      documentStart: performance.timeOrigin,
      revision: tracker.revision,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      width: innerWidth,
      height: innerHeight
    });
  });
}

function expireScreenshotTickets() {
  for (const [id, ticket] of screenshotTickets) {
    if (Date.now() - ticket.createdAt > SNAPSHOT_TTL_MS) {
      screenshotTickets.delete(id);
    }
  }
}



async function setRealBrowserVisibility(page, visible) {
  const session = await page.context().newCDPSession(page);

  try {
    const { windowId } = await session.send(
      "Browser.getWindowForTarget"
    );

    if (!Number.isInteger(windowId)) {
      throw new Error("Chromium window unavailable.");
    }

    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        windowState: visible ? "normal" : "minimized"
      }
    });

    if (visible) {
      await page.bringToFront();
    }

    update({
      browserVisible: visible,
      browserControlAvailable: true
    });
  } finally {
    await session.detach().catch(() => {});
  }
}

function observeActiveBrowser(browser) {
  if (!browser) return null;

  const pages = browser.contexts()
    .flatMap(context => context.pages())
    .filter(page => !page.isClosed());

  if (!pages.length) return null;

  if (activeObservedTabId) {
    return pages.find(
      page => getPageId(page) === activeObservedTabId
    ) ?? null;
  }

  // Before the first observation, only one-page selection
  // can be unambiguous.
  return pages.length === 1 ? pages[0] : null;
}



const state = {
  phase: "idle",
  browserVisible: false,
  browserControlAvailable: true,
  url: "",
  activity: [],
  pending: null,
  result: null,
  error: null
};

function publish() {
  const data = `data: ${JSON.stringify(state)}\n\n`;

  for (const client of clients) {
    try {
      client.write(data);
    } catch {
      clients.delete(client);
    }
  }
}

function update(fields) {
  Object.assign(state, fields);
  publish();
}

function activity(text) {
  state.activity.push({
    at: new Date().toLocaleTimeString(),
    text
  });

  state.activity = state.activity.slice(-60);
  publish();
}

function respond(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let raw = "";

  for await (const part of req) {
    raw += part;

    if (raw.length > 65536) {
      throw new Error("Request too large.");
    }
  }

  return JSON.parse(raw || "{}");
}

function askUser(dialog) {
  if (stopRequested) {
    return Promise.resolve({ optionId: "deny" });
  }

  if (pending) {
    throw new Error("Another user interaction is pending.");
  }

  return new Promise(resolve => {
    const id = randomUUID();

    pending = { id, resolve };

    update({
      phase: dialog.kind,
      pending: { id, ...dialog }
    });
  });
}

function observeBrowser(browserInstance) {
  const context = browserInstance.contexts()[0];

  if (!context) return null;

  const pages = context.pages().filter(page => !page.isClosed());

  return pages.at(-1) ?? null;
}

async function runTask(instruction, startUrl, maxSteps = 12) {
  running = true;
  stopRequested = false;
  activeObservedUrl = null;
  activeObservedTabId = null;
  screenshotTickets.clear();
  const control = createAgentRunControl({
    onPaused: () => {
      if (
        activeRunControl !== control ||
        !running ||
        stopRequested
      ) return;

      update({ phase: "paused" });
      activity(
        "Agent paused at a safe checkpoint. " +
        "You can now interact with Chromium manually."
      );
    }
  });
  activeRunControl = control;

  update({
    phase: "starting",
    activity: [],
    pending: null,
    result: null,
    error: null,
    url: ""
  });



  try {
    if (browser) {
      await browser.close().catch(() => {});
    }

    update({
      browserVisible: false,
      browserControlAvailable: true
    });

    browser = await chromium.launch({
      headless: process.env.COPILOT_HEADLESS === "1",
        args: ["--start-minimized"]
    });

    if (stopRequested) {
      await browser.close();
      throw new Error("Task stopped by user.");
    }

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true
    });

    context.on("page", openedPage => {
      openedPage.on("framenavigated", frame => {
        if (frame === openedPage.mainFrame()) {
          update({ url: openedPage.url() });
        }
      });
    });

    const page = await context.newPage();

    try {
      await setRealBrowserVisibility(page, false);
    } catch {
      update({
        browserVisible: true,
        browserControlAvailable: false
      });
      activity("Browser minimization unavailable on this system.");
    }

    if (startUrl) {
      await page.goto(startUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });
    }

    update({
      phase: "running",
      url: page.url()
    });

    if (stopRequested) {
      throw new Error("Task stopped by user.");
    }

    activity("Ollama agent started.");

    const approvalProvider =
      createConversationalApprovalProvider({
        requestUser: askUser
      });

    const humanHandoverProvider = async ({
      handover,
      page: handoverPage,
      targetHandle
    }) => {
      activity(
        `Manual interaction required: ${handover.field?.label || "Sensitive field"}`
      );

      const isPassword =
          String(handover.field?.type ?? "").toLowerCase()
            === "password";

        const boundHandover =
          isPassword &&
          targetHandle &&
          handoverPage &&
          !handoverPage.isClosed()
            ? {
                page: handoverPage,
                targetHandle,
                url: handoverPage.url()
              }
            : null;

        securePasswordHandover = boundHandover;

        const reply = await askUser({
        kind: "human_handover",
        question:
          "Enter the password securely below, or show Chromium for manual entry.",
        field: {
          label: handover.field?.label ?? "",
          type: handover.field?.type ?? "",
          boundingBox: handover.field?.boundingBox ?? null,
            secureEntrySupported: Boolean(boundHandover)
        },
        options: [
          { id: "done", label: "I've completed it" },
          { id: "cancel", label: "Cancel handover" }
        ]
      });

      if (securePasswordHandover === boundHandover) {
          securePasswordHandover = null;
        }

        const completed = reply?.optionId === "done";

      if (completed) {
        activity("Manual step marked complete. Agent resuming.");
      }

      return { completed };
    };

    const result = await executeNaturalLanguageTask(
      page,
      instruction,
      {
        urlLess: !startUrl,
        orchestratorOptions: {
          agentOptions: {
          maxSteps,
          approvalProvider,
          humanHandoverProvider,
          onApprovedPdfClick: async ({
            instruction: requestedInstruction,
            selectedLink,
            pageTitle,
            performApprovedAction
          }) => {
            if (stopRequested) {
              throw new Error("Task stopped by user.");
            }

            return await captureRequestedPdfAndRegister({
              context,
              registry: verifiedDownloadRegistry,
              directory: downloadDirectory,
              instruction: requestedInstruction,
              selectedLink,
              pageTitle,
              performApprovedAction,
              onEvent: event => {
                if (event.type === "download_started") {
                  activity("PDF download started.");
                }
                if (event.type === "download_verified") {
                  activity("PDF downloaded and byte-verified.");
                }
                if (event.type === "download_failed") {
                  activity("PDF verification failed.");
                }
              }
            });
          },
          runControl: control,
          onAgentEvent: event => {
            if (
              event.type === "page_observed" &&
              typeof event.url === "string"
            ) {
              activeObservedUrl = event.url;
              activeObservedTabId = event.tabId ?? null;
              update({ url: event.url });
            }
            if (event.type === "plan_invalidated") {
              activity("Stale plan discarded. Reobserving page.");
            }
            if (event.type === "planning_started") {
              activity(`Ollama planning · attempt ${event.attempt}`);
            }

            if (event.type === "action_selected") {
              activity(`Selected ${event.operation} on ${event.ref}`);
            }

            if (event.type === "action_executed") {
              const outcome = event.executionCompleted
                ? (event.verified
                    ? "executed and verified"
                    : "executed; verification pending")
                : "execution not confirmed";

              activity(`${event.operation} on ${event.ref}: ${outcome}`);
            }

            if (event.type === "page_observed") {
              activity(
                `Observed: ${event.title || event.url}` +
                (event.goalVerified ? " · goal matched" : "")
              );
            }

            if (event.type === "goal_verified") {
              activity("Goal verified against current browser state.");
            }
          }
        }
        }
      }
    );

    if (stopRequested) {
      update({
        phase: "cancelled",
        pending: null,
        result: {
          status: "cancelled",
          reason: "Task stopped by user.",
          history: []
        }
      });

      activity("Task cancelled by user.");
      return;
    }

    const browserPage = observeActiveBrowser(browser) ?? page;

    // Natural-language executor wraps orchestrator and agent results.
    const agentResult = result.execution?.result ?? result;

    const sanitizedHistory = (agentResult.history ?? []).map(item => ({
      step: item.step,
      operation: item.decision?.operation ?? "",
      ref: item.decision?.ref ?? "",
      executionCompleted:
        item.execution?.executionCompleted === true
    }));

    // A reading task succeeds only when an actual answer and
    // source URL are available for delivery to the dashboard.
    const deliveredAnswer =
      result.status === "answer_ready" &&
      typeof result.answer === "string" &&
      result.answer.trim().length >= 35 &&
      typeof result.sourceUrl === "string" &&
      /^https?:\/\//i.test(result.sourceUrl)
        ? result.answer.trim().slice(0, 12000)
        : null;

    const claimedDownload =
      agentResult.status === "download_ready" ||
      result.status === "download_ready";

    const deliveredPdf = extractVerifiedPdfResult(
      agentResult,
      result
    );

    const deliveredStatus = claimedDownload
      ? (deliveredPdf ? "download_ready" : "download_unavailable")
      : result.status === "answer_ready" && !deliveredAnswer
        ? "answer_unavailable"
        : result.status;

    update({
      phase: "finished",
      url: browserPage.url(),
      result: {
        status: deliveredStatus,
        reason: agentResult.reason ?? result.reason ??
          (deliveredStatus === "answer_unavailable"
            ? "No usable answer was delivered."
            : null),
        history: sanitizedHistory,
        ...(deliveredPdf ? { download: deliveredPdf } : {}),
        ...(deliveredAnswer ? {
          answer: deliveredAnswer,
          sourceUrl: result.sourceUrl,
          sourceTitle: result.sourceTitle ?? null,
          evidence: result.evidence ?? null
        } : {})
      }
    });

    activity(`Agent finished: ${result.status}`);

  } catch (error) {
    if (stopRequested) {
      update({
        phase: "cancelled",
        pending: null,
        error: null,
        result: {
          status: "cancelled",
          reason: "Task stopped by user.",
          history: []
        }
      });

      activity("Task cancelled by user.");
    } else {
      update({
        phase: "error",
        error: error.message
      });

      activity("Execution stopped with an error.");
      console.error(error.stack);
    }

  } finally {

    if (activeRunControl === control) {
      activeRunControl = null;
    }
    running = false;
  }
}

const html = await readFile(
  new URL("./index.html", import.meta.url)
);

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(
      req.url,
      `http://${HOST}:${PORT}`
    ).pathname;

    // Keep control of this agent restricted to the local dashboard.
    const origin = req.headers.origin;

    if (origin && origin !== `http://${HOST}:${PORT}`) {
      return respond(res, 403, { error: "Invalid origin." });
    }

    const host = req.headers.host;

    if (host !== `${HOST}:${PORT}`) {
      return respond(res, 403, { error: "Invalid host." });
    }

    if (
      req.method === "GET" &&
      pathname.startsWith("/api/download/")
    ) {
      const token = pathname.slice("/api/download/".length);
      return await verifiedDownloadRegistry.serve(token, res);
    }

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      });

      return res.end(html);
    }

    if (req.method === "GET" && pathname === "/api/state") {
      return respond(res, 200, state);
    }

    if (req.method === "GET" && pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      clients.add(res);
      res.write(`data: ${JSON.stringify(state)}\n\n`);

      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "GET" && pathname === "/api/screenshot") {
      const page = browser ? observeActiveBrowser(browser) : null;

      if (!page) {
        return respond(res, 404, {
          error: "Browser not started."
        });
      }

      const before = await snapshotPageState(page);

        const png = await page.screenshot({
        type: "png",
        timeout: 4000
      });

        const after = await snapshotPageState(page);
        const viewport = page.viewportSize();

        expireScreenshotTickets();

        let snapshotId = "";

        if (
          state.phase === "paused" &&
          activeRunControl?.getState() === "paused" &&
          before &&
          before === after &&
          viewport &&
          !page.isClosed()
        ) {
          snapshotId = randomUUID();

          screenshotTickets.set(snapshotId, {
            page,
            tabId: getPageId(page),
            control: activeRunControl,
            createdAt: Date.now(),
            url: page.url(),
            pageState: after,
            viewport
          });
        }

      res.writeHead(200, {
        "X-CoPilot-Snapshot": snapshotId,
          "Content-Type": "image/png",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });

      return res.end(png);
    }


    if (req.method === "GET" && pathname === "/api/browser-tabs") {
      const pages = browser
        ? browser.contexts()
            .flatMap(context => context.pages())
            .filter(page => !page.isClosed())
        : [];

      // URL tracking is reliable only when one tab matches.
      const activePage = activeObservedTabId
        ? pages.find(
            page => getPageId(page) === activeObservedTabId
          ) ?? null
        : null;

      const tabs = await Promise.all(pages.map(async (page, index) => {
        let title = "Untitled";

        try {
          title = await page.title();
        } catch {
          // Navigation might be in progress.
        }

        // Do not expose URL query tokens or fragments to the UI.
        let displayUrl = page.url();

        try {
          const parsed = new URL(displayUrl);
          displayUrl = parsed.origin + parsed.pathname;
        } catch {}

        return {
          index: index + 1,
          id: getPageId(page),
          title: String(title).slice(0, 100),
          url: displayUrl,
          active: page === activePage
        };
      }));

      return respond(res, 200, {
        tabs,
        activeKnown: activePage !== null,
        tracking: activePage
          ? "matched"
          : "unavailable"
      });
    }

    if (req.method === "POST" && pathname === "/api/start") {
      if (running || pending) {
        return respond(res, 409, {
          error: "An agent task is already running."
        });
      }

      const body = await readBody(req);
      const instruction = String(body.instruction ?? "").trim();
      const startUrl = String(body.startUrl ?? "").trim();
      const maxSteps = Number(body.maxSteps ?? 12);
      if (![6, 12, 30].includes(maxSteps))
        return respond(res, 400, {error:'Invalid action budget.'});

      if (!instruction || instruction.length > 10000) {
        return respond(res, 400, {
          error: "Enter a valid task."
        });
      }

      if (startUrl) {
        const parsed = new URL(startUrl);

        if (!["http:", "https:"].includes(parsed.protocol)) {
          return respond(res, 400, {
            error: "Only HTTP/HTTPS URLs are supported."
          });
        }
      }

      // Mark busy synchronously before returning.
      running = true;

      void runTask(instruction, startUrl, maxSteps);

      return respond(res, 202, {
        accepted: true
      });
    }

    if (req.method === "POST" && pathname === "/api/pause") {
      if (
        !running ||
        state.phase !== "running" ||
        !activeRunControl?.pause()
      ) {
        return respond(res, 409, {
          error: "Agent cannot be paused in its current state."
        });
      }

      update({ phase: "pausing" });
      activity(
        "Pause requested. Waiting for the current operation " +
        "to reach a safe checkpoint."
      );

      return respond(res, 202, { accepted: true });
    }

    if (req.method === "POST" && pathname === "/api/resume") {
      if (
        !running ||
        activeRunControl?.getState() !== "paused" ||
        (manualActionInFlight &&
         manualActionInFlight.control === activeRunControl) ||
        !activeRunControl.resume()
      ) {
        return respond(res, 409, {
          error: "Agent is not paused."
        });
      }

      update({ phase: "running" });
      activity("Resumed. Rechecking browser state.");

      return respond(res, 202, { accepted: true });
    }


    if (req.method === "POST" && pathname === "/api/manual-action") {
      // Deny cross-origin writes to this localhost browser controller.
      if (
        req.headers.origin !== `http://${HOST}:${PORT}` ||
        !String(req.headers["content-type"] ?? "")
          .includes("application/json")
      ) {
        return respond(res, 403, {
          error: "Manual control requires the local dashboard."
        });
      }

      const control = activeRunControl;

      if (
        !running ||
        stopRequested ||
        state.phase !== "paused" ||
        control?.getState() !== "paused" ||
        pending ||
        manualActionInFlight
      ) {
        return respond(res, 409, {
          error: "Manual control is available only during a confirmed pause."
        });
      }

      const body = await readBody(req);

      // Recheck after reading the asynchronous request body.
      if (
        activeRunControl !== control ||
        state.phase !== "paused" ||
        control.getState() !== "paused" ||
        stopRequested ||
        manualActionInFlight
      ) {
        return respond(res, 409, {
          error: "The browser control state changed."
        });
      }

      const page = observeActiveBrowser(browser);

      if (
        !page ||
        page.isClosed() ||
        !activeObservedTabId ||
        body.tabId !== activeObservedTabId ||
        getPageId(page) !== body.tabId
      ) {
        return respond(res, 409, {
          error: "The active browser tab could not be verified."
        });
      }

      const action = String(body.action ?? "");
      const allowedKeys = new Set([
        "Tab", "Enter", "Escape", "Backspace",
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"
      ]);

      let execute;

      if (action === "click") {
        expireScreenshotTickets();

        const ticket = screenshotTickets.get(
          typeof body.snapshotId === "string"
            ? body.snapshotId
            : ""
        );

        if (
          !ticket ||
          ticket.page !== page ||
          ticket.tabId !== body.tabId ||
          ticket.control !== control ||
          ticket.url !== page.url() ||
          Date.now() - ticket.createdAt > SNAPSHOT_TTL_MS
        ) {
          return respond(res, 409, {
            error: "Screenshot expired or browser tab changed."
          });
        }

        const x = Number(body.xRatio);
        const y = Number(body.yRatio);
        const viewport = page.viewportSize();

        if (
          !viewport ||
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 || x > 1 || y < 0 || y > 1
        ) {
          return respond(res, 400, {
            error: "Invalid screenshot coordinates."
          });
        }

        execute = () => page.mouse.click(
          Math.min(viewport.width - 1, x * viewport.width),
          Math.min(viewport.height - 1, y * viewport.height)
        );


        const originalClick = execute;

        execute = async () => {
          const current = await snapshotPageState(page);
          const currentViewport = page.viewportSize();

          if (
            current !== ticket.pageState ||
            page.isClosed() ||
            state.phase !== "paused" ||
            control.getState() !== "paused" ||
            !currentViewport ||
            currentViewport.width !== ticket.viewport.width ||
            currentViewport.height !== ticket.viewport.height
          ) {
            throw new Error(
              "Screenshot no longer matches the browser state."
            );
          }

          screenshotTickets.delete(body.snapshotId);

          await originalClick();
        };

      } else if (action === "scroll") {
        const dx = Number(body.deltaX ?? 0);
        const dy = Number(body.deltaY ?? 0);

        if (
          !Number.isFinite(dx) ||
          !Number.isFinite(dy)
        ) {
          return respond(res, 400, {
            error: "Invalid scroll distance."
          });
        }

        execute = () => page.mouse.wheel(
          Math.max(-900, Math.min(900, dx)),
          Math.max(-900, Math.min(900, dy))
        );

      } else if (action === "key" && allowedKeys.has(body.key)) {
        execute = () => page.keyboard.press(body.key);

      } else if (
        action === "type" &&
        typeof body.text === "string" &&
        body.text.length > 0 &&
        body.text.length <= 500 &&
        !/[\r\n]/.test(body.text)
      ) {
        execute = async () => {
          const allowed = await page.evaluate(() => {
            const el = document.activeElement;

            if (!el || !(el instanceof HTMLElement)) {
              return false;
            }

            const tag = el.tagName.toLowerCase();
            const type = (
              el.getAttribute("type") || "text"
            ).toLowerCase();

            const autocomplete = (
              el.getAttribute("autocomplete") || ""
            ).toLowerCase();

            const identity = [
              el.id,
              el.getAttribute("name"),
              el.getAttribute("placeholder"),
              el.getAttribute("aria-label")
            ].filter(Boolean).join(" ");

            const sensitiveType = new Set([
              "password", "hidden", "file"
            ]).has(type);

            const sensitiveAutocomplete =
              /(?:password|one-time-code|cc-number|cc-csc|cc-exp)/i
                .test(autocomplete);

            const sensitiveIdentity =
              /(?:password|passwd|otp|one.?time.?code|verification.?code|cvv|cvc|card.?number)/i
                .test(identity);

            const editable = (
              (tag === "input" &&
                !["button", "submit", "reset", "checkbox",
                  "radio", "file", "hidden"].includes(type)) ||
              tag === "textarea" ||
              el.isContentEditable
            );

            const blocked =
              el.hasAttribute("disabled") ||
              el.hasAttribute("readonly") ||
              sensitiveType ||
              sensitiveAutocomplete ||
              sensitiveIdentity;

            return editable && !blocked;
          });

          if (!allowed) {
            throw new Error(
              "Focused field is not eligible for dashboard typing."
            );
          }

          await page.keyboard.insertText(body.text);
        };

      } else {
        return respond(res, 400, {
          error: "Unsupported manual browser action."
        });
      }

      const operation = { control, page };
      manualActionInFlight = operation;

      try {
        await execute();

        // Never log manual text or field contents.
        activity(`Manual browser action: ${action}`);

        return respond(res, 200, {
          ok: true,
          action,
          tabId: body.tabId
        });

      } catch {
        return respond(res, 409, {
          error: "Manual action could not be completed."
        });

      } finally {
        if (manualActionInFlight === operation) {
          manualActionInFlight = null;
        }
      }
    }

    if (req.method === "POST" && pathname === "/api/stop") {
      if (!running) {
        return respond(res, 409, {
          error: "No task is running."
        });
      }

      stopRequested = true;
      activeRunControl?.cancel();

      const waiting = pending;
      pending = null;

      update({
        phase: "stopping",
        pending: null
      });

      // Release a pending conversational approval or handover.
      if (waiting) {
        waiting.resolve({ optionId: "deny" });
      }

      // Closing the browser prevents additional Playwright actions,
      // including actions proposed by an outstanding Ollama request.
      if (browser) {
        void browser.close().catch(() => {});
      }

      return respond(res, 202, {
        accepted: true,
        stopping: true
      });
    }


if (
  req.method === "POST" &&
  pathname === "/api/browser-visibility"
) {
  if (
    req.headers.origin !== `http://${HOST}:${PORT}` ||
    !String(req.headers["content-type"] ?? "")
      .includes("application/json")
  ) {
    return respond(res, 403, {
      error: "Local dashboard required."
    });
  }

  const body = await readBody(req);

  if (typeof body.visible !== "boolean") {
    return respond(res, 400, {
      error: "Expected a boolean visibility value."
    });
  }

  const page = browser ? observeActiveBrowser(browser) : null;

  if (!page || page.isClosed() || stopRequested) {
    return respond(res, 409, {
      error: "No active browser available."
    });
  }

  try {
    await setRealBrowserVisibility(page, body.visible);

    return respond(res, 200, {
      accepted: true,
      visible: body.visible
    });
  } catch {
    update({ browserControlAvailable: false });

    return respond(res, 409, {
      error: "Chromium window control is unavailable."
    });
  }
}


      if (
        req.method === "POST" &&
        pathname === "/api/secure-password"
      ) {
        if (
          req.headers.origin !== `http://${HOST}:${PORT}` ||
          !String(req.headers["content-type"] ?? "")
            .includes("application/json")
        ) {
          return respond(res, 403, {
            error: "Local dashboard required."
          });
        }

        const body = await readBody(req);
        let secret =
          typeof body.secret === "string"
            ? body.secret
            : "";

        if (!secret || secret.length > 256) {
          body.secret = "";
          return respond(res, 400, {
            error: "Enter a password of 1–256 characters."
          });
        }

        const handover = securePasswordHandover;

        if (
          !running ||
          stopRequested ||
          securePasswordSubmissionBusy ||
          !handover ||
          !pending ||
          pending.id !== body.id ||
          state.phase !== "human_handover" ||
          handover.page.isClosed() ||
          handover.page.url() !== handover.url
        ) {
          body.secret = "";
          secret = "";

          return respond(res, 409, {
            error: "No matching active password handover."
          });
        }

        securePasswordSubmissionBusy = true;

        try {
          const target = handover.targetHandle;

          const eligible = await target.evaluate(node =>
            node.isConnected &&
            node instanceof HTMLInputElement &&
            node.type === "password" &&
            !node.disabled &&
            !node.readOnly
          );

          if (!eligible) {
            return respond(res, 409, {
              error: "Original password field is unavailable."
            });
          }

          await target.fill(secret, { timeout: 5000 });

          // Compare privately inside Chromium.
          // Only a boolean is returned to the server.
          const verified = await target.evaluate(
            (node, expected) =>
              node.isConnected &&
              node instanceof HTMLInputElement &&
              node.type === "password" &&
              node.value === expected,
            secret
          );

          if (!verified) {
            return respond(res, 409, {
              error: "Password field verification failed."
            });
          }

          // The existing agent handover verifier independently
          // rechecks the field after this acknowledgment.
          const interaction = pending;

          pending = null;
          securePasswordHandover = null;

          update({
            pending: null,
            phase: "running"
          });

          activity("Secure password entry completed.");

          interaction.resolve({
            optionId: "done"
          });

          return respond(res, 200, {
            accepted: true
          });

        } catch {
          return respond(res, 409, {
            error: "Password entry failed or the field changed."
          });

        } finally {
          body.secret = "";
          secret = "";
          securePasswordSubmissionBusy = false;
        }
      }

      if (req.method === "POST" && pathname === "/api/reply") {
      const body = await readBody(req);

      if (!pending || body.id !== pending.id) {
        return respond(res, 409, {
          error: "No matching pending interaction."
        });
      }

      const response = {
        optionId: typeof body.optionId === "string"
          ? body.optionId
          : undefined,
        text: typeof body.text === "string"
          ? body.text.slice(0, 600)
          : undefined
      };

      const interaction = pending;

      pending = null;

      update({
        pending: null,
        phase: "running"
      });

      interaction.resolve(response);

      return respond(res, 200, {
        accepted: true
      });
    }

    respond(res, 404, { error: "Not found." });

  } catch (error) {
    respond(res, 500, {
      error: error.message
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `Website CoPilot dashboard: http://${HOST}:${PORT}`
  );
});
