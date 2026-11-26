import assert from "node:assert/strict";
import {verifyRequestedPdfIdentity}
  from "../src/agent/pdf-download-identity.js";

const instruction =
  'On the current page, find and click the link labeled '+
  '"Download 1 MB PDF". Download the PDF file and verify '+
  'that an actual PDF was successfully saved, rather than '+
  'merely confirming that the link was clicked. Do not use '+
  'the website search field, upload anything, or submit any '+
  'form. Report success only after independently confirming '+
  'the downloaded file.';

const base = {
  instruction,
  filename:"sample-pdf-1mb.pdf",
  bytes:1048576,
  linkText:"Download 1 MB PDF",
  linkHref:
    "https://www.sampletestfiles.com/sample-files/pdf/1mb/",
  pageTitle:"1 MB PDF Sample: Free Download for Testing"
};

const verify = overrides =>
  verifyRequestedPdfIdentity({...base,...overrides});

if (process.env.PHASE === "before") {
  const result=verify({});
  assert.equal(result.matched,false);
  assert.equal(result.reason,"INSUFFICIENT_DOCUMENT_MATCH");
  console.log("PASS: Original identity failure reproduced");
  process.exit(0);
}

const valid=verify({});
assert.equal(valid.matched,true);
assert.equal(
  valid.reason,
  "EXPLICIT_NAMED_PDF_SIZE_VERIFIED"
);
console.log("PASS: Exact PDF identity accepted");

const cases = [
  ["Wrong byte size",{bytes:5120}],
  ["Missing byte evidence",{bytes:null}],
  ["Wrong filename",{filename:"sample-pdf-5kb.pdf"}],
  ["Wrong link label",{linkText:"Download 5 KB PDF"}],
  ["Wrong requested label",{
    instruction:instruction.replace(
      '"Download 1 MB PDF"',
      '"Download 5 KB PDF"'
    )
  }],
  ["Different requested filename",{
    instruction:instruction+
      " The required filename is other-report.pdf."
  }],
  ["Explicit year constraint",{
    instruction:instruction+
      " The required document is from 2024."
  }],
  ["Explicit semester constraint",{
    instruction:instruction+
      " The required document is for semester 6."
  }],
  ["Negated link click",{
    instruction:
      'Download a PDF, but do not click the link labeled '+
      '"Download 1 MB PDF".'
  }],
  ["Non-download request",{
    instruction:
      'Explain how to click the link labeled "Download 1 MB PDF".'
  }],
  ["Unsafe URL",{linkHref:"javascript:void(0)"}]
];

for(const [name,changes] of cases){
  const result=verify(changes);
  assert.equal(
    result.matched,false,
    `${name}: identity must be rejected`
  );
  console.log("PASS:",name);
}

const semester=verifyRequestedPdfIdentity({
  instruction:"Download semester 6 mathematics PDF.",
  filename:"semester-5-mathematics.pdf",
  linkText:"Semester 5 Mathematics",
  linkHref:"https://example.org/semester-5-mathematics.pdf",
  pageTitle:"Semester 6 Mathematics",
  bytes:1048576
});

assert.equal(
  semester.reason,
  "CONFLICTING_DOCUMENT_IDENTIFIER"
);
assert.equal(semester.matched,false);

console.log("PASS: Existing semester protection");
console.log("PASS: Step 7F.33J identity regression");
