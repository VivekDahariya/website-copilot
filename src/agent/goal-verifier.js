import { normalizeBooleanState } from "./boolean-state.js";

export function verifyGoal(observation, goal) {
  if (!goal || typeof goal !== "object") {
    return {
      completed: false,
      reason: "No valid goal provided."
    };
  }

  if (goal.type === "all_of") {
    if (
      !Array.isArray(goal.conditions) ||
      goal.conditions.length === 0 ||
      goal.conditions.length > 20 ||
      goal.conditions.some(
        condition => condition?.type === "all_of"
      )
    ) {
      return {
        completed: false,
        reason: "Invalid composite goal."
      };
    }

    const results = goal.conditions.map(
      condition => verifyGoal(observation, condition)
    );

    return {
      completed: results.every(
        result => result.completed === true
      ),
      evidence: {
        conditions: results
      }
    };
  }

  if (goal.type === "page_destination") {
    let parsedUrl;

    try {
      parsedUrl = new URL(observation.url);
    } catch {
      return {
        completed: false,
        reason: "Invalid current URL."
      };
    }

    const hasHostname =
      typeof goal.hostname === "string" &&
      goal.hostname.trim().length > 0;

    const hasPathname =
      typeof goal.pathname === "string" &&
      goal.pathname.trim().length > 0;

    const hasPathPattern =
      typeof goal.pathnamePattern === "string" &&
      goal.pathnamePattern.trim().length > 0;

    const hasHeading =
      typeof goal.heading === "string" &&
      goal.heading.trim().length > 0;

    const hasText =
      typeof goal.text === "string" &&
      goal.text.trim().length > 0;

    if (
      !hasHostname &&
      !hasPathname &&
      !hasPathPattern &&
      !hasHeading &&
      !hasText &&
        !goal.identity
    ) {
      return {
        completed: false,
        reason: "Destination has no verification constraints."
      };
    }

    const hostnameMatches =
      !hasHostname ||
      parsedUrl.hostname.toLowerCase() ===
        goal.hostname.trim().toLowerCase();

    let pathMatches = true;

    if (hasPathname) {
      pathMatches = parsedUrl.pathname === goal.pathname;
    } else if (hasPathPattern) {
      try {
        pathMatches = new RegExp(
          goal.pathnamePattern
        ).test(parsedUrl.pathname);
      } catch {
        return {
          completed: false,
          reason: "Invalid destination pathname pattern."
        };
      }
    }

    const headings = Array.isArray(observation.headings)
      ? observation.headings
      : [];

    const normalizeIdentity = value => String(value ?? "")
      .toLowerCase()
      .replace(/[_/-]+/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // A destination identity must describe the document itself, not a
    // sidebar, autocomplete suggestion, or unrelated subsection heading.
    const identityMatches = !goal.identity || (() => {
      const expected = normalizeIdentity(goal.identity);
      if (!expected) return false;
      const actualTitle = normalizeIdentity(observation.title);
      const pathSegment = (() => {
        const raw = parsedUrl.pathname.split('/').filter(Boolean).at(-1) || '';
        try { return decodeURIComponent(raw); }
        catch { return raw; }
      })();
      const actualPath = normalizeIdentity(pathSegment);
      return actualPath === expected ||
        actualTitle === expected ||
        actualTitle.startsWith(expected + ' - ') ||
        actualTitle.startsWith(expected + ' ');
    })();


    const normalizeHeading = value => String(value ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[¶#]+\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(?:the|a|an)\s+/, "");

    const structuralHeadings =
      Array.isArray(observation.headingEvidence)
        ? observation.headingEvidence
        : null;

    const expectedHeading = normalizeHeading(goal.heading);
    const actualTitle = normalizeHeading(observation.title);
    const rawLastSegment = parsedUrl.pathname.split('/').filter(Boolean).at(-1) || '';
    let lastSegment = rawLastSegment;
    try { lastSegment = decodeURIComponent(rawLastSegment); }
    catch { /* Keep the raw segment if URL encoding is malformed. */ }
    const pathIdentity = normalizeHeading(lastSegment.replace(/[_-]+/g, ' '));

    // A matching result card or autocomplete heading is NOT the page itself.
    // A primary h1 alone is insufficient if the document title and path
    // both identify a different page.
    const searchResults = /\bsearch results?\b/i.test(observation.title || '') ||
      /(?:^|\/)(?:special:search|search|results)(?:\/|$)/i
        .test(parsedUrl.pathname);
    const primaryHeadingMatches = structuralHeadings
      ? structuralHeadings.some(item =>
          item.tag === 'h1' && !item.insideNavigation &&
          normalizeHeading(item.text) === expectedHeading)
      : headings.some(item => normalizeHeading(item) === expectedHeading);
    const titleCorroborates = actualTitle === expectedHeading ||
      actualTitle.startsWith(expectedHeading + ' - ') ||
      actualTitle.startsWith(expectedHeading + ' ');
    const pathCorroborates = pathIdentity === expectedHeading;
    const headingMatches = !hasHeading || (
      !searchResults && primaryHeadingMatches &&
      (titleCorroborates || pathCorroborates)
    );

    const visibleText = String(
      observation.visibleBodyText || ""
    ).toLowerCase();

    const textMatches =
      !hasText ||
      visibleText.includes(goal.text.trim().toLowerCase());

    return {
      completed:
        hostnameMatches &&
        pathMatches &&
        headingMatches &&
        textMatches && identityMatches,
      evidence: {
        hostnameMatches,
        pathMatches,
        headingMatches,
        textMatches,
          identityMatches,
        observedUrl: observation.url
      }
    };
  }

  if (goal.type === "visible_content") {
    const expected = goal.text?.trim().toLowerCase();

    if (!expected) {
      return {
        completed: false,
        reason: "No expected text provided."
      };
    }

    const visibleText = (
      observation.visibleBodyText || ""
    ).toLowerCase();

    return {
      completed: visibleText.includes(expected),
      evidence: {
        expectedText: goal.text,
        matched: visibleText.includes(expected)
      }
    };
  }

  if (goal.type === "visible_form") {
    const elements = Array.isArray(observation.actionableElements)
      ? observation.actionableElements
      : [];

    const controls = elements.filter(element => {
      const tag = String(element.tagName || element.tag || "")
        .toLowerCase();
      const type = String(element.type || "").toLowerCase();

      return ["input", "select", "textarea", "button"].includes(tag) ||
        ["text", "email", "tel", "checkbox", "radio", "submit"].includes(type);
    });

    return {
      completed: controls.length > 0,
      evidence: { visibleFormControls: controls.length }
    };
  }

  if (goal.type === "modal_closed") {
    return {completed:observation.activeModalVisible === false,
      evidence:{modalVisible:observation.activeModalVisible}};
  }

  if (goal.type === "paragraph_count") {
    const found = Number(observation.counts?.paragraphs || 0);
    const required = Number(goal.expectedValue);
    return {completed:found >= required,
      evidence:{observedCount:found,requiredCount:required}};
  }

  if (goal.type === "element_count") {
    const expected = Number(goal.expectedValue);
    const normalize = value => String(value ?? '').trim().toLowerCase();
    const matched = (observation.actionableElements ?? []).filter(element =>
      normalize(element.label) === normalize(goal.label));
    return {
      completed: matched.length === expected,
      evidence: { expectedLabel: goal.label, expectedCount: expected,
        observedCount: matched.length }
    };
  }

  if (goal.type === "form_state") {
    // Labels can contain multiline option text from <label> nodes.
    // Compare normalized whitespace, but do not guess across unrelated fields.
    const normalizeFieldLabel = value => String(value ?? "")
      .replace(/\s+/g, " ").trim().toLowerCase();
    const expectedLabel = normalizeFieldLabel(goal.fieldLabel);
    const expectedValue = String(goal.expectedValue ?? "");

    const fields = observation.actionableElements ?? [];
    let matchingFields = fields.filter(element => expectedLabel &&
      [element.label, element.name, element.placeholder]
        .some(label => normalizeFieldLabel(label).includes(expectedLabel)));

    // Some real HTML controls have no accessible label (e.g. an isolated
    // input[type=number], or a select showing only its option labels).
    // Resolve these only when exactly ONE compatible field exists. Never
    // guess between multiple fields or sensitive inputs.
    if (matchingFields.length === 0) {
      const candidates = fields.filter(element => {
        const tag = String(element.tag || '').toLowerCase();
        const type = String(element.type || '').toLowerCase();
        if (['password','file','hidden'].includes(type)) return false;
        if (/\b(number|numeric|integer)\b/.test(expectedLabel))
          return tag === 'input' && type === 'number';
        if (/\b(dropdown|select|option|choice)\b/.test(expectedLabel))
          return tag === 'select';
        if (/\b(textarea|editor|description|text area)\b/.test(expectedLabel))
          return tag === 'textarea' || element.editable === true && tag !== 'input';
        return false;
      });
      // A generic instruction ("the dropdown", "number input") can
      // identify the sole compatible control. A *specific* expected label
      // must not silently match a differently named control.
      const genericTarget = /^(?:(?:the|a)\s+)?(?:dropdown|select|option|choice|menu|number|numeric|integer|textarea|editor|description|text area)(?:\s+(?:field|input))?$|^select a dropdown$/.test(expectedLabel);
      if (candidates.length === 1 &&
          (genericTarget || !normalizeFieldLabel(candidates[0].label)))
        matchingFields = candidates;
    }

    const matchedField = matchingFields.find(element => {
      const type = String(element.type || "").toLowerCase();

      if (type === "checkbox" || type === "radio") {
        if (expectedValue.trim().toLowerCase() === 'unchanged') {
          return typeof element.initialChecked === 'boolean' &&
            element.checked === element.initialChecked;
        }
        const expectedChecked = normalizeBooleanState(expectedValue);
        return expectedChecked !== null && element.checked === expectedChecked;
      }

      if (element.tag === "select") {
        // A native option's value may be "2" while its label is "Two".
        const selected = [element.currentValue, element.selectedLabel]
          .map(value => String(value ?? "").trim().toLowerCase());
        return selected.includes(expectedValue.trim().toLowerCase());
      }

      // A truncated observation must never establish a successful match.
      return element.editable &&
        element.currentValueTruncated !== true &&
        element.currentValue === expectedValue;
    });

    return {
      completed: Boolean(matchedField),
      evidence: {
        expectedField: goal.fieldLabel,
        expectedValue: goal.expectedValue,
        matchedReference: matchedField?.ref || null
      }
    };
  }

  return {
    completed: false,
    reason: `Unsupported goal type: ${goal.type}`
  };
}
