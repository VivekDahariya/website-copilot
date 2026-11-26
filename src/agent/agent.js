import { buildApprovalAdvisoryContext } from "./approval-advisory-context.js";
import { getPageId } from "./page-identity.js";
import { validateGoalSchema } from "./goal-schema-validator.js";
import {
  isDirectInstructionGoal,
  createDirectFormScope,
  asksToLogIn,
  verifyDirectCompletion,
  MAX_DIRECT_COMPLETION_REJECTIONS
} from "./direct-instruction.js";
import {
  createNavigationIntentGuard
} from "./navigation-intent-guard.js";
import {
  authorizeBrowserAction
} from "./action-safety-policy.js";
import { observeReliably, describeObservationFailure } from "../observer/reliable-observer.js";
import { resolveElement } from "../observer/dom-observer.js";
import { readSelectiveEvidence } from "../observer/selective-evidence.js";
import { getDomRevision, waitForRelevantDomChange } from "../observer/dom-change-watcher.js";
import { executeAction } from "../executor/action-executor.js";
import {
  getEligiblePdfDownloadClick
} from "./pdf-download-click-guard.js";

import {
  isExplicitPdfDownloadRequest
} from "./pdf-download-identity.js";

import {
  selectUniqueDirectPdfAction
} from "./pdf-direct-link-planner.js";
import { inspectLiveTarget } from "./live-target-identity.js";
import {
  capturePdfDescriptionEvidence
} from "./pdf-description-evidence.js";
import {
  validateActionApproval
} from "./action-approval.js";
import { readPageMessages, newMessages, cleanMessage } from "./login-outcome.js";
import { saveScreenshot } from "../executor/screenshot-save.js";
import { screenshotRequest } from "./direct-instruction.js";
import { decideNextAction } from "./local-reasoner.js";
import { createFormFastPathSession, proposeFormBatch, proposeGroundedFormBatch, eligibleForFormFastPath, validateFormBatch } from "./form-fast-path.js";
import { createTabContext } from "./tab-context.js";
import { mayReactLate, waitForLateReaction } from "./late-reaction.js";
import { detectChallenge } from "./challenge-wall.js";
import { createExplicitTabWorkflow } from "./explicit-tab-workflow.js";
import {
  extractDesiredState,
  deriveDesiredStateFromBaseline
} from "./intent-extractor.js";
import { reconcileDesiredState } from "./desired-state-planner.js";
import { verifyRequirementCoverage } from "./requirement-coverage-verifier.js";
import {
  verifyAnchoredRequirementCoverage
} from "./anchored-coverage-verifier.js";
import { evaluateFormCompleteness } from "./completeness-gate.js";

import {
  reconcileFormActions,
  isRedundantFormAction
} from "./form-state-reconciler.js";
import { verifyGoal } from "./goal-verifier.js";
import { makeEvidenceSnapshot } from "./evidence-snapshot.js";
import { createWorkflowGoalVerifier } from "./workflow-goal-verifier.js";
import { verifyPersistence } from "./persistence-verifier.js";
import { selectRelevantElements } from "./element-ranker.js";
import { createProgressGuard } from "./progress-guard.js";
import { createBrowserStateBaseline, rejectContradictoryFormAction } from "./browser-state-baseline.js";
import { createFormMutationPolicy, isSubmitAction } from "./form-mutation-policy.js";
import { isNavigationThenReadingTask } from "./webpage-answer.js";
import { reachableElements } from "./covered-elements.js";
import { recoverExplicitBooleanAction } from "./explicit-boolean-recovery.js";
import { recoverExplicitSubmitAction } from "./explicit-submit-recovery.js";
import { verifySubmittedFormOutcome } from "./submission-outcome-evidence.js";
import { evaluateGoalProgress } from "./goal-progress.js";
import { assessPage } from "./content-policy.js";
import {
  settleAsyncAction,
  isFinalizingAction
} from "./async-action-settlement.js";
import { createStagnationDetector } from "./stagnation-detector.js";
import { createStagnationRecovery } from "./stagnation-recovery.js";
import {
  createBoundedNavigationBacktracker
} from "./navigation-tree.js";

const MAX_STEPS = Math.min(50, Math.max(1, Number(process.env.COPILOT_MAX_STEPS || 12) || 12));
const MAX_REPLANS = 2;

export async function runAgent(
  page,
  task,
  goal,
  {
    reasoner = decideNextAction,
    formBatchPlanner = null,
    observer = observeReliably,
    originalInstruction = task,
    arrivedByDiscovery = false,
    onAgentEvent = null,
    runControl = null,
    approvalProvider = null,
    humanHandoverProvider = null,
    statedPassword = null,
    mediaDirectory = null,
    desiredStateGuard = false,
    deterministicFormPlanning = false,
    maxSteps = MAX_STEPS,
    onApprovedPdfClick = null,
    persistencePolicy = {
      allowReload: false,
      workflowCategory: "unknown"
    }
  } = {}
) {
  if (deterministicFormPlanning && !desiredStateGuard) {
    throw new Error(
      "Deterministic form planning requires the submission guard."
    );
  }

  const history = [];

  const explicitPdfRequest =
    isExplicitPdfDownloadRequest(originalInstruction);

  const pdfPlanningDeadline = Date.now() + 180000;
  let previousPdfPlanningSignature = null;
  let repeatedPdfPlanningCount = 0;
  const browserBaseline = createBrowserStateBaseline();
  // Direct-instruction mode: no structured goal exists. The original
  // instruction is the only intent; completion is checked separately.
  const directMode = isDirectInstructionGoal(goal);
  let directCompletionRejections = 0;
  // Set when the planner repeats an action the browser showed to be
  // ineffective: it has nothing new to offer, so completion is checked next.
  let checkCompletionNext = false;
  let directArrivalChecked = false;
  const formMutationPolicy = createFormMutationPolicy({
    goal,
    instruction:originalInstruction,
    ...(directMode
      ? {directScope:createDirectFormScope(originalInstruction)}
      : {})
  });
  const formFastPath = createFormFastPathSession();

  const sensitiveTask =
    /password|passcode|otp|one.time.code|verification.code|cvv|cvc/i
      .test(String(originalInstruction)) ||
    /password|passcode|otp|one.time.code|verification.code|cvv|cvc/i
      .test(JSON.stringify(goal));

  const emitAgentEvent = (type, details = {}) => {
    if (typeof onAgentEvent !== "function") return;

    try {
      onAgentEvent({
        type,
        timestamp: Date.now(),
        ...details
      });
    } catch {
      // UI listeners cannot interrupt the agent.
    }
  };

  emitAgentEvent("agent_started", { url: page.url() });

  const tabContext = createTabContext(page);
  // A human-verification challenge (CAPTCHA) is passed only by a person. The
  // same handover provider that serves password fields serves it, once per
  // challenge: if the person says it is done and the challenge is still
  // there, the run stops instead of asking again.
  let challengeHandovers = 0;
  let lastChallengeKey = null;
  const handOverChallenge = async (challenge, step) => {
    const key = `${challenge.kind}|${page.url()}`;
    if (key === lastChallengeKey || challengeHandovers >= 3) {
      return {
        stop: {
          status: "human_handover_unverified",
          reason: "The verification challenge is still shown after the manual step.",
          steps: history.length,
          finalUrl: page.url(),
          history
        }
      };
    }
    const screenshot = await page.screenshot({ type: "png" }).catch(() => null);
    const handover = {
      pageUrl: page.url(),
      field: {
        ref: "",
        label: "Human verification (CAPTCHA)",
        type: "captcha",
        boundingBox: null
      },
      reason: "A human-verification challenge must be completed by a person.",
      screenshotPngBase64: screenshot ? screenshot.toString("base64") : null
    };
    const paused = {
      status: "human_handover_required",
      steps: history.length,
      finalUrl: page.url(),
      handover,
      history
    };
    if (typeof humanHandoverProvider !== "function") return { stop: paused };
    challengeHandovers += 1;
    const response = await humanHandoverProvider({
      page, handover, targetHandle: null
    });
    if (response?.completed !== true) return { stop: paused };
    lastChallengeKey = key;
    emitAgentEvent("action_selected", {
      ref: "", operation: "human_handover",
      targetLabel: handover.field.label, url: page.url()
    });
    emitAgentEvent("action_executed", {
      ref: "", operation: "human_handover",
      executionCompleted: true, verified: null, url: page.url()
    });
    history.push({
      step,
      targetLabel: handover.field.label,
      decision: { ref: "", operation: "human_handover", value: "" },
      execution: {
        executionCompleted: true,
        performedBy: "user",
        verified: null
      }
    });
    return { stop: null };
  };
  const originalAgentPage = page;
  // Which tab the agent is looking at, for the completion check: a task that
  // says "switch back to the first tab" or "in the new tab" is only complete
  // on that tab.
  const tabState = () => ({
    onStartTab: page === originalAgentPage,
    count: page.context().pages().filter(item => !item.isClosed()).length
  });
  const explicitTabWorkflow = createExplicitTabWorkflow(originalInstruction, page);
  const workflowVerifier = createWorkflowGoalVerifier(
    goal,
    originalInstruction
  );

  const navigationGuard = createNavigationIntentGuard(
    task,
    page.url(),
    originalInstruction
  );

  // Navigation recovery is bounded and never force-clicks obstructed DOM.
  let backNavigations = 0;
  let blockedClickRecoveries = 0;
  let overlayBlocked = false;
  let mediaSaveFailures = 0;
  let pageChangedRecoveries = 0;
  let screenshotFailures = 0;
  // Set after a login button was pressed; checked on the next observation.
  let pendingLoginCheck = null;
  let unavailableSelectRecoveries = 0;

  // Reject invalid goals before observation, planning, or execution.
  try {
    // The direct-mode marker carries no interpretation to validate.
    if (!directMode) goal = validateGoalSchema(goal);
  } catch (error) {
    return {
      status: "invalid_goal",
      steps: 0,
      finalUrl: page.url(),
      reason: error.message,
      history
    };
  }

  let dynamicRecoveryAttempts = 0;
  let dynamicRecoveryPage = page.url();
  const progressGuard = createProgressGuard(page.url());
  const stagnationDetector = createStagnationDetector();
  const stagnationRecovery = createStagnationRecovery();
  const navigationBacktracker =
    createBoundedNavigationBacktracker({maxBacktracks:2});

  async function attemptTreeBacktrack(step) {
    const recovery = await navigationBacktracker.attempt(page);
    if (!recovery.completed) return false;

    progressGuard.blockNavigation(
      recovery.fromUrl,recovery.toUrl
    );

    stagnationRecovery.remember(
      recovery.observation,
      recovery.element,
      recovery.decision
    );

    history.push({
      step,
      decision:{ref:"",operation:"back",value:""},
      execution:{
        operation:"back",
        executionCompleted:true,
        verified:true,
        previousUrl:recovery.toUrl,
        urlAfter:recovery.fromUrl
      }
    });

    emitAgentEvent("navigation_backtracked",{
      fromUrl:recovery.toUrl,
      url:recovery.fromUrl,
      reason:"navigation_stagnation",
      backtracks:recovery.backtracks
    });

    return true;
  }

  const currentPageOnly =
    goal?.type === "visible_content" &&
    /\bon this page\b/i.test(task);

  console.log("\n========== WEBSITE COPILOT ==========");
  console.log(
    "TASK:",
    sensitiveTask ? "[SENSITIVE TASK REDACTED]" : task
  );

  let immutableIntentBaseline = null;
  let policyCheckedUrl = null;

    for (let step = 1; step <= Math.min(50, Math.max(1, Math.floor(maxSteps) || MAX_STEPS)); step++) {
      await runControl?.checkpoint();
      const planRevision = runControl?.getRevision() ?? null;
    console.log(`\n========== STEP ${step} ==========`);

    if (page.url() !== dynamicRecoveryPage) {
      dynamicRecoveryPage = page.url();
      dynamicRecoveryAttempts = 0;
    }

    const revisionBeforePlanning = await getDomRevision(page);

    const observedAt = performance.now();
    const observationResult = await observer(page);
    if (process.env.COPILOT_PERF === "1") {
      console.log("[PERF] observationMs", Math.round(performance.now()-observedAt));
    }

    if (observationResult.status !== "ready") {
      console.log(
        "Observation recovery failed:",
        observationResult.assessment
      );

      return {
        status: "observation_unavailable",
        steps: history.length,
        finalUrl: page.url(),
        observationAttempts: observationResult.attempts,
        reason: describeObservationFailure(observationResult.assessment, page.url()),
        assessment: observationResult.assessment,
        history
      };
    }

    if (observationResult.attempts > 1) {
      console.log(
        "Observation recovered after",
        observationResult.attempts,
        "attempts"
      );
    }

    const observation = browserBaseline.enrich({
      ...observationResult.observation,
      availableTabs: await tabContext.describe(page)
    });

    // Content policy: every new page is checked before anything is done on it.
    if (policyCheckedUrl !== observation.url) {
      policyCheckedUrl = observation.url;
      const policy = await assessPage(page);
      if (!policy.allowed) {
        console.log("Task refused by content policy:", policy.category);
        return {
          status: "refused_by_policy",
          steps: history.length,
          finalUrl: page.url(),
          reason: policy.reason,
          history
        };
      }
    }

    // The page itself may be a human-verification wall. Only a person can
    // pass it, so hand over exactly then. A page that merely talks about
    // CAPTCHAs is not one; see challenge-wall.js.
    {
      const challenge = await detectChallenge(page, observation);
      if (challenge.kind === "interstitial") {
        const outcome = await handOverChallenge(challenge, step);
        if (outcome.stop) return outcome.stop;
        continue;
      }
      if (challenge.kind === null) lastChallengeKey = null;
    }

    // A login was just submitted. If the sign-in form is still there and the
    // site answered with a message of its own, the login was rejected: say so
    // in the site's words and stop. Never retried, never reported as done.
    if (pendingLoginCheck !== null) {
      const check = pendingLoginCheck;
      pendingLoginCheck = null;
      const formStillOpen = (observation.actionableElements ?? []).some(element =>
        String(element.type ?? "").toLowerCase() === "password");
      if (formStillOpen) {
        const message = cleanMessage(newMessages(
          check.before, await readPageMessages(page).catch(() => []))[0]);
        if (message) {
          console.log("Login rejected by the site:", message);
          emitAgentEvent("login_rejected", { message, url: page.url() });
          return {
            status: "login_rejected",
            steps: history.length,
            finalUrl: page.url(),
            pageMessage: message,
            reason: 'The page said: "' + message + '"',
            history
          };
        }
      }
    }

    formMutationPolicy.observe(observation);

    // The initial observation and independent verifier always remain intact.
    // Ollama may request one additional read-only detail scope before
    // choosing an action. No browser operation is selected by this callback.
    observation.requestMoreEvidence = scope =>
      readSelectiveEvidence(page, scope, observation.url);

    const verification = workflowVerifier.verify(observation);

    // Shadow evidence ledger only. The workflow verifier retains full authority.
    emitAgentEvent("evidence_snapshot", makeEvidenceSnapshot(
      goal, verification, step, "pre_action"
    ));

    // Update the dashboard's active page BEFORE early completion.
    // Otherwise a successful return to the original tab leaves the preview
    // displaying the last secondary tab, despite correct browser state.
    emitAgentEvent("page_observed", {
      tabId: getPageId(page),
      url: observation.url,
      title: observation.title ?? "",
      goalVerified: verification.completed === true
    });

    // An explicit "open new tab -> read heading -> return" request is an
    // ordered workflow. A goal matching the original or second page alone
    // must not finish it before return to the original page.
    if (explicitTabWorkflow?.observe(
      page, observation, verification, ref => tabContext.resolve(ref)
    )) {
      const evidence = explicitTabWorkflow.evidence();
      if (goal.type === "tab_workflow") {
        // Shadow telemetry records the independent tab workflow verdict,
        // not a fabricated text match on the original page.
        emitAgentEvent("evidence_snapshot", makeEvidenceSnapshot(goal, {
          completed: true,
          evidence: { tabWorkflow: evidence }
        }, step, "post_action"));
      }
      emitAgentEvent("goal_verified", { url: observation.url });
      return {
        status: "verified_complete",
        steps: history.length,
        finalUrl: page.url(),
        reason: `Read heading "${evidence.observedHeading}" in the new tab; returned to original tab; both remain open.`,
        verification: { completed: true, evidence: { tabWorkflow: evidence } },
        history
      };
    }

    navigationGuard.observe(observation.url);

    const navigationVerified = !explicitTabWorkflow &&
      navigationGuard.canComplete(
        verification.completed,
        observation,
        goal
      );

    if (navigationVerified) {
      emitAgentEvent("goal_verified", {
        url: observation.url
      });
    }

    const latestValidationFeedback = [...history]
      .reverse()
      .find(entry =>
        typeof entry.validationFeedback === "string" &&
        entry.validationFeedback.trim()
      )?.validationFeedback ?? "";

    let desiredStatePlan = null;

    if (deterministicFormPlanning && !navigationVerified) {
      try {
        const extraction = immutableIntentBaseline
          ? deriveDesiredStateFromBaseline(
              immutableIntentBaseline,
              observation,
              latestValidationFeedback,
              originalInstruction
            )
          : await extractDesiredState(
              originalInstruction,
              observation,
              latestValidationFeedback
            );

        const coverage = immutableIntentBaseline
          ? verifyAnchoredRequirementCoverage({
              baseline: immutableIntentBaseline,
              extraction,
              validationFeedback: latestValidationFeedback
            })
          : await verifyRequirementCoverage({
              instruction: originalInstruction,
              observation,
              extraction,
              validationFeedback: latestValidationFeedback
            });

        const completeness = evaluateFormCompleteness({
          extraction,
          attestation: coverage.attestation
        });

        if (
          !coverage.verified ||
          completeness.status === "unresolved" ||
          completeness.status === "unverified"
        ) {
          return {
            status: "form_requirements_unverified",
            reason: !coverage.verified
              ? "requirement_coverage_failed"
              : completeness.reason,
            coverageIssues: coverage.issues,
            steps: history.length,
            history
          };
        }

        if (
          immutableIntentBaseline === null &&
          latestValidationFeedback === "" &&
          coverage.verified &&
          coverage.attestation?.verified === true &&
          coverage.attestation?.source === "independent_verifier" &&
          completeness.status !== "unresolved" &&
          completeness.status !== "unverified"
        ) {
          immutableIntentBaseline = Object.freeze({
            requirements: Object.freeze(
              extraction.requirements.map(requirement =>
                Object.freeze({ ...requirement })
              )
            ),
            attestation: Object.freeze({
              verified: coverage.attestation.verified,
              source: coverage.attestation.source,
              requirements: Object.freeze(
                coverage.attestation.requirements.map(requirement =>
                  Object.freeze({ ...requirement })
                )
              )
            })
          });
        }

        desiredStatePlan = reconcileDesiredState(
          extraction.requirements,
          observation
        );

        if (desiredStatePlan.unresolved.length > 0) {
          return {
            status: "form_requirements_unverified",
            reason: "form_fields_missing_or_ambiguous",
            unresolvedRequirements: desiredStatePlan.unresolved,
            steps: history.length,
            history
          };
        }
      } catch (error) {
        return {
          status: "form_requirements_unverified",
          reason: "desired_state_planning_failed",
          detail: error.message,
          steps: history.length,
          history
        };
      }
    }


    if (currentPageOnly && step === 1) {
      return {
        status: verification.completed
          ? "verified_complete"
          : "content_not_found_on_current_page",
        steps: 0,
        finalUrl: page.url(),
        verification,
        history
      };
    }

    console.log("Page:", observation.title);
    console.log("URL:", observation.url);
    console.log("Goal verification:", verification.completed);

    if (!verification.completed && process.env.COPILOT_VERIFIER_DEBUG === "1") {
      if (!sensitiveTask) {
      console.log(
        "[68P VERIFIER DEBUG]",
        JSON.stringify({
          url: observation.url,
          goal,
          verification,
          headings: observation.headings,
          title: observation.title,
          visibleTextIncludesGoal:
            typeof goal?.text === "string"
              ? String(observation.visibleBodyText || "")
                  .toLowerCase()
                  .includes(goal.text.toLowerCase())
              : null
        }, null, 2)
      );
    }
    }

    if (navigationVerified) {
      const preserved = formMutationPolicy.verify(observation);
      emitAgentEvent("evidence_invariant", {passed:preserved.verified === true});
      if (!preserved.verified) {
        return {
          status: 'protected_form_state_changed',
          reason: 'Unrequested form controls differ from their initial browser states.',
          preservationIssues: preserved.issues,
          steps:history.length, finalUrl:page.url(),history
        };
      }
      const persistence = await verifyPersistence({
        page,
        goal,
        observer,
        allowReload: persistencePolicy?.allowReload === true,
        workflowCategory:
          persistencePolicy?.workflowCategory ?? "unknown"
      });

      const persistenceRequired =
        persistencePolicy?.requirePersistence === true;

      let completionStatus = "verified_complete";

      if (persistenceRequired) {
        if (persistence.status === "persisted_verified") {
          completionStatus = "persisted_complete";
        } else if (persistence.status === "persistence_failed") {
          completionStatus = "persistence_failed";
        } else {
          completionStatus = "persistence_unverified";
        }
      }

      return {
        status: completionStatus,
        steps: history.length,
        finalUrl: page.url(),
        verification,
        persistence,
        history
      };
    }

    // Use a real, newly observed tab ref only when the user's instruction
    // explicitly demands these two tab transitions. Normal tab tasks and
    // model-selected browser actions continue through the original planner.
    const guidedTabAction = explicitTabWorkflow?.nextAction(page);
    if (guidedTabAction) {
      const target = tabContext.resolve(guidedTabAction.ref);
      if (target && target !== page) {
        const previousUrl = page.url();
        emitAgentEvent("action_selected", {
          ref: guidedTabAction.ref,
          operation: "switch_tab",
          url: previousUrl
        });
        await target.bringToFront();
        page = target;
        history.push({
          step,
          decision: guidedTabAction,
          execution: {
            operation: "switch_tab",
            executionCompleted: true,
            verified: true,
            previousUrl,
            urlAfter: page.url()
          }
        });
        emitAgentEvent("action_executed", {
          ref: guidedTabAction.ref,
          operation: "switch_tab",
          executionCompleted: true,
          verified: true,
          url: page.url()
        });
        continue;
      }
    }

    // Direct mode, no starting URL: the run found and opened this page
    // itself. If that already is everything the user asked for, say so
    // before choosing any action instead of wandering around the page.
    if (directMode && arrivedByDiscovery && history.length === 0 &&
        !directArrivalChecked) {
      directArrivalChecked = true;
      const arrival = verifyDirectCompletion({
        instruction: originalInstruction,
        claim: "",
        observation,
        history,
        preservation: formMutationPolicy.verify(observation),
        workflow: verification?.evidence ?? {},
        tabs: tabState(),
        arrivedByDiscovery: true
      });
      emitAgentEvent("completion_checked", {
        completed: arrival.completed === true,
        url: observation.url
      });
      if (arrival.completed === true) {
        emitAgentEvent("goal_verified", { url: observation.url });
        return {
          status: "verified_complete",
          steps: 0,
          finalUrl: page.url(),
          reason: arrival.reason,
          verification: arrival,
          history
        };
      }
      console.log("Not complete on arrival:", arrival.reason);
    }

    const rejectedActions = [];
    let planInvalidated = false;
    let decision = null;
    let tabSwitched = false;

    for (let attempt = 1; attempt <= MAX_REPLANS; attempt++) {
      if (attempt > 1) formFastPath.discard();
      console.log(`Planning attempt ${attempt}`);

      // A queued form action does not make a new Ollama request.
      const previouslyPlannedFormAction = attempt === 1
        ? formFastPath.peek(observation) : null;
      emitAgentEvent(previouslyPlannedFormAction
        ? 'form_fast_path_next' : 'planning_started', {
        attempt,
        url: observation.url,
        ...(previouslyPlannedFormAction
          ? {remaining:formFastPath.remaining()} : {})
      });

      try {
        const relevantElements = selectRelevantElements(
          task,
          observation.actionableElements,
          30
        );

        console.log(
          "Relevant candidates:",
          relevantElements.slice(0, 10).map(element => ({
            ref: element.ref,
            label: element.label,
            score: element.relevanceScore
          }))
        );

        // Original architecture:
        // One Ollama decision per observed DOM state.
        // Deterministic logic may validate/block an action,
        // but must not choose the next action.
        const directPdfDecision = explicitPdfRequest
          ? selectUniqueDirectPdfAction({
              instruction: originalInstruction,
              observation
            })
          : null;

        if (explicitPdfRequest && !directPdfDecision) {
          const signature = JSON.stringify({
            url: observation.url,
            historyLength: history.length,
            links: observation.actionableElements
              .filter(item => item.tag === "a")
              .slice(0, 40)
              .map(item => item.href)
          });

          if (signature === previousPdfPlanningSignature) {
            repeatedPdfPlanningCount++;
          } else {
            previousPdfPlanningSignature = signature;
            repeatedPdfPlanningCount = 0;
          }

          if (
            repeatedPdfPlanningCount >= 2 ||
            Date.now() >= pdfPlanningDeadline
          ) {
            emitAgentEvent("planning_stagnation", {
              reason: "PDF planning made no progress.",
              url: observation.url
            });

            return {
              status: "planning_stagnation",
              reason:
                "No verified PDF target found after repeated planning.",
              steps: history.length,
              finalUrl: page.url(),
              history
            };
          }
        }

        // A single bounded Qwen plan may cover independent form edits.
        // Each queued action still passes this loop's existing constraints,
        // approval, Playwright execution, and browser verification.
        // Injected test reasoners are unchanged unless a batch planner is
        // explicitly supplied.
        const batchPlanner = process.env.COPILOT_FORM_FAST_PATH === '0'
          ? null : (formBatchPlanner ??
          (reasoner === decideNextAction ? proposeFormBatch : null));
        let queuedFormAction = attempt === 1
          ? formFastPath.peek(observation) : null;
        if (!queuedFormAction && attempt === 1 && batchPlanner &&
            formFastPath.canAttempt() && !explicitPdfRequest &&
            !explicitTabWorkflow && !sensitiveTask &&
            !deterministicFormPlanning &&
            eligibleForFormFastPath({instruction:originalInstruction,goal,observation})) {
          formFastPath.markAttempted();
          try {
            const context = {instruction:originalInstruction,goal,observation};
            // The existing interpreter has already paid for a structured
            // goal. Use it directly when every control is uniquely grounded.
            // Injected test reasoners retain their original behavior.
            const grounded = reasoner === decideNextAction && !formBatchPlanner
              ? proposeGroundedFormBatch(context) : null;
            const proposal = grounded ?? await batchPlanner(context);
            const proposed = grounded ?? validateFormBatch(
              {actions:proposal}, observation,
              {instruction:originalInstruction,goal}
            );
            if (proposed && formFastPath.start(proposed,observation)) {
              queuedFormAction = formFastPath.peek(observation);
              emitAgentEvent('form_fast_path_planned', {
                count:proposed.length, source:grounded ? 'goal_grounded' : 'model_batch'
              });
            } else {
              emitAgentEvent('form_fast_path_fallback', {reason:'no_safe_batch'});
            }
          } catch (error) {
            console.log('Form fast path unavailable; original planner retained:', error.message);
          }
        }
        const completionRequest = checkCompletionNext
          ? { ref: "", operation: "done", value: "" } : null;
        checkCompletionNext = false;
        // After a click was covered by a dialog or banner, offer only the
        // controls a click can reach until some action goes through.
        const plannerObservation = overlayBlocked && !completionRequest &&
          !directPdfDecision && !queuedFormAction
          ? {
              ...observation,
              actionableElements: await reachableElements(page, observation.actionableElements)
            }
          : observation;
        const candidate = completionRequest ?? directPdfDecision ?? queuedFormAction ?? await reasoner(
          originalInstruction,
          plannerObservation,
          history,
          rejectedActions,
          goal,
          verification
        );

        if (
          explicitPdfRequest &&
          candidate?.operation === "fill" &&
          history.some(entry =>
            entry.decision?.operation === "fill" &&
            entry.decision?.ref === candidate.ref &&
            entry.execution?.executionCompleted === true
          )
        ) {
          rejectedActions.push(candidate);
          continue;
        }

        if ((await runControl?.checkpoint(planRevision))?.stale) {
          planInvalidated = true;
          break;
        }

        // Hover must be explicitly requested, never inferred as an extra step.
        if (candidate.operation === "hover" &&
            !/\b(?:hover|mouse\s*over|move\s+(?:the\s+)?(?:pointer|cursor)\s+over)\b/i.test(originalInstruction)) {
          rejectedActions.push(candidate);
          continue;
        }

        if (candidate.operation === "switch_tab") {
          const target = tabContext.resolve(candidate.ref);

          if (!target || target === page) {
            rejectedActions.push(candidate);
            continue;
          }

          const previousUrl = page.url();
          // A tab switch has no page element, so it is recorded here by hand;
          // otherwise the run's record would not show it.
          emitAgentEvent("action_selected", {
            ref: candidate.ref, operation: "switch_tab",
            targetLabel: String(await target.title().catch(() => "") ||
              target.url()).slice(0, 80),
            url: previousUrl
          });
          await target.bringToFront();
          page = target;
          emitAgentEvent("action_executed", {
            ref: candidate.ref, operation: "switch_tab",
            executionCompleted: true, verified: true, url: page.url()
          });

          history.push({
            step,
            decision: candidate,
            execution: {
              operation: "switch_tab",
              executionCompleted: true,
              verified: true,
              previousUrl,
              urlAfter: page.url()
            }
          });

          tabSwitched = true;
          break;
        }

        if (candidate.operation === "back") {
          const recentNavigation = [...history].reverse().find(entry =>
            entry.execution?.executionCompleted === true &&
            entry.decision?.operation === 'click' &&
            entry.execution?.urlAfter &&
            entry.execution?.previousUrl !== entry.execution?.urlAfter
          );
          if (!recentNavigation || backNavigations >= 2) {
            rejectedActions.push(candidate);
            continue;
          }
          const fromUrl = page.url();
          const nav = await page.goBack({
            waitUntil: 'domcontentloaded', timeout: 6000
          }).catch(() => null);
          if (!nav || fromUrl === page.url()) {
            rejectedActions.push(candidate);
            continue;
          }
          backNavigations += 1;
          emitAgentEvent('action_executed', {
            operation: 'back', ref: '', executionCompleted: true,
            verified: true, url: page.url()
          });
          history.push({
            step,
            decision: {ref:'', operation:'back', value:''},
            execution: {
              operation:'back', executionCompleted:true,
              verified:true, previousUrl:fromUrl, urlAfter:page.url()
            }
          });
          tabSwitched = true;
          break;
        }

        if (candidate.operation === 'scroll') {
          if (!/\bscroll\b/i.test(originalInstruction)) {
            rejectedActions.push(candidate);
            continue;
          }
          const beforeUrl = page.url();
          // Where the page is scrolled to, read from the browser itself.
          const scrollState = () => page.evaluate(() => {
            const root = document.scrollingElement || document.documentElement;
            const y = Math.round(window.scrollY);
            return { y, height: root.scrollHeight,
              atTop: y <= 2,
              atBottom: y + window.innerHeight >= root.scrollHeight - 2 };
          }).catch(() => null);
          // "to the bottom / end" and "to the top" mean all the way, not one
          // screenful. Everything else moves one step in the asked direction.
          const wantsUp = candidate.value === 'up' || candidate.value === 'top';
          const toEdge = candidate.value === 'bottom' || candidate.value === 'top' ||
            (wantsUp
              ? /\bscroll\w*\b[^.;]*\b(?:top|beginning|start)\b/i
              : /\bscroll\w*\b[^.;]*\b(?:bottom|end|footer)\b/i
            ).test(originalInstruction);
          const scrollGoal = toEdge ? (wantsUp ? 'top' : 'bottom')
            : (wantsUp ? 'up' : 'down');
          const scrollBefore = await scrollState();
          // Scrolling again in a direction the page cannot move any further
          // changes nothing: the planner has nothing new to offer.
          if (directMode && scrollBefore &&
              (wantsUp ? scrollBefore.atTop : scrollBefore.atBottom)) {
            console.log('Rejected scroll: the page is already at that end.');
            rejectedActions.push(candidate);
            if (directCompletionRejections === 0) checkCompletionNext = true;
            continue;
          }
          if (toEdge) {
            // Pages that load more as they scroll grow; follow them a few times.
            for (let pass = 0, lastHeight = -1; pass < 8; pass += 1) {
              await page.evaluate(up => {
                const root = document.scrollingElement || document.documentElement;
                window.scrollTo(0, up ? 0 : root.scrollHeight);
              }, wantsUp);
              await page.waitForTimeout(400);
              const now = await scrollState();
              if (!now || wantsUp || now.height === lastHeight) break;
              lastHeight = now.height;
            }
          } else {
            await page.mouse.wheel(0, wantsUp ? -700 : 700);
            await page.waitForTimeout(350);
          }
          // Scrolling has no element, so it is recorded here by hand; without
          // this the run's record would say no action was taken.
          emitAgentEvent('action_selected', {
            ref: '', operation: 'scroll', targetLabel: 'page',
            scrollTo: scrollGoal, url: beforeUrl });
          const scrollAfter = await scrollState();
          const scrollMoved = Boolean(scrollBefore && scrollAfter &&
            scrollBefore.y !== scrollAfter.y);
          history.push({step,
            decision:{ref:'',operation:'scroll',value:candidate.value},
            execution:{operation:'scroll',executionCompleted:true,
              // Verified from the browser: the page really moved.
              verified:scrollMoved,previousUrl:beforeUrl,urlAfter:page.url(),
              scroll:{ moved: scrollMoved, atTop: scrollAfter?.atTop === true,
                atBottom: scrollAfter?.atBottom === true }}});
          emitAgentEvent('action_executed',{
            operation:'scroll',ref:'',executionCompleted:true,
            verified:scrollMoved,url:page.url()});
          tabSwitched = true;
          break;
        }

        if (candidate.operation === 'screenshot') {
          const request = screenshotRequest(originalInstruction);
          if (!request || !directMode || screenshotFailures >= 2) {
            rejectedActions.push(candidate);
            continue;
          }
          const beforeUrl = page.url();
          // The page itself has no element, so the step is recorded by hand.
          emitAgentEvent('action_selected', {
            ref: '', operation: 'screenshot', targetLabel: 'page', url: beforeUrl });
          let receipt = null;
          let problem = '';
          try {
            receipt = await saveScreenshot(page, mediaDirectory, { fullPage: request.fullPage });
          } catch (error) {
            problem = String(error?.message ?? error).replace(/^MEDIA_SAVE_FAILED:\s*/, '').slice(0, 160);
          }
          if (receipt) {
            history.push({step,
              decision:{ref:'',operation:'screenshot',value:''},
              execution:{operation:'screenshot',executionCompleted:true,verified:true,
                previousUrl:beforeUrl,urlAfter:page.url(),media:receipt}});
            emitAgentEvent('action_executed',{
              operation:'screenshot',ref:'',executionCompleted:true,
              verified:true,url:page.url()});
            emitAgentEvent('media_saved', {
              fileName: receipt.fileName, bytes: receipt.bytes, type: receipt.type,
              kind: 'screenshot', width: receipt.width, height: receipt.height });
          } else {
            screenshotFailures += 1;
            console.log('Screenshot not saved:', problem);
            emitAgentEvent('action_failed', {
              operation: 'screenshot', ref: '', reason: 'media_save_failed', url: page.url() });
            history.push({step,
              decision:{ref:'',operation:'screenshot',value:''},
              execution:{operation:'screenshot',executionCompleted:false,verified:false,
                errorCode:'MEDIA_SAVE_FAILED',errorDetail:problem,
                previousUrl:beforeUrl,urlAfter:page.url()}});
          }
          tabSwitched = true;
          break;
        }

        if (candidate.operation === "done" && directMode) {
          // The model's claim is only a request to check. Completion is
          // decided from the fresh observation and verified action results.
          const completion = verifyDirectCompletion({
            instruction: originalInstruction,
            claim: candidate.value,
            observation,
            history,
            preservation: formMutationPolicy.verify(observation),
            workflow: verification?.evidence ?? {},
            tabs: tabState(),
            arrivedByDiscovery
          });

          emitAgentEvent("completion_checked", {
            completed: completion.completed === true,
            url: observation.url
          });

          if (completion.completed === true) {
            emitAgentEvent("goal_verified", { url: observation.url });
            return {
              status: "verified_complete",
              steps: history.length,
              finalUrl: page.url(),
              reason: completion.reason,
              verification: completion,
              history
            };
          }

          directCompletionRejections += 1;
          console.log("Completion claim rejected:", completion.reason);

          if (directCompletionRejections >= MAX_DIRECT_COMPLETION_REJECTIONS) {
            return {
              status: "unverified_completion_claim",
              steps: history.length,
              finalUrl: page.url(),
              reason: completion.reason,
              verification: completion,
              history
            };
          }

          rejectedActions.push({
            ref: "",
            operation: "done",
            value: "",
            reason: completion.reason
          });
          continue;
        }

        if (candidate.operation === "done") {
          return {
            status: "unverified_completion_claim",
            steps: history.length,
            finalUrl: page.url(),
            verification,
            history
          };
        }

        const element = observation.actionableElements.find(
          item => item.ref === candidate.ref
        );

        if (!element) {
          rejectedActions.push(candidate);
          continue;
        }

        const constraintViolation = formMutationPolicy.reject(
          observation, element, candidate
        ) || rejectContradictoryFormAction(goal, element, candidate);
        // Direct mode: never undo a change this run already made and the
        // browser verified. The opposite action on the same control of the
        // same page would silently cancel completed work.
        const undoesOwnChange = directMode && !constraintViolation &&
          ['check','uncheck'].includes(candidate.operation) &&
          history.some(entry =>
            entry.execution?.executionCompleted === true &&
            entry.execution?.verified === true &&
            entry.decision?.ref === candidate.ref &&
            entry.execution?.urlAfter === observation.url &&
            ['check','uncheck'].includes(entry.decision?.operation) &&
            entry.decision.operation !== candidate.operation);
        if (undoesOwnChange) {
          console.log('Rejected action that undoes a verified change:', candidate.operation);
          rejectedActions.push(candidate);
          continue;
        }
        // Direct mode: a drag the browser already verified is never done a
        // second time between the same two places. Repeating it, or dragging
        // the two items back, would silently cancel the completed move (two
        // swapped boxes end up where they started). The planner has nothing
        // new to offer, so completion is checked from the browser next.
        const dragDestinationLabel = candidate.operation === 'drag'
          ? String(observation.actionableElements.find(
              item => item.ref === candidate.value)?.label ?? '')
          : '';
        const repeatsOwnDrag = directMode && !constraintViolation &&
          candidate.operation === 'drag' &&
          history.some(entry =>
            entry.decision?.operation === 'drag' &&
            entry.execution?.executionCompleted === true &&
            entry.execution?.verified === true &&
            entry.execution?.urlAfter === observation.url &&
            [entry.decision.ref, entry.decision.value].sort().join('>') ===
              [candidate.ref, candidate.value].sort().join('>') &&
            [entry.targetLabel ?? '', entry.destinationLabel ?? ''].sort().join('>') ===
              [String(element.label ?? ''), dragDestinationLabel].sort().join('>'));
        if (repeatsOwnDrag) {
          console.log('Rejected action that repeats or reverses a verified drag.');
          rejectedActions.push(candidate);
          if (directCompletionRejections === 0) checkCompletionNext = true;
          continue;
        }
        // Direct mode: the pointer is already over this element. Hovering
        // reveals content, which can renumber the page's elements, so the
        // same element is recognised by its name, not by its reference.
        const lastAction = history.at(-1);
        const repeatsOwnHover = directMode && !constraintViolation &&
          candidate.operation === 'hover' &&
          lastAction?.decision?.operation === 'hover' &&
          lastAction.execution?.executionCompleted === true &&
          lastAction.execution?.urlAfter === observation.url &&
          String(lastAction.targetLabel ?? '') !== '' &&
          lastAction.targetLabel === String(element.label ?? '');
        if (repeatsOwnHover) {
          console.log('Rejected action that repeats the hover already in place.');
          rejectedActions.push(candidate);
          if (directCompletionRejections === 0) checkCompletionNext = true;
          continue;
        }
        // Direct mode: the same key on the same field, straight after it was
        // pressed, is a repeat unless the user asked for more than one press
        // ("press Tab three times", "press ArrowDown until ...").
        const repeatsOwnKeyPress = directMode && !constraintViolation &&
          candidate.operation === 'press' &&
          lastAction?.decision?.operation === 'press' &&
          lastAction.execution?.executionCompleted === true &&
          lastAction.execution?.urlAfter === observation.url &&
          String(lastAction.decision.value ?? '').toLowerCase() ===
            String(candidate.value ?? '').toLowerCase() &&
          String(lastAction.targetLabel ?? '') === String(element.label ?? '') &&
          !/\b(?:twice|thrice|times|again|repeatedly|until|each|every|two|three|four|five|six|seven|eight|nine|ten|[2-9]|\d{2,})\b/i
            .test(originalInstruction);
        if (repeatsOwnKeyPress) {
          console.log('Rejected action that repeats the key press just made.');
          rejectedActions.push(candidate);
          if (directCompletionRejections === 0) checkCompletionNext = true;
          continue;
        }
        // Ending the session undoes a login. It is never an extra step: unless
        // the user asked for it, it is refused and completion is checked.
        if (directMode && candidate.operation === "click" &&
            /\b(?:log\s?-?out|sign\s?-?out)\b/i.test(
              [element.label, element.text, element.ariaLabel].filter(Boolean).join(" ")) &&
            !/\b(?:log\s?-?out|sign\s?-?out)\b/i.test(originalInstruction)) {
          console.log('Rejected action that ends the session; it was not requested.');
          rejectedActions.push(candidate);
          if (directCompletionRejections === 0) checkCompletionNext = true;
          continue;
        }
        if (constraintViolation) {
          console.log('Rejected goal-contradicting action:', constraintViolation);
          rejectedActions.push(candidate);
          continue;
        }

        // Ground destination choices against available link evidence.
        // Reject unrelated links only when a matching target is currently
        // observable. The model still chooses which valid link to click.
        const destination = goal?.type === "page_destination" ? goal :
          goal?.type === "all_of"
            ? goal.conditions.find(c => c.type === "page_destination")
            : null;
        const targetName = String(destination?.heading || destination?.identity || "")
          .toLowerCase().trim();
        const isTargetLink = link => {
          const label = String(link.label ?? "").toLowerCase().trim();
          const href = String(link.href ?? "").toLowerCase();
          return link.tag === "a" && Boolean(targetName) &&
            (label === targetName || href.includes(targetName.replace(/\s+/g, "_")));
        };
        if (candidate.operation === "click" && element.tag === "a" &&
          targetName && !isTargetLink(element) &&
          observation.actionableElements.some(isTargetLink)) {
          rejectedActions.push(candidate);
          console.log("Rejected unrelated destination link:", candidate.ref);
          continue;
        }

        // Generic exact-count guard: "click Add Element twice" is not a
        // license to click it twelve times just because the DOM changes.
        const repeatedClick = originalInstruction.match(
          /\bclick\s+["']?(.+?)["']?\s+(twice|once|\d+\s+times?)\b/i
        );
        if (candidate.operation === 'click' && repeatedClick) {
          const requested = repeatedClick[2].toLowerCase() === 'twice'
            ? 2 : repeatedClick[2].toLowerCase() === 'once'
              ? 1 : Number(repeatedClick[2].match(/\d+/)?.[0]);
          const named = repeatedClick[1].replace(/["']/g,'').trim().toLowerCase();
          const actual = String(element.label || '').trim().toLowerCase();
          if (actual === named && Number.isFinite(requested)) {
            const performed = history.filter(entry =>
              entry.execution?.executionCompleted &&
              entry.decision?.operation === 'click' &&
              String(entry.targetLabel || '').toLowerCase() === actual
            ).length;
            if (performed >= requested) {
              rejectedActions.push(candidate);
              console.log('Prevented excessive repeated click:', actual);
              continue;
            }
          }
        }

        const redundantFill =
          candidate.operation === "fill" &&
          element.currentValue === candidate.value;

        const redundantCheck =
          candidate.operation === "check" &&
          element.checked === true;

        if (
            redundantFill ||
            redundantCheck ||
            isRedundantFormAction(candidate, observation)
          ) {
          console.log("Rejected redundant action:", {
              ref: candidate.ref,
              operation: candidate.operation
            });
          rejectedActions.push(candidate);
          continue;
        }

        if (
          stagnationRecovery.isIneffective(
            observation,
            element,
            candidate
          )
        ) {
          console.log(
            "Recovery rejected ineffective action:",
            { ref: candidate.ref, operation: candidate.operation }
          );

          rejectedActions.push(candidate);
          if (directMode && directCompletionRejections === 0) {
            checkCompletionNext = true;
          }
          continue;
        }

        const progressCheck = progressGuard.check(
          observation,
          element,
          candidate
        );

        if (!progressCheck.allowed) {
          console.log(
            "Progress guard rejected:",
            progressCheck.reason,
            { ref: candidate.ref, operation: candidate.operation }
          );

          rejectedActions.push(candidate);
          continue;
        }

        decision = candidate;
        break;

      } catch (error) {
        console.log(
            "Planning error:",
            sensitiveTask ? "[REDACTED]" : error.message
          );

        // Retry planning rather than immediately terminating.
        // The current catalog will still reject invalid operations.
      }
    }

    if (tabSwitched) continue;

    if (planInvalidated) {
      emitAgentEvent("plan_invalidated", {
        reason: "Reobserve after pause or resume."
      });
      continue;
    }

    // A final, narrowly scoped recovery for a uniquely grounded checkbox
    // explicitly requested by the user. It does not relax the preservation,
    // safety, progress, or completion checks for ordinary model actions.
    if (!decision) {
      const recovery = recoverExplicitBooleanAction({
        instruction: originalInstruction, goal, observation
      });
      if (recovery) {
        const target = observation.actionableElements.find(
          item => item.ref === recovery.ref
        );
        const violation = target && (
          formMutationPolicy.reject(observation,target,recovery) ||
          rejectContradictoryFormAction(goal,target,recovery)
        );
        if (target && !violation &&
            !isRedundantFormAction(recovery,observation) &&
            !stagnationRecovery.isIneffective(observation,target,recovery) &&
            progressGuard.check(observation,target,recovery).allowed) {
          decision = recovery;
          console.log('Recovered explicit checkbox target from browser evidence:', {
            ref: recovery.ref, operation: recovery.operation
          });
          emitAgentEvent('planning_recovered', {
            ref: recovery.ref, operation: recovery.operation,
            reason: 'unique_unmet_explicit_checkbox'
          });
        } else {
          console.log('Explicit checkbox recovery rejected by safety or progress guard:',
            violation || 'no_safe_progress');
        }
      }
    }

    // Last-resort recovery for exactly one native submit control when the
    // user explicitly requested submission and all other field requirements
    // are already verified. Still requires normal safety approval.
    if (!decision) {
      const recovery = recoverExplicitSubmitAction({
        instruction: originalInstruction, goal, observation, verification, history
      });
      if (recovery) {
        const target = observation.actionableElements.find(
          item => item.ref === recovery.ref
        );
        const violation = target && (
          formMutationPolicy.reject(observation,target,recovery) ||
          rejectContradictoryFormAction(goal,target,recovery)
        );
        if (target && !violation &&
            !stagnationRecovery.isIneffective(observation,target,recovery) &&
            progressGuard.check(observation,target,recovery).allowed) {
          decision = recovery;
          console.log('Recovered explicit native submit target; approval still required:', {
            ref: recovery.ref, operation: recovery.operation
          });
          emitAgentEvent('planning_recovered', {
            ref: recovery.ref, operation: recovery.operation,
            reason: 'unique_explicit_submit_pending_approval'
          });
        }
      }
    }

    // Direct mode: the model asked to finish, the browser evidence did not
    // support it, and no further action was proposed. Report that honestly
    // rather than as a planner fault.
    if (!decision && directMode) {
      const rejectedCompletion = rejectedActions.find(
        action => action?.operation === "done"
      );
      if (rejectedCompletion) {
        return {
          status: "unverified_completion_claim",
          steps: history.length,
          finalUrl: page.url(),
          reason: rejectedCompletion.reason,
          verification: { completed: false, reason: rejectedCompletion.reason },
          history
        };
      }

      // The planner produced no usable action. Before reporting a planner
      // fault, check whether the browser already shows the finished task.
      const completion = verifyDirectCompletion({
        instruction: originalInstruction,
        claim: "",
        observation,
        history,
        preservation: formMutationPolicy.verify(observation),
        workflow: verification?.evidence ?? {},
        tabs: tabState(),
        arrivedByDiscovery
      });
      emitAgentEvent("completion_checked", {
        completed: completion.completed === true,
        url: observation.url
      });
      if (completion.completed === true) {
        emitAgentEvent("goal_verified", { url: observation.url });
        return {
          status: "verified_complete",
          steps: history.length,
          finalUrl: page.url(),
          reason: completion.reason,
          verification: completion,
          history
        };
      }
      console.log("No further action and not complete:", completion.reason);
    }

    if (!decision) {
      const guardRejectedAction = rejectedActions.some(
        action => action && action.ref
      );

      const freshObservationResult = await observer(page);

      if (freshObservationResult.status === "ready") {
        const freshObservation = freshObservationResult.observation;

        const fingerprint = value => JSON.stringify({
          url: value.url,
          headings: value.headings,
          // Ignore only synthetic first-observation metadata; all live
          // element properties remain part of the change fingerprint.
          actionableElements: (value.actionableElements ?? []).map(
            ({ initialChecked, ...liveElement }) => liveElement
          ),
          visibleBodyText: value.visibleBodyText
        });

        if (fingerprint(freshObservation) !== fingerprint(observation)) {
          console.log(
            "Page changed during planning. Reobserving without waiting."
          );
          continue;
        }
      }

      if (!guardRejectedAction && dynamicRecoveryAttempts < 2) {
        dynamicRecoveryAttempts++;

        console.log(
          "Waiting for dynamic DOM changes:",
          dynamicRecoveryAttempts
        );

        const changed = await waitForRelevantDomChange(page, {
          timeoutMs: 1800,
          sinceRevision: revisionBeforePlanning
        });

        if (changed) {
          console.log("Dynamic DOM change detected. Replanning.");
          continue;
        }
      }

      if (await attemptTreeBacktrack(step)) {
        stagnationDetector.reset();
        continue;
      }

      const previousStagnation = history.some(
        entry => entry.stagnation?.stagnating
      );

      return {
        status: previousStagnation
          ? "stagnation_detected"
          : "planning_stagnation",
        steps: history.length,
        finalUrl: page.url(),
        reason: previousStagnation
          ? "No effective action available after stagnation recovery."
          : "No valid action available during planning.",
        recoveryStatus: stagnationRecovery.getStatus(),
        history
      };
    }

    console.log("Selected action:", {
      ...decision,
      value: (sensitiveTask || decision.operation === "fill")
        ? "[REDACTED]"
        : decision.value
    });

    emitAgentEvent("action_selected", {
      ref: decision.ref,
      operation: decision.operation,
      targetLabel: observation.actionableElements?.find(
        item => item.ref === decision.ref
      )?.label ?? "",
      // Which key was pressed is not private either (typed text never is recorded).
      ...(decision.operation === "press"
        ? { pressKey: String(decision.value ?? "").slice(0, 20) } : {}),
      // A slider position is not private; record it so the run can be told.
      ...(decision.operation === "set_range"
        ? { setValue: String(decision.value ?? "").slice(0, 20) } : {}),
      // Where a dragged item is being dropped, so the record names both ends.
      ...(decision.operation === "drag"
        ? { destinationLabel: observation.actionableElements?.find(
            item => item.ref === decision.value)?.label ?? "" }
        : {}),
      targetIsLink: Boolean(
        observation.actionableElements?.find(
          item => item.ref === decision.ref
        )?.href
      ),
      url: observation.url
    });

    const element = observation.actionableElements.find(
      item => item.ref === decision.ref
    );

    if (
      decision.operation === "fill" &&
      !element.editable
    ) {
      throw new Error("Model selected a non-editable element.");
    }



    // Placed before the attempt is recorded: the submit has not happened yet,
    // so proposing it again after the person is done is not a repeat.
    // A form that holds an unsolved human-verification widget cannot be
    // submitted by the agent. Hand over just before the submit, not earlier:
    // reading or filling the form needs no person.
    if (isSubmitAction(decision, element)) {
      const challenge = await detectChallenge(page, observation);
      if (challenge.kind === "widget" || challenge.kind === "interstitial") {
        const outcome = await handOverChallenge(challenge, step);
        if (outcome.stop) return outcome.stop;
        continue;
      }
    }

    progressGuard.recordAttempt(
      observation,
      element,
      decision
    );

    const urlBeforeAction = page.url();
    const revisionBeforeAction = await getDomRevision(page).catch(() => null);

    const safetyDecision = authorizeBrowserAction(decision, element);

    // The user wrote this password in their own task, so it is typed into the
    // password field it was meant for. The value comes from the user's text,
    // never from the model's proposal or from the page. A field that is not
    // a plain password input, or any failure, falls back to the handover.
    if (statedPassword && directMode &&
        safetyDecision.classification === "human_handover" &&
        decision.operation === "fill" &&
        String(element.type ?? "").toLowerCase() === "password") {
      const target = await resolveElement(page, decision.ref).catch(() => null);
      let typed = false;
      try {
        const eligible = target && await target.evaluate(node =>
          node.isConnected && node instanceof HTMLInputElement &&
          node.type === "password" && !node.disabled && !node.readOnly);
        if (eligible) {
          await target.fill(statedPassword);
          typed = await target.evaluate(node => node.value.length > 0);
        }
      } catch {
        typed = false;
      }
      if (typed) {
        workflowVerifier.recordHumanHandover(decision, element, {
          verified: true,
          url: page.url()
        });
        // The password was typed once. If the site rejects it, typing the same
        // value again cannot help, so any later password field goes to the person.
        statedPassword = null;
        emitAgentEvent("action_executed", {
          ref: decision.ref, operation: "fill",
          executionCompleted: true, verified: true, url: page.url()
        });
        history.push({
          step,
          targetLabel: element.label,
          decision: { ref: decision.ref, operation: "fill", value: "" },
          execution: {
            executionCompleted: true,
            performedBy: "copilot",
            verified: true,
            urlAfter: page.url()
          }
        });
        continue;
      }
    }

    if (safetyDecision.classification === "human_handover") {
      const handle = await resolveElement(page, decision.ref)
        .catch(() => null);

      const boundingBox = handle
        ? await handle.boundingBox().catch(() => null)
        : null;

      const screenshot = await page.screenshot({
        type: "png"
      }).catch(() => null);

      const handover = {
        pageUrl: page.url(),
        field: {
          ref: decision.ref,
          label: String(element.label ?? ""),
          type: String(element.type ?? ""),
          boundingBox
        },
        reason: safetyDecision.reason,
        screenshotPngBase64: screenshot
          ? screenshot.toString("base64")
          : null
      };

      const paused = {
        status: "human_handover_required",
        steps: history.length,
        finalUrl: page.url(),
        handover,
        history
      };

      if (typeof humanHandoverProvider !== "function") {
        return paused;
      }

      const response = await humanHandoverProvider({
        page,
        handover,
          targetHandle: handle});

      if (response?.completed !== true) {
        return paused;
      }

      const isPasswordHandover =
        String(element.type ?? "").toLowerCase() === "password";

      let manualPasswordVerified = false;

      if (isPasswordHandover) {
        // Compare a specifically requested value only inside Chromium.
        // Otherwise check that the password field is populated.
        try {
            manualPasswordVerified = Boolean(
              handle &&
              page.url() === urlBeforeAction &&
              await handle.evaluate(node =>
                node.isConnected &&
                node instanceof HTMLInputElement &&
                node.type === "password" &&
                node.value.length > 0
              )
            );
          } catch {
          manualPasswordVerified = false;
        }

        if (!manualPasswordVerified) {
          return {
            status: "human_handover_unverified",
            reason: "Manual password entry was not verified.",
            steps: history.length,
            finalUrl: page.url(),
            history
          };
        }

        workflowVerifier.recordHumanHandover(
          decision,
          element,
          {
            verified: true,
            url: page.url()
          }
        );
      }


      // Recorded so the run's report can say the person entered the value.
      emitAgentEvent("action_selected", {
        ref: decision.ref, operation: "human_handover",
        targetLabel: String(element.label ?? "").slice(0, 80), url: urlBeforeAction
      });
      emitAgentEvent("action_executed", {
        ref: decision.ref, operation: "human_handover",
        executionCompleted: true, verified: manualPasswordVerified, url: page.url()
      });

      history.push({
        step,
        targetLabel: element.label,
        decision: {
          ref: decision.ref,
          operation: "human_handover",
          value: ""
        },
        execution: {
          executionCompleted: true,
          performedBy: "user",
          verified: manualPasswordVerified
        }
      });

      // Resume from a fresh DOM observation.
      continue;
    }

    let actionApproval = null;

    const prospectiveSearchEnter =
      decision.operation === "press" &&
      /^(?:enter|numpadenter)$/i.test(decision.value) &&
      element.editable &&
      /\b(search|query|find)\b/i.test([
        element.label, element.name, element.placeholder, element.type
      ].filter(Boolean).join(" "));

    // Qwen3 may increase caution, but cannot authorize an action.
    // Only the executor's live safety classification can exempt a
    // search from approval. Preflight itself performs no browser action.
    let verifiedLiveSearchEnter = false;
    let liveGetSearchVerified = false;

    // The user asked to log in, and this is the login button of a sign-in
    // form: no approval is needed. The live page decides, not the model.
    let verifiedLoginSubmit = false;
    let loginMessagesBefore = [];
    if (directMode && decision.operation === "click" &&
        asksToLogIn(originalInstruction) &&
        safetyDecision.classification === "requires_approval") {
      try {
        const check = await executeAction(page, decision, {
          preflightOnly: true, loginRequested: true
        });
        verifiedLoginSubmit = check?.loginSubmission === true &&
          check?.classification === "safe";
      } catch {
        // Fail closed: retain normal human approval.
      }
      if (verifiedLoginSubmit) {
        // What the page already says, so only a response to the login counts.
        loginMessagesBefore = await readPageMessages(page).catch(() => []);
      }
    }

    if (prospectiveSearchEnter &&
        safetyDecision.classification === "requires_approval") {
      try {
        const check = await executeAction(page, decision, {
          preflightOnly: true
        });
        liveGetSearchVerified =
          check?.classification === "safe" &&
          check?.verifiedSearchContext === true &&
          check?.sensitiveFormContext === false;
      } catch {
        // Fail closed: retain normal human approval.
      }

      const aiCautions =
        process.env.COPILOT_ACTION_RISK_V2 !== "0" &&
        ["uncertain", "consequential"].includes(
          decision.riskAdvisory?.level
        );

      verifiedLiveSearchEnter =
        liveGetSearchVerified && !aiCautions;

      if (process.env.COPILOT_ACTION_RISK_V2 !== "0") {
        console.log("[APPROVAL V2]", {
          aiRisk: decision.riskAdvisory?.level ?? "not_available",
          liveGetSearchVerified,
          approvalRequired: !verifiedLiveSearchEnter
        });
      }
    }

    if (
      safetyDecision.classification === "requires_approval" &&
      !verifiedLiveSearchEnter &&
      !verifiedLoginSubmit &&
      typeof approvalProvider === "function"
    ) {
      const liveTarget = await inspectLiveTarget(page, decision);

      const candidate = await approvalProvider({
        action: Object.freeze({ ...decision }),
        element: Object.freeze({ ...element }),
        pageUrl: liveTarget.pageUrl,
        targetIdentity: liveTarget.targetIdentity,
        liveTarget: Object.freeze({ ...liveTarget.live }),
        ...(process.env.COPILOT_APPROVAL_V2 !== "0" ? {
          advisoryContext: buildApprovalAdvisoryContext({
            instruction: originalInstruction,
            history,
            pageTitle: observation.title,
            safetyReason: safetyDecision.reason,
            riskAdvisory: process.env.COPILOT_ACTION_RISK_V2 !== "0"
              ? decision.riskAdvisory : null
          })
        } : {})
      });

      if (
        candidate &&
        typeof candidate === "object" &&
        candidate.granted === true &&
        candidate.actionRef === decision.ref &&
        candidate.operation === decision.operation
      ) {
        actionApproval = candidate;
      }
    }

    const approvalPresent = actionApproval !== null;

    if (
      !safetyDecision.allowed &&
      !verifiedLiveSearchEnter &&
      !verifiedLoginSubmit &&
      !approvalPresent
    ) {
      return {
        status:
          safetyDecision.classification === "requires_approval"
            ? "approval_required"
            : safetyDecision.classification === "human_handover"
              ? "human_handover_required"
              : "action_blocked",
        action: decision,
        safety: safetyDecision,
        // Actions already carried out before this stop still happened;
        // report them so the run is not shown as having done nothing.
        steps: history.length,
        finalUrl: page.url(),
        history
      };
    }

    if (desiredStateGuard) {
      const proposedFinalization = isFinalizingAction(
        decision,
        element,
        goal,
        originalInstruction,
        observation
      );

      if (proposedFinalization) {
        const freshResult = await observer(page);

        if (freshResult.status !== "ready") {
          return {
            status: "form_completeness_unverified",
            reason: "fresh_observation_unavailable",
            steps: history.length,
            history
          };
        }

        const freshObservation = freshResult.observation;

        let extraction;
        let coverage;

        try {
          extraction = immutableIntentBaseline
            ? deriveDesiredStateFromBaseline(
                immutableIntentBaseline,
                freshObservation,
                latestValidationFeedback,
                originalInstruction
              )
            : await extractDesiredState(
                originalInstruction,
                freshObservation,
                latestValidationFeedback
              );

          coverage = immutableIntentBaseline
            ? verifyAnchoredRequirementCoverage({
                baseline: immutableIntentBaseline,
                extraction,
                validationFeedback: latestValidationFeedback
              })
            : await verifyRequirementCoverage({
                instruction: originalInstruction,
                observation: freshObservation,
                extraction,
                validationFeedback: latestValidationFeedback
              });
        } catch (error) {
          return {
            status: "form_completeness_unverified",
            reason: "verification_failed",
            detail: error.message,
            steps: history.length,
            history
          };
        }

        const completeness = evaluateFormCompleteness({
          extraction,
          attestation: coverage.attestation
        });

        const reconciliation = extraction.reconciliation;

        const liveStateSatisfied =
          reconciliation?.allSatisfied === true &&
          Array.isArray(reconciliation.pending) &&
          reconciliation.pending.length === 0 &&
          Array.isArray(reconciliation.unresolved) &&
          reconciliation.unresolved.length === 0;

        if (
          !coverage.verified ||
          !completeness.submissionEligible ||
          !liveStateSatisfied
        ) {
          return {
            status: "form_submission_blocked",
            reason: !coverage.verified
              ? "requirement_coverage_unverified"
              : !completeness.submissionEligible
                ? completeness.reason
                : "live_form_state_incomplete",
            coverageIssues: coverage.issues,
            pendingRequirements: reconciliation?.pending ?? [],
            unresolvedRequirements: reconciliation?.unresolved ?? [],
            steps: history.length,
            history
          };
        }

        // Verification must still describe the current page.
        const finalObservationResult = await observer(page);

        if (finalObservationResult.status !== "ready") {
          return {
            status: "form_completeness_unverified",
            reason: "final_observation_unavailable",
            steps: history.length,
            history
          };
        }

        const fingerprint = value => JSON.stringify({
          url: value.url,
          actionableElements: value.actionableElements
        });

        if (
          fingerprint(finalObservationResult.observation) !==
          fingerprint(freshObservation)
        ) {
          return {
            status: "form_completeness_unverified",
            reason: "form_changed_during_verification",
            steps: history.length,
            history
          };
        }
      }
    }

    const checkpoint =
      await runControl?.checkpoint(planRevision);

    if (checkpoint?.stale) {
      emitAgentEvent("plan_invalidated", {
        reason: "Decision invalidated before execution."
      });
      continue;
    }

    // For the explicit new-tab reading workflow, subscribe BEFORE executing
    // the click. Otherwise a slow popup is absent from the next snapshot and
    // both model retries see stale one-tab evidence. This does not affect
    // other browsing, downloads, or normal model-selected tab operations.
    const newTabAfterClick =
      explicitTabWorkflow &&
      page === originalAgentPage &&
      decision.operation === "click" &&
      element?.tag === "a"
        ? page.waitForEvent("popup", { timeout: 4000 })
            .catch(() => null)
        : null;

    // Direct mode: notice a tab that this action opens. The listener belongs
    // to the real browser context; a tab is never assumed.
    const openedTabs = [];
    const noteOpenedTab = opened => openedTabs.push(opened);
    const watchForNewTab = directMode && !explicitTabWorkflow &&
      ["click", "press"].includes(decision.operation);
    if (watchForNewTab) page.context().on("page", noteOpenedTab);

    let result;
    try {
      const pdfCandidate =
                typeof onApprovedPdfClick === "function"
                  ? getEligiblePdfDownloadClick({
                      instruction: originalInstruction,
                      decision,
                      element,
                      pageUrl: page.url()
                    })
                  : null;

              if (pdfCandidate) {
                  const descriptionEvidence =
                    await capturePdfDescriptionEvidence(
                      page,
                      originalInstruction,
                      pdfCandidate.href
                    );

                  const selectedPdfLink = {
                    ...pdfCandidate,
                    ...(descriptionEvidence
                      ? { descriptionEvidence }
                      : {})
                  };

                // Reuse the exact existing executor and approval token.
                // The callback must never execute a second click.
                let actionPerformed = false;

                const receipt = await onApprovedPdfClick({
                  instruction: originalInstruction,
                  selectedLink: selectedPdfLink,
                  pageTitle: observation?.title ?? "",

                  performApprovedAction: async () => {
                    if (actionPerformed) {
                      throw new Error("DOWNLOAD_ACTION_ALREADY_EXECUTED");
                    }

                    actionPerformed = true;

                    const performed = await executeAction(
                      page,
                      decision,
                      { approval: actionApproval }
                    );

                    if (performed?.executionCompleted !== true) {
                      throw new Error("DOWNLOAD_CLICK_NOT_COMPLETED");
                    }

                    return performed;
                  }
                });

                if (
                  !actionPerformed ||
                  receipt?.status !== "download_ready" ||
                  receipt?.verified !== true ||
                  receipt?.identity?.matched !== true ||
                  typeof receipt.filename !== "string" ||
                  !Number.isSafeInteger(receipt.bytes) ||
                  receipt.bytes < 100 ||
                  !/^[a-f0-9]{64}$/i.test(
                    String(receipt.sha256 ?? "")
                  ) ||
                  !/^\/api\/download\/[a-f0-9]{48}$/.test(
                    String(receipt.downloadUrl ?? "")
                  )
                ) {
                  throw new Error(
                    "VERIFIED_DOWNLOAD_RECEIPT_REQUIRED"
                  );
                }

                const completed = {
                  step,
                  decision: {
                    ref: decision.ref,
                    operation: decision.operation,
                    value: ""
                  },
                  execution: {
                    operation: "click",
                    executionCompleted: true,
                    verified: true,
                    previousUrl: urlBeforeAction,
                    urlAfter: page.url()
                  }
                };

                emitAgentEvent("action_executed", {
                  ref: decision.ref,
                  operation: "click",
                  executionCompleted: true,
                  verified: true,
                  url: page.url()
                });

                emitAgentEvent("download_verified", {
                  filename: receipt.filename,
                  bytes: receipt.bytes
                });

                return {
                  status: "download_ready",
                  steps: history.length + 1,
                  history: [...history, completed],
                  finalUrl: page.url(),
                  verified: true,
                  filename: receipt.filename,
                  bytes: receipt.bytes,
                  sha256: receipt.sha256,
                  downloadUrl: receipt.downloadUrl,
                  expiresAt: receipt.expiresAt,
                  identity: receipt.identity
                };
              }

              result = await executeAction(page, decision, {
                approval: actionApproval,
                loginRequested: verifiedLoginSubmit,
                mediaDirectory
              });


    } catch (error) {
      // The executor rejects an unavailable native select option BEFORE
      // changing the control. Reobserve and allow a different model-selected
      // option only; never invent a replacement, retry identical evidence,
      // or treat a failed selection as successful.
      if (
        decision.operation === 'select' &&
        String(error?.message ?? '').startsWith('SELECT_OPTION_UNAVAILABLE:') &&
        unavailableSelectRecoveries < 2 &&
        actionApproval === null &&
        !sensitiveTask
      ) {
        unavailableSelectRecoveries += 1;
        stagnationRecovery.remember(observation, element, decision);
        console.log('Unavailable select option: suppressing identical selection on unchanged page state.');
        emitAgentEvent('action_failed', {
          operation: 'select', ref: decision.ref,
          reason: 'select_option_unavailable', url: page.url()
        });
        history.push({
          step,
          decision: { ref: decision.ref, operation:'select', value:'' },
          execution: {
            operation:'select', executionCompleted:false,
            verified:false, errorCode:'SELECT_OPTION_UNAVAILABLE',
            previousUrl:urlBeforeAction, urlAfter:page.url()
          },
          progress: { classification:'action_blocked', goalCompleted:false }
        });
        continue;
      }
      // The page moved on (a redirect, a late navigation) or the element was
      // replaced between looking and acting. The executor refuses such an action
      // BEFORE doing anything, so nothing happened: look again and decide again.
      // Bounded, and never when an approval was granted for the old target.
      if (
        /Re-observation required\.$/.test(String(error?.message ?? '')) &&
        !String(error?.message ?? '').startsWith('SAFETY_') &&
        pageChangedRecoveries < 3 &&
        actionApproval === null &&
        !sensitiveTask
      ) {
        pageChangedRecoveries += 1;
        console.log('Page changed before the action: observing again.');
        emitAgentEvent('action_failed', {
          operation: decision.operation, ref: decision.ref,
          reason: 'page_changed_before_action', url: page.url()
        });
        continue;
      }
      // A picture that could not be saved is a failed action, not a crash.
      // The reason is kept for the report; the file was not written.
      if (
        error?.code === 'MEDIA_SAVE_FAILED' &&
        decision.operation === 'save_image' &&
        mediaSaveFailures < 2
      ) {
        mediaSaveFailures += 1;
        stagnationRecovery.remember(observation, element, decision);
        console.log('Picture not saved:', String(error.message).slice(0, 160));
        emitAgentEvent('action_failed', {
          operation: 'save_image', ref: decision.ref,
          reason: 'media_save_failed', url: page.url()
        });
        history.push({
          step,
          targetLabel: element?.label ?? '',
          decision: { ref: decision.ref, operation:'save_image', value:'' },
          execution: {
            operation:'save_image', executionCompleted:false,
            verified:false, errorCode:'MEDIA_SAVE_FAILED',
            errorDetail: String(error.message).replace(/^MEDIA_SAVE_FAILED:\s*/, '').slice(0, 160),
            previousUrl:urlBeforeAction, urlAfter:page.url()
          },
          progress: { classification:'action_blocked', goalCompleted:false }
        });
        continue;
      }
      // The click was performed but the page it opened never began to load.
      // Never click again automatically: a repeated click could repeat a
      // submission. Stop and say so.
      if (error?.code === 'ACTION_NAVIGATION_TIMEOUT' && decision.operation === 'click') {
        emitAgentEvent('action_failed', {
          operation: 'click', ref: decision.ref,
          reason: 'page_not_responding', url: page.url()
        });
        history.push({
          step,
          decision: { ref: decision.ref, operation:'click', value:'' },
          execution: {
            operation:'click', executionCompleted:true,
            verified:false, errorCode:'ACTION_NAVIGATION_TIMEOUT',
            previousUrl:urlBeforeAction, urlAfter:page.url()
          },
          progress: { classification:'action_outcome_unknown', goalCompleted:false }
        });
        return {
          status: 'page_not_responding',
          steps: history.length,
          finalUrl: page.url(),
          reason:
            'The click was performed, but the page it opened did not respond. ' +
            'Loading was stopped; the previous page is unchanged.',
          history
        };
      }
      if (
        error?.code === 'ACTION_CLICK_BLOCKED' &&
        decision.operation === 'click' &&
        blockedClickRecoveries < 2
      ) {
        blockedClickRecoveries += 1;
        // A blocked click is failed browser evidence, not an invitation to
        // repeat the same action against an unchanged observed page state.
        // A changed page fingerprint permits reconsideration after reobserve.
        stagnationRecovery.remember(observation, element, decision);
        if (error.blockedBy) overlayBlocked = true;
        console.log('Click obstructed: suppressing identical retry on unchanged page state.');
        emitAgentEvent('action_failed', {
          operation: 'click', ref: decision.ref,
          reason: 'blocked_click', url: page.url()
        });
        history.push({
          step,
          decision: { ref: decision.ref, operation:'click', value:'' },
          execution: {
            operation:'click', executionCompleted:false,
            verified:false, errorCode:'ACTION_CLICK_BLOCKED',
            ...(error.blockedBy ? { blockedBy: error.blockedBy } : {}),
            previousUrl:urlBeforeAction, urlAfter:page.url()
          },
          progress: { classification:'action_blocked', goalCompleted:false }
        });
        continue;
      }
      // The action itself was carried out; the page then asked a question in
      // a confirm/prompt dialog, which is never answered automatically. Record
      // that truthfully before stopping, so the run is not told as "not done".
      if (error?.code === 'ACTION_NATIVE_DIALOG_INTERRUPTED') {
        emitAgentEvent("action_executed", {
          ref: decision.ref,
          operation: decision.operation,
          executionCompleted: true,
          verified: false,
          dialogStopped: String(error.dialogType ?? 'dialog'),
          url: page.url()
        });
      }
      throw error;
    }

    emitAgentEvent("action_executed", {
      ref: result.ref ?? decision.ref,
      operation: result.operation ?? decision.operation,
      executionCompleted: result.executionCompleted === true,
      verified: result.verified === true,
      ...(result.acknowledgedAlert === true ? { acknowledgedAlert: true } : {}),
      ...(result.openedTab === true ? { openedTab: true } : {}),
      url: result.urlAfter ?? page.url()
    });

    if (result.media?.verified === true) {
      emitAgentEvent("media_saved", {
        fileName: result.media.fileName,
        bytes: result.media.bytes,
        type: result.media.type
      });
    }

    result.previousUrl = urlBeforeAction;

    if (verifiedLoginSubmit && result.executionCompleted === true) {
      pendingLoginCheck = { before: loginMessagesBefore };
    }

    if (newTabAfterClick && result.executionCompleted === true) {
      // The event is owned by the real browser context; never synthesize a
      // tab on timeout. Wait for a real heading before the next observation.
      const openedTab = await newTabAfterClick;
      if (openedTab && !openedTab.isClosed() &&
          explicitTabWorkflow.registerSourcePopup(openedTab)) {
        await openedTab.locator("h1,h2,h3,h4,h5,h6").first()
          .waitFor({ state: "visible", timeout: 3500 })
          .catch(() => null);
      }
    }

    // A link that opens a new tab puts that tab in front, exactly as in a
    // normal browser. The agent follows it, so "in the new tab ..." and
    // "switch back to the first tab" mean what the user expects.
    if (watchForNewTab) {
      if (result?.executionCompleted === true && openedTabs.length === 0 &&
          page.url() === urlBeforeAction) {
        await page.waitForTimeout(300);
      }
      page.context().off("page", noteOpenedTab);
      const openedTab = openedTabs.filter(item => !item.isClosed()).at(-1);
      if (openedTab && result?.executionCompleted === true) {
        await openedTab.waitForLoadState("domcontentloaded", { timeout: 8000 })
          .catch(() => null);
        if (!openedTab.isClosed()) {
          await openedTab.bringToFront().catch(() => null);
          page = openedTab;
          result.openedTab = true;
          result.urlAfter = page.url();
          console.log("Followed the tab opened by this action:", page.url());
        }
      }
    }

    workflowVerifier.recordAction(
      decision,
      element,
      result
    );

    if (page.url() !== urlBeforeAction) {
      progressGuard.recordNavigation(page.url());
    }

    let afterObservationResult = await observer(page);

    // The page may answer a moment after the action ran. When nothing visibly
    // changed, give it a short, bounded chance before judging the action.
    if (afterObservationResult.status === "ready" && mayReactLate({
      decision, result, before: observation,
      after: afterObservationResult.observation,
      urlBefore: urlBeforeAction, urlNow: page.url()
    })) {
      if (await waitForLateReaction(page, { sinceRevision: revisionBeforeAction })) {
        console.log("The page reacted late. Re-observing.");
        afterObservationResult = await observer(page);
      }
    }

    if (afterObservationResult.status === 'ready') {
      afterObservationResult.observation = browserBaseline.enrich(afterObservationResult.observation);
      formMutationPolicy.observe(afterObservationResult.observation);
      if (result?.executionCompleted === true && isSubmitAction(decision, element)) {
        formMutationPolicy.acknowledgeSubmit(afterObservationResult.observation);
      }
      const preserved = formMutationPolicy.verify(afterObservationResult.observation);
      emitAgentEvent("evidence_invariant", {passed:preserved.verified === true});
      if (!preserved.verified) {
        return {
          status: 'protected_form_state_changed',
          reason: 'Unrequested form controls differ from their initial browser states.',
          preservationIssues: preserved.issues,
          steps:history.length + 1, finalUrl:page.url(),
          history:[...history,{step, decision, execution:result}]
        };
      }
    }

    // Only advance an action batch after execution + fresh observation.
    // Structural changes or browser navigation discard remaining actions.
    if (result?.executionCompleted === true && result?.verified === true &&
        afterObservationResult.status === "ready") {
      formFastPath.accepted(decision, observation, afterObservationResult.observation);
    } else {
      formFastPath.discard();
    }

    let progress;

    if (afterObservationResult.status === "ready") {
      progress = evaluateGoalProgress(
        observation,
        afterObservationResult.observation,
        goal
      );
    } else {
      progress = {
        classification: "post_action_observation_unavailable",
        stateChanged: null,
        goalProgress: null,
        goalCompleted: false
      };
    }

    // Reconcile post-action progress with the workflow verifier.
    // It preserves verified form actions across navigation and requires
    // fresh final-state evidence after consequential submissions.
    if (afterObservationResult.status === "ready") {
      const workflowResult = workflowVerifier.verify(
        afterObservationResult.observation
      );

      emitAgentEvent("evidence_snapshot", makeEvidenceSnapshot(
        goal, workflowResult, step, "post_action"
      ));

      if (workflowResult.completed === true) {
        progress = {
          ...progress,
          classification: "goal_completed",
          goalCompleted: true,
          goalProgress: true
        };
      }
    }

    const finalizingAction = isFinalizingAction(
      decision,
      element,
      goal,
      originalInstruction,
      observation
    );

    if (finalizingAction && !progress.goalCompleted) {
      // Native submit may replace the input form with a result document.
      // Field-state goals cannot be re-read from the new page; use verified
      // pre-submit states plus independent, new confirmation evidence.
      // Never retry a consequential action to manufacture this evidence.
      const inspectSubmission = candidate => {
        const outcome = verifySubmittedFormOutcome({
          instruction: originalInstruction,
          action: decision,
          element,
          before: observation,
          after: candidate,
          preActionVerification: verification
        });
        if (!workflowVerifier.recordConfirmedSubmission(outcome))
          return {completed:false};
        const verificationAfter = workflowVerifier.verify(candidate);
        emitAgentEvent("evidence_snapshot", makeEvidenceSnapshot(
          goal, verificationAfter, step, "post_action"
        ));
        return {
          completed: verificationAfter.completed === true,
          verification: verificationAfter
        };
      };
      const immediate = afterObservationResult.status === 'ready'
        ? inspectSubmission(afterObservationResult.observation)
        : {completed:false};
      if (immediate.completed === true) {
        progress = {...progress, classification:'goal_completed',goalCompleted:true,goalProgress:true};
        emitAgentEvent('goal_verified', {url: page.url()});
      }
      const settlement = progress.goalCompleted
        ? {status:'goal_settled',progress}
        : await settleAsyncAction({
          page,
          observer,
          before: observation,
          goal,
          timeoutMs: 1800,
          inspectOutcome: inspectSubmission
        });

      if (settlement.progress) {
        progress = settlement.progress;
      }

      if (
        settlement.status === "explicit_validation_rejection" &&
        !progress.goalCompleted
      ) {
        console.log(
          "Explicit validation rejection detected. " +
          "Re-observing the form for correction."
        );

        history.push({
          step,
          decision,
          execution: result,
          progress,
          settlement: settlement.status,
          validationFeedback: String(
            settlement.observation?.visibleBodyText ?? ""
          ).slice(0, 3500)
        });

        continue;
      }

      if (
        settlement.status === "settlement_timeout" &&
        !progress.goalCompleted
      ) {
        history.push({
          step,
          decision,
          ...(directMode ? { targetLabel: element?.label ?? '' } : {}),
          execution: result,
          progress,
          settlement: settlement.status
        });

        // Direct mode has no goal to settle against. Re-observe and let the
        // independent completion check judge the resulting page. The same
        // finalizing action is never retried automatically.
        if (directMode) {
          stagnationRecovery.remember(observation, element, decision);
          continue;
        }

        return {
          status: "action_outcome_unverified",
          steps: history.length,
          finalUrl: page.url(),
          reason:
            "Finalizing action was executed, but its outcome " +
            "could not be verified. Automatic retry suppressed.",
          history
        };
      }
    }

    console.log("Goal progress:", progress.classification);

    const stagnation = stagnationDetector.record(progress);

    history.push({
      step,
      decision,
      targetLabel: element?.label ?? '',
      ...(decision.operation === 'drag'
        ? { destinationLabel: String(observation.actionableElements?.find(
            item => item.ref === decision.value)?.label ?? '') }
        : {}),
      execution: result,
      progress,
      stagnation
    });

    navigationBacktracker.record({
      observation,
      element,
      decision,
      result,
      actualUrl:page.url()
    });
    
    // "Open X and tell me Y": opening X is all this loop has to do; Y is
    // answered afterwards from the page by the reader. When a verified action
    // has just landed on a new page, ask the same independent verifier whether
    // the browser already shows everything the navigation part asked for. The
    // check has no model claim behind it and costs no model call. If it does
    // not pass, nothing changes: the loop continues and no rejection is counted.
    if (directMode && isNavigationThenReadingTask(originalInstruction) &&
        result?.executionCompleted === true && result?.verified !== false &&
        afterObservationResult.status === "ready" &&
        page.url() !== urlBeforeAction) {
      const arrivalCheck = verifyDirectCompletion({
        instruction: originalInstruction,
        claim: "",
        observation: afterObservationResult.observation,
        history,
        preservation: formMutationPolicy.verify(afterObservationResult.observation),
        workflow: verification?.evidence ?? {},
        tabs: tabState(),
        arrivedByDiscovery
      });
      emitAgentEvent("completion_checked", {
        completed: arrivalCheck.completed === true,
        url: afterObservationResult.observation.url
      });
      if (arrivalCheck.completed === true) {
        emitAgentEvent("goal_verified", { url: afterObservationResult.observation.url });
        return {
          status: "verified_complete",
          steps: history.length,
          finalUrl: page.url(),
          reason: arrivalCheck.reason,
          verification: arrivalCheck,
          history
        };
      }
    }

    if (result?.executionCompleted === true) overlayBlocked = false;
    let ineffectiveSelfNavigation=false;

    if(
      result?.executionCompleted===true &&
      decision?.operation==="click" &&
      element?.href &&
      progress?.goalCompleted!==true &&
      progress?.goalProgress!==true &&
      afterObservationResult.status==="ready"
    ) {
      try {
        const before=new URL(observation.url);
        const after=new URL(page.url());
        const target=new URL(element.href,before);
        const observed=afterObservationResult.observation;

        ineffectiveSelfNavigation=
          before.href===after.href &&
          target.href===after.href &&
          !target.hash &&
          observed.title===observation.title &&
          JSON.stringify(observed.headings ?? [])===
            JSON.stringify(observation.headings ?? []);
      } catch {
        ineffectiveSelfNavigation=false;
      }
    }

    if(ineffectiveSelfNavigation) {
      stagnationRecovery.remember(
        observation,element,decision
      );

      if(await attemptTreeBacktrack(step)) {
        stagnationDetector.reset();
        continue;
      }
    }


    if (progress.classification === "no_observed_change") {
      stagnationRecovery.remember(
        observation,
        element,
        decision
      );
    }

    if (stagnation.stagnating) {
      if (await attemptTreeBacktrack(step)) {
        stagnationDetector.reset();
        continue;
      }

      const recovery = stagnationRecovery.recover();

      if (!recovery.allowed) {
        return {
          status: "stagnation_detected",
          steps: history.length,
          finalUrl: page.url(),
          reason: recovery.reason,
          history
        };
      }

      console.log(
        "Autonomous recovery attempt:",
        recovery.recoveries
      );

      stagnationDetector.reset();
    }

    console.log("Execution:", result);
  }

  return {
    status: "step_limit_reached",
    steps: history.length,
    finalUrl: page.url(),
    history
  };
}
