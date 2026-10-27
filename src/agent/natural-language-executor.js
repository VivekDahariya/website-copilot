import { discoverWebsite } from "./website-discovery.js";
import { isReadOnlyQuestion, answerWebpage } from "./webpage-answer.js";
import { buildVerifiedDiscoveredNavigationGoal } from "./discovered-navigation-goal.js";
import { buildRepositoryDestinationGoal } from "./repository-result-planner.js";

import {
  interpretTask
} from "./task-interpreter.js";

import {
  executeTask
} from "./task-orchestrator.js";

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

  // Ground references such as "this website" in the actual
  // browser location. Never invent or assume a destination.
  let verifiedDiscoveredGoal = null;

  if (options.urlLess === true) {
    const discovery = await discoverWebsite(page, instruction);

    if (discovery.status !== "found") {
      return {
        status: "needs_clarification",
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

  // Reuse a verified deterministic goal only for simple GitHub
  // repository navigation. All other tasks retain AI interpretation.
  let trustedGitHubPage = false;

  try {
    const site = new URL(currentUrl);

    trustedGitHubPage =
      site.protocol === "https:" &&
      site.hostname.toLowerCase() === "github.com";
  } catch {
    trustedGitHubPage = false;
  }

  const fastRepositoryGoal =
    process.env.COPILOT_DETERMINISTIC_SEARCH === "1" &&
    trustedGitHubPage
      ? buildRepositoryDestinationGoal(instruction)
      : null;

  const fastGoal = verifiedDiscoveredGoal ?? fastRepositoryGoal;

  const interpretation = fastGoal
    ? {
        status: "interpreted",
        task: {
          type: "browser_goal",
          instruction,
          goal: fastGoal
        }
      }
    : await interpretTask(instruction, {
    ...(options.interpreterOptions ?? {}),
    currentUrl,
    formControls
  });

  if (interpretation.status !== "interpreted") {
    return {
      status: "needs_clarification",
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
      originalInstruction: instruction
    }
  );

  return {
    status: execution.status,
    instruction,
    interpretedTask: task,
    executed: true,
    execution
  };
}
