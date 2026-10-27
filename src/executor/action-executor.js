import { resolveElement } from "../observer/dom-observer.js";
import {
  inspectLiveTarget,
  buildTargetIdentity
} from "../agent/live-target-identity.js";
import { authorizeBrowserAction } from "../agent/action-safety-policy.js";
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
  "press", "right_click", "drag", "set_range"
]);

export async function executeAction(
  page,
  action,
  { approval = null } = {}
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

  // Pressing Enter inside a form can also submit it.
  const enterSubmission =
    operation === "press" &&
    /^(enter|numpadenter)$/i.test(String(value || "")) &&
    Boolean(live.formText);

  // Classify the actual target, not unrelated fields in its form.
  // Form submission remains protected by the explicit approval gate.
  const safetyElement = {
    ...live,
    label: [
      live.label,
      submission || enterSubmission ? "submit" : ""
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

  const safety = authorizeBrowserAction(
    action,
    safetyElement,
    approvalValid ? approval : null,
    approvalContext
  );

  if (submission || enterSubmission) {
    if (
      safety.classification !== "human_handover" &&
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

  switch (operation) {
    case "click":
      try {
        // Clickability failures are not user errors. Replan against a
        // fresh DOM rather than waiting 10 seconds or forcing the click.
        await handle.click({ timeout: 3500 });
      } catch (error) {
        const message = String(error?.message ?? '');
        if (/intercepts pointer events|outside of the viewport|element is not stable|not visible|timeout/i.test(message)) {
          const blocked = new Error(
            'ACTION_CLICK_BLOCKED: Target cannot be clicked safely; refresh observation and choose another control.'
          );
          blocked.code = 'ACTION_CLICK_BLOCKED';
          throw blocked;
        }
        throw error;
      }
      break;

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
      const updated = await handle.evaluate((element, requested) => {
        const n = Number(requested);
        if (!Number.isFinite(n)) return false;
        const min = element.min === '' ? 0 : Number(element.min);
        const max = element.max === '' ? 100 : Number(element.max);
        if (n < min || n > max) return false;
        element.value = String(n);
        element.dispatchEvent(new Event('input', {bubbles:true}));
        element.dispatchEvent(new Event('change', {bubbles:true}));
        return true;
      }, value);
      if (!updated) throw new Error('Invalid or out-of-range slider value.');
      break;
    }
    case "drag": {
      const target = await resolveElement(page, value);
      if (!await target.isVisible()) throw new Error('Drag destination not visible.');
      await handle.dragTo(target, {timeout:7000});
      break;
    }
  }

  const result = {
    ref,
    operation,
    executionCompleted: true,
    durationMs: Date.now() - startedAt,
    urlAfter: page.url()
  };

  if (operation === "fill") {
    const actual = await handle.inputValue().catch(() => null);

    result.verified = actual === value;

    if (!result.verified) {
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
  } else {
    result.verified = null;
  }

  return result;
}
