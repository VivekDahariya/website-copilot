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

if (
  selected.some(element =>
    ["Home", "Poetry", "Next"].includes(element.label)
  )
) {
  throw new Error(
    "Irrelevant elements were not filtered."
  );
}

console.log("\nELEMENT RANKING: PASSED");
