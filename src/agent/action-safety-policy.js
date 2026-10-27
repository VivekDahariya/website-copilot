import {
  validateActionApproval
} from "./action-approval.js";

const SENSITIVE_TERMS = [
  /\b(send|submit|publish|post|share)\b/i,
  /\b(purchase|buy|checkout|pay|transfer)\b/i,
  /\b(delete|remove|erase|destroy)\b/i,
  /\b(change password|reset password)\b/i,
  /\b(account settings|privacy settings)\b/i,
  /\b(confirm order|place order)\b/i,
  /\b(subscribe|unsubscribe)\b/i,
  /\b(upload|download)\b/i
];

const RESTRICTED_TERMS = [
  /\b(password|passcode|pin)\b/i,
  /\b(otp|one.time.password|verification code)\b/i,
  /\b(cvv|cvc|card number|credit card)\b/i,
  /\b(captcha|security challenge)\b/i,
  /\b(bank account|upi pin)\b/i
];

const SEARCH_TERMS = [
  /\bsearch\b/i,
  /\bfind\b/i,
  /\blook up\b/i
];

function normalize(value) {
  return String(value ?? "").trim();
}

function matchesAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}


export function isVerifiedSearchSubmission(element = {}) {
  return element.verifiedSearchContext === true &&
    !element.sensitiveFormContext;
}

export function classifyBrowserAction(
  action,
  element = {}
) {
  if (!action || typeof action !== "object") {
    return {
      classification: "blocked",
      reason: "Invalid action."
    };
  }

  const operation = normalize(action.operation).toLowerCase();

  const description = [
    element.label,
    element.text,
    element.ariaLabel,
    element.placeholder,
    element.type,
    element.name,
    element.href,
    action.value
  ].map(normalize).join(" ");

  if (
    matchesAny(description, RESTRICTED_TERMS) ||
    normalize(element.type).toLowerCase() === "password"
  ) {
    return {
      classification: "human_handover",
      reason: "Sensitive credential or verification interaction."
    };
  }

  if (
    !["click", "fill", "select", "check", "uncheck", "press", "scroll", "navigate", "right_click", "drag", "set_range"].includes(operation)
  ) {
    return {
      classification: "blocked",
      reason: `Unrecognized operation: ${operation}`
    };
  }


  // Form context takes precedence over harmless-looking control labels.
  // An ambiguous action inside a sensitive form must not be assumed safe.
  if (
    element.sensitiveFormContext === true &&
    ["click", "press"].includes(operation)
  ) {
    return {
      classification: "requires_approval",
      reason: "Action occurs inside a potentially consequential form."
    };
  }

  // The executor recomputes this from the LIVE form. GET-only search
  // submissions are read-only; never treat this as approval for other forms.
  if (["click", "press"].includes(operation) &&
      isVerifiedSearchSubmission(element)) {
    return { classification: "safe", reason: "Verified read-only search form." };
  }

  // Keyboard shortcuts can trigger submission or destructive actions.
  if (operation === "press") {
    const key = normalize(action.value).toLowerCase();

    if (
      /^(enter|numpadenter)$/.test(key) ||
      /^(control|meta)\\+enter$/.test(key)
    ) {
      if (
        /^(enter|numpadenter)$/.test(key) &&
        isVerifiedSearchSubmission(element)
      ) {
        return {
          classification: "safe",
          reason: "Verified search-only submission."
        };
      }

      return {
        classification: "requires_approval",
        reason: "Keyboard action may submit a form."
      };
    }

    if (
      /^(delete|backspace)$/.test(key) &&
      matchesAny(description, SENSITIVE_TERMS)
    ) {
      return {
        classification: "requires_approval",
        reason: "Potentially destructive keyboard action."
      };
    }
  }

  if (operation === "scroll") {
    return {
      classification: "safe",
      reason: "Scrolling is read-only."
    };
  }

  if (operation === "navigate") {
    return {
      classification: "safe",
      reason: "Navigation permitted by this policy."
    };
  }

  // Opening an ordinary page is navigation, not authorization
  // to perform consequential operations on that page.
  if (operation === "click") {
    const tag = normalize(element.tag).toLowerCase();
    const href = normalize(element.href);

    const consequential =
      /\b(delete|remove|erase|destroy|logout|log.out|signout|sign.out|unsubscribe|purchase|checkout|pay|payment|transfer|confirm|submit|send|publish|post|buy|order|password|passcode|pin|otp|verification|captcha)\b/i;

    const navigationCandidate =
      tag === "a" &&
      href.length > 0 &&
      !href.startsWith("#") &&
      !/^(javascript|data|mailto|tel):/i.test(href);

    if (
      navigationCandidate &&
      (consequential.test(description.replace(/\bpost\b/gi, "")) ||
        /(?:^|[/?#&=_-])(?:delete|remove|erase|destroy|logout|signout|unsubscribe|purchase|checkout|pay|payment|transfer|confirm|submit|send|publish|buy|order)(?:$|[/?#&=_-])/i.test(href))
    ) {
      return {
        classification: "requires_approval",
        reason: "Navigation link may initiate a consequential action."
      };
    }

    const navigationOnly = navigationCandidate;

    if (navigationOnly) {
      return {
        classification: "safe",
        reason: "Ordinary navigation link without a consequential action."
      };
    }
  }

  if (matchesAny(description, SENSITIVE_TERMS)) {
    if (
      operation === "click" &&
      matchesAny(description, SEARCH_TERMS) &&
      !/\b(pay|purchase|delete|send|publish|transfer)\b/i.test(description)
    ) {
      return {
        classification: "safe",
        reason: "Public search interaction."
      };
    }

    return {
      classification: "requires_approval",
      reason: "Potentially consequential browser action."
    };
  }

  if (["fill", "select", "check", "uncheck", "press", "set_range"].includes(operation)) {
    return {
      classification: "safe",
      reason: "Ordinary non-credential field."
    };
  }

  if (["click", "right_click", "drag"].includes(operation)) {
    return {
      classification: "safe",
      reason: "Ordinary browser interaction."
    };
  }

  return {
    classification: "blocked",
    reason: "No matching permission rule."
  };
}

export function authorizeBrowserAction(
  action,
  element = {},
  approval = null,
  approvalContext = null
) {
  const decision = classifyBrowserAction(action, element);

  if (decision.classification === "safe") {
    return {
      ...decision,
      allowed: true
    };
  }

  if (decision.classification === "human_handover") {
    return {
      ...decision,
      allowed: false
    };
  }

  if (
    decision.classification === "requires_approval" &&
    approval &&
    approval.granted === true &&
    approval.actionRef === action.ref &&
    approval.operation === action.operation &&
    validateActionApproval(
      approval,
      action,
      {
        pageUrl: approvalContext?.pageUrl,
        targetIdentity: approvalContext?.targetIdentity
      }
    ).allowed === true
  ) {
    return {
      ...decision,
      allowed: true,
      approved: true
    };
  }

  return {
    ...decision,
    allowed: false
  };
}
