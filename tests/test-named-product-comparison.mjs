import assert from "node:assert/strict";

import {
  interpretTask,
  interpretNamedComparisonRequest
} from "../src/agent/task-interpreter.js";

import {
  validateTaskContract
} from "../src/agent/task-contract.js";

import {
  resolveNamedProductLinks,
  buildNamedPriceDifference,
  buildProductPriceComparison
} from "../src/agent/autonomous-workflow.js";

const instruction =
  'On Books to Scrape, compare the books "A Light in the Attic" ' +
  'and "Tipping the Velvet". Visit each book\'s product detail page, ' +
  'record its displayed price in GBP and stock availability, then ' +
  'tell me which book is cheaper and by how much. Use only ' +
  'information actually observed on the website. Do not add ' +
  'anything to the basket, purchase anything, or visit unrelated websites.';

const source = "https://books.toscrape.com/";

const named = interpretNamedComparisonRequest(
  instruction, source
);

assert.deepEqual(
  named.titles,
  ["A Light in the Attic", "Tipping the Velvet"]
);

assert.equal(named.startUrl, source);
assert.equal(named.limit, 2);

const result = await interpretTask(instruction, {
  currentUrl: source,
  fetchImpl: () => {
    throw new Error(
      "The model must not be called for a grounded named comparison."
    );
  }
});

assert.equal(result.status, "interpreted");
assert.deepEqual(result.task.titles, named.titles);

console.log("PASS: Both requested names preserved without model call");

validateTaskContract({
  type: "product_comparison",
  startUrl: source,
  category: "Travel",
  limit: 3
});

assert.throws(
  () => validateTaskContract({
    type: "product_comparison",
    startUrl: source,
    titles: ["Book One", "Book Two"],
    category: "Travel",
    limit: 2
  }),
  /either category or exactly two titles/
);

console.log("PASS: Existing category mode preserved");

const observedLinks = [
  {
    title: "A Light in the Attic",
    label: "A Light in the Attic",
    href: source + "catalogue/a/index.html"
  },
  {
    title: "Tipping the Velvet",
    label: "Tipping the Velvet",
    href: source + "catalogue/b/index.html"
  },
  {
    title: "Unrelated Product",
    label: "Unrelated Product",
    href: source + "catalogue/c/index.html"
  }
];

const links = resolveNamedProductLinks(
  observedLinks, named.titles, source
);

assert.equal(links.length, 2);
assert.equal(
  links[0].url,
  source + "catalogue/a/index.html"
);

assert.equal(
  resolveNamedProductLinks(
    [
      ...observedLinks,
      {
        title: "A Light in the Attic",
        href: source + "catalogue/d/index.html"
      }
    ],
    named.titles,
    source
  ),
  null
);

assert.equal(
  resolveNamedProductLinks(
    [
      {
        title: "A Light in the Attic",
        href: "https://unrelated.example/book"
      },
      observedLinks[1]
    ],
    named.titles,
    source
  ),
  null
);

console.log("PASS: Unique source-grounded links required");
console.log("PASS: Ambiguous and cross-origin links rejected");

const books = [
  {
    title: "A Light in the Attic",
    price: "£51.77",
    availability: "In stock",
    url: links[0].url
  },
  {
    title: "Tipping the Velvet",
    price: "£53.74",
    availability: "In stock",
    url: links[1].url
  }
];

const pricing = buildProductPriceComparison(books);
const difference = buildNamedPriceDifference(pricing);

assert.equal(difference.display, "£1.97");
assert.equal(pricing.cheapest.title, "A Light in the Attic");

const mixed = buildProductPriceComparison([
  books[0],
  { ...books[1], price: "$53.74" }
]);

assert.equal(buildNamedPriceDifference(mixed), null);

console.log("PASS: Price difference calculated correctly");
console.log("PASS: Different currencies cannot be compared");

console.log("PASS: Step 7F.24D regression checks");
