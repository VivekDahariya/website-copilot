function searchTarget(task) {
  const text = String(task || "");

  const patterns = [
    /\b(?:find|open)\s+(?:the\s+)?(.+?)\s+repository\s+(?:on|in|at)\s+(?:github|gitlab|bitbucket)\b/i,
    /\bsearch\s+(?:on|in|at)?\s*(?:[\w.-]+\s+)?for\s+(.+?)(?:,| then | and (?:open|verify|find)|$)/i,
    /\b(?:find|open)\s+(?:the\s+)?(?:article|page|profile)\s+(?:about|for|on)\s+(.+?)(?:,| then | and |$)/i,
    /\b(?:article|page|profile)\s+(?:about|for|on)\s+(.+?)(?:,| then | and |$)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim().replace(/[.!?]+$/, "");
    }
  }

  return null;
}

function isSearchField(element) {
  if (!element?.editable) return false;

  const metadata = [
    element.type,
    element.name,
    element.placeholder,
    element.label
  ].filter(Boolean).join(" ");

  return element.type === "search" ||
    /\b(search|query|find)\b/i.test(metadata);
}

export function planSearchFirstAction(task, observation) {
  const target = searchTarget(task);
  if (!target) return null;

  const fields = observation.actionableElements.filter(isSearchField);

  // Some websites expose a search launcher before rendering the
  // actual input. Only open a uniquely identified search launcher.
  if (fields.length === 0) {
    const openers = observation.actionableElements.filter(element =>
      element?.tag === "button" &&
      element.editable !== true &&
      /^search or jump to\b/i.test(
        String(element.label || "").trim()
      )
    );

    if (openers.length === 1) {
      return {
        ref: openers[0].ref,
        operation: "click",
        value: ""
      };
    }

    return null;
  }

  if (fields.length !== 1) return null;

  const field = fields[0];
  const current = String(field.currentValue || "").trim();

  if (!current) {
    return {
      ref: field.ref,
      operation: "fill",
      value: target
    };
  }

  if (current.toLowerCase() === target.toLowerCase()) {
    return {
      ref: field.ref,
      operation: "press",
      value: "Enter"
    };
  }

  return null;
}
