import assert from "node:assert/strict";
import {
  focusProfessionContributionsAnswer
} from "../src/agent/webpage-answer.js";

const instruction =
  "Explain her profession and major contributions " +
  "to computing using the introductory text.";

const answer =
  "Grace Hopper was an American computer scientist and mathematician. " +
  "She pioneered machine-independent programming languages " +
  "and developed FLOW-MATIC, influencing COBOL. " +
  "She earned a Ph.D. at Yale University and taught at Vassar College. " +
  "Her contributions included developing compiler technology. " +
  "She received 40 honorary degrees and a national award.";

const result =
  focusProfessionContributionsAnswer(answer, instruction);

assert.equal(result.applied, true);
assert.equal(result.removedSentences, 2);
assert.match(result.answer, /computer scientist/);
assert.match(result.answer, /FLOW-MATIC/);
assert.match(result.answer, /compiler technology/);
assert.doesNotMatch(result.answer, /Yale University/);
assert.doesNotMatch(result.answer, /honorary degrees/);

console.log("PASS: Profession and contributions preserved");
console.log("PASS: Unrequested education and awards removed");

const awardsRequest =
  "Explain her profession, contributions and awards.";

assert.equal(
  focusProfessionContributionsAnswer(answer, awardsRequest).answer,
  answer
);

console.log("PASS: Explicit award request remains unchanged");

const otherRequest = "Summarize the article.";
assert.equal(
  focusProfessionContributionsAnswer(answer, otherRequest).answer,
  answer
);

console.log("PASS: Other reading tasks remain unchanged");

const noContribution =
  "Morgan was a scientist. Morgan received several honorary degrees.";

const limited =
  focusProfessionContributionsAnswer(
    noContribution, instruction
  );

assert.equal(limited.insufficientFocus, true);
assert.equal(limited.answer, noContribution);

console.log("PASS: Missing contributions are not invented");
