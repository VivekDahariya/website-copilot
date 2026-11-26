// The reason shown with a finished run. When the answer step failed, the
// reason comes from that step. The agent's own "every requirement is backed by
// browser evidence" would read as a contradiction beside "could not be
// completed", because the agent did reach the page; only the answer is missing.
export function deliveredReason({ result, agentResult, deliveredStatus }) {
  if (deliveredStatus === "answer_unavailable") {
    return result?.status === "answer_unavailable" && result.reason
      ? result.reason
      : "No usable answer was delivered.";
  }
  return agentResult?.reason ?? result?.reason ?? null;
}
