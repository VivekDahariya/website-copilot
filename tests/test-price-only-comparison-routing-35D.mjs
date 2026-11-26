import assert from "node:assert/strict";
import {
  interpretNamedComparisonRequest,
  interpretTask
} from "../src/agent/task-interpreter.js";

import {isReadOnlyQuestion}
  from "../src/agent/webpage-answer.js";

const url="https://books.toscrape.com/";

const task=
  'On this bookstore website, compare the prices of two '+
  'books: "A Light in the Attic" and "Tipping the Velvet". '+
  "Open each book's individual product page, independently "+
  'read its listed price, and determine which book is cheaper. '+
  'Report both book titles, their exact prices, and the '+
  'cheaper book. Do not add anything to the basket, submit '+
  'forms, or purchase anything. Report success only after '+
  'verifying the prices from both product pages.';

if(process.env.PHASE==="before"){
  assert.equal(
    interpretNamedComparisonRequest(task,url),
    null
  );
  console.log(
    "PASS: Original price-only routing rejection reproduced"
  );
  process.exit(0);
}

const named=interpretNamedComparisonRequest(task,url);

assert.ok(named);
assert.equal(named.type,"product_comparison");
assert.deepEqual(
  named.titles,
  ["A Light in the Attic","Tipping the Velvet"]
);
assert.equal(named.startUrl,url);
assert.equal(named.limit,2);

console.log("PASS: Exact original task recognized");
console.log("PASS: Both product names preserved");

assert.equal(isReadOnlyQuestion(task),false);
console.log("PASS: Product-page navigation remains authorized");

let modelCalls=0;

const result=await interpretTask(task,{
  currentUrl:url,
  fetchImpl:async()=>{
    modelCalls++;
    throw new Error(
      "Named price comparison must not use AI interpretation"
    );
  }
});

assert.equal(result.status,"interpreted");
assert.equal(result.task.type,"product_comparison");
assert.deepEqual(result.task.titles,named.titles);
assert.equal(modelCalls,0);

console.log("PASS: Dedicated comparison workflow selected");
console.log("PASS: Zero model interpretation calls");

const withAvailability=
  task+" Also verify stock availability.";

assert.equal(
  interpretNamedComparisonRequest(
    withAvailability,url
  )?.type,
  "product_comparison"
);

console.log("PASS: Existing price-and-stock tasks preserved");

const invalid=[
  [
    "Missing comparison intent",
    task.replace("compare the prices","inspect the prices")
  ],
  [
    "Missing price requirement",
    task.replaceAll(/prices?/gi,"cost information")
  ],
  [
    "Additional comparison dimension",
    task+" Compare ratings as well."
  ],
  [
    "Additional third product",
    task.replace(
      '"Tipping the Velvet"',
      '"Tipping the Velvet" and "Another Book"'
    )
  ],
  [
    "Duplicate product title",
    task.replace(
      '"Tipping the Velvet"',
      '"A Light in the Attic"'
    )
  ]
];

for(const [label,instruction] of invalid){
  assert.equal(
    interpretNamedComparisonRequest(instruction,url),
    null,
    label
  );
  console.log("PASS: Rejected",label);
}

console.log("PASS: Step 7F.35D routing regression");
