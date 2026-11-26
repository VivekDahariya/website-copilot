import {addCheckboxOrdinals30W} from "./form-checkbox-ordinals-30W.js";
import { createExplicitDestinationGoal } from "./explicit-destination-goal.js";
import { discoverWebsite } from "./website-discovery.js";
import { isReadOnlyQuestion, isNavigationThenReadingTask, answerWebpage } from "./webpage-answer.js";
import { buildVerifiedDiscoveredNavigationGoal } from "./discovered-navigation-goal.js";
import { createExplicitTabWorkflow } from "./explicit-tab-workflow.js";
import { isExplicitPdfDownloadRequest } from "./pdf-download-identity.js";
import { assessTask, assessPage } from "./content-policy.js";
import {
  isDirectInstructionEnabled,
  extractStatedPassword,
  redactStatedPassword
} from "./direct-instruction.js";

import {
  interpretTask
} from "./task-interpreter.js";

import {
  executeTask
} from "./task-orchestrator.js";

// Route only an affirmative, explicit PDF-download instruction.
// Never interpret a visible link as proof of a completed download.
export function createExplicitPdfReceiptGoal(instruction) {
  const text = String(instruction ?? "");

  const affirmative =
    /\b(?:download|save|fetch|retrieve)\s+(?:the\s+|a\s+|this\s+|that\s+|requested\s+)?(?:pdf|document|file|report)\b/i
      .test(text);

  const prohibited =
    /\b(?:do not|don't|never|without)\s+(?:\w+\s+){0,2}(?:download|save|fetch|retrieve)\s+(?:the\s+|a\s+|this\s+|that\s+)?(?:pdf|document|file|report)\b/i
      .test(text);

  if (!/\bpdf\b/i.test(text) ||
      !affirmative ||
      prohibited ||
      !isExplicitPdfDownloadRequest(text)) {
    return null;
  }

  return { type: "download_receipt" };
}

export async function executeNaturalLanguageTask(
  page,
  instruction,
  options = {}
) {
  if (!page || typeof page.goto !== "function") {
    throw new Error("A valid Playwright page is required.");
  }

  if (
    typeof instruction !== "string" ||
    !instruction.trim()
  ) {
    throw new Error("A non-empty instruction is required.");
  }

  // Content policy, decided by code before any model or site is involved.
  for (const policy of [
    assessTask({ instruction }),
    await assessPage(page)
  ]) {
    if (!policy.allowed) {
      return {
        status: "refused_by_policy",
        instruction,
        reason: policy.reason,
        executed: false
      };
    }
  }

  // A password the user wrote into the task is kept out of everything that
  // follows (model prompts, discovery, logs, records). Only the agent's
  // password-field step receives it, and only to type into that field.
  const statedPassword = isDirectInstructionEnabled()
    ? extractStatedPassword(instruction) : null;
  if (statedPassword) instruction = redactStatedPassword(instruction);

  // Ground references such as "this website" in the actual
  // browser location. Never invent or assume a destination.
  let verifiedDiscoveredGoal = null;
  // Where the browser was before this run opened anything itself. A page the
  // run found and opened by discovery counts as reached by navigation.
  const urlBeforeRun = page.url();

  if (options.urlLess === true) {
    const discovery = await discoverWebsite(page, instruction);
    // Lets the caller record how the site was reached (given address or search).
    options.onDiscovery?.(discovery);

    if (discovery.status !== "found") {
      if (process.env.COPILOT_DISCOVERY_DIAG === "1") {
        let observedUrl = "unknown";

        try {
          const observed = new URL(page.url());
          observedUrl = observed.origin + observed.pathname;
        } catch {
          observedUrl = String(page.url());
        }

        console.error(
          "[DISCOVERY_DIAG_36G1]",
          JSON.stringify({
            status: discovery.status,
            reason: discovery.reason ?? null,
            detail: String(discovery.detail ?? "").slice(0, 800),
            observedUrl
          })
        );
      }
      return {
        status: discovery.status === "site_unreachable"
          ? "site_unreachable"
          : "needs_clarification",
        instruction,
        reason: discovery.reason,
        executed: false
      };
    }
    verifiedDiscoveredGoal =
      await buildVerifiedDiscoveredNavigationGoal(
        page, instruction, discovery
      );
  }

  const currentUrl = page.url();

  // Reading is an information-delivery task, not a browser-state
  // goal. Finding the page alone must never complete this request.
  if (isReadOnlyQuestion(instruction)) {
    const reading = await answerWebpage(
      page,
      instruction,
      options.answerOptions ?? {}
    );

    return {
      status: reading.status,
      instruction,
      executed: true,
      ...(reading.status === "answer_ready"
        ? {
            answer: reading.answer,
            sourceUrl: reading.sourceUrl,
            sourceTitle: reading.sourceTitle,
            evidence: reading.evidence
          }
        : {
            reason: reading.reason ??
              "No readable answer could be generated."
          }),
      reading
    };
  }

  // Browser location is context, not part of what the user requested.
  // Mixing them caused the interpreter to invent goals like
  // identity: "webpage: https://www".
  // Only fetch lightweight, non-secret field metadata when the task
  // involves interacting with a form. No field values are read here.
  const formLikeInstruction =
    /\b(?:fill|enter|type|select|choose|check|uncheck|form|input|dropdown|textarea|text\s+area|write|put|field|option|registration)\b/i
      .test(instruction);
  const formControls = formLikeInstruction
    ? await page.evaluate(() => [...document.querySelectorAll(
        'input:not([type="hidden"]), textarea, select'
      )].filter(el => {
        const bounds = el.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && !el.disabled &&
          !el.readOnly &&
          !['file','password','submit','button','reset'].includes(el.type);
      }).slice(0, 35).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') || '').toLowerCase(),
        label: [
          el.getAttribute('aria-label'),
          el.getAttribute('aria-labelledby')?.split(/\s+/)
            .map(id => document.getElementById(id)?.textContent || '').join(' '),
          'labels' in el ? [...el.labels].map(x => x.textContent).join(' ') : '',
          el.getAttribute('placeholder'),
          el.getAttribute('title')
        ].find(v => typeof v === 'string' && v.trim())?.trim().slice(0, 100) || '',
        name: el.getAttribute('name')?.slice(0, 80) || '',
        options: el.tagName.toLowerCase() === 'select'
          ? [...el.options].filter(x => !x.disabled).slice(0, 20).map(x => ({
              label: x.label.slice(0, 80), value: x.value.slice(0, 80)
            }))
          : []
      }))).catch(() => [])
    : [];

  // Checkbox names such as "checkboxes[]" are shared by
  // several controls. Preserve DOM-order identity before
  // interpreting separately numbered checkbox instructions.
  addCheckboxOrdinals30W(formControls);

  // This exact, explicit tab sequence has its own browser-evidence verifier.
  // Do not ask a small local model to invent a form/page destination goal
  // for an operation that is defined by returning to its source tab.
  const explicitTabGoal = createExplicitTabWorkflow(instruction, page)
    ? { type: "tab_workflow" }
    : null;
  const explicitPdfGoal = createExplicitPdfReceiptGoal(instruction);

  const explicitDestinationGoal =
    createExplicitDestinationGoal(instruction);

  const fastGoal =
    explicitTabGoal ??
    explicitPdfGoal ??
    explicitDestinationGoal ??
    verifiedDiscoveredGoal;

  const interpretation = fastGoal
    ? {
        status: "interpreted",
        task: {
          type: "browser_goal",
          instruction,
          goal: fastGoal
        }
      }
    : isDirectInstructionEnabled()
      // Direct-instruction mode: no upfront structured goal. The agent loop
      // receives the original instruction and decides one action at a time.
      ? {
          status: "interpreted",
          task: { type: "direct_instruction", instruction }
        }
      : await interpretTask(instruction, {
    ...(options.interpreterOptions ?? {}),
    currentUrl,
    formControls
  });

  if (interpretation.status !== "interpreted") {
    return {
      status: interpretation.status === "needs_clarification"
        ? "needs_clarification"
        : "interpretation_failed",
      instruction,
      reason: interpretation.reason,
      executed: false
    };
  }

  const task = interpretation.task;

  const execution = await executeTask(
    page,
    task,
    {
      ...(options.orchestratorOptions ?? {}),
      // Tell the agent when this run found and opened the starting page
      // itself, so that opening it counts as done work.
      ...(options.urlLess === true || statedPassword ? {
        agentOptions: {
          ...(options.orchestratorOptions?.agentOptions ?? {}),
          ...(options.urlLess === true ? { arrivedByDiscovery: true } : {}),
          ...(statedPassword ? { statedPassword } : {})
        }
      } : {}),
      originalInstruction: instruction
    }
  );

  // A navigation milestone cannot complete a two-stage request that also
  // asks for an explanation. Run the same read-only, source-grounded reader
  // only AFTER the destination was independently verified by the browser.
  const navigationReadingRequested =
    isNavigationThenReadingTask(instruction) && !isReadOnlyQuestion(instruction);

  if (navigationReadingRequested && execution.status === "verified_complete") {
    const conditions = task.goal?.type === "all_of"
      ? task.goal.conditions ?? []
      : [task.goal];
    const pageGoal = task.type === "direct_instruction" ||
      (task.type === "browser_goal" &&
      conditions.some(condition => condition?.type === "page_destination"));
    // A link that opens a new tab leaves the agent on that tab. Read the page
    // the run ended on, which the browser confirms by its address, not the
    // tab the run started in.
    const finalUrl = execution.result?.finalUrl;
    const readingPage = (finalUrl
      ? [...page.context().pages()].reverse()
          .find(candidate => !candidate.isClosed() && candidate.url() === finalUrl)
      : null) ?? page;
    const reached = pageGoal &&
      execution.result?.verification?.completed === true &&
      finalUrl === readingPage.url() &&
      readingPage.url() !== (options.urlLess === true ? urlBeforeRun : currentUrl) &&
      /^https?:\/\//i.test(readingPage.url());

    if (!reached) {
      return {
        status: "answer_unavailable",
        instruction,
        interpretedTask: task,
        executed: true,
        execution,
        reason: "Destination not independently confirmed for the requested explanation."
      };
    }

    const reading = await answerWebpage(readingPage, instruction, {
      ...(options.answerOptions ?? {}),
      navigationCompleted: true
    });

    return {
      status: reading.status,
      instruction,
      interpretedTask: task,
      executed: true,
      execution,
      reading,
      ...(reading.status === "answer_ready"
        ? {
            answer: reading.answer,
            sourceUrl: reading.sourceUrl,
            sourceTitle: reading.sourceTitle,
            evidence: reading.evidence
          }
        : {
            reason: reading.reason ?? "The destination was reached, but the requested answer was not verified."
          })
    };
  }

  return {
    status: execution.status,
    instruction,
    interpretedTask: task,
    executed: true,
    execution
  };
}
