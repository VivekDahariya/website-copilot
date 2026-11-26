import {
  rankElements,
  selectRelevantElements
} from "./src/agent/element-ranker.js";

const elements = [
  {
    ref: "e1",
    label: "Home",
    href: "/index.html"
  },
  {
    ref: "e2",
    label: "Poetry",
    href: "/category/poetry"
  },
  {
    ref: "e3",
    label: "Travel",
    href: "/category/travel"
  },
  {
    ref: "e4",
    label: "Next",
    href: "/page-2"
  }
];

const task =
  "Find the Travel category on this website and open its category page.";

const ranked = rankElements(task, elements);

console.table(
  ranked.map(element => ({
    ref: element.ref,
    label: element.label,
    score: element.relevanceScore
  }))
);

const selected = selectRelevantElements(
  task,
  elements
);

if (ranked[0].label !== "Travel") {
  throw new Error("Travel was not ranked first.");
}

// Controls whose labels share nothing with the task are deliberately kept:
// multi-step workflows need intermediate controls. The relevant control must
// still be offered first, and nothing observed may be discarded.
if (selected.length !== elements.length) {
  throw new Error("Observed controls were discarded.");
}

if (selected[0].label !== "Travel") {
  throw new Error("The relevant control was not offered first.");
}

console.log("\nELEMENT RANKING: PASSED");
