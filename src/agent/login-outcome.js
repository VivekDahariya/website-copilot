// After a login button was pressed and the sign-in form is still on the page,
// the site has usually said why in its own words ("Your password is invalid!").
// This reads that message from the live page. Messages that were already on
// the page before the button was pressed are ignored, so only a response to
// the login counts. Read-only: nothing on the page is changed.
const REJECTION_WORDS =
  "invalid|incorrect|wrong|failed|failure|denied|unauthori[sz]ed|" +
  "not\\s+(?:recogni[sz]ed|valid|correct|found|match(?:ed|ing)?)|" +
  "(?:does|do|did)\\s?n['\\u2019]?t\\s+match|unable\\s+to|try\\s+again|locked|too\\s+many|error";

export async function readPageMessages(page) {
  return page.evaluate(source => {
    const wording = new RegExp("\\b(?:" + source + ")\\b", "i");
    const alertish = element =>
      element.matches('[role="alert"],[role="status"],[aria-live]') ||
      /(?:alert|error|flash|invalid|danger|warning|notice|message)/i.test(
        String(element.id) + " " + String(typeof element.className === "string" ? element.className : ""));
    const visible = element => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 &&
        style.visibility !== "hidden" && style.display !== "none";
    };
    const found = [];
    for (const element of document.body.querySelectorAll("*")) {
      if (/^(?:script|style|noscript|option|title|head)$/i.test(element.tagName)) continue;
      const leaf = element.children.length === 0;
      const flagged = alertish(element);
      if (!leaf && !flagged) continue;
      const text = (element.innerText || "").replace(/\s+/g, " ")
        .replace(new RegExp("\\s*[" + String.fromCharCode(215, 10005, 10006) + "]\\s*$"), "").trim();
      if (text.length < 3 || text.length > 200 || !wording.test(text)) continue;
      if (!visible(element)) continue;
      found.push({ text, flagged });
    }
    const ordered = [...found.filter(item => item.flagged), ...found.filter(item => !item.flagged)];
    return [...new Set(ordered.map(item => item.text))].slice(0, 5);
  }, REJECTION_WORDS);
}

// Messages that appeared after the login button was pressed.
export function newMessages(before, after) {
  const known = new Set(before ?? []);
  return (after ?? []).filter(text => !known.has(text));
}

export function cleanMessage(text) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}
