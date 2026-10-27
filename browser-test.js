import { chromium } from "playwright";

async function main() {
  let browser;

  try {
    console.log("Starting Website CoPilot browser...");

    browser = await chromium.launch({
      headless: false
    });

    const page = await browser.newPage();

    console.log("Navigating to example.com...");

    await page.goto("https://example.com", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const title = await page.title();
    const url = page.url();

    console.log("\n========== BROWSER RESULT ==========");
    console.log("Title:", title);
    console.log("URL:", url);

    if (title !== "Example Domain") {
      throw new Error(`Unexpected page title: ${title}`);
    }

    console.log("Verification: PASSED");

  } catch (error) {
    console.error("Browser test failed:", error.message);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed.");
    }
  }
}

await main();
