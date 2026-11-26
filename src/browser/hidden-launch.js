// Starts Chromium so that no window is ever shown, while keeping it a real
// (headed) browser that "Show real browser" can reveal later.
//
// On macOS a normal launch creates a visible window that is only minimized a
// moment later, which shows as a flash. Here the app is started hidden with
// `open -g -j`, and Playwright connects to it over the local debugging port.
//
// The browser is a separate process, so closing it must stop that process and
// remove its throwaway profile. This module does that for every way a run can
// end (finish, stop, failure, Ctrl+C). If anything about the hidden launch does
// not work, launchHiddenBrowser returns null and the caller uses the normal
// launch, so a run is never lost because of this.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const live = new Set();
let exitHandlersInstalled = false;

// "/.../Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
// -> "/.../Google Chrome for Testing.app"
export function appBundlePath(executablePath) {
  const text = String(executablePath ?? "");
  const end = text.indexOf(".app");
  return end > 0 ? text.slice(0, end + 4) : null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function pidListeningOn(port) {
  try {
    const { stdout } = await run("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
    const pid = Number(stdout.split("\n").find(Boolean));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killNow(entry) {
  try { if (alive(entry.pid)) process.kill(entry.pid, "SIGTERM"); } catch {}
  try { rmSync(entry.dir, { recursive: true, force: true }); } catch {}
}

function installExitHandlers() {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  process.once("exit", () => { for (const entry of live) killNow(entry); });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      for (const entry of live) killNow(entry);
      process.exit(code);
    });
  }
}

async function waitForDebugPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

async function stopProcess(entry) {
  const deadline = Date.now() + 3000;
  while (alive(entry.pid) && Date.now() < deadline) await sleep(50);
  if (alive(entry.pid)) {
    try { process.kill(entry.pid, "SIGTERM"); } catch {}
    const grace = Date.now() + 1500;
    while (alive(entry.pid) && Date.now() < grace) await sleep(50);
  }
  if (alive(entry.pid)) {
    try { process.kill(entry.pid, "SIGKILL"); } catch {}
  }
  live.delete(entry);
  await rm(entry.dir, { recursive: true, force: true }).catch(() => {});
}

// Returns { browser, context, page } or null when a hidden launch is not
// available or did not work. `spawnApp` and `revealApp` exist so the lifecycle
// can be tested on machines without macOS; real runs use `open`.
export async function launchHiddenBrowser({
  chromium,
  viewport = { width: 1280, height: 800 },
  platform = process.platform,
  spawnApp = null,
  revealApp = null,
  startupTimeoutMs = 15000,
  log = () => {}
} = {}) {
  if (!chromium) return null;
  if (platform !== "darwin" && !spawnApp) return null;
  const app = appBundlePath(chromium.executablePath());
  if (!app && !spawnApp) return null;

  const entry = { pid: null, dir: null };
  let browser = null;
  try {
    const port = await freePort();
    entry.dir = await mkdtemp(join(tmpdir(), "wcp-browser-"));
    live.add(entry);
    installExitHandlers();

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${entry.dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--use-mock-keychain",
      "--password-store=basic"
    ];
    let spawned = null;
    if (spawnApp) spawned = await spawnApp({ app, args, port, dir: entry.dir });
    else await run("open", ["-g", "-j", "-n", "-a", app, "--args", ...args]);

    if (!(await waitForDebugPort(port, startupTimeoutMs))) {
      throw new Error("the browser did not open its local debugging port");
    }
    entry.pid = Number.isInteger(spawned?.pid) ? spawned.pid : await pidListeningOn(port);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error("the browser has no default context");
    const page = context.pages()[0] ?? await context.newPage();
    // A fresh browser starts on its own "new tab" page; start from a plain
    // blank page instead, like a normal Playwright launch does.
    await page.goto("about:blank");
    await page.setViewportSize(viewport);
    context.on("page", opened => { opened.setViewportSize(viewport).catch(() => {}); });
    // A hidden window must still be capturable, because the dashboard preview
    // depends on screenshots. If this fails, use the normal launch instead.
    await page.screenshot({ timeout: 5000 });

    const disconnect = browser.close.bind(browser);
    let closing = null;
    browser.close = () => {
      closing ??= (async () => {
        try {
          const session = await browser.newBrowserCDPSession();
          await Promise.race([session.send("Browser.close"), sleep(2000)]);
        } catch {}
        await disconnect().catch(() => {});
        await stopProcess(entry);
      })();
      return closing;
    };
    browser.wcpReveal = async () => {
      if (revealApp) await revealApp({ app });
      else await run("open", ["-a", app]);
    };
    return { browser, context, page };
  } catch (error) {
    log(String(error?.message ?? error));
    if (browser) await browser.close().catch(() => {});
    if (entry.pid === null) entry.pid = await pidListeningOnSafe(entry);
    await stopProcess(entry);
    return null;
  }
}

async function pidListeningOnSafe(entry) {
  // The process may exist even if the launch failed before its pid was known:
  // find it by the profile folder it was started with.
  if (!entry.dir) return null;
  try {
    const { stdout } = await run("pgrep", ["-f", `--user-data-dir=${entry.dir}`]);
    const pid = Number(stdout.split("\n").find(Boolean));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
