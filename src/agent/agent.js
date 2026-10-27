import { getPageId } from "./page-identity.js";
import { validateGoalSchema } from "./goal-schema-validator.js";
import {
  createNavigationIntentGuard
} from "./navigation-intent-guard.js";
import {
  authorizeBrowserAction
} from "./action-safety-policy.js";
import { observeReliably } from "../observer/reliable-observer.js";
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
  validateActionApproval
} from "./action-approval.js";
import { decideNextAction } from "./local-reasoner.js";
import { planSearchFirstAction } from "./search-first-planner.js";
import { waitForSearchField } from "./dynamic-search-settlement.js";
import {
  requiresRepositorySelection,
  captureRepositorySelection,
  verifyRepositorySelection
} from "./repository-destination-evidence.js";
import { createTabContext } from "./tab-context.js";
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
import { createWorkflowGoalVerifier } from "./workflow-goal-verifier.js";
import { verifyPersistence } from "./persistence-verifier.js";
import { selectRelevantElements } from "./element-ranker.js";
import { createProgressGuard } from "./progress-guard.js";
import { createBrowserStateBaseline, rejectContradictoryFormAction } from "./browser-state-baseline.js";
import { evaluateGoalProgress } from "./goal-progress.js";
import {
  settleAsyncAction,
  isFinalizingAction
} from "./async-action-settlement.js";
import { createStagnationDetector } from "./stagnation-detector.js";
import { createStagnationRecovery } from "./stagnation-recovery.js";

const MAX_STEPS = Math.min(50, Math.max(1, Number(process.env.COPILOT_MAX_STEPS || 12) || 12));
const MAX_REPLANS = 2;

export async function runAgent(
  page,
  task,
  goal,
  {
    reasoner = decideNextAction,
    observer = observeReliably,
    originalInstruction = task,
    onAgentEvent = null,
    runControl = null,
    approvalProvider = null,
    humanHandoverProvider = null,
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
  const workflowVerifier = createWorkflowGoalVerifier(
    goal,
    originalInstruction
  );

  // Bind name-only repository navigation to the exact observed
  // result without replacing or weakening workflow verification.
  const repositoryBindingRequired =
    requiresRepositorySelection(originalInstruction, goal);

  let selectedRepositoryDestination = null;

  const originalWorkflowVerify =
    workflowVerifier.verify.bind(workflowVerifier);

  workflowVerifier.verify = (...args) => {
    const result = originalWorkflowVerify(...args);

    if (
      !repositoryBindingRequired ||
      verifyRepositorySelection(
        args[0],
        selectedRepositoryDestination
      )
    ) {
      return result;
    }

    return {
      ...result,
      completed: false,
      reason: "Selected repository destination not verified."
    };
  };

  const navigationGuard = createNavigationIntentGuard(
    task,
    page.url(),
    originalInstruction
  );

  // Navigation recovery is bounded and never force-clicks obstructed DOM.
  let backNavigations = 0;
  let blockedClickRecoveries = 0;

  // Reject invalid goals before observation, planning, or execution.
  try {
    goal = validateGoalSchema(goal);
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

  const currentPageOnly =
    goal?.type === "visible_content" &&
    /\bon this page\b/i.test(task);

  console.log("\n========== WEBSITE COPILOT ==========");
  console.log(
    "TASK:",
    sensitiveTask ? "[SENSITIVE TASK REDACTED]" : task
  );

  let immutableIntentBaseline = null;

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
        reason: observationResult.assessment,
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

    // The initial observation and independent verifier always remain intact.
    // Ollama may request one additional read-only detail scope before
    // choosing an action. No browser operation is selected by this callback.
    observation.requestMoreEvidence = scope =>
      readSelectiveEvidence(page, scope, observation.url);

    const verification = workflowVerifier.verify(observation);

    emitAgentEvent("page_observed", {
      tabId: getPageId(page),
      url: observation.url,
      title: observation.title ?? "",
      goalVerified: verification.completed === true
    });

    navigationGuard.observe(observation.url);

    const navigationVerified = navigationGuard.canComplete(
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

    if (!verification.completed) {
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

    const rejectedActions = [];
    let planInvalidated = false;
    let decision = null;
    let tabSwitched = false;

    for (let attempt = 1; attempt <= MAX_REPLANS; attempt++) {
      console.log(`Planning attempt ${attempt}`);

      emitAgentEvent("planning_started", {
        attempt,
        url: observation.url
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

        const candidate = directPdfDecision ?? await reasoner(
          originalInstruction,
          observation,
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

        if (candidate.operation === "switch_tab") {
          const target = tabContext.resolve(candidate.ref);

          if (!target || target === page) {
            rejectedActions.push(candidate);
            continue;
          }

          const previousUrl = page.url();
          await target.bringToFront();
          page = target;

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
          await page.mouse.wheel(0, candidate.value === 'up' ? -700 : 700);
          await page.waitForTimeout(350);
          history.push({step,
            decision:{ref:'',operation:'scroll',value:candidate.value},
            execution:{operation:'scroll',executionCompleted:true,
              verified:null,previousUrl:beforeUrl,urlAfter:page.url()}});
          emitAgentEvent('action_executed',{
            operation:'scroll',ref:'',executionCompleted:true,
            verified:false,url:page.url()});
          tabSwitched = true;
          break;
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

        const constraintViolation = rejectContradictoryFormAction(
          goal, element, candidate
        );
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
          actionableElements: value.actionableElements,
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



    progressGuard.recordAttempt(
      observation,
      element,
      decision
    );

    // Record the exact repository candidate identified by the
    // deterministic resolver. Completion still requires a matching
    // independently observed destination.
    if (
      repositoryBindingRequired &&
      decision.operation === "click"
    ) {
      const evidence = captureRepositorySelection(
        originalInstruction,
        observation,
        decision
      );

      if (evidence) {
        selectedRepositoryDestination = evidence;
      }
    }

    const urlBeforeAction = page.url();

    const safetyDecision = authorizeBrowserAction(decision, element);

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

    if (
      safetyDecision.classification === "requires_approval" &&
      typeof approvalProvider === "function"
    ) {
      const liveTarget = await inspectLiveTarget(page, decision);

      const candidate = await approvalProvider({
        action: Object.freeze({ ...decision }),
        element: Object.freeze({ ...element }),
        pageUrl: liveTarget.pageUrl,
        targetIdentity: liveTarget.targetIdentity,
        liveTarget: Object.freeze({ ...liveTarget.live })
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

    const searchEnterNeedsLiveInspection =
      decision.operation === "press" &&
      /^(Enter|NumpadEnter)$/i.test(decision.value) &&
      safetyDecision.classification === "requires_approval";

    const approvalPresent = actionApproval !== null;

    if (
      !safetyDecision.allowed &&
      !searchEnterNeedsLiveInspection &&
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
        safety: safetyDecision
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
                // Reuse the exact existing executor and approval token.
                // The callback must never execute a second click.
                let actionPerformed = false;

                const receipt = await onApprovedPdfClick({
                  instruction: originalInstruction,
                  selectedLink: pdfCandidate,
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
                approval: actionApproval
              });

      // Wait only after the deterministic planner has selected
      // a search-opening button. Never bypass execution safety.
      if (
        process.env.COPILOT_DETERMINISTIC_SEARCH === "1" &&
        result?.executionCompleted === true &&
        decision.operation === "click"
      ) {
        const opener = planSearchFirstAction(
          originalInstruction,
          observation
        );

        if (
          opener?.operation === "click" &&
          opener.ref === decision.ref
        ) {
          const ready = await waitForSearchField(page, {
            timeoutMs: 5000
          });

          console.log(
            "Dynamic search input:",
            ready ? "ready" : "not detected within wait"
          );
        }
      }

    } catch (error) {
      if (
        error?.code === 'ACTION_CLICK_BLOCKED' &&
        decision.operation === 'click' &&
        blockedClickRecoveries < 2
      ) {
        blockedClickRecoveries += 1;
        console.log('Click obstructed: reobserving and choosing an alternative.');
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
            previousUrl:urlBeforeAction, urlAfter:page.url()
          },
          progress: { classification:'action_blocked', goalCompleted:false }
        });
        continue;
      }
      throw error;
    }

    emitAgentEvent("action_executed", {
      ref: result.ref ?? decision.ref,
      operation: result.operation ?? decision.operation,
      executionCompleted: result.executionCompleted === true,
      verified: result.verified === true,
      url: result.urlAfter ?? page.url()
    });

    result.previousUrl = urlBeforeAction;

    workflowVerifier.recordAction(
      decision,
      element,
      result
    );

    if (page.url() !== urlBeforeAction) {
      progressGuard.recordNavigation(page.url());
    }

    const afterObservationResult = await observer(page);
    if (afterObservationResult.status === 'ready') {
      afterObservationResult.observation = browserBaseline.enrich(afterObservationResult.observation);
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

    if (
      finalizingAction &&
      !progress.goalCompleted
    ) {
      const settlement = await settleAsyncAction({
        page,
        observer,
        before: observation,
        goal,
        timeoutMs: 1800
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
          execution: result,
          progress,
          settlement: settlement.status
        });

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
      execution: result,
      progress,
      stagnation
    });

    if (progress.classification === "no_observed_change") {
      stagnationRecovery.remember(
        observation,
        element,
        decision
      );
    }

    if (stagnation.stagnating) {
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
