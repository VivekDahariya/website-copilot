import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import {
  executeNaturalLanguageTask
} from "./src/agent/natural-language-executor.js";

const BENCHMARKS = [
  {
    id: "wikipedia-alan-turing",
    name: "Wikipedia — Alan Turing",
    startUrl: "https://www.wikipedia.org/",
    instruction:
      "On https://www.wikipedia.org/, search for Alan Turing, " +
      "open his English Wikipedia article, and verify that " +
      "it contains the section Early life and education.",
    verify: async page => {
      const url = new URL(page.url());

      const destination =
        url.hostname === "en.wikipedia.org" &&
        url.pathname === "/wiki/Alan_Turing";

      const heading = await page.getByRole("heading", {
        name: "Alan Turing",
        exact: true
      }).first().isVisible().catch(() => false);

      const section = await page.getByRole("heading", {
        name: "Early life and education",
        exact: true
      }).first().isVisible().catch(() => false);

      return {
        passed: destination && heading && section,
        destination,
        heading,
        section
      };
    }
  },
  {
    id: "wikipedia-ada-lovelace",
    name: "Wikipedia — Ada Lovelace",
    startUrl: "https://www.wikipedia.org/",
    instruction:
      "On https://www.wikipedia.org/, find the English Wikipedia " +
      "article about Ada Lovelace and open it. Finish only when " +
      "the article heading says Ada Lovelace.",
    verify: async page => {
      const url = new URL(page.url());

      const destination =
        url.hostname === "en.wikipedia.org" &&
        url.pathname === "/wiki/Ada_Lovelace";

      const heading = await page.getByRole("heading", {
        name: "Ada Lovelace",
        exact: true
      }).first().isVisible().catch(() => false);

      return {
        passed: destination && heading,
        destination,
        heading
      };
    }
  },
  {
    id: "books-travel-category",
    name: "Books to Scrape — Travel Category",
    startUrl: "https://books.toscrape.com/",
    instruction:
      "Open https://books.toscrape.com/. " +
      "Find and open the Travel category. " +
      "Finish when the Travel category page is visible.",
    verify: async page => {
      const url = new URL(page.url());

      const destination =
        url.hostname === "books.toscrape.com" &&
        url.pathname.includes("/catalogue/category/books/travel_");

      const heading = await page.getByRole("heading", {
        name: "Travel",
        exact: true
      }).first().isVisible().catch(() => false);

      return {
        passed: destination && heading,
        destination,
        heading
      };
    }
  },
  {
    id: "books-mystery-category",
    name: "Books to Scrape — Mystery Category",
    startUrl: "https://books.toscrape.com/",
    instruction:
      "Open https://books.toscrape.com/. " +
      "Find and open the Mystery category. " +
      "Finish when the Mystery category page is visible.",
    verify: async page => {
      const url = new URL(page.url());

      const destination =
        url.hostname === "books.toscrape.com" &&
        url.pathname.includes("/catalogue/category/books/mystery_");

      const heading = await page.getByRole("heading", {
        name: "Mystery",
        exact: true
      }).first().isVisible().catch(() => false);

      return {
        passed: destination && heading,
        destination,
        heading
      };
    }
  }
];

function classifyFailure(result, error, verification) {
  if (error) {
    if (/timeout/i.test(error.message)) return "timeout";
    return "execution_error";
  }

  if (result?.status === "needs_clarification") {
    return "interpretation_failure";
  }

  if (result?.status === "approval_required") {
    return "approval_required";
  }

  if (result?.status === "human_handover_required") {
    return "human_handover_required";
  }

  if (result?.status !== "verified_complete") {
    return "agent_incomplete";
  }

  if (!verification?.passed) {
    return "independent_verification_failed";
  }

  return null;
}

async function runBenchmark(browser, benchmark) {
  const context = await browser.newContext();
  const page = await context.newPage();

  const started = performance.now();

  let result = null;
  let error = null;
  let verification = null;

  try {
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(30000);

    await page.goto(benchmark.startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    result = await executeNaturalLanguageTask(
      page,
      benchmark.instruction
    );

    verification = await benchmark.verify(page);
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
    id: benchmark.id,
    name: benchmark.name,
    passed,
    agentStatus: result?.status ?? null,
    failureType: passed
      ? null
      : classifyFailure(result, error, verification),
    durationMs,
    actions:
      result?.execution?.result?.steps ??
      result?.execution?.result?.navigationSteps ??
      null,
    finalUrl: page.url(),
    interpretedTask: result?.interpretedTask ?? null,
    independentVerification: verification,
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
  for (const benchmark of BENCHMARKS) {
    console.log("\n========================================");
    console.log("BENCHMARK:", benchmark.name);
    console.log("========================================");

    const result = await runBenchmark(browser, benchmark);

    results.push(result);

    console.log("RESULT:", result.passed ? "PASS" : "FAIL");
    console.log("AGENT STATUS:", result.agentStatus);
    console.log("ACTIONS:", result.actions);
    console.log("DURATION:", result.durationMs, "ms");
    console.log("FINAL URL:", result.finalUrl);

    if (!result.passed) {
      console.log("FAILURE:", result.failureType);
      console.log("ERROR:", result.error?.message ?? "none");
    }
  }
} finally {
  await browser.close();
}

const passed = results.filter(result => result.passed).length;

const report = {
  benchmark: "Website CoPilot — Real-World Evaluation",
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed,
  failed: results.length - passed,
  successRate: results.length
    ? Number(((passed / results.length) * 100).toFixed(2))
    : 0,
  results
};

await mkdir("benchmark-results", {
  recursive: true
});

const filename =
  "benchmark-results/real-world-" +
  new Date().toISOString().replace(/[:.]/g, "-") +
  ".json";

await writeFile(
  filename,
  JSON.stringify(report, null, 2)
);

console.log("\n========================================");
console.log("STEP 67 — REAL-WORLD BENCHMARK RESULTS");
console.log("========================================");
console.log("PASSED:", passed, "/", results.length);
console.log("SUCCESS RATE:", report.successRate + "%");
console.log("REPORT:", filename);

if (passed !== results.length) {
  process.exitCode = 1;
}
