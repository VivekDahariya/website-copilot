// History page: the real dashboard server serves /history, a started task is
// recorded for this browser session only, a typed password is never stored,
// and Re-execute puts the task and URL back into the workspace and starts it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['src/ui/server.js'], {
  env: { ...process.env, PORT: String(PORT), COPILOT_HEADLESS: '1', OLLAMA_HOST: 'http://127.0.0.1:9' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
child.stdout.on('data', chunk => { serverLog += chunk; });
child.stderr.on('data', chunk => { serverLog += chunk; });
const stopServer = () => { try { child.kill('SIGKILL'); } catch {} };
process.on('exit', stopServer);

for (let i = 0; i < 100; i++) {
  try { if ((await fetch(base + '/history', { headers: { Host: `127.0.0.1:${PORT}` } })).ok) break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(i < 99, 'server did not start: ' + serverLog);
}

// ---- the page and the guards ----
const page = await fetch(base + '/history');
assert.equal(page.status, 200);
assert.match(page.headers.get('content-type'), /text\/html/);
assert.equal(page.headers.get('cache-control'), 'no-store');
const text = await page.text();
assert.match(text, /Re-execute/);
assert.match(text, /Time executed/);
assert.match(text, /Back to Workspace/);
assert.equal((await fetch(base + '/history', { headers: { Origin: 'http://evil.example' } })).status, 403, 'foreign origin refused');
assert.equal((await fetch(base + '/history/x')).status, 404, 'no other history paths');
assert.match(await (await fetch(base + '/')).text(), /href="\/history"/, 'sidebar links to History');

// ---- the browser flow ----
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const dash = await context.newPage();
  const starts = [];
  await dash.route('**/api/start', async route => {
    const body = JSON.parse(route.request().postData());
    starts.push(body);
    await route.fulfill({
      status: 202, contentType: 'application/json',
      body: JSON.stringify({ accepted: true, instruction: body.instruction.replace(/hunter2/g, '') })
    });
  });
  await dash.goto(base + '/');
  await dash.waitForFunction(() => document.getElementById('instruction'));

  // empty history shows the empty state
  await dash.click('#navHistory');
  await dash.waitForURL(base + '/history');
  assert.equal(await dash.locator('#historyEmpty').isVisible(), true, 'empty state');
  assert.equal(await dash.locator('.history-row').count(), 0);
  await dash.click('text=Back to Workspace');
  await dash.waitForURL(base + '/');

  // run two tasks from the workspace
  for (const [instruction, url, budget] of [
    ['Open the Sport page <b>bold</b>', 'http://127.0.0.1:' + PORT + '/one', '6'],
    ['Log in with password hunter2', '', '30']
  ]) {
    await dash.fill('#instruction', instruction);
    await dash.fill('#startUrl', url);
    await dash.selectOption('#maxSteps', budget);
    await dash.click('#runStopToggle');
    await dash.waitForFunction(n => JSON.parse(sessionStorage.getItem('wcp.history') || '[]').length === n, starts.length);
  }
  assert.equal(starts.length, 2);
  const stored = await dash.evaluate(() => sessionStorage.getItem('wcp.history'));
  assert.ok(!stored.includes('hunter2'), 'a typed password is never stored');

  // the history page lists newest first, as text (never as markup)
  await dash.goto(base + '/history');
  const rows = dash.locator('.history-row');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).locator('.h-task').innerText(), /Log in with password/);
  assert.doesNotMatch(await rows.nth(0).innerText(), /hunter2/);
  assert.match(await rows.nth(0).locator('.h-url').innerText(), /No starting URL/);
  assert.equal(await rows.nth(1).locator('.h-task').innerText(), 'Open the Sport page <b>bold</b>');
  assert.equal(await rows.nth(1).locator('.h-task b').count(), 0, 'task text is not parsed as HTML');
  assert.equal(await rows.nth(1).locator('.h-url').innerText(), `http://127.0.0.1:${PORT}/one`);
  assert.match(await rows.nth(1).locator('.h-time').innerText(), /\d{4}/, 'time executed is shown');
  assert.equal(await rows.nth(0).getByRole('button', { name: /Re-execute/ }).count(), 1);

  // Re-execute: fields filled, budget restored, run started automatically
  await dash.goto(base + '/history');
  await rows.nth(1).getByRole('button', { name: /Re-execute/ }).click();
  await dash.waitForURL(base + '/');
  await dash.waitForFunction(() => document.getElementById('instruction').value.length > 0);
  assert.equal(await dash.inputValue('#instruction'), 'Open the Sport page <b>bold</b>');
  assert.equal(await dash.inputValue('#startUrl'), `http://127.0.0.1:${PORT}/one`);
  assert.equal(await dash.inputValue('#maxSteps'), '6');
  await dash.waitForFunction(n => JSON.parse(sessionStorage.getItem('wcp.history') || '[]').length === n, 3);
  assert.equal(starts.length, 3, 'Re-execute started exactly one run');
  assert.deepEqual(starts[2], { instruction: 'Open the Sport page <b>bold</b>', startUrl: `http://127.0.0.1:${PORT}/one`, maxSteps: 6 });
  assert.equal(await dash.evaluate(() => sessionStorage.getItem('wcp.rerun')), null, 'the re-run request is used once');

  // a task without a URL re-runs without one
  await dash.goto(base + '/history');
  await dash.locator('.history-row').nth(1).getByRole('button', { name: /Re-execute/ }).click();
  await dash.waitForURL(base + '/');
  await dash.waitForFunction(n => JSON.parse(sessionStorage.getItem('wcp.history') || '[]').length === n, 4);
  assert.equal(starts[3].startUrl, '');
  assert.equal(starts[3].maxSteps, 30);
  assert.ok(!starts[3].instruction.includes('hunter2'));

  // moving between the workspace and History keeps the list
  await dash.goto(base + '/history');
  assert.equal(await dash.locator('.history-row').count(), 4, 'history survives going back and forth between pages');
  await dash.goBack();
  await dash.goForward();
  assert.equal(await dash.locator('.history-row').count(), 4, 'history survives back and forward');

  // a refresh clears the history and must not run anything again
  await dash.reload();
  assert.equal(await dash.locator('.history-row').count(), 0, 'refreshing History clears it');
  assert.equal(await dash.locator('#historyEmpty').isVisible(), true);
  await dash.goto(base + '/');
  await dash.waitForFunction(() => document.getElementById('instruction'));
  await dash.fill('#instruction', 'Another task');
  await dash.click('#runStopToggle');
  await dash.waitForFunction(() => JSON.parse(sessionStorage.getItem('wcp.history') || '[]').length === 1);
  const afterRefreshStarts = starts.length;
  await dash.reload();
  await dash.waitForTimeout(600);
  assert.equal(starts.length, afterRefreshStarts, 'refreshing the workspace does not start another run');
  assert.equal(await dash.evaluate(() => sessionStorage.getItem('wcp.history')), null, 'refreshing the workspace clears the history');

  // a server that restarted is a new session: the old list is gone
  await dash.evaluate(() => sessionStorage.setItem('wcp.history', JSON.stringify([{ instruction: 'old run', startUrl: '', maxSteps: 12, time: Date.now() }])));
  await dash.evaluate(() => sessionStorage.setItem('wcp.session', 'a-previous-server-run'));
  await dash.goto(base + '/history');
  assert.equal(await dash.locator('.history-row').count(), 0, 'history from an earlier server run is not shown');
  await dash.evaluate(() => sessionStorage.setItem('wcp.history', JSON.stringify([{ instruction: 'same run', startUrl: '', maxSteps: 12, time: Date.now() }])));
  await dash.goto(base + '/');
  await dash.goto(base + '/history');
  assert.equal(await dash.locator('.history-row').count(), 1, 'the same server run keeps it');

  // history belongs to the browser session: a fresh session starts empty
  const other = await (await browser.newContext()).newPage();
  await other.goto(base + '/history');
  assert.equal(await other.locator('.history-row').count(), 0, 'a new browser session has no history');
  assert.equal(await other.locator('#historyEmpty').isVisible(), true);

  // a task that is refused (409) is not recorded
  await dash.goto(base + '/');
  await dash.waitForFunction(() => document.getElementById('instruction'));
  const before = await dash.evaluate(() => JSON.parse(sessionStorage.getItem('wcp.history') || '[]').length);
  await dash.unroute('**/api/start');
  await dash.route('**/api/start', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'An agent task is already running.' }) }));
  await dash.fill('#instruction', 'Refused task');
  await dash.click('#runStopToggle');
  await dash.waitForSelector('text=An agent task is already running.');
  assert.equal(await dash.evaluate(() => JSON.parse(sessionStorage.getItem('wcp.history') || '[]').length), before, 'refused starts are not recorded');
} finally {
  await browser.close();
}

// ---- the real /api/start returns the instruction with the password removed ----
const real = await fetch(base + '/api/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({ instruction: 'Open the page and log in with password hunter2', startUrl: '', maxSteps: 6 })
});
assert.equal(real.status, 202);
const started = await real.json();
assert.equal(started.accepted, true);
assert.ok(!started.instruction.includes('hunter2'), 'server removes the password from the copy it returns');
assert.match(started.instruction, /^Open the page and log in with password/);

stopServer();
console.log('PASS history page, session record, password removal, re-execute');
