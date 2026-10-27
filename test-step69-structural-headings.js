import { chromium } from "playwright";

const cases = [
  {
    name: "W3Schools starting page",
    url: "https://www.w3schools.com/html/",
    expected: "HTML Forms",
    shouldMatch: false
  },
  {
    name: "W3Schools destination",
    url: "https://www.w3schools.com/html/html_forms.asp",
    expected: "HTML Forms",
    shouldMatch: true
  },
  {
    name: "Wikipedia destination",
    url: "https://en.wikipedia.org/wiki/Alan_Turing",
    expected: "Alan Turing",
    shouldMatch: true
  },
  {
    name: "Python documentation destination",
    url: "https://docs.python.org/3/tutorial/index.html",
    expected: "Python Tutorial",
    shouldMatch: true
  },
  {
    name: "MDN destination",
    url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array",
    expected: "Array",
    shouldMatch: true
  }
];

const browser = await chromium.launch({ headless: true });

let passed = 0;

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[¶#]+\s*$/g, "")
    .replace(/^(the|a|an)\s+/, "")
    .trim();
}

for (const test of cases) {
  const page = await browser.newPage();

  try {
    await page.goto(test.url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const data = await page.evaluate(() => {
      return [...document.querySelectorAll("h1,h2,h3")]
        .filter(el => el.getClientRects().length > 0)
        .map(el => {
          const landmark = el.closest(
            "main,article,[role='main'],nav,aside,header,footer,[role='navigation']"
          );

          const navigation = el.closest(
            "nav,aside,[role='navigation'],[role='menu'],[role='menubar']"
          );

          const ancestors = [];
          let parent = el.parentElement;

          for (let depth = 0; parent && depth < 5; depth++) {
            ancestors.push({
              tag: parent.tagName.toLowerCase(),
              id: parent.id || "",
              className:
                typeof parent.className === "string"
                  ? parent.className.slice(0, 100)
                  : ""
            });

            parent = parent.parentElement;
          }

          return {
            text: el.innerText.trim(),
            tag: el.tagName.toLowerCase(),
            landmark: landmark?.tagName.toLowerCase() || null,
            landmarkRole: landmark?.getAttribute("role") || null,
            insideNavigation: Boolean(navigation),
            ancestors
          };
        });
    });

    const matches = data.filter(
      heading => normalize(heading.text) === normalize(test.expected)
    );

    const strongMatches = matches.filter(
      heading =>
        !heading.insideNavigation &&
        heading.tag === "h1"
    );

    const actual = strongMatches.length > 0;
    const success = actual === test.shouldMatch;

    if (success) passed++;

    console.log(`\n========== ${test.name} ==========`);

    console.log("Expected:", test.shouldMatch);
    console.log("Structural match:", actual);
    console.log("Result:", success ? "PASS" : "FAIL");

    console.log(
      "Matching heading evidence:",
      JSON.stringify(matches, null, 2)
    );

  } catch (error) {
    console.log(`\n${test.name}: ERROR`);
    console.log(error.message);
  } finally {
    await page.close();
  }
}

await browser.close();

console.log("\n================================");
console.log(`STRUCTURAL RESULTS: ${passed}/${cases.length}`);
console.log("================================");
