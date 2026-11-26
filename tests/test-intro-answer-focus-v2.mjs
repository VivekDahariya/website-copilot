import assert from "node:assert/strict";
import { chromium } from "playwright";
import { answerWebpage } from "../src/agent/webpage-answer.js";

const previous = process.env.COPILOT_READING_SCOPE_V2;

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"]
});

try {
  const page = await browser.newPage();

  const introduction =
    "Avery Morgan was a computer scientist and software engineer. " +
    "Morgan developed compiler tools and contributed to programming " +
    "language design. The work helped other engineers write " +
    "portable software and improved development workflows.";

  const unrelated =
    "UNRELATED_AWARD_MARKER Morgan received numerous honors " +
    "and had several buildings named in recognition of the work.";

  await page.route("https://example.test/reading-focus", route =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <html><head><title>Reading Focus Test</title></head>
        <body><main><article>
          <h1>Avery Morgan</h1>
          <p>${introduction}</p>
          <h2>Recognition</h2>
          <p>${unrelated}</p>
        </article></main></body></html>`
    })
  );

  await page.goto("https://example.test/reading-focus");

  for (const enabled of [true, false]) {
    process.env.COPILOT_READING_SCOPE_V2 =
      enabled ? "1" : "0";

    let calls = 0;

    const result = await answerWebpage(
      page,
      "Explain Avery Morgan's profession and major computing " +
      "contributions using the introductory text.",
      {
        fetchImpl: async (_url, options) => {
          calls++;
          const body = JSON.parse(options.body);

          assert.equal(body.model, "qwen2.5:3b");

          if (enabled) {
            assert.match(
              body.system,
              /actual questions as the answer checklist/
            );
            assert.match(
              body.system,
              /Exclude unrelated education, honors/
            );
            assert.match(
              body.system,
              /Do not imply sole authorship/
            );
            assert.match(
              body.prompt,
              /contributed to programming language design/
            );
            assert.doesNotMatch(
              body.prompt,
              /UNRELATED_AWARD_MARKER/
            );
          } else {
            assert.doesNotMatch(
              body.system,
              /actual questions as the answer checklist/
            );
          }

          return {
            ok: true,
            json: async () => ({
              response:
                "Avery Morgan was a computer scientist and " +
                "software engineer. Morgan developed compiler " +
                "tools and contributed to programming-language " +
                "design, improving software portability.",
              done: true,
              done_reason: "stop"
            })
          };
        }
      }
    );

    assert.equal(result.status, "answer_ready");
    assert.equal(calls, 1);

    if (enabled) {
      assert.equal(
        result.evidence.readingScope,
        "introductory_text"
      );
    } else {
      assert.equal(
        result.evidence.readingScope,
        undefined
      );
    }
  }

  console.log("PASS: Focus instructions enabled for scoped reading");
  console.log("PASS: Unrelated sections excluded from model input");
  console.log("PASS: Legacy reading prompt unchanged when disabled");
  console.log("PASS: One model call per successful answer");

} finally {
  await browser.close();

  if (previous === undefined)
    delete process.env.COPILOT_READING_SCOPE_V2;
  else
    process.env.COPILOT_READING_SCOPE_V2 = previous;
}
