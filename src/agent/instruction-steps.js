// Multi-part instructions: "click A, then click B", "open the X page and then
// the Y page". Each named step must have its own verified action, in the order
// written. Words that merely appear on the page (a link in the navigation bar)
// are not proof that the step was done. Only click, open-page and go-back steps
// are read here; fills, selections and the like keep their own checks.

const FILLER = new Set("the a an on its my our your this that".split(" "));
const CONTROL_NOUN = /\s+(?:link|button|tab|icon|item|option|menu|entry)\s*$/i;
const NOT_NAMED = /\d|\b(?:first|second|third|fourth|fifth|last|next|previous|all|every|each|both|any|random|one|two|three|and|or)\b/i;
const OTHER_VERB = /\b(?:read|scroll|type|fill|enter|write|search|check|tick|untick|download|save|take|show|explain|describe|summari[sz]e|screenshot|wait|log|sign|submit|send|select|choose|pick|hover|drag|upload|find|look|tell|list|count|compare|extract|copy|return)\b/i;

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
    } else if (/^(?:please\s+)?(?:go\s+back|return(?=\s*$|\s+(?:back|to)\b)|come\s+back|navigate\s+back)\b/i.test(clause)) {
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

function matches(target, entry, earlier = []) {
  const operation = entry?.decision?.operation;
  if (target.kind === "back") {
    if (operation === "back" || operation === "switch_tab") return true;
    // A click is "going back" only when it landed on a page the run had
    // already left (an in-page "Back to home" link). A click that went on to
    // somewhere new is not.
    const reached = entry?.execution?.urlAfter;
    return operation === "click" && Boolean(reached) &&
      entry.execution.previousUrl !== reached &&
      earlier.some(prior => prior?.execution?.previousUrl &&
        sameAddress(prior.execution.previousUrl, reached));
  }
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
        if (verified(history[index]) && matches(target, history[index], history.slice(0, index))) { found = index; break; }
      }
    } else {
      for (let index = from; index < history.length; index += 1) {
        if (verified(history[index]) && matches(target, history[index], history.slice(0, index))) { found = index; break; }
      }
    }
    if (isLast) lastIndex = found;
    if (found < 0 && position === 0 && target.kind === "page" &&
        target.name.every(word => currentWords.has(word))) continue;
    if (found < 0) missing.push(target.display); else from = found + 1;
  }
  return {applies: true, missing, targets, lastIndex};
}

// ---- named key presses -------------------------------------------------------
// "Type hello and press Enter", "press the Tab key twice": a key the user names
// needs its own verified `press` action, as many times as asked. The generic
// verb table counts a fill as a "press", so without this the typing alone passed.
// Only unambiguous names count as keys: "press Home" or "press Delete" may be a
// button, so those need the word "key" after them.
const KEY_WORD = String.raw`(?:enter|return|tab|escape|esc|backspace|page\s?up|page\s?down|arrow\s?(?:up|down|left|right)|(?:up|down|left|right)\s?arrow|f(?:[1-9]|1[0-2]))`;
const MODIFIER = String.raw`(?:ctrl|control|shift|alt|option|cmd|command|meta)`;
const KEY_COMBO = String.raw`${MODIFIER}(?:\s*\+\s*[a-z0-9]+)+`;
const KEY_PRESS = new RegExp(
  String.raw`\b(?:press|pressing|hit|hitting)\s+(?:the\s+)?(?:(${KEY_COMBO})|(${KEY_WORD})(?:\s+key)?|([a-z0-9]+)\s+key)\b` +
  String.raw`(?:[^.,;]{0,30}?\b(once|twice|thrice|(\d+|two|three|four|five|six)\s+times?)\b)?`, "gi");
const COUNT_WORDS = { once: 1, twice: 2, thrice: 3, two: 2, three: 3, four: 4, five: 5, six: 6 };
const KEY_ALIAS = { return: "enter", esc: "escape", ctrl: "control", cmd: "meta", command: "meta", option: "alt" };

export function normalizedKey(text) {
  return String(text ?? "").toLowerCase().split("+").map(part => {
    const key = part.replace(/\s+/g, "");
    if (/^(?:arrow)?(?:up|down|left|right)(?:arrow)?$/.test(key) && key.length > 5) {
      return "arrow" + key.replace(/arrow/, "");
    }
    return KEY_ALIAS[key] ?? key;
  }).join("+");
}

// [{ key: "enter", display: "Enter", count: 1 }, ...] in the order written.
export function keyRequirements(instruction) {
  const found = new Map();
  for (const match of String(instruction ?? "").matchAll(KEY_PRESS)) {
    const display = (match[1] ?? match[2] ?? match[3]).trim();
    const key = normalizedKey(display);
    const amount = match[4] === undefined ? 1
      : (COUNT_WORDS[match[4].toLowerCase()] ?? COUNT_WORDS[String(match[5] ?? "").toLowerCase()] ?? Number(match[5]) ?? 1) || 1;
    const earlier = found.get(key);
    if (earlier) earlier.count += amount; else found.set(key, { key, display, count: amount });
  }
  return [...found.values()];
}

// What is still missing: one entry per key that was pressed fewer times than asked.
export function keyShortfall(instruction, history = []) {
  const done = new Map();
  for (const entry of history) {
    if (entry?.decision?.operation === "press" && verified(entry)) {
      const key = normalizedKey(entry.decision.value);
      done.set(key, (done.get(key) ?? 0) + 1);
    }
  }
  return keyRequirements(instruction)
    .filter(need => (done.get(need.key) ?? 0) < need.count)
    .map(need => need.count > 1
      ? `press ${need.display} ${need.count} times (${done.get(need.key) ?? 0} done)`
      : `press ${need.display}`);
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
