import { chromium } from "playwright";
import { pathToFileURL } from "node:url";

const verifierModule = await import(
  pathToFileURL(
    `${process.cwd()}/src/agent/goal-verifier.js`
  ).href
);

console.log(
  "Available verifier exports:",
  Object.keys(verifierModule)
);

const browser = await chromium.launch({ headless: true });

const cases = [
  {
    name: "W3Schools starting page",
    url: "https://www.w3schools.com/html/",
    expectedHeading: "HTML Forms",
    expectedComplete: false
  },
  {
    name: "W3Schools destination",
    url: "https://www.w3schools.com/html/html_forms.asp",
    expectedHeading: "HTML Forms",
    expectedComplete: true
  }
];

for (const test of cases) {
  const page = await browser.newPage();

  try {
    await page.goto(test.url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const observation = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
        .filter(el => el.getClientRects().length > 0)
        .map(el => el.innerText.trim())
        .filter(Boolean),
      visibleBodyText: document.body?.innerText || ""
    }));

    const matchingHeadings = observation.headings.filter(
      heading => heading.toLowerCase() ===
        test.expectedHeading.toLowerCase()
    );

    console.log(`\n${test.name}`);
    console.log("URL:", observation.url);
    console.log("Matching headings:", matchingHeadings);
    console.log("Expected completion:", test.expectedComplete);

    if (!test.expectedComplete && matchingHeadings.length > 0) {
      console.log(
        "WARNING: Destination heading appears on starting page."
      );
    }
  } catch (error) {
    console.log("ERROR:", error.message);
  } finally {
    await page.close();
  }
}

await browser.close();
