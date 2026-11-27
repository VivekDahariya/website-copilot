import { resolveElement } from "../observer/dom-observer.js";
import {
  inspectLiveTarget,
  buildTargetIdentity
} from "../agent/live-target-identity.js";
import { authorizeBrowserAction } from "../agent/action-safety-policy.js";
import { saveImage } from "./media-save.js";
import { stopPendingNavigation } from "../browser/pending-navigation.js";
import {
  validateActionApproval,
  consumeActionApproval
} from "../agent/action-approval.js";

const SUPPORTED_ACTIONS = new Set([
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "press", "right_click", "drag", "set_range", "hover", "save_image"
]);

export async function executeAction(
  page,
  action,
  { approval = null, preflightOnly = false, loginRequested = false, mediaDirectory = null } = {}
) {
  const { ref, operation, value } = action;

  if (!SUPPORTED_ACTIONS.has(operation)) {
    throw new Error(`Unsupported operation: ${operation}`);
  }

  if (typeof ref !== "string") {
    throw new Error("Action requires a valid element reference.");
  }

  const handle = await resolveElement(page, ref);

  const state = await handle.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return {
      connected: element.isConnected,
      visible:
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        !element.closest("[hidden], [inert]"),
      enabled: !element.matches(":disabled"),
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type") || "",
      editable:
        element.matches("textarea,[contenteditable='true']") ||
        (element.tagName.toLowerCase() === "input" &&
          !["button", "submit", "reset", "checkbox", "radio",
            "file", "hidden", "image", "color", "range"]
            .includes(element.type))
    };
  });

  if (!state.connected || !state.visible || !state.enabled) {
    throw new Error(`Element ${ref} is not currently actionable.`);
  }

  if (operation === "fill" && !state.editable) {
    throw new Error(`Element ${ref} is not editable.`);
  }

  if (operation === "save_image" && state.tag !== "img") {
    throw new Error(`Element ${ref} is not a picture.`);
  }

  if (operation === "set_range" && state.type !== "range") {
    throw new Error(`Element ${ref} is not a range control.`);
  }
  if (operation === "select" && state.tag !== "select") {
    throw new Error(`Element ${ref} is not a native select.`);
  }

  if (
    (
      (operation === "check" &&
        !["checkbox", "radio"].includes(state.type)) ||
      (operation === "uncheck" && state.type !== "checkbox")
    )
  ) {
    throw new Error(`Element ${ref} is not a checkbox or radio input.`);
  }

  if (
    ["fill", "select", "press", "set_range", "drag"].includes(operation) &&
    typeof value !== "string"
  ) {
    throw new Error(`${operation} requires a string value.`);
  }


  // Reinspect the actual target immediately before execution.
  // Do not trust the model's description or an earlier DOM snapshot.
  const live = await handle.evaluate(element => {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || "").toLowerCase();
    const form = element.closest("form");

    const labels = "labels" in element
      ? Array.from(element.labels || [])
          .map(label => label.textContent || "")
          .join(" ")
      : "";

    const labelledBy = (element.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map(id => document.getElementById(id)?.textContent || "")
      .join(" ");

    const label = [
      element.getAttribute("aria-label"),
      labelledBy,
      labels,
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      element.innerText,
      element.getAttribute("value")
    ].filter(Boolean).join(" ");

    const submitControl =
      type === "submit" ||
      (tag === "button" && !type && Boolean(form));

    const formText = form
      ? [
          form.getAttribute("aria-label"),
          form.getAttribute("name"),
          form.getAttribute("action"),
          Array.from(form.querySelectorAll("label"))
            .map(item => item.textContent || "")
            .join(" ")
        ].filter(Boolean).join(" ")
      : "";

    return {
      tag,
      type,
      label,
      text: element.innerText || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      placeholder: element.getAttribute("placeholder") || "",
      name: element.getAttribute("name") || "",
      href: element.getAttribute("href") || "",
      submitControl,
      hasForm: Boolean(form),
      formText,
      verifiedSearchContext: (() => {
        if (!form) return false;
        if (String(form.method || "get").toLowerCase() !== "get") return false;
        const searchField = tag === "input" &&
          !["submit", "button", "reset", "image"].includes(type)
          ? element :
          form.querySelector('input[type="search"],input[name="search"],input[name="q"],input[name="query"],input[aria-label*="Search" i]');
        if (!searchField) return false;
        const isSubmitButton = (tag === "button" ||
          (tag === "input" && ["submit", "button"].includes(type)));
        if (isSubmitButton && !/\b(search|go|find)\b/i.test(label)) return false;
        if (!isSubmitButton && element !== searchField) return false;

        const fieldDescription = [
          searchField.type,
          searchField.name,
          searchField.id,
          searchField.getAttribute("aria-label"),
          searchField.getAttribute("placeholder"),
          searchField.labels ? Array.from(searchField.labels)
            .map(item => item.textContent || "").join(" ") : ""
        ].filter(Boolean).join(" ");

        if (
          String(searchField.type || "").toLowerCase() !== "search" &&
          !/\b(search|query|find)\b/i.test(fieldDescription)
        ) return false;

        const controls = Array.from(
          form.querySelectorAll("input,textarea,select,button")
        );

        const dangerous =
          /\b(pay|payment|purchase|checkout|transfer|delete|remove|send|publish|post|subscribe|password|otp|message)\b/i;

        const formMetadata = [
          form.getAttribute("action"),
          form.getAttribute("name"),
          form.getAttribute("aria-label")
        ].filter(Boolean).join(" ");

        if (dangerous.test(formMetadata)) return false;

        const hasUnrelatedControls = controls.some(control => {
          if (control === searchField || control === element) return false;

          const controlType = String(control.type || "").toLowerCase();

          const metadata = [
            controlType,
            control.name,
            control.id,
            control.getAttribute("aria-label"),
            control.getAttribute("placeholder")
          ].filter(Boolean).join(" ");

          if (dangerous.test(metadata)) return true;

          if (controlType === "hidden") return false;

          if (
            controlType === "submit" ||
            controlType === "button"
          ) {
            const buttonLabel = [
              control.getAttribute("aria-label"),
              control.textContent
            ].filter(Boolean).join(" ");

            return !/\b(search|find|go)\b/i.test(buttonLabel);
          }

          if (control.matches("select")) {
            return !/\b(language|locale|region|country|category|scope|filter)\b/i
              .test(metadata);
          }

          return control.matches("input,textarea,select");
        });

        return !hasUnrelatedControls;
      })(),
      // The login button of a genuine sign-in form: one password field, a
      // button that says only "log in" / "sign in", and nothing in the form
      // about payments, deletion, sending or posting. Used only when the user
      // asked to log in; it never makes any other submission safe.
      loginSubmission: (() => {
        if (!form) return false;
        const isButton = tag === "button" ||
          (tag === "input" && ["submit", "button"].includes(type));
        if (!isButton) return false;
        if (!/^\s*(?:log\s?-?in|sign\s?-?in)\s*$/i.test(label)) return false;
        if (form.querySelectorAll('input[type="password"]').length !== 1) return false;
        const description = [
          form.getAttribute("action"), form.getAttribute("name"),
          form.getAttribute("aria-label"), form.getAttribute("id"),
          form.getAttribute("class"), form.innerText
        ].filter(Boolean).join(" ");
        return !/(?:^|[^a-z])(?:pay|payment|purchase|checkout|transfer|delete|send|publish|post|subscribe|otp)(?:$|[^a-z])/i.test(description);
      })(),
      sensitiveFormContext: (() => {
        if (!form) return false;

        const description = [
          form.getAttribute("action"),
          form.getAttribute("name"),
          form.getAttribute("aria-label"),
          form.getAttribute("id"),
          form.getAttribute("class"),
          form.innerText
        ].filter(Boolean).join(" ");

        return /(?:^|[^a-z])(?:pay|payment|purchase|checkout|transfer|delete|send|publish|post|subscribe|password|otp)(?:$|[^a-z])/i.test(description);
      })()
    };
  });

  // Submit buttons can cause consequential changes even when labelled
  // "Continue", "OK", or "Confirm".
  const submission =
    operation === "click" &&
    live.submitControl;

  // Modifier+Enter may submit a form through a site shortcut; Space on a
  // submit button activates that button. Guard both like a physical click.
  const keyboardKey = String(value ?? "").toLowerCase().replace(/\s+/g, "");
  const keyboardSubmission = operation === "press" && (
    (/(?:^|\+)(?:enter|numpadenter)$/.test(keyboardKey) && live.hasForm) ||
    (/(?:^|\+)(?:space|spacebar)$/.test(keyboardKey) && live.submitControl)
  );

  // Classify the actual target, not unrelated fields in its form.
  // Form submission remains protected by the explicit approval gate.
  const safetyElement = {
    ...live,
    label: [
      live.label,
      submission || keyboardSubmission ? "submit" : ""
    ].filter(Boolean).join(" ")
  };

  const approvalContext = {
    pageUrl: page.url(),
    targetIdentity: buildTargetIdentity(live)
  };

  if (approval !== null) {
    const inspected = await inspectLiveTarget(page, action);

    if (
      inspected.pageUrl !== approvalContext.pageUrl ||
      inspected.targetIdentity !== approvalContext.targetIdentity
    ) {
      throw new Error(
        "SAFETY_STALE_TARGET: Approval target identity changed."
      );
    }
  }

  const approvalValid = approval !== null &&
    validateActionApproval(
      approval,
      action,
      approvalContext
    ).allowed === true;

  let safety = authorizeBrowserAction(
    action,
    safetyElement,
    approvalValid ? approval : null,
    approvalContext
  );

  // Logging in is what the user asked for, so its own button needs no
  // approval. Credentials still go to the person (human_handover is kept).
  const loginPermitted = loginRequested === true &&
    operation === "click" && live.loginSubmission === true;
  if (loginPermitted && safety.classification !== "human_handover" &&
      safety.classification !== "blocked") {
    safety = {
      classification: "safe",
      allowed: true,
      reason: "The login button of a sign-in form the user asked to use."
    };
  }

  if (submission || keyboardSubmission) {
    if (
      safety.classification !== "human_handover" &&
      !loginPermitted &&
      !(
        (
          approvalValid &&
          safety.allowed &&
          safety.classification === "requires_approval"
        ) ||
        (
          live.verifiedSearchContext === true &&
          live.sensitiveFormContext !== true &&
          safety.classification === "safe"
        )
      )
    ) {
      throw new Error(
        "SAFETY_APPROVAL_REQUIRED: Form submission requires explicit approval."
      );
    }
  }

  if (!safety.allowed) {
    throw new Error(
      `SAFETY_${safety.classification.toUpperCase()}: ${safety.reason}`
    );
  }

  // Read-only preflight using the SAME live safety classification
  // as normal execution. No browser action is performed.
  // Normal execution independently rechecks current browser state.
  if (preflightOnly === true) {
    return {
      preflightOnly: true,
      classification: safety.classification,
      verifiedSearchContext: live.verifiedSearchContext === true,
      loginSubmission: loginPermitted,
      sensitiveFormContext: live.sensitiveFormContext === true
    };
  }

  // Reject target mutations between inspection and execution.
  const stable = await handle.evaluate(
    (element, expected) => {
      return (
        element.isConnected &&
        element.tagName.toLowerCase() === expected.tag &&
        (element.getAttribute("type") || "").toLowerCase() === expected.type &&
        (element.getAttribute("aria-label") || "") === expected.ariaLabel &&
        (element.getAttribute("name") || "") === expected.name &&
        (element.getAttribute("href") || "") === expected.href
      );
    },
    live
  );

  if (!stable) {
    throw new Error(
      "SAFETY_STALE_TARGET: Target changed. Re-observation required."
    );
  }

  if (approval !== null && !approvalValid) {
    throw new Error(
      "SAFETY_APPROVAL_INVALID: Approval context mismatch."
    );
  }

  if (approvalValid) {
    const finalInspection = await inspectLiveTarget(page, action);

    if (
      finalInspection.pageUrl !== approvalContext.pageUrl ||
      finalInspection.targetIdentity !== approvalContext.targetIdentity
    ) {
      throw new Error(
        "SAFETY_STALE_TARGET: Approved target changed before execution."
      );
    }

    const consumed = consumeActionApproval(
      approval,
      action,
      approvalContext
    );

    if (!consumed.allowed) {
      throw new Error(
        `SAFETY_APPROVAL_INVALID: ${consumed.reason}`
      );
    }
  }

  const startedAt = Date.now();

  // Native JavaScript dialogs are not ordinary DOM controls. Playwright
  // silently dismisses them when no handler is registered, which otherwise
  // makes it easy to mistake a cancelled confirmation for a completed action.
  // Scope this guard to the precise task page and authorized action only.
  const encounteredDialogs = [];
  const pendingDialogResponses = [];
  const onNativeDialog = dialog => {
    const kind = dialog.type();
    encounteredDialogs.push(kind);
    // Never accept a confirm, prompt or beforeunload decision automatically.
    // An alert has no affirmative decision and is merely acknowledged.
    const response = kind === "alert" ? dialog.accept() : dialog.dismiss();
    pendingDialogResponses.push(response.catch(() => null));
  };
  page.on("dialog", onNativeDialog);
  let dragBefore = null;
  let savedImage = null;
  try {
  switch (operation) {
    case "save_image":
      savedImage = await saveImage(page, handle, mediaDirectory);
      break;
    case "hover":
      // A real pointer hover reveals CSS/JS menus without activating clicks.
      await handle.hover({ timeout: 3500 });
      break;
    case "click": {
      const urlBeforeClick = page.url();
      try {
        // Clickability failures are not user errors. Replan against a
        // fresh DOM rather than waiting 10 seconds or forcing the click.
        await handle.click({ timeout: 3500 });
      } catch (error) {
        const message = String(error?.message ?? '');
        // The click itself was performed, but the page it started is still
        // loading (a slow server). That is not a blocked click.
        if (/timeout/i.test(message) && /click action done/i.test(message)) {
          if (await waitForSlowNavigation(page, urlBeforeClick)) break;
          const slow = new Error(
            'ACTION_NAVIGATION_TIMEOUT: The click was performed, but the page it opened did not start loading in time. Loading was stopped and the previous page is unchanged.'
          );
          slow.code = 'ACTION_NAVIGATION_TIMEOUT';
          throw slow;
        }
        if (/intercepts pointer events|outside of the viewport|element is not stable|not visible|timeout/i.test(message)) {
          const blocked = new Error(
            'ACTION_CLICK_BLOCKED: Target cannot be clicked safely; refresh observation and choose another control.'
          );
          blocked.code = 'ACTION_CLICK_BLOCKED';
          // Say what is in the way (a dialog, cookie banner or other overlay),
          // so the planner can dismiss it instead of repeating the click.
          const blockedBy = await describeBlockingOverlay(handle).catch(() => null);
          if (blockedBy) blocked.blockedBy = blockedBy;
          throw blocked;
        }
        throw error;
      }
      break;
    }

    case "fill":
      await handle.fill(value, { timeout: 10000 });
      break;

    case "select": {
      // Native selects commonly store numeric values but display human
      // labels. Resolve against the live inspected select, then select by
      // exact value without guessing or changing disabled options.
      const selectedValue = await handle.evaluate((element, requested) => {
        if (element.tagName.toLowerCase() !== 'select') return null;
        const options = Array.from(element.options).filter(option => !option.disabled);
        const byValue = options.find(option => option.value === requested);
        const byLabel = options.find(option => option.label.trim() === requested.trim());
        return (byValue || byLabel)?.value ?? null;
      }, value);
      if (selectedValue === null) {
        throw new Error('SELECT_OPTION_UNAVAILABLE: Reobserve choices before selecting.');
      }
      await handle.selectOption({ value: selectedValue }, { timeout: 10000 });
      break;
    }

    case "check":
      await handle.check({ timeout: 10000 });
      break;

      case "uncheck":
        await handle.uncheck({ timeout: 10000 });
        break;

    case "press":
      await handle.press(value, { timeout: 10000 });
      break;
    case "right_click":
      await handle.click({button:'right', timeout:3500});
      break;
    case "set_range": {
      // Nothing is changed unless the value is a number inside the slider's own
      // range. The error carries the real range so the run can say what is allowed.
      const outcome = await handle.evaluate((element, requested) => {
        const min = element.min === '' ? 0 : Number(element.min);
        const max = element.max === '' ? 100 : Number(element.max);
        const n = Number(requested);
        if (String(requested ?? '').trim() === '' || !Number.isFinite(n)) return { ok: false, min, max, why: 'not a number' };
        if (n < min || n > max) return { ok: false, min, max, why: 'outside the range' };
        element.value = String(n);
        element.dispatchEvent(new Event('input', {bubbles:true}));
        element.dispatchEvent(new Event('change', {bubbles:true}));
        return { ok: true };
      }, value);
      if (!outcome.ok) {
        throw Object.assign(
          new Error(`RANGE_VALUE_INVALID: ${JSON.stringify(String(value ?? '').slice(0, 20))} is ${outcome.why} (allowed ${outcome.min} to ${outcome.max}).`),
          { code: 'RANGE_VALUE_INVALID', range: { min: outcome.min, max: outcome.max }, requested: String(value ?? '').slice(0, 20) });
      }
      break;
    }
    case "drag": {
      const target = await resolveElement(page, value);
      if (!await target.isVisible()) throw new Error('Drag destination not visible.');
      // Element handles have no dragTo; perform a real pointer drag so both
      // HTML5 drag-and-drop and pointer-based drag libraries receive it.
      dragBefore = await handle.evaluate(dragPlacement).catch(() => null);
      await handle.scrollIntoViewIfNeeded({ timeout: 3500 });
      const from = await handle.boundingBox();
      await target.scrollIntoViewIfNeeded({ timeout: 3500 });
      const to = await target.boundingBox();
      const start = await handle.boundingBox() ?? from;
      if (!start || !to) throw new Error('Drag source or destination has no visible box.');
      const startX = start.x + start.width / 2, startY = start.y + start.height / 2;
      const endX = to.x + to.width / 2, endY = to.y + to.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 6, startY + 6, { steps: 3 });
      await page.mouse.move(endX, endY, { steps: 12 });
      await page.mouse.move(endX, endY);
      await page.mouse.up();
      break;
    }
  }

  await Promise.all(pendingDialogResponses);
  // A plain alert only has an OK button: there is no decision to make, so
  // it is acknowledged and the action counts as carried out. A confirm,
  // prompt or leave-page dialog asks for a decision and is never answered
  // automatically: it is dismissed and the run stops for manual review.
  const decisionDialogs = encounteredDialogs.filter(kind => kind !== "alert");
  if (decisionDialogs.length > 0) {
    // No private dialog text is logged or returned to the planner.
    const interruption = new Error(
      "ACTION_NATIVE_DIALOG_INTERRUPTED: Browser dialog intercepted; manual review required before repeating the action."
    );
    interruption.code = "ACTION_NATIVE_DIALOG_INTERRUPTED";
    interruption.dialogType = decisionDialogs[0];
    throw interruption;
  }

  const result = {
    ref,
    operation,
    executionCompleted: true,
    durationMs: Date.now() - startedAt,
    urlAfter: page.url(),
    // Only the fact that an alert appeared is kept, never its text.
    ...(encounteredDialogs.length > 0 ? { acknowledgedAlert: true } : {})
  };

  if (operation === "fill") {
    const actual = await handle.inputValue().catch(() => null);

    result.verified = actual === value;

    if (!result.verified) {
      if (process.env.COPILOT_FILL_DIAGNOSTICS === "1") {
        const targetState = await handle.evaluate((element, expected) => ({
          connected: element.isConnected,
          focused: document.activeElement === element,
          tag: element.tagName.toLowerCase(),
          type: element.type || "",
          liveMatchesExpected: element.value === expected,
          liveValueLength: String(element.value ?? "").length
        }), value).catch(() => null);

        if (targetState?.type !== "password") {
          console.error("[FILL_DIAGNOSTICS]", {
            ref,
            requestedLength: String(value ?? "").length,
            observedLength: typeof actual === "string"
              ? actual.length : null,
            observedNull: actual === null,
            equalAfterTrim: typeof actual === "string"
              ? actual.trim() === String(value).trim() : false,
            equalIgnoringCase: typeof actual === "string"
              ? actual.toLowerCase() === String(value).toLowerCase()
              : false,
            requestedHasNewline: /[\\r\\n]/.test(String(value)),
            requestedHasOuterWhitespace:
              String(value) !== String(value).trim(),
            targetState
          });
        } else {
          console.error("[FILL_DIAGNOSTICS]", {
            ref,
            sensitiveInput: true,
            valuesWithheld: true
          });
        }
      }
      throw new Error(`Fill verification failed for ${ref}.`);
    }
  } else if (operation === "check") {
    result.verified = await handle.isChecked();
    } else if (operation === "uncheck") {
      result.verified = !(await handle.isChecked());

      if (!result.verified) {
        throw new Error(`Uncheck verification failed for ${ref}.`);
      }
  } else if (operation === "select") {
    result.verified = await handle.evaluate(
        (element, expectedValue) =>
          Array.from(element.selectedOptions).some(
            option =>
              option.value === expectedValue ||
              option.label === expectedValue
          ),
        value
      );
  } else if (operation === "set_range") {
    result.verified = await handle.inputValue().catch(() => null) === value;
  } else if (operation === "save_image") {
    // saveImage read the file back and compared size and hash.
    result.verified = savedImage?.verified === true;
    result.media = savedImage;
  } else if (operation === "drag") {
    // Verified only when the page really placed the item somewhere else:
    // another container, another position among its siblings, or another
    // spot on screen. A drag the page ignored is reported as not verified.
    const dragAfter = await handle.evaluate(dragPlacement).catch(() => null);
    result.verified = Boolean(dragBefore && dragAfter && (
      dragBefore.container !== dragAfter.container ||
      dragBefore.position !== dragAfter.position ||
      dragBefore.text !== dragAfter.text ||
      Math.abs(dragBefore.x - dragAfter.x) > 4 ||
      Math.abs(dragBefore.y - dragAfter.y) > 4));
  } else {
    result.verified = null;
  }

  return result;
  } finally {
    page.off("dialog", onNativeDialog);
  }
}

// Where an item currently sits: which container, which position among its
// siblings, what it shows and where it is on screen. Runs in the page.
function dragPlacement(element) {
  const parent = element.parentElement;
  const path = [];
  for (let node = parent; node && node !== document.body && path.length < 6;
       node = node.parentElement) {
    path.push(node.tagName + "#" + node.id + ":" +
      [...(node.parentElement?.children ?? [])].indexOf(node));
  }
  const rect = element.getBoundingClientRect();
  return {
    container: path.join("/"),
    position: parent ? [...parent.children].indexOf(element) : -1,
    text: (element.innerText || "").slice(0, 200),
    x: Math.round(rect.left + window.scrollX),
    y: Math.round(rect.top + window.scrollY)
  };
}

// What is on top of the element at the point a click would land? Returns the
// overlay's kind, a short name and the labels of its controls, or null when the
// target is not covered by a separate element. Page text is only measured and
// shortened here; the planner treats it as untrusted data.
export async function describeBlockingOverlay(handle) {
  return handle.evaluate(element => {
    const clean = text => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    const top = document.elementFromPoint(x, y);
    if (!top || top === element || element.contains(top) || top.contains(element)) return null;
    let container = top.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog');
    let kind = container ? "dialog" : "overlay";
    if (!container) {
      for (let node = top; node && node !== document.body; node = node.parentElement) {
        const position = getComputedStyle(node).position;
        if (position === "fixed" || position === "sticky") container = node;
      }
      container ??= top;
    }
    const labelledBy = container.getAttribute("aria-labelledby");
    const name = clean(
      container.getAttribute("aria-label") ||
      (labelledBy && document.getElementById(labelledBy)?.textContent) ||
      container.querySelector("h1,h2,h3,[role=heading]")?.textContent ||
      container.innerText
    );
    const controls = [...container.querySelectorAll(
      'button,a[href],[role="button"],input[type="button"],input[type="submit"]'
    )].filter(control => control.getClientRects().length > 0)
      .map(control => clean(control.innerText || control.value || control.getAttribute("aria-label")))
      .filter(Boolean).slice(0, 6);
    return { kind, name, controls };
  });
}

// How long a click may wait for the page it started to begin loading.
function navigationWaitMs() {
  const configured = Number(process.env.COPILOT_NAVIGATION_WAIT_MS);
  return Number.isFinite(configured) && configured >= 500 && configured <= 120000
    ? configured : 20000;
}

// A click that starts a navigation does not return until the new page begins to
// load. With a slow server Playwright's click times out although the click was
// performed. Wait (bounded) for the page to move on; if it never does, stop the
// loading and say so. Returns true when the page moved on.
export async function waitForSlowNavigation(page, urlBefore, { timeoutMs = navigationWaitMs() } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (page.url() === urlBefore) {
    if (Date.now() >= deadline) {
      await stopPendingNavigation(page);
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await page.waitForLoadState('domcontentloaded', {
    timeout: Math.max(1000, deadline - Date.now())
  }).catch(() => {});
  return true;
}
