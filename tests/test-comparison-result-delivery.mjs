import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

import {
  extractVerifiedNamedComparison
} from "../src/ui/comparison-result.js";

const titles=[
  "A Light in the Attic",
  "Tipping the Velvet"
];

const startUrl="https://books.toscrape.com/";

const books=[
  {
    title:titles[0],
    price:"£51.77",
    availability:"In stock (22 available)",
    url:startUrl+"catalogue/a-light-in-the-attic_1000/index.html"
  },
  {
    title:titles[1],
    price:"£53.74",
    availability:"In stock (20 available)",
    url:startUrl+"catalogue/tipping-the-velvet_999/index.html"
  }
];

const comparison=books.map(book=>({
  ...book,
  numericPrice:Number(book.price.slice(1)),
  currency:"£"
}));

const run={
  status:"verified_complete",
  interpretedTask:{
    type:"product_comparison",
    startUrl,
    titles,
    limit:2
  },
  execution:{
    status:"verified_complete",
    result:{
      status:"verified_complete",
      comparisonMode:"named_products",
      requestedNames:titles,
      requested:2,
      collected:2,
      books,
      comparison,
      cheapest:{title:titles[0]},
      priceDifference:{
        currency:"£",
        amount:1.97,
        display:"£1.97",
        tied:false
      }
    }
  }
};

const delivered=extractVerifiedNamedComparison(run);

assert.equal(delivered?.verified,true);
assert.equal(delivered?.products.length,2);
assert.equal(delivered?.cheaperTitle,titles[0]);
assert.equal(delivered?.difference,"£1.97");

console.log("PASS: Correct verified comparison delivered");

const invalid=change=>{
  const copy=structuredClone(run);
  change(copy);
  return extractVerifiedNamedComparison(copy);
};

assert.equal(invalid(x=>{
  x.execution.result.books.pop();
}),null);

assert.equal(invalid(x=>{
  x.execution.result.books[0].price="£1.00";
}),null);

assert.equal(invalid(x=>{
  x.execution.result.books[1].url=
    "https://unrelated.example/product";
}),null);

assert.equal(invalid(x=>{
  x.execution.result.priceDifference.display="£0.00";
}),null);

assert.equal(invalid(x=>{
  x.execution.result.books[0].availability="";
}),null);

assert.equal(invalid(x=>{
  x.status="interpretation_failed";
}),null);

console.log("PASS: Missing and inconsistent evidence rejected");

const html=readFileSync("src/ui/index.html","utf8");

for(const id of [
  "comparisonCard",
  "comparisonProducts",
  "comparisonSummary"
]){
  assert.ok(html.includes('id="'+id+'"'));
}

assert.match(html,/function renderComparison\(state\)/);
assert.match(
  html,
  /renderAnswer\(state\);renderComparison\(state\);renderDownload\(state\)/
);

const scripts=[
  ...html.matchAll(/<script>([\s\S]*?)<\/script>/g)
].map(match=>match[1]);

assert.ok(scripts.length>0);

for(const script of scripts){
  new Script(script);
}

console.log("PASS: Dashboard JavaScript parses");

const server=readFileSync("src/ui/server.js","utf8");

assert.match(
  server,
  /extractVerifiedNamedComparison\(result\)/
);

assert.match(
  server,
  /"comparison_unavailable"/
);

assert.match(
  server,
  /comparison: deliveredComparison/
);

console.log("PASS: Server result-delivery path connected");
console.log("PASS: Step 7F.24J regression");
