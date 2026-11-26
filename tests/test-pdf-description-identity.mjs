import assert from "node:assert/strict";
import { chromium } from "playwright";

import {
  capturePdfDescriptionEvidence
} from "../src/agent/pdf-description-evidence.js";

import {
  verifyRequestedPdfIdentity
} from "../src/agent/pdf-download-identity.js";

const href =
  "https://example.test/pdf/Download+Test.pdf?download=1";

const otherHref =
  "https://example.test/pdf/Another+Document.pdf";

const instruction =
  'Find the PDF link described as "Forced download, never opens ' +
  'in the viewer". Click it to download the PDF. Verify from ' +
  'browser download evidence that it was saved. Do not download ' +
  'any other files or visit unrelated websites.';

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  await page.setContent(`
    <table>
      <tr>
        <td>Ordinary sample file</td>
        <td><a href="${otherHref}">Another Document</a></td>
      </tr>
      <tr>
        <td>Forced download, never opens in the viewer</td>
        <td><a href="${href}">/pdf/Download+Test.pdf?download=1</a></td>
      </tr>
    </table>
  `);

  const evidence = await capturePdfDescriptionEvidence(
    page, instruction, href
  );

  assert.ok(evidence, "Matching source description required");
  assert.equal(evidence.href, href);
  assert.equal(evidence.pdfLinkCount, 1);

  console.log("PASS: Source description uniquely identifies PDF link");

  const request = {
    instruction,
    filename: "Download+Test.pdf",
    linkText: "/pdf/Download+Test.pdf?download=1",
    linkHref: href,
    pageTitle: "Sample PDF files",
    descriptionEvidence: evidence
  };

  const accepted = verifyRequestedPdfIdentity(request);

  assert.equal(accepted.matched, true);
  assert.equal(
    accepted.reason,
    "DESCRIPTIVE_LINK_IDENTITY_SUPPORTED"
  );

  console.log("PASS: Described file passes identity verification");

  assert.notEqual(
    verifyRequestedPdfIdentity({
      ...request,
      descriptionEvidence: null
    }).matched,
    true
  );

  assert.notEqual(
    verifyRequestedPdfIdentity({
      ...request,
      linkHref: otherHref
    }).matched,
    true
  );

  console.log("PASS: Missing or mismatched evidence is rejected");

  const wrongLinkEvidence =
    await capturePdfDescriptionEvidence(
      page, instruction, otherHref
    );

  assert.equal(wrongLinkEvidence, null);

  console.log("PASS: Unrelated PDF cannot inherit description");

  await page.setContent(`
    <div>
      Forced download, never opens in the viewer
      <a href="${href}">First PDF</a>
      <a href="${otherHref}">Second PDF</a>
    </div>
  `);

  const ambiguous =
    await capturePdfDescriptionEvidence(
      page, instruction, href
    );

  assert.equal(ambiguous, null);

  console.log("PASS: Multiple PDFs in one context are rejected");

  const explicitDifferentFile =
    'Download "Wrong.pdf" using the description ' +
    '"Forced download, never opens in the viewer".';

  assert.notEqual(
    verifyRequestedPdfIdentity({
      ...request,
      instruction: explicitDifferentFile
    }).matched,
    true
  );

  console.log("PASS: Explicit filename cannot be overridden");

  console.log("PASS: Step 7F.23K regression");
} finally {
  await browser.close();
}
