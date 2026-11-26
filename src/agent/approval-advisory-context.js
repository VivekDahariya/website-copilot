const SENSITIVE = /\b(?:password|passcode|otp|one.time.code|cvv|cvc|card.number|upi.pin|secret|token|private.key)\b/i;

function short(value, limit = 140) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function buildApprovalAdvisoryContext({
  instruction = "",
  history = [],
  pageTitle = "",
  safetyReason = "",
  riskAdvisory = null
} = {}) {
  const task = short(instruction, 350);

  return {
    task: SENSITIVE.test(task)
      ? "[Sensitive task text withheld]"
      : task,
    recentActions: (Array.isArray(history) ? history : [])
      .slice(-4)
      .map(entry => ({
        operation: short(entry?.decision?.operation, 24),
        target: short(entry?.targetLabel, 90),
        outcome: entry?.execution?.verified === true
          ? "verified"
          : entry?.execution?.executionCompleted === true
            ? "executed, verification unavailable"
            : "not verified"
      })),
    pageTitle: short(pageTitle, 120),
    safetyReason: short(safetyReason, 200),
    ...(riskAdvisory && typeof riskAdvisory === "object" ? {
      modelRisk: {
        level: ["harmless", "consequential", "uncertain"].includes(
          riskAdvisory.level
        ) ? riskAdvisory.level : "uncertain",
        rationale: SENSITIVE.test(String(riskAdvisory.rationale ?? ""))
          ? "[Sensitive rationale withheld]"
          : short(riskAdvisory.rationale, 180)
      }
    } : {})
  };
}
