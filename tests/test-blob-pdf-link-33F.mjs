import assert from "node:assert/strict";

import {getEligiblePdfDownloadClick}
  from "../src/agent/pdf-download-click-guard.js";

const pageUrl=
  "https://www.sampletestfiles.com/sample-files/pdf/1mb/";

const instruction=
  'On the current page, find and click the link labeled '+
  '"Download 1 MB PDF". Download the PDF file and verify '+
  'that an actual PDF was successfully saved, rather than '+
  'merely confirming that the link was clicked. Do not use '+
  'the website search field, upload anything, or submit any form.';

const decision={
  ref:"e14",
  operation:"click",
  value:"Download 1 MB PDF"
};

const element={
  ref:"e14",
  tag:"a",
  label:"Download 1 MB PDF",
  href:pageUrl
};

const candidate=(changes={})=>
  getEligiblePdfDownloadClick({
    instruction,
    decision,
    element,
    pageUrl,
    ...changes
  });

if(process.env.PHASE==="before"){
  assert.equal(candidate(),null);
  console.log(
    "PASS: Existing guard rejects the real self-referencing PDF link"
  );
  process.exit(0);
}

assert.deepEqual(candidate(),{
  label:"Download 1 MB PDF",
  href:pageUrl
});

console.log("PASS: Exact requested PDF link eligible for capture");

assert.equal(
  candidate({
    element:{
      ...element,
      label:"Download 5 KB PDF"
    }
  }),
  null
);

assert.equal(
  candidate({
    instruction:
      'Click the link labeled "Download 5 KB PDF". Download the PDF.'
  }),
  null
);

assert.equal(
  candidate({
    instruction:"Explain how PDF downloads work."
  }),
  null
);

console.log("PASS: Wrong or non-download instructions rejected");

assert.equal(
  candidate({
    element:{
      ...element,
      href:"https://example.org/unrelated"
    }
  }),
  null
);

assert.equal(
  candidate({
    element:{
      ...element,
      href:"https://www.sampletestfiles.com/other/"
    }
  }),
  null
);

assert.equal(
  candidate({
    element:{
      ...element,
      href:"javascript:void(0)"
    }
  }),
  null
);

console.log("PASS: Unrelated and unsafe destinations rejected");

assert.equal(
  candidate({
    decision:{...decision,operation:"fill"}
  }),
  null
);

assert.equal(
  candidate({
    element:{...element,tag:"button"}
  }),
  null
);

console.log("PASS: Non-link and non-click actions rejected");

// Conventional direct PDF URLs must still work.
const directUrl=
  "https://example.org/reports/sample.pdf";

assert.deepEqual(
  candidate({
    element:{
      ...element,
      href:directUrl
    }
  }),
  {
    label:"Download 1 MB PDF",
    href:directUrl
  }
);

console.log("PASS: Existing direct PDF support preserved");
console.log("PASS: Step 7F.33F regression");
