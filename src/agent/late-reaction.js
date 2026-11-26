import { waitForRelevantDomChange } from "../observer/dom-change-watcher.js";

// A page can answer an action a moment after it ran: a reveal timer, an
// animation, a request that fills a panel. Judging the page the instant the
// action returns would report "nothing happened" and make the agent give up
// on, or refuse to repeat, an action that worked.

// Actions whose effect shows up on the page. Looking, scrolling and typing
// change something the agent can already see.
const REACTING_OPERATIONS = new Set([
  "click", "press", "select", "check", "uncheck"
]);

// Long enough for a typical delayed reveal, short enough that a real no-op
// costs little. A wait is only ever spent when nothing visibly changed.
export const LATE_REACTION_WAIT_MS = 1500;

export function observationFingerprint(value) {
  return JSON.stringify({
    url: value?.url,
    headings: value?.headings,
    // Only synthetic first-observation metadata is ignored; every live
    // property of the controls stays part of the fingerprint.
    actionableElements: (value?.actionableElements ?? []).map(
      ({ initialChecked, ...liveElement }) => liveElement
    ),
    visibleBodyText: value?.visibleBodyText
  });
}

export function mayReactLate({
  decision, result, before, after, urlBefore, urlNow
}) {
  return REACTING_OPERATIONS.has(decision?.operation) &&
    result?.executionCompleted === true &&
    urlNow === urlBefore &&
    Boolean(before) && Boolean(after) &&
    observationFingerprint(before) === observationFingerprint(after);
}

// True when the page changed within the wait. Never throws: a page that is
// closed or navigating simply has nothing to wait for.
export async function waitForLateReaction(page, {
  sinceRevision = null,
  timeoutMs = LATE_REACTION_WAIT_MS
} = {}) {
  try {
    return await waitForRelevantDomChange(page, { timeoutMs, sinceRevision });
  } catch {
    return false;
  }
}
