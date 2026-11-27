import { keyRequirements, keyShortfall, keysStillOwed, sameAddress, sequencedTargets, unmetSteps } from "./instruction-steps.js";
import { navigationPartOf } from "./webpage-answer.js";
/**
 * Direct-instruction mode.
 *
 * The user's original instruction is the only statement of intent. No
 * structured goal is generated before the browser starts. The planner picks
 * one next action from the instruction, the fresh observation, the available
 * actions and the action history.
 *
 * Nothing in this module chooses a browser action. It only answers two
 * questions from browser evidence and the original instruction:
 *   1. May this form control be changed?        (createDirectFormScope)
 *   2. Is a model's "done" claim actually backed? (verifyDirectCompletion)
 *
 * A model saying "done" is never proof. Completion requires that every
 * content word and quoted literal of the instruction is backed by the fresh
 * observation or by verified executed actions, and that no veto applies.
 */

export const DIRECT_INSTRUCTION_GOAL = Object.freeze({
  type: "direct_instruction"
});

export function isDirectInstructionGoal(goal) {
  return goal?.type === "direct_instruction";
}

// Direct-instruction mode is the default. The earlier structured-goal
// interpreter runs only when COPILOT_DIRECT_INSTRUCTION=0 is set explicitly.
export function isDirectInstructionEnabled(env = process.env) {
  return env.COPILOT_DIRECT_INSTRUCTION !== "0";
}

export const MAX_DIRECT_COMPLETION_REJECTIONS = 3;

const norm = value => String(value ?? "")
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim()
  .replace(/\s+/g, " ");

// Everyday short forms that mean the same word.
const SHORT_FORMS = new Map([
  ["documentation", "doc"], ["repository", "repo"], ["information", "info"],
  ["application", "app"], ["configuration", "config"]
]);

const stem = token => {
  if (SHORT_FORMS.has(token)) return SHORT_FORMS.get(token);
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
};

const tokens = value => norm(value).split(" ").filter(Boolean);

// Words that describe how to act, not what must be true afterwards.
// Kept general: no website, product or task names.
const NON_EVIDENCE_WORDS = new Set((
  "a an the this that these those it its is are was were be been being am do does did " +
  "to of in on at by for from with into onto over under up down out off as and or but if " +
  "then than so also too just only very not no yes please kindly me my i you your we our " +
  "us they them their there here now once twice thrice time times after before when while " +
  "until which what who whose where how any all each every some both either other another " +
  "same new current existing given following next previous first second third fourth fifth " +
  "sixth seventh eighth ninth tenth last 1st 2nd 3rd 4th 5th 6th 7th 8th 9th 10th one two " +
  "three four five six seven eight nine ten " +
  "go goto open visit navigate browse follow find locate look click tap press hit choose " +
  "pick select check tick uncheck untick fill type enter write input put set change make " +
  "use using get take show tell give see view read verify confirm ensure sure return back " +
  "switch move scroll hover drag drop add remove delete submit save send search download " +
  "upload login log sign start stop finish complete done wait let have has had can could " +
  "should would will must may want need like " +
  "page pages website site web webpage link links button buttons field fields input inputs " +
  "box boxes textbox checkbox checkboxes radio dropdown menu option options form forms tab " +
  "slider sliders column columns row rows " +
  "tabs window element elements item items value values text section area screen homepage " +
  "home example called named labeled labelled titled whose present visible displayed shown " +
  "exactly appears appear available correct right explain describe summarize summarise " +
  "about information details answer question says say contains contain " +
  // Other forms of the reading verbs above ("verify that it explains X"), and
  // plain prepositions that say how to get somewhere ("through the Help
  // Center"). Neither is text a page has to print. They are listed whole
  // rather than stemmed, because a stem can collide with a real word
  // ("news" -> "new").
  "explains describes summarizes summarises shows tells gives verifies confirms " +
  "ensures mentions mention mentioned " +
  "through via across within inside between among around per upon toward towards " +
  "along beyond throughout during against " +
  // Describes which site is meant, not something a page prints about itself.
  // Site identity is established when the site is found, not from page text.
  "official officially"
).split(" "));

const ORDINALS = new Map([
  ["first", 1], ["1st", 1], ["second", 2], ["2nd", 2], ["third", 3], ["3rd", 3],
  ["fourth", 4], ["4th", 4], ["fifth", 5], ["5th", 5], ["sixth", 6], ["6th", 6],
  ["seventh", 7], ["7th", 7], ["eighth", 8], ["8th", 8], ["ninth", 9], ["9th", 9],
  ["tenth", 10], ["10th", 10]
]);

const CONTROL_NOUNS = {
  checkbox: /\b(?:checkbox|check box|checkboxes)\b/,
  radio: /\b(?:radio|radio button|radios)\b/
};

// Clauses that forbid or protect are not requests. They are enforced by
// the existing safety policy and the form-preservation check, so they must
// never count as something to perform or as permission to edit a field.
const PROTECTIVE_CLAUSES = [
  /\b(?:leave|keep)\b[^.;!?\n]*?\b(?:unchanged|intact|untouched|alone|as is|as it is|as they are)\b/gi,
  /\b(?:do\s+not|don['\u2019]?t|dont|never|must\s+not|should\s+not|without|avoid)\b[^.;!?\n]*/gi
];

export function splitInstruction(instruction) {
  const text = String(instruction ?? "");
  const protectedParts = [];
  let positive = text;
  for (const pattern of PROTECTIVE_CLAUSES) {
    positive = positive.replace(pattern, match => {
      protectedParts.push(match);
      return " ";
    });
  }
  return { positive, protective: protectedParts.join(" ") };
}

function quotedLiterals(text) {
  const found = [];
  for (const match of String(text).matchAll(/"([^"\n]{1,200})"|\u201C([^\u201D\n]{1,200})\u201D|(?<![\p{L}\p{N}])'([^'\n]{1,200})'(?![\p{L}\p{N}])/gu)) {
    const literal = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (norm(literal)) found.push(literal);
  }
  return found;
}

function ordinalMentions(text) {
  const words = tokens(text);
  const mentions = [];
  words.forEach((word, index) => {
    const window = words.slice(index, index + 4).join(" ");
    if (ORDINALS.has(word)) {
      const kind = Object.keys(CONTROL_NOUNS)
        .find(name => CONTROL_NOUNS[name].test(window)) ?? null;
      mentions.push({ ordinal: ORDINALS.get(word), kind });
    }
    if (/^\d{1,2}$/.test(word) && index > 0) {
      const previous = words[index - 1];
      const kind = /^checkbox(?:es)?$/.test(previous) ? "checkbox"
        : /^radio$/.test(previous) ? "radio" : null;
      if (kind) mentions.push({ ordinal: Number(word), kind });
    }
  });
  return mentions;
}

function elementWords(element) {
  return [element?.label, element?.name, element?.placeholder]
    .flatMap(tokens);
}

const GENERIC_LABEL_WORDS = new Set([
  ...NON_EVIDENCE_WORDS, "your", "please", "here", "optional", "required"
]);

/**
 * Decides whether a form control may be changed in direct mode.
 *
 * Existing information is protected: a control that already holds a value or
 * a checked state may only change when the instruction refers to it. Empty
 * controls may be filled by the planner unless the user asked to leave the
 * other fields alone, in which case every edit needs a reference.
 */
export function createDirectFormScope(instruction) {
  const { positive, protective } = splitInstruction(instruction);
  const positiveWords = new Set(tokens(positive).map(stem));
  const protectiveWords = new Set(tokens(protective).map(stem));
  const positiveText = ` ${norm(positive)} `;
  const positiveOrdinals = ordinalMentions(positive);
  const protectiveOrdinals = ordinalMentions(protective);

  const controlKind = element => {
    const type = String(element?.type ?? "").toLowerCase();
    return type === "checkbox" || type === "radio" ? type : null;
  };

  const ordinalHit = (mentions, element) => {
    const kind = controlKind(element);
    const ordinal = Number(element?.ordinal);
    if (!Number.isInteger(ordinal)) return false;
    return mentions.some(mention =>
      mention.ordinal === ordinal &&
      (mention.kind === null ? kind === null : mention.kind === kind));
  };

  const labelHit = (words, element) => {
    const specific = elementWords(element)
      .filter(word => !GENERIC_LABEL_WORDS.has(word) || /^\d+$/.test(word))
      .map(stem);
    // A numbered control label such as "Checkbox 2" is matched by ordinal
    // only; a bare digit elsewhere in the instruction is not a reference.
    const named = specific.filter(word => !/^\d+$/.test(word));
    return named.length > 0 && named.some(word => words.has(word));
  };

  const valueHit = action => {
    const value = norm(action?.value);
    return value.length >= 1 && positiveText.includes(` ${value} `);
  };

  // Direction of checkbox changes the user asked for. An instruction that
  // only says "check" never permits an uncheck, and the reverse.
  const asksUncheck = /\b(?:un-?check|un-?tick|deselect|clear)\b/i.test(positive);
  const asksCheck = /\b(?<!un)(?<!un-)(?:check|tick|select|enable|turn\s+on)\b/i
    .test(positive.replace(/\b(?:un-?check|un-?tick)\b/gi, " "));

  const hasExistingState = element => {
    const type = String(element?.type ?? "").toLowerCase();
    if (type === "checkbox" || type === "radio") return element.checked === true;
    if (String(element?.tag ?? "").toLowerCase() === "select") {
      return String(element.currentValue ?? "") !== "";
    }
    return String(element?.currentValue ?? "") !== "";
  };

  return {
    /** Returns null when permitted, otherwise a rejection code. */
    reject(element, action, { strict = false } = {}) {
      const referenced = ordinalHit(positiveOrdinals, element) ||
        labelHit(positiveWords, element) || valueHit(action);
      const guarded = ordinalHit(protectiveOrdinals, element) ||
        (labelHit(protectiveWords, element) && !labelHit(positiveWords, element));
      if (guarded && !ordinalHit(positiveOrdinals, element)) {
        return "protected_unchanged_field";
      }
      const boolean = controlKind(element) !== null;
      if (boolean && action?.operation === "uncheck" && asksCheck && !asksUncheck) {
        return "reverses_requested_checkbox_state";
      }
      if (boolean && action?.operation === "check" && asksUncheck && !asksCheck) {
        return "reverses_requested_checkbox_state";
      }
      // A password field is never typed by the model: the safety policy hands
      // it to the person. Refusing it here would stop that handover from
      // ever being offered, so it is not an "unrequested" change.
      if (referenced || String(element?.type ?? "").toLowerCase() === "password") return null;
      if (strict || hasExistingState(element)) {
        return "unrequested_form_field_change";
      }
      return null;
    }
  };
}

function pageCorpus(observation) {
  const elements = observation?.actionableElements ?? [];
  return norm([
    observation?.url,
    observation?.title,
    ...(observation?.headings ?? []),
    observation?.visibleBodyText,
    ...elements.flatMap(element => [
      element.label,
      element.currentValue === "[REDACTED]" ? "" : element.currentValue,
      element.selectedLabel
    ])
  ].filter(Boolean).join(" \n "));
}

const verifiedAction = entry =>
  entry?.execution?.executionCompleted === true &&
  entry?.execution?.verified !== false;

// A check or uncheck only counts while the browser still shows its effect.
// "Checked once, then unchecked again" is not evidence of a checked box.
function effectStillVisible(entry, observation) {
  const operation = entry?.decision?.operation;
  if (operation !== "check" && operation !== "uncheck") return true;
  const where = entry.execution?.urlAfter;
  if (where && observation?.url && where !== observation.url) return true;
  const element = (observation?.actionableElements ?? [])
    .find(item => item.ref === entry.decision.ref);
  const type = String(element?.type ?? "").toLowerCase();
  if (!element || (type !== "checkbox" && type !== "radio")) return true;
  return operation === "check"
    ? element.checked === true
    : element.checked === false;
}

function actionCorpus(history) {
  return norm(history.filter(verifiedAction).flatMap(entry => [
    entry.targetLabel,
    ["fill", "select"].includes(entry.decision?.operation)
      ? entry.decision?.value : "",
    entry.execution?.urlAfter
  ]).filter(Boolean).join(" \n "));
}

// "Open the X page": X must be the page itself (its address, title or
// headings). A link named X somewhere on another page is not evidence.
const PAGE_WORD_FILLER = new Set(
  "the a an its their this that my our your official main new".split(" ")
);

export function requestedPages(positive) {
  const found = [];
  for (const match of String(positive).matchAll(
    // The name runs from the verb to "page" within one clause: it never
    // crosses "and", "then", punctuation or another such verb, so "open X
    // and go to the Y page" asks for the Y page, not for "X and go to Y".
    /\b(?:open|go\s+to|navigate\s+to|visit|reach|load)\s+((?:(?!\b(?:and|then|open|go\s+to|navigate\s+to|visit|reach|load)\b|[,.;:])[\s\S]){1,60}?)\s+(?:page|section|screen)\b/gi
  )) {
    const words = tokens(match[1]).filter(word => !PAGE_WORD_FILLER.has(word));
    if (words.length && words.length <= 5) found.push(words);
  }
  return found;
}

// Requests that are satisfied by being on the right page.
const NAVIGATION_REQUEST =
  /\b(?:open|go\s+to|navigate|visit|reach|load)\b/i;

// Which verified operations can satisfy a requested kind of change.
const REQUIRED_OPERATIONS = [
  [/\b(?:un-?check|un-?tick|deselect)\b/i, ["uncheck", "click"]],
  [/\b(?<!un)(?<!un-)(?:check|tick)\b(?!\s+(?:that|whether|if|for|out)\b)/i, ["check", "click"]],
  [/\b(?:fill|type|enter|write|input)\b/i, ["fill"]],
  [/\b(?:select|choose|pick)\b/i, ["select", "check", "click"]],
  [/\b(?:hover|mouse\s*over)\b/i, ["hover"]],
  [/\b(?:drag)\b/i, ["drag"]],
  [/\bscroll/i, ["scroll"]],
  [/\b(?:screenshots?|screen\s*shots?|screen\s*captures?)\b/i, ["screenshot"]],
  [/\b(?:right[\s-]?click|context[\s-]?menu)\b/i, ["right_click"]],
  [/\b(?:(?<!right[\s-]?)click|tap|press|follow|switch|search|log\s*in|sign\s*in|add|remove|delete|submit|save|send|download|upload|toggle|close|dismiss)\b/i,
    ["click", "press", "switch_tab", "fill", "select", "check", "uncheck", "save_image"]]
];

const CHANGE_OPERATIONS = new Set([
  "fill", "select", "check", "uncheck", "click", "press", "set_range", "drag",
  "right_click", "save_image"
]);

/**
 * Independent completion check for a model's "done" claim.
 *
 * @param {object} input
 * @param {string} input.instruction   The user's original instruction.
 * @param {string} input.claim         Evidence quoted by the model.
 * @param {object} input.observation   Fresh browser observation.
 * @param {Array}  input.history       Executed actions with browser results.
 * @param {object} input.preservation  Form-preservation check result.
 * @param {object} input.workflow      Evidence from the workflow verifier.
 * @param {boolean} input.arrivedByDiscovery  The run itself found and opened
 *   the starting page (no starting URL was given by the user).
 */
// A password the user wrote into the task ("... with password X"). Only the
// user's own words count: never a value the model proposes or a page prints.
// Quote it ("my pass.") if it ends in punctuation or contains spaces.
const STATED_PASSWORD = /\bpassword(?:\s*[:=]\s*|\s+is\s+|\s+)(?:(["\u201c\u2018'])(.+?)\1|([^\s"\u201c\u2018']+))/i;
const NOT_A_PASSWORD = new Set(("field box input and then to is please text entry form label " +
  "button from on in for securely here there as with by the a an my your " +
  "reset recovery manager page link policy rules requirements strength hint visibility toggle").split(" "));

function statedPasswordMatch(instruction) {
  const match = STATED_PASSWORD.exec(String(instruction ?? ""));
  if (!match) return null;
  const quoted = match[2] !== undefined;
  const value = quoted ? match[2] : match[3].replace(/[.,;:]+$/, "");
  if (!value || (!quoted && NOT_A_PASSWORD.has(value.toLowerCase()))) return null;
  // Punctuation after an unquoted value belongs to the sentence, not to it.
  const trail = quoted ? "" : match[3].slice(value.length);
  return { match, value, trail };
}

export function extractStatedPassword(instruction) {
  return statedPasswordMatch(instruction)?.value ?? null;
}

// The instruction with the password value removed, so that no model prompt,
// log, record or report ever contains it.
export function redactStatedPassword(instruction) {
  const found = statedPasswordMatch(instruction);
  if (!found) return String(instruction ?? "");
  const text = String(instruction);
  const { match, trail } = found;
  const word = text.slice(match.index, match.index + "password".length);
  return text.slice(0, match.index) + word + trail +
    text.slice(match.index + match[0].length);
}

// True when the user asks CoPilot to log in. Naming the button, link or page
// ("click the Sign in link", "open the login page") is not asking to log in.
// The keys of the instruction that still have presses owed. The agent uses it
// so that a key press the user asked for (twice, three times) is not refused as
// a repeat of an earlier press that changed nothing on the page.
export function keyPressesOwed(instruction, history = []) {
  return keysStillOwed(splitInstruction(navigationPartOf(instruction)).positive, history);
}

export function asksToLogIn(instruction) {
  return /\b(?:log\s?-?in|sign\s?-?in)\b(?!\s+(?:page|form|screen|button|link|tab|menu|option|field|box))|\blogin\s+(?:to|with|as|into|using)\b/i
    .test(splitInstruction(instruction).positive
      .replace(/\b(?:click|press|tap|open|select|find|locate|hover)\b[^,.;]*?\b(?:log\s?-?in|sign\s?-?in)\b/gi, " "));
}

// True when the user asks to save or download a picture. Reading about a
// picture, or saying not to save it, is not asking.
export function asksToSaveImage(instruction) {
  const text = splitInstruction(instruction).positive;
  return /\b(?:download|save|grab|fetch|store)\b(?:\s+\w+){0,6}?\s+(?:images?|pictures?|photos?|pics?|logos?|icons?|banners?|thumbnails?|wallpapers?|avatars?)\b/i
    .test(text) &&
    !/\b(?:do not|don't|never|without)\s+(?:\w+\s+){0,2}(?:download|save|grab|fetch|store)\b/i.test(text);
}

// True when the user asks to see a picture: "show / view / display / open /
// preview the first image". The picture is then fetched to a file (checked
// from the file, like a save) and shown in the dashboard with a full-screen
// view and a download button. "Click the image" is a click, not this, and a
// name such as "open the image gallery link" is not a picture.
export function asksToShowImage(instruction) {
  const text = splitInstruction(instruction).positive;
  return /\b(?:show|view|display|see|open|preview)\b(?:\s+[\w-]+){0,6}?\s+(?:images?|pictures?|photos?|pics?|logos?|icons?|banners?|thumbnails?|wallpapers?|avatars?)\b(?!\s+(?:gallery|galleries|page|pages|link|links|tab|tabs|folder|menu|search|library|viewer|button|section|carousel|slider)\b)/i
    .test(text) &&
    !/\b(?:do not|don't|never|without)\s+(?:\w+\s+){0,2}(?:show|view|display|see|open|preview)\b/i.test(text);
}

// The task needs a picture file: it asks to save one or to see one.
export function asksForImageFile(instruction) {
  return asksToSaveImage(instruction) || asksToShowImage(instruction);
}

// A request to take a screenshot of the page: { fullPage } or null. Reading
// about screenshots, or saying not to take one, is not asking.
export function screenshotRequest(instruction) {
  const text = splitInstruction(instruction).positive;
  const noun = "(?:screenshots?|screen\\s*shots?|screen\\s*captures?|page\\s*captures?)";
  if (!new RegExp("\\b(?:take|capture|grab|save|make|get|snap|record)\\b(?:\\s+[\\w-]+){0,5}?\\s+" + noun + "\\b", "i").test(text)) return null;
  if (/\b(?:do not|don't|never|without)\s+(?:\w+\s+){0,2}(?:take|capture|grab|save|make|get|snap)\b/i.test(text)) return null;
  return { fullPage: /\b(?:full[\s-]?page|whole\s+page|entire\s+page|full\s+length|scrolling)\b/i.test(text) };
}

// How many pictures the request covers: an explicit number ("two images"),
// 10 for "all" / plural wording without a number, otherwise one per picture
// word it names (overcounting only allows one more save, never blocks one).
export function imageSaveLimit(instruction) {
  const text = splitInstruction(instruction).positive;
  const noun = "(?:images?|pictures?|photos?|pics?|logos?|icons?|banners?|thumbnails?|wallpapers?|avatars?)";
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const numbered = new RegExp("\\b(\\d{1,2}|" + Object.keys(words).join("|") + ")\\b(?:\\s+[\\w-]+){0,2}?\\s+" + noun + "\\b", "i").exec(text);
  if (numbered) {
    const count = Number(numbered[1]) || words[numbered[1].toLowerCase()];
    return Math.min(Math.max(count, 1), 10);
  }
  if (/\b(?:all|every|each)\b(?:\s+[\w-]+){0,3}?\s+(?:images|pictures|photos|pics|logos|icons|banners|thumbnails|wallpapers|avatars)\b/i.test(text) ||
      /\b(?:images|pictures|photos|pics|logos|icons|banners|thumbnails|wallpapers|avatars)\b/i.test(text)) return 10;
  const mentions = text.match(new RegExp("\\b" + noun + "\\b", "gi")) ?? [];
  return Math.min(Math.max(mentions.length, 1), 10);
}

export function verifyDirectCompletion({
  instruction,
  claim = "",
  observation,
  history = [],
  preservation = { verified: true, issues: [] },
  workflow = {},
  tabs = null,
  arrivedByDiscovery = false
}) {
  const checks = [];
  const fail = (reason, detail = {}) => ({
    completed: false,
    reason,
    evidence: { direct: true, checks, ...detail }
  });
  const record = (name, passed, detail) => {
    checks.push({ check: name, passed, ...(detail ? { detail } : {}) });
    return passed;
  };
  // Marks whether a check had anything to check in this run. A check that
  // passes only because it did not apply must not be reported as a reason.
  const relevant = (name, applies) => {
    const entry = checks.filter(item => item.check === name).pop();
    if (entry) entry.relevant = applies === true;
  };
  const verifiedOperations = history.filter(verifiedAction)
    .map(entry => entry.decision?.operation);

  if (!observation || !Array.isArray(observation.actionableElements)) {
    return fail("No fresh browser observation is available.");
  }

  // ---- Vetoes -------------------------------------------------------------
  const formStatePreserved =
    record("form_state_preserved", preservation?.verified === true);
  relevant("form_state_preserved", verifiedOperations.some(operation =>
    ["fill", "select", "check", "uncheck", "set_range"].includes(operation)));
  if (!formStatePreserved) {
    return fail("Form controls the user did not ask to change were modified.");
  }

  const last = history[history.length - 1];
  if (!record("last_action_succeeded", !last || verifiedAction(last))) {
    return fail("The most recent action failed or was not verified.");
  }

  // "Scroll to the bottom / top" is done only when the browser itself
  // reported that end of the page after the last scroll.
  const scrollRequest = splitInstruction(instruction).positive;
  // Every end the user named, in the order named ("to the bottom, then back
  // to the top"). Each must have been reached, and the page must be at the
  // one named last.
  const scrollEdges = /\bscroll/i.test(scrollRequest)
    ? [...scrollRequest.matchAll(/\b(bottom|end|footer|top|beginning|start)\b/gi)]
        .map(match => /^(?:bottom|end|footer)$/i.test(match[1]) ? "atBottom" : "atTop")
    : [];
  const scrollEdge = scrollEdges.at(-1) ?? null;
  const scrolls = history.filter(entry => entry?.decision?.operation === "scroll");
  const missedEdge = scrollEdges.find(edge =>
    !scrolls.some(entry => entry.execution?.scroll?.[edge] === true)) ??
    (scrollEdge && scrolls.at(-1)?.execution?.scroll?.[scrollEdge] !== true
      ? scrollEdge : null);
  const edgeReached = record("scroll_reached_requested_end", !missedEdge);
  relevant("scroll_reached_requested_end", Boolean(scrollEdge));
  if (!edgeReached) {
    return fail(missedEdge === "atBottom"
      ? "The page has not been scrolled to the bottom yet."
      : "The page has not been scrolled to the top yet.");
  }

  if (!record("no_explicit_failure",
    workflow?.explicitFailureEvidence !== true)) {
    return fail("The page reports that the change was not saved.");
  }

  const finalized = record("finalizing_action_performed",
    workflow?.requiresFinalizingAction !== true ||
    workflow?.finalizingActionObserved === true);
  relevant("finalizing_action_performed",
    workflow?.requiresFinalizingAction === true);
  if (!finalized) {
    return fail("The requested save, submit or send action has not been performed.");
  }

  // "Log in" is done only when the page is past the login form. Filling a
  // username, or pressing Login with no password, leaves the form open (or
  // shows it again with an error); a password field still on the page means
  // the login has not happened. Naming the button or page is not asking.
  const loginAsked = asksToLogIn(instruction);
  const loginFormOpen = observation.actionableElements.some(element =>
    String(element.type ?? "").toLowerCase() === "password");
  const loginDone = record("login_form_gone", !(loginAsked && loginFormOpen));
  relevant("login_form_gone", loginAsked);
  if (!loginDone) {
    return fail("The page still shows the password field, so the login is not complete.");
  }

  // "Take a screenshot" is done only when the PNG is on disk, read back with
  // the same size and hash.
  const shotAsked = screenshotRequest(instruction) !== null;
  const shotSaved = record("screenshot_saved", !shotAsked || history.some(entry =>
    entry?.decision?.operation === "screenshot" &&
    entry.execution?.media?.verified === true));
  relevant("screenshot_saved", shotAsked);
  if (!shotSaved) {
    return fail("No screenshot has been saved to disk yet.");
  }

  // "Save / download the image" is done only when the file is on disk: a real
  // image, written, and read back with the same size and hash.
  const imageAsked = asksForImageFile(instruction);
  const imageSaved = record("image_saved", !imageAsked || history.some(entry =>
    entry?.decision?.operation === "save_image" &&
    entry.execution?.media?.verified === true));
  relevant("image_saved", imageAsked);
  if (!imageSaved) {
    return fail("No image has been saved to disk yet.");
  }

  // ---- Positive evidence --------------------------------------------------
  const { positive } = splitInstruction(instruction);
  const page = pageCorpus(observation);
  const actions = actionCorpus(history);
  const evidenceText = ` ${page} ${actions} `;
  const evidenceWords = new Set(evidenceText.split(" ").filter(Boolean).map(stem));

  const missingLiterals = quotedLiterals(positive)
    .filter(literal => !evidenceText.includes(` ${norm(literal)} `));
  const quotedPresent = record("quoted_values_present",
    missingLiterals.length === 0,
    missingLiterals.length ? { missing: missingLiterals } : undefined);
  relevant("quoted_values_present", quotedLiterals(positive).length > 0);
  if (!quotedPresent) {
    return fail(
      `No browser evidence for the requested value: ${missingLiterals.map(v => JSON.stringify(v)).join(", ")}.`,
      { missing: missingLiterals }
    );
  }

  // Only what asks the browser to go somewhere has to show up as evidence.
  // The question a reader answers afterwards ("tell me its price") does not.
  const words = tokens(splitInstruction(navigationPartOf(instruction)).positive);
  const missingWords = [...new Set(words.filter((word, index) => {
    if (NON_EVIDENCE_WORDS.has(word)) return false;
    // What kind of file was asked for is proven by the saved file itself,
    // which was checked above.
    if (imageAsked && /^(?:images?|pictures?|photos?|pics?|logos?|icons?|banners?|thumbnails?|wallpapers?|avatars?)$/.test(word)) return false;
    // Words that say WHICH picture ("main", "largest", "featured") describe the
    // choice among the page's pictures. The saved file is the evidence that a
    // picture was fetched; they are not text the page has to contain.
    if (imageAsked && /^(?:main|primary|featured|top|big|biggest|large|largest|hero|cover|lead|default|headline|principal)$/.test(word)) return false;
    // What a screenshot shows is proven by the saved file, checked above.
    if (shotAsked && /^(?:screenshots?|screen|shots?|captures?|full|whole|entire|page|visible|viewport|length)$/.test(word)) return false;
    // Where to scroll to is a position, not page content. It is proven by
    // the browser's own scroll position, checked above.
    if (scrollEdge && /^(?:bottom|top|end|beginning|start|footer)$/.test(word)) return false;
    // "3 times" is a count of actions, not page content.
    if (/^\d+$/.test(word) && /^times?$/.test(words[index + 1] ?? "")) return false;
    return !evidenceWords.has(stem(word));
  }))];
  const wordsEvidenced = record("instruction_words_evidenced",
    missingWords.length === 0,
    missingWords.length ? { missing: missingWords } : undefined);
  relevant("instruction_words_evidenced",
    words.some(word => !NON_EVIDENCE_WORDS.has(word)));
  if (!wordsEvidenced) {
    return fail(
      `No browser evidence yet for: ${missingWords.join(", ")}.`,
      { missing: missingWords }
    );
  }

  const identity = new Set(norm([
    observation?.url, observation?.title, ...(observation?.headings ?? [])
  ].filter(Boolean).join(" ")).split(" ").filter(Boolean).map(stem));
  // The last page named is the one the run must end on. An earlier page in
  // a sequence ("open the Sport page and then the About page") only has to have
  // been visited: a verified action led to it by its label or address.
  const sequencedPages = sequencedTargets(positive)
    .filter(target => target.kind === "page").map(target => target.name);
  const pagesAsked = sequencedPages.length > 1
    ? sequencedPages : requestedPages(positive);
  const visitedWords = new Set(norm(history.filter(verifiedAction)
    .flatMap(entry => [entry.targetLabel, entry.execution?.urlAfter])
    .filter(Boolean).join(" ")).split(" ").filter(Boolean).map(stem));
  const wrongPage = pagesAsked.find((words, index) =>
    !words.every(word => identity.has(stem(word))) &&
    !(index < pagesAsked.length - 1 &&
      words.every(word => visitedWords.has(stem(word)))));
  const pageIsOpen = record("requested_page_is_open", !wrongPage,
    wrongPage ? { missing: wrongPage } : undefined);
  relevant("requested_page_is_open", requestedPages(positive).length > 0);
  if (!pageIsOpen) {
    return fail(
      `The current page is not the ${wrongPage.join(" ")} page: its address, title and headings do not say so.`,
      { missing: wrongPage }
    );
  }

  // Which tab the task must end on, from the tab the user named last.
  // "First / original / main tab" is the tab the run started on; "new /
  // second / other tab" is any tab opened since. Proven by which tab the
  // browser has in front, never by words on the page.
  const tabMentions = [...positive.matchAll(
    /\b(first|original|previous|main|starting|initial|new|second|other|opened|newly\s+opened)\s+(?:browser\s+)?(?:tab|window)\b/gi)];
  const lastTab = tabMentions.at(-1)?.[1]?.toLowerCase() ?? null;
  const wantsStartTab = lastTab
    ? /^(?:first|original|previous|main|starting|initial)$/.test(lastTab) : null;
  const onRequestedTab = record("requested_tab_is_active",
    wantsStartTab === null || !tabs ||
    (wantsStartTab ? tabs.onStartTab === true
      : tabs.onStartTab === false && tabs.count > 1));
  relevant("requested_tab_is_active", wantsStartTab !== null && Boolean(tabs));
  if (!onRequestedTab) {
    return fail(wantsStartTab
      ? "The browser is not on the first tab, where the task must end."
      : "The browser is not on the new tab, where the task must end.");
  }

  const done = history.filter(verifiedAction)
    .filter(entry => effectStillVisible(entry, observation));
  record("action_effects_still_visible",
    done.length === history.filter(verifiedAction).length);
  relevant("action_effects_still_visible", verifiedOperations.some(
    operation => operation === "check" || operation === "uncheck"));
  const operations = new Set(done.map(entry => entry.decision?.operation));
  const urlChanged = done.some(entry =>
    entry.execution?.previousUrl && entry.execution?.urlAfter &&
    entry.execution.previousUrl !== entry.execution.urlAfter);

  // A "search for X" request is already carried out when the run itself
  // searched the web and the page it opened is about X by its own address,
  // title or headings. Only that search is treated as done; every other
  // requested change still needs its own verified action.
  const changeText = arrivedByDiscovery === true
    ? positive.replace(
        /\bsearch(?:\s+(?:for|up))?\s+((?:(?!\b(?:and|then)\b|[,.;:])[\s\S]){1,60})/gi,
        (clause, subject) => {
          const subjectWords = tokens(subject.replace(/^.*\bfor\s+/i, ""))
            .filter(word => !NON_EVIDENCE_WORDS.has(word));
          return subjectWords.length > 0 &&
            subjectWords.every(word => identity.has(stem(word)))
            ? " " : clause;
        })
    : positive;

  const unmetChange = REQUIRED_OPERATIONS.find(([pattern, accepted]) =>
    pattern.test(changeText) &&
    !accepted.some(operation => operations.has(operation)) &&
    !(urlChanged && accepted.includes("click")));
  const changePerformed = record("requested_change_performed", !unmetChange);
  relevant("requested_change_performed",
    REQUIRED_OPERATIONS.some(([pattern]) => pattern.test(changeText)));
  if (!changePerformed) {
    return fail("A requested change has no verified browser action behind it.");
  }

  // Several named steps ("click A, then click B"): each needs its own verified
  // action, in the order written. A word that is merely on the page (a link in
  // the navigation bar) does not prove the step was done.
  // The question after "and tell me ..." is not a step the browser takes.
  const steps = unmetSteps(splitInstruction(navigationPartOf(instruction)).positive,
    history, { currentWords: identity });
  const stepsDone = record("sequence_steps_evidenced",
    steps.missing.length === 0,
    steps.missing.length ? { missing: steps.missing } : undefined);
  relevant("sequence_steps_evidenced", steps.applies);
  if (!stepsDone) {
    return fail(
      `Not every step of the instruction has a verified action yet. Still to do, in order: ${steps.missing.join(", ")}.`,
      { missing: steps.missing }
    );
  }

  // A key the user named ("press Enter", "press Tab twice") needs its own
  // verified key press, as many times as asked. Typing is not pressing.
  const keyPart = splitInstruction(navigationPartOf(instruction)).positive;
  const missingKeys = keyShortfall(keyPart, history);
  const keysDone = record("key_presses_evidenced", missingKeys.length === 0,
    missingKeys.length ? { missing: missingKeys } : undefined);
  relevant("key_presses_evidenced", keyRequirements(keyPart).length > 0);
  if (!keysDone) {
    return fail(
      `Not every key press of the instruction has a verified action yet. Still to do: ${missingKeys.join(", ")}.`,
      { missing: missingKeys }
    );
  }

  // The last step's result must still be what is open. A run that did every
  // step and then clicked somewhere else is not finished where it was asked to be.
  // For a sequence, and for one named click: a run that clicked the link and
  // then went elsewhere did not end where the click led. A later verified
  // switch of tab or step back is a move the user may have asked for.
  const loneClick = steps.targets.length === 1 && steps.targets[0].kind === "click";
  const leftOnPurpose = loneClick && steps.lastIndex >= 0 &&
    history.slice(steps.lastIndex + 1).some(entry =>
      ["switch_tab", "back"].includes(entry.decision?.operation) &&
      entry.execution?.executionCompleted === true && entry.execution?.verified !== false);
  if (steps.applies && (steps.targets.length >= 2 || (loneClick && !leftOnPurpose)) &&
      steps.lastIndex >= 0) {
    const lastStep = history[steps.lastIndex].execution ?? {};
    const opened = lastStep.previousUrl && lastStep.urlAfter &&
      lastStep.previousUrl !== lastStep.urlAfter;
    const stillOpen = record("last_step_result_still_open",
      !opened || sameAddress(lastStep.urlAfter, observation.url),
      opened ? { opened: lastStep.urlAfter, now: observation.url } : undefined);
    relevant("last_step_result_still_open", true);
    if (!stillOpen) {
      return fail(
        `The browser moved on after the last step. The last step opened ${lastStep.urlAfter}, but the page open now is ${observation.url}.`,
        { opened: lastStep.urlAfter, now: observation.url }
      );
    }
  }

  // "Open ..." is satisfied by a verified action, a changed address, or by
  // the run having found and opened the page itself.
  const navigationRequested = NAVIGATION_REQUEST.test(positive);
  if (!record("navigation_performed",
    !navigationRequested || done.length > 0 || urlChanged ||
    arrivedByDiscovery === true)) {
    return fail("The requested page was not opened by any verified browser action.");
  }

  const stateChanges = done.filter(entry =>
    CHANGE_OPERATIONS.has(entry.decision?.operation)).length;
  const distinctOrdinals = new Set(ordinalMentions(positive)
    .map(mention => `${mention.kind}:${mention.ordinal}`)).size;
  const numberedHandled = record("every_numbered_target_handled",
    distinctOrdinals <= 1 || stateChanges >= distinctOrdinals);
  relevant("every_numbered_target_handled", distinctOrdinals > 1);
  if (!numberedHandled) {
    return fail("Not every numbered control in the instruction has a verified action.");
  }

  const changeRequested = REQUIRED_OPERATIONS
    .some(([pattern]) => pattern.test(changeText));
  const claimText = norm(claim);
  const claimGrounded = claimText.length >= 3 && page.includes(claimText);
  record("claim_quote_on_page", claimGrounded);

  if (!record("supporting_evidence",
    changeRequested
      ? done.length > 0
      : (done.length > 0 || claimGrounded || arrivedByDiscovery === true))) {
    return fail(changeRequested
      ? "No verified browser action supports this completion claim."
      : "The quoted evidence does not appear on the current page.");
  }

  return {
    completed: true,
    reason: "Every requirement of the instruction is backed by browser evidence.",
    evidence: {
      direct: true,
      checks,
      verifiedActions: done.length,
      claimQuoteOnPage: claimGrounded,
      url: observation.url
    }
  };
}
