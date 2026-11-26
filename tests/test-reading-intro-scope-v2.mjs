import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  answerWebpage,
  requestsIntroductoryEvidence,
  extractIntroductoryEvidence
} from "../src/agent/webpage-answer.js";

assert.equal(
  requestsIntroductoryEvidence(
    "Explain her contributions using the introductory text."
  ), true
);
assert.equal(
  requestsIntroductoryEvidence("Summarize the whole article."),
  false
);
console.log("PASS: Explicit scope detection");

const previous = process.env.COPILOT_READING_SCOPE_V2;
process.env.COPILOT_READING_SCOPE_V2 = "1";

const browser = await chromium.launch({
  headless: true, args: ["--no-sandbox"]
});

try {
  const page = await browser.newPage();

  const introduction =
    "Grace Hopper was a computer scientist and naval officer. " +
    "She pioneered compiler technology and worked on languages " +
    "that were easier for humans to understand. " +
    "Her programming-language work influenced the development " +
    "of COBOL and helped make computing more accessible.";

  const later =
    "LATER_SECTION_MARKER This text is in a different section " +
    "and should never be included in the introductory evidence.";

  await page.route("https://example.test/reading", route =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><head><title>Reading Test</title></head>
        <body><main><article>
        <h1>Grace Hopper</h1>
        <p>${introduction}</p>
        <h2>Later biography</h2>
        <p>${later}</p>
        </article></main></body></html>`
    })
  );

  await page.goto("https://example.test/reading");

  const scoped = await extractIntroductoryEvidence(
    page, page.url()
  );

  assert.ok(scoped);
  assert.match(scoped.text, /influenced the development/);
  assert.doesNotMatch(scoped.text, /LATER_SECTION_MARKER/);
  console.log("PASS: Section boundary enforced in DOM");

  let calls = 0;

  const response = await answerWebpage(
    page,
    "Explain her contributions using the introductory text.",
    {
      fetchImpl: async (_url, options) => {
        calls++;
        const body = JSON.parse(options.body);
        assert.equal(body.model, "qwen2.5:3b");
        assert.match(body.prompt, /influenced the development/);
        assert.doesNotMatch(body.prompt, /LATER_SECTION_MARKER/);
        assert.match(
          body.system, /Preserve the source's strength of attribution/
        );

        return {
          ok: true,
          json: async () => ({
            response:
              "Grace Hopper was a computer scientist and naval " +
              "officer who pioneered compiler technology and " +
              "influenced the development of COBOL.",
            done: true, done_reason: "stop"
          })
        };
      }
    }
  );

  assert.equal(response.status, "answer_ready");
  assert.equal(response.evidence.readingScope, "introductory_text");
  assert.equal(response.evidence.scopeVerified, true);
  assert.equal(calls, 1);
  console.log("PASS: Only introductory evidence reaches the model");
  console.log("PASS: Answer response contract preserved");
} finally {
  await browser.close();

  if (previous === undefined)
    delete process.env.COPILOT_READING_SCOPE_V2;
  else
    process.env.COPILOT_READING_SCOPE_V2 = previous;
}
