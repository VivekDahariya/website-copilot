import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import {
  executeNaturalLanguageTask
} from "./src/agent/natural-language-executor.js";

const CASES = [
  {
    id: "quotes-author",
    site: "Quotes to Scrape",
    startUrl: "https://quotes.toscrape.com/",
    instruction:
      "Open https://quotes.toscrape.com/. Find Albert Einstein " +
      "through the website's author links and open his author page. " +
      "Finish when the Albert Einstein author heading is visible.",
    expectedHost: "quotes.toscrape.com",
    expectedPath: /^\/author\/Albert-Einstein\/?$/,
    expectedHeading: "Albert Einstein"
  },
  {
    id: "python-tutorial",
    site: "Python Documentation",
    startUrl: "https://docs.python.org/3/",
    instruction:
      "Open https://docs.python.org/3/. Find and open the Python " +
      "Tutorial from the documentation homepage. Finish when " +
      "the Python Tutorial heading is visible.",
    expectedHost: "docs.python.org",
    expectedPath: /^\/3\/tutorial\/(?:index\.html)?$/,
    expectedHeading: "The Python Tutorial"
  },
  {
    id: "mdn-array",
    site: "MDN Web Docs",
    startUrl: "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
    instruction:
      "Open https://developer.mozilla.org/en-US/docs/Web/JavaScript. " +
      "Navigate through the website to the JavaScript Array " +
      "documentation page. Finish when the Array heading is visible.",
    expectedHost: "developer.mozilla.org",
    expectedPath:
      /^\/en-US\/docs\/Web\/JavaScript\/Reference\/Global_Objects\/Array\/?$/,
    expectedHeading: "Array"
  },
  {
    id: "httpbin-forms",
    site: "HTTPBin",
    startUrl: "https://httpbin.org/",
    instruction:
      "Open https://httpbin.org/. Find the Forms example and " +
      "navigate to the form demonstration page. " +
      "Finish when the form demonstration is visible.",
    expectedHost: "httpbin.org",
    expectedPath: /^\/forms\/post\/?$/,
    expectedHeading: null,
    expectedForm: true
  },
  {
    id: "w3schools-html",
    site: "W3Schools",
    startUrl: "https://www.w3schools.com/html/",
    instruction:
      "Open https://www.w3schools.com/html/. Find the HTML Forms " +
      "tutorial through the website navigation and open it. " +
      "Finish when the HTML Forms heading is visible.",
    expectedHost: "www.w3schools.com",
    expectedPath: /^\/html\/html_forms\.asp$/,
    expectedHeading: "HTML Forms"
  }
];

async function independentlyVerify(page, testCase) {
  const url = new URL(page.url());

  const host = url.hostname === testCase.expectedHost;
  const path = testCase.expectedPath.test(url.pathname);

  let heading = true;

  if (testCase.expectedHeading) {
    heading = await page
      .getByRole("heading", {
        name: testCase.expectedHeading,
        exact: true
      })
      .first()
      .isVisible()
      .catch(() => false);
  }

  let form = true;

  if (testCase.expectedForm) {
    form = await page.locator("form").first()
      .isVisible()
      .catch(() => false);
  }

  return {
    passed: host && path && heading && form,
    host,
    path,
    heading,
    form
  };
}

async function runCase(browser, testCase) {
  const context = await browser.newContext();
  const page = await context.newPage();

  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(30000);

  const started = performance.now();

  let result = null;
  let error = null;
  let verification = null;

  try {
    await page.goto(testCase.startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    result = await executeNaturalLanguageTask(
      page,
      testCase.instruction
    );

    verification = await independentlyVerify(
      page,
      testCase
    );
  } catch (caught) {
    error = {
      name: caught.name,
      message: caught.message
    };
  }

  const durationMs = Math.round(performance.now() - started);

  const passed =
    !error &&
    result?.status === "verified_complete" &&
    verification?.passed === true;

  const record = {
    id: testCase.id,
    site: testCase.site,
    passed,
    agentStatus: result?.status ?? null,
    durationMs,
    actions:
      result?.execution?.result?.steps ??
      result?.execution?.result?.navigationSteps ??
      null,
    finalUrl: page.url(),
    interpretedTask: result?.interpretedTask ?? null,
    verification,
    error
  };

  await context.close();

  return record;
}

const browser = await chromium.launch({
  headless: true
});

const results = [];

try {
  for (const testCase of CASES) {
    console.log("\n======================================");
    console.log("STEP 68:", testCase.site);
    console.log("======================================");

    try {
      const result = await runCase(browser, testCase);
      results.push(result);

      console.log("RESULT:", result.passed ? "PASS" : "FAIL");
      console.log("STATUS:", result.agentStatus);
      console.log("ACTIONS:", result.actions);
      console.log("DURATION:", result.durationMs, "ms");
      console.log("FINAL URL:", result.finalUrl);

      if (!result.passed) {
        console.log("VERIFICATION:", result.verification);
        console.log("ERROR:", result.error?.message ?? "none");
      }
    } catch (error) {
      results.push({
        id: testCase.id,
        site: testCase.site,
        passed: false,
        error: {
          name: error.name,
          message: error.message
        }
      });

      console.log("RESULT: FAIL");
      console.log("ERROR:", error.message);
    }
  }
} finally {
  await browser.close();
}

const passed = results.filter(item => item.passed).length;

const report = {
  benchmark: "Website CoPilot — Cross-Website Generalization",
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed,
  failed: results.length - passed,
  successRate: Number(
    (100 * passed / results.length).toFixed(2)
  ),
  results
};

await mkdir("benchmark-results", {
  recursive: true
});

const filename =
  "benchmark-results/cross-website-" +
  new Date().toISOString().replace(/[:.]/g, "-") +
  ".json";

await writeFile(
  filename,
  JSON.stringify(report, null, 2)
);

console.log("\n======================================");
console.log("STEP 68 — GENERALIZATION RESULTS");
console.log("======================================");
console.log("PASSED:", passed, "/", results.length);
console.log("SUCCESS RATE:", report.successRate + "%");
console.log("REPORT:", filename);

if (passed !== results.length) {
  process.exitCode = 1;
}
