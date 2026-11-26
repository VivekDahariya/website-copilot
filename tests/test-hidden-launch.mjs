// The hidden browser launch: the browser connects and works, closing it really
// stops the browser process and removes its profile, a failed launch cleans up
// and returns null (so the normal launch is used), and "Show real browser" can
// reveal the app. A real Chromium is started through an injected launcher,
// because the macOS `open` command is not available everywhere.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { appBundlePath, launchHiddenBrowser } from '../src/browser/hidden-launch.js';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const profiles = () => readdirSync(tmpdir()).filter(name => name.startsWith('wcp-browser-'));
const leftovers = profiles().length;

// appBundlePath
assert.equal(appBundlePath('/x/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), '/x/Google Chrome for Testing.app');
assert.equal(appBundlePath('/tmp/chrome-linux64/chrome'), null);
assert.equal(appBundlePath(undefined), null);

// Not macOS and no injected launcher: nothing is attempted.
assert.equal(await launchHiddenBrowser({ chromium, platform: 'linux' }), null);

// A launcher that starts a real browser the way `open` would.
const started = [];
const spawnApp = async ({ args }) => {
  const child = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', ...args], { stdio: 'ignore' });
  started.push(child);
  return { pid: child.pid };
};
let revealed = 0;
const messages = [];
const hidden = await launchHiddenBrowser({ chromium, platform: 'linux', spawnApp, revealApp: async () => { revealed++; }, log: m => messages.push(m) });
assert.ok(hidden, 'the hidden launch works: ' + messages.join('; '));
const { browser, context, page } = hidden;
const pid = started[0].pid;
assert.ok(alive(pid), 'the browser process is running');
assert.equal(browser.contexts().length, 1);
assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [1280, 800], 'viewport is set');
await page.setContent('<h1>hello</h1>');
assert.equal(await page.textContent('h1'), 'hello');
const popup = await Promise.all([context.waitForEvent('page'), page.evaluate(() => window.open('about:blank'))]);
assert.deepEqual(await popup[0].evaluate(() => [innerWidth, innerHeight]), [1280, 800], 'new tabs get the same viewport');
assert.equal(profiles().length, leftovers + 1, 'one throwaway profile exists while it runs');
await browser.wcpReveal();
assert.equal(revealed, 1, 'Show real browser can reveal the app');
await Promise.all([browser.close(), browser.close()]);
await browser.close();
assert.equal(alive(pid), false, 'closing the browser stops the process');
assert.equal(profiles().length, leftovers, 'closing removes the throwaway profile');

// A launcher that never opens the debugging port: null, and nothing is left.
const never = await launchHiddenBrowser({ chromium, platform: 'linux', spawnApp: async () => ({ pid: null }), startupTimeoutMs: 700, log: m => messages.push(m) });
assert.equal(never, null, 'a launch that does not come up falls back');
assert.ok(messages.some(m => /debugging port/.test(m)));
assert.equal(profiles().length, leftovers, 'a failed launch leaves no profile');

// A launcher that throws: null, and nothing is left.
const broken = await launchHiddenBrowser({ chromium, platform: 'linux', spawnApp: async () => { throw new Error('boom'); } });
assert.equal(broken, null);
assert.equal(profiles().length, leftovers);

// A launch that comes up but is stopped by a failed self-check cleans up the process.
const started2 = [];
const failing = await launchHiddenBrowser({
  chromium: { executablePath: () => chromium.executablePath(), connectOverCDP: async url => { const b = await chromium.connectOverCDP(url); const ctx = b.contexts()[0]; const p = ctx.pages()[0]; p.screenshot = async () => { throw new Error('capture failed'); }; return b; } },
  platform: 'linux', log: m => messages.push(m),
  spawnApp: async ({ args }) => { const child = spawn(chromium.executablePath(), ['--headless=new', '--no-sandbox', ...args], { stdio: 'ignore' }); started2.push(child); return { pid: child.pid }; }
});
assert.equal(failing, null, 'a hidden window that cannot be captured falls back');
assert.equal(alive(started2[0].pid), false, 'the process of a failed launch is stopped');
assert.equal(profiles().length, leftovers);
assert.ok(!existsSync('/nonexistent'));
console.log('hidden-launch: all checks passed');
