import assert from "node:assert/strict";
import { interpretTask } from "../src/agent/task-interpreter.js";

const instruction =
  'Find the PDF link described as "Forced download, never opens in the viewer". ' +
  'Click it to download the PDF. Verify from the available browser download ' +
  'evidence that the PDF was successfully downloaded, including its filename. ' +
  'Do not download any other files or visit unrelated websites. ' +
  'If the download cannot be verified, report that explicitly.';

const invalidModelOutput = JSON.stringify({
  type: "browser_goal",
  instruction,
  goal: {
    type: "visible_content",
    text: "download-test.pdf",
    expectedValue: "download-test.pdf"
  }
});

const originalFetch = globalThis.fetch;
const prompts = [];

try {
  globalThis.fetch = async (_url, options) => {
    prompts.push(String(options?.body ?? ""));

    return {
      ok: true,
      json: async () => ({
        response: invalidModelOutput,
        done: true
      })
    };
  };

  const result = await interpretTask(instruction, {
    currentUrl: "https://pdfplaceholder.com/sample-pdf-file",
    formControls: []
  });

  assert.equal(
    prompts.length,
    2,
    "Invalid schema should trigger exactly one correction attempt"
  );

  assert.match(
    prompts[1],
    /Unexpected field/,
    "Correction request must mention the actual validation failure"
  );

  assert.equal(
    result.status,
    "interpretation_failed",
    "Repeated internal schema failure must not become needs_clarification"
  );

  assert.match(result.reason, /Internal task interpretation failed/);

  console.log("PASS: Schema failure triggers corrective retry");
  console.log("PASS: Retry includes actual validation error");
  console.log("PASS: Repeated failure classified as internal error");
  console.log("PASS: No browser actions or actual model calls");
} finally {
  globalThis.fetch = originalFetch;
}
