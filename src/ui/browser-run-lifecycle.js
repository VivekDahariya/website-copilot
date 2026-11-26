// General browser lifetime policy; independent of any task/site.
// Unverified consequential submissions require human inspection, so
// their browser is deliberately retained instead of discarded.
const KEEP_OPEN_STATUSES = new Set([
  "verified_complete",
  "answer_ready",
  "download_ready",
  "approval_required",
  "human_handover_required",
  "action_outcome_unverified"
]);

export function shouldCloseBrowserAfterRun(phase, status) {
  if (phase === "cancelled" || phase === "error") return true;
  if (phase !== "finished") return false;
  return !KEEP_OPEN_STATUSES.has(status);
}
