import http from "node:http";
import { chromium } from "playwright";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  console.log(
    "[SERVER]",
    req.method,
    url.pathname + url.search
  );

  if (req.method === "POST") {
    const status = Number(url.searchParams.get("status"));

    res.writeHead(status, {
      Location: `/settings?updated=1&status=${status}`
    });

    res.end();
    return;
  }

  const status = Number(url.searchParams.get("status")) || 303;
  const updated = url.searchParams.has("updated");

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8"
  });

  res.end(`
    <!doctype html>
    <html>
      <body>
        <form method="post" action="/settings?status=${status}">
          <input name="projectName" value="Website CoPilot">
          <button type="submit">Submit</button>
        </form>

        ${
          updated
            ? "<p>Preferences saved successfully</p>"
            : ""
        }
      </body>
    </html>
  `);
});

await new Promise(resolve =>
  server.listen(0, "127.0.0.1", resolve)
);

const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch({ headless: true });

let failed = 0;

try {
  for (const status of [302, 303]) {
    const page = await browser.newPage();

    let posts = 0;
    let gets = 0;

    page.on("request", request => {
      if (request.method() === "POST") posts++;
      if (request.method() === "GET") gets++;
    });

    try {
      await page.goto(`${origin}/settings?status=${status}`);

      await Promise.all([
        page.waitForURL(
          url => url.searchParams.has("updated"),
          { timeout: 5000 }
        ),
        page.locator('button[type="submit"]').click()
      ]);

      const success = await page
        .getByText("Preferences saved successfully")
        .isVisible();

      if (!success || posts !== 1 || gets < 2) {
        throw new Error(
          `Invalid redirect outcome: success=${success}, ` +
          `POST=${posts}, GET=${gets}`
        );
      }

      console.log(`PASS: HTTP ${status} redirect`);
      console.log(`POST REQUESTS: ${posts}`);
      console.log(`GET REQUESTS: ${gets}`);
      console.log(`FINAL URL: ${page.url()}`);
    } catch (error) {
      failed++;
      console.error(`FAIL: HTTP ${status} redirect`);
      console.error(error.stack ?? error);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log(`\nPassed: ${2 - failed}/2`);
console.log(`Failed: ${failed}/2`);

if (failed) process.exitCode = 1;
