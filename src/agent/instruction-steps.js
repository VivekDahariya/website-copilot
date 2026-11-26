// Multi-part instructions: "click A, then click B", "open the X page and then
// the Y page". Each named step must have its own verified action, in the order
// written. Words that merely appear on the page (a link in the navigation bar)
// are not proof that the step was done. Only click, open-page and go-back steps
// are read here; fills, selections and the like keep their own checks.

const FILLER = new Set("the a an on its my our your this that".split(" "));
const CONTROL_NOUN = /\s+(?:link|button|tab|icon|item|option|menu|entry)\s*$/i;
const NOT_NAMED = /\d|\b(?:first|second|third|fourth|fifth|last|next|previous|all|every|each|both|any|random|one|two|three|and|or)\b/i;
const OTHER_VERB = /\b(?:read|scroll|type|fill|enter|write|search|check|tick|untick|download|save|take|show|explain|describe|summari[sz]e|screenshot|wait|log|sign|submit|send|select|choose|pick|hover|drag|upload|find|look|tell|list|count|compare|extract|copy)\b/i;

const norm = value => String(value ?? "").normalize("NFKC").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
const stem = token => token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
const nameTokens = text => norm(text).split(" ").filter(word => word && !FILLER.has(word)).map(stem);

// The clauses of an instruction, in order. Never splits inside a quoted name.
function clauses(instruction) {
  const quoted = [];
  const text = String(instruction ?? "").replace(/"[^"\n]*"|“[^”\n]*”/g, match => {
    quoted.push(match); return `\u0001${quoted.length - 1}\u0001`;
  });
  const parts = text.split(new RegExp(
    "\\s*,?\\s*(?:and\\s+)?(?:then|after\\s+that|afterwards?|finally|followed\\s+by|and\\s+also)\\b\\s*,?\\s*" +
    "|\\s*[.;!]\\s+" +
    "|\\s*,\\s*(?:and\\s+)?(?=(?:also\\s+)?(?:click|tap|follow|go|open|visit|navigate|return)\\b)" +
    "|\\s+and\\s+(?=(?:also\\s+)?(?:click|tap|follow|go|open|visit|navigate|return)\\b)", "i"));
  return parts.map(part => part.replace(/\u0001(\d+)\u0001/g, (_, i) => quoted[Number(i)])
      .replace(/^[\s,]*(?:also\s+)?/i, "").replace(/[\s.,;!?]+$/, "").trim())
    .filter(Boolean);
}

export function sequencedTargets(instruction) {
  const targets = [];
  let kind = null;
  for (const clause of clauses(instruction)) {
    let match;
    if ((match = clause.match(/^(?:please\s+)?(?:(?:click|tap)(?:\s+on)?|follow)\s+(.+)$/i))) {
      kind = "click";
      const object = match[1].replace(CONTROL_NOUN, "");
      if (!NOT_NAMED.test(object.replace(/"[^"]*"/g, ""))) {
        const name = nameTokens(object);
        if (name.length) targets.push({kind, name, display: object.replace(/^the\s+/i, "")});
      }
    } else if ((match = clause.match(/^(?:please\s+)?(?:open|go\s+to|navigate\s+to|visit|reach|load)\s+(.+?)\s+(?:page|section|screen)$/i))) {
      kind = "page";
      if (!NOT_NAMED.test(match[1])) {
        const name = nameTokens(match[1]);
        if (name.length) targets.push({kind, name, display: match[1].replace(/^the\s+/i, "") + " page"});
      }
    } else if (/^(?:please\s+)?(?:go\s+back|return|come\s+back|navigate\s+back)\b/i.test(clause)) {
      kind = "back";
      targets.push({kind, name: [], display: clause});
    } else if (kind === "click" && !OTHER_VERB.test(clause) && norm(clause).split(" ").length <= 4 &&
               !NOT_NAMED.test(clause.replace(/"[^"]*"/g, ""))) {
      // "Click Sport, then News": a bare name continues the click.
      const object = clause.replace(CONTROL_NOUN, "");
      const name = nameTokens(object);
      if (name.length) targets.push({kind, name, display: object.replace(/^the\s+/i, "")});
    } else if (kind === "page" && !OTHER_VERB.test(clause) &&
               (match = clause.match(/^(?:please\s+)?(?:open|go\s+to|navigate\s+to|visit)\s+(?!https?:|www\.)(.+)$/i)) &&
               !/[./]/.test(match[1])) {
      // "Open the Products page, open Gadget": after a page step, a bare
      // "open NAME" is a further step, reached by its link.
      const object = match[1].replace(CONTROL_NOUN, "");
      if (!NOT_NAMED.test(object) && norm(object).split(" ").length <= 4) {
        const name = nameTokens(object);
        if (name.length) {
          kind = "click";
          targets.push({kind, name, display: object.replace(/^the\s+/i, "")});
        }
      }
    } else if (kind === "page" && !OTHER_VERB.test(clause)) {
      const bare = clause.match(/^(?:the\s+)?(.+?)\s+(?:page|section|screen)$/i);
      if (bare && !NOT_NAMED.test(bare[1])) {
        const name = nameTokens(bare[1]);
        if (name.length) targets.push({kind, name, display: bare[1].replace(/^the\s+/i, "") + " page"});
      }
    } else {
      kind = null;
    }
  }
  return targets;
}

const verified = entry =>
  entry?.execution?.executionCompleted === true && entry?.execution?.verified !== false;

function matches(target, entry) {
  const operation = entry?.decision?.operation;
  if (target.kind === "back") return ["back", "click", "switch_tab"].includes(operation);
  if (operation !== "click") return false;
  const wanted = new Set(target.name);
  const sharing = text => {
    const have = nameTokens(text);
    return have.length > 0 &&
      (target.name.every(word => have.includes(word)) || have.every(word => wanted.has(word)));
  };
  let path = "";
  try { path = decodeURIComponent(new URL(entry.execution?.urlAfter ?? "").pathname); } catch { path = ""; }
  return sharing(entry.targetLabel ?? "") ||
    (entry.execution?.previousUrl !== entry.execution?.urlAfter &&
      target.name.every(word => nameTokens(path).includes(word)));
}

// Which named steps have no verified action yet, in the order written.
// `currentWords` are the stemmed words of the open page's address, title and
// headings. A FIRST "open the X page" step is already done when X is the page
// that is open (the run started there, or a site search landed there).
export function unmetSteps(instruction, history = [], { currentWords = new Set() } = {}) {
  const targets = sequencedTargets(instruction);
  // One named click is a step too: "type Alice, then click Continue" is not
  // done until Continue was clicked, however plainly the word is printed on
  // the page. A lone page or back step keeps its own checks.
  const loneClick = targets.length === 1 && targets[0].kind === "click";
  if (targets.length < 2 && !loneClick) return {applies: false, missing: [], targets, lastIndex: -1};
  const missing = [];
  let from = 0;
  let lastIndex = -1;
  for (const [position, target] of targets.entries()) {
    const isLast = position === targets.length - 1;
    let found = -1;
    if (isLast) {
      // The result of the final step is what the run must end on, so the
      // latest matching action counts (the run may have repeated it).
      for (let index = history.length - 1; index >= from; index -= 1) {
        if (verified(history[index]) && matches(target, history[index])) { found = index; break; }
      }
    } else {
      for (let index = from; index < history.length; index += 1) {
        if (verified(history[index]) && matches(target, history[index])) { found = index; break; }
      }
    }
    if (isLast) lastIndex = found;
    if (found < 0 && position === 0 && target.kind === "page" &&
        target.name.every(word => currentWords.has(word))) continue;
    if (found < 0) missing.push(target.display); else from = found + 1;
  }
  return {applies: true, missing, targets, lastIndex};
}

// The same page, ignoring a #fragment and a trailing slash.
export function sameAddress(first, second) {
  const key = value => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    } catch { return String(value ?? ""); }
  };
  return key(first) === key(second);
}
