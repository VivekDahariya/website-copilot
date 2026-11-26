// A narrowly scoped, observation-verified sequence for an explicit request to
// open a new tab, read its heading and RETURN to the original tab. It never
// navigates, clicks, reads secrets, or infers a tab from a model response.
export function createExplicitTabWorkflow(instruction, initialPage) {
  const words = String(instruction ?? "");
  const explicitSequence =
    /\b(?:open|click)\b/i.test(words) &&
    /\b(?:new|another|second)\s+(?:browser\s+)?(?:tab|window)\b/i.test(words) &&
    /\bswitch\b/i.test(words) &&
    /\b(?:read|verify|check|confirm)\b.{0,70}\bheading\b/i.test(words) &&
    /\b(?:return|switch\s+back|go\s+back)\b/i.test(words) &&
    /\b(?:original|first|previous|initial)\s+(?:browser\s+)?(?:tab|window)\b/i.test(words) &&
    !/\b(?:submit|purchase|pay|delete|publish|send|download|password|otp)\b/i.test(words);

  if (!explicitSequence) return null;

  const context = initialPage.context();
  const initialPages = new Set(context.pages());
  let sourcePopup = null;
  let targetPage = null;
  let targetRef = null;
  let observedHeading = null;
  let targetUrl = null;
  let targetTitle = null;
  let returned = false;
  const requiresExactOutcome = /\b(?:finish|stop)\s+(?:only\s+)?when\b/i.test(words);
  const expectedHeading = words.match(
    /\bheading\s+(?:says|is(?:\s+exactly)?|reads)\s*["'“‘]([^"'”’]+)["'”’]/i
  )?.[1]?.trim() ?? null;

  // Accept only a popup emitted by the task's initial page, registered
  // before its click. A new page opened by another tab is not evidence.
  function registerSourcePopup(popup) {
    if (!popup || popup.isClosed() || initialPages.has(popup) ||
        popup === initialPage || sourcePopup) return false;
    sourcePopup = popup;
    return true;
  }

  function observe(page, observation, verification, resolveTab) {
    if (!targetPage && sourcePopup && !sourcePopup.isClosed()) {
      const matches = (observation.availableTabs ?? []).filter(
        tab => resolveTab(tab.ref) === sourcePopup
      );
      if (matches.length === 1) {
        targetRef = matches[0].ref;
        targetPage = sourcePopup;
      }
    }

    if (targetPage && page === targetPage && !targetPage.isClosed()) {
      const heading = (observation.headings ?? [])
        .find(value => typeof value === "string" && value.trim());
      // Read actual observed document heading. An unrelated page title is
      // insufficient proof when the user specifically requested a heading.
      if (heading &&
            (!expectedHeading || heading.trim() === expectedHeading) &&
            (!requiresExactOutcome || verification.completed === true)) {
        observedHeading = heading.trim();
        targetUrl = observation.url;
        targetTitle = observation.title;
      }
    }

    if (page === initialPage && observedHeading && targetPage &&
        !targetPage.isClosed() && targetPage !== initialPage) {
      returned = true;
    }

    return returned;
  }

  function nextAction(page) {
    if (!targetPage || targetPage.isClosed()) return null;
    if (page === initialPage && !observedHeading) {
      return { ref: targetRef, operation: "switch_tab", value: "" };
    }
    if (page === targetPage && observedHeading && !returned) {
      return { ref: "tab_1", operation: "switch_tab", value: "" };
    }
    return null;
  }

  return {
    registerSourcePopup,
    observe,
    nextAction,
    evidence() {
      return {
        originalTabRestored: returned,
        newTabOpen: Boolean(targetPage && !targetPage.isClosed()),
        targetRef,
        observedHeading,
        targetUrl,
        targetTitle
      };
    }
  };
}
