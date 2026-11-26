import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createExplicitDestinationGoal
} from "../src/agent/explicit-destination-goal.js";

import {
  verifyGoal
} from "../src/agent/goal-verifier.js";

const instruction =
  'Find the official MDN Web Docs documentation page for the ' +
  'JavaScript Array.prototype.map() method. Discover the correct ' +
  'website yourself, navigate to the documentation page, and ' +
  'verify that the destination belongs to developer.mozilla.org ' +
  'and that the main heading is "Array.prototype.map()". ' +
  'Do not consider a search results page as successful navigation. ' +
  'Do not visit unrelated websites. If the correct destination ' +
  'cannot be verified, report that explicitly instead of claiming success.';

const goal = createExplicitDestinationGoal(instruction);

assert.deepEqual(goal, {
  type: "page_destination",
  hostname: "developer.mozilla.org",
  heading: "Array.prototype.map()"
});

console.log("PASS: Exact hostname and heading preserved");

const correct = {
  url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map",
  title: "Array.prototype.map() - JavaScript | MDN",
  headings: ["Array.prototype.map()"],
  headingEvidence: [{
    tag: "h1",
    text: "Array.prototype.map()",
    insideNavigation: false
  }],
  visibleBodyText: "Array.prototype.map()"
};

assert.equal(
  verifyGoal(correct, goal).completed,
  true
);

console.log("PASS: Correct destination verified");

const wrongDomain = {
  ...correct,
  url: "https://unrelated.example/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map"
};

assert.equal(
  verifyGoal(wrongDomain, goal).completed,
  false
);

// A real homepage has homepage title and heading evidence.
// Do not retain the article heading while changing only its URL.
const homepage = {
  ...correct,
  url: "https://developer.mozilla.org/en-US/",
  title: "MDN Web Docs",
  headings: ["MDN Web Docs"],
  headingEvidence: [{
    tag: "h1",
    text: "MDN Web Docs",
    insideNavigation: false
  }],
  visibleBodyText: "MDN Web Docs"
};

assert.equal(
  verifyGoal(homepage, goal).completed,
  false
);

const searchPage = {
  ...correct,
  url: "https://developer.mozilla.org/en-US/search?q=map",
  title: "Search results - MDN"
};

assert.equal(
  verifyGoal(searchPage, goal).completed,
  false
);

console.log("PASS: Wrong domain, real homepage, search rejected");

const sidebarOnly = {
  ...correct,
  headingEvidence: [{
    tag: "h2",
    text: "Array.prototype.map()",
    insideNavigation: true
  }]
};

assert.equal(
  verifyGoal(sidebarOnly, goal).completed,
  false
);

const wrongArticle = {
  ...correct,
  title: "Array.prototype.filter() - JavaScript | MDN"
};

assert.equal(
  verifyGoal(wrongArticle, goal).completed,
  false
);

console.log("PASS: Sidebar and wrong article rejected");

assert.equal(
  createExplicitDestinationGoal(
    "Compare two product prices and stock availability."
  ),
  null
);

assert.equal(
  createExplicitDestinationGoal(
    "Download the PDF and verify its filename."
  ),
  null
);

assert.equal(
  createExplicitDestinationGoal(
    "Find the official MDN page about JavaScript arrays."
  ),
  null
);

console.log("PASS: Other workflows unaffected");

const source = readFileSync(
  "src/agent/natural-language-executor.js",
  "utf8"
);

assert.match(
  source,
  /createExplicitDestinationGoal\(instruction\)/
);

assert.match(
  source,
  /explicitPdfGoal\s*\?\?\s*explicitDestinationGoal\s*\?\?\s*verifiedDiscoveredGoal/
);

console.log("PASS: Executor routing verified");
console.log("PASS: Step 7F.25C regression");
