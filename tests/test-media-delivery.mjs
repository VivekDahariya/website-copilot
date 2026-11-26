// Showing a saved picture or screenshot in the dashboard: only a file that
// passed the save check is offered, it is re-checked on every request, and the
// dashboard card (preview, Full Screen View, Download Image) only appears for a
// verified run with valid links. Real files, a real HTTP server, a real browser.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createMediaDelivery, extractVerifiedImages } from '../src/ui/media-delivery.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQ0lEQVR4nO3PQQ0AAAgEIL9/6c2hAy4KQM/IOw5iAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBLwPjWAE5k8Tb7wAAAABJRU5ErkJggg==', 'base64');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const dir = await mkdtemp(join(tmpdir(), 'wcp-deliver-'));
const outside = await mkdtemp(join(tmpdir(), 'wcp-outside-'));
const record = (name, bytes, extra = {}) => ({ path: join(dir, name), bytes: bytes.length, sha256: sha(bytes), verified: true, kind: 'image', ...extra });
await writeFile(join(dir, 'cat.png'), png);

// ---- which saved files are delivered ----
const history = [
  { decision: { operation: 'save_image' }, execution: { media: { ...record('cat.png', png), verified: true } } },
  { decision: { operation: 'save_image' }, execution: { media: { ...record('cat.png', png), verified: true } } },
  { decision: { operation: 'save_image' }, execution: { media: { ...record('x.png', png), verified: false } } },
  { decision: { operation: 'click' }, execution: { media: { ...record('y.png', png), verified: true } } },
  { decision: { operation: 'screenshot' }, execution: { media: { ...record('s.png', Buffer.concat([png, Buffer.from('s')])), verified: true } } }
];
const found = extractVerifiedImages(history);
assert.equal(found.length, 2, 'duplicates, unverified saves and non-save actions are left out');
assert.deepEqual(found.map(item => item.kind), ['image', 'screenshot']);

// ---- registration refuses anything unsafe ----
const delivery = createMediaDelivery({ directory: dir });
await assert.rejects(delivery.register({ ...record('cat.png', png), verified: false }), /INVALID_VERIFIED_MEDIA_RECORD/);
await assert.rejects(delivery.register({ ...record('cat.png', png), sha256: sha(Buffer.from('other')) }), /MEDIA_CHANGED/);
await writeFile(join(outside, 'o.png'), png);
await assert.rejects(delivery.register({ ...record('o.png', png), path: join(outside, 'o.png') }), /MEDIA_OUTSIDE_FOLDER/);
await symlink(join(outside, 'o.png'), join(dir, 'link.png'));
await assert.rejects(delivery.register({ ...record('link.png', png), path: join(dir, 'link.png') }), /MEDIA_OUTSIDE_FOLDER|MEDIA_NOT_A_FILE/);
const text = Buffer.from('<html><script>alert(1)</script></html>'.repeat(5));
await writeFile(join(dir, 'fake.png'), text);
await assert.rejects(delivery.register(record('fake.png', text)), /MEDIA_NOT_AN_IMAGE/);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><script>1</script></svg>'.repeat(3));
await writeFile(join(dir, 'v.svg'), svg);
await assert.rejects(delivery.register(record('v.svg', svg)), /MEDIA_NOT_AN_IMAGE/);

// ---- serving: preview, download, bad links, tampering, expiry ----
const delivered = await delivery.register(record('cat.png', png, { width: 64, height: 64 }));
assert.match(delivered.viewUrl, /^\/api\/media\/[a-f0-9]{48}$/);
assert.match(delivered.downloadUrl, /^\/api\/media\/[a-f0-9]{48}\/download$/);
assert.equal(delivered.path, undefined, 'the real path is never handed to the dashboard');
assert.equal(delivered.type, 'png');
const server = http.createServer((request, response) => {
  if (request.url.startsWith('/api/media/')) return delivery.serve(request.url.slice('/api/media/'.length), response);
  response.writeHead(404); response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const view = await fetch(base + delivered.viewUrl);
assert.equal(view.status, 200);
assert.equal(view.headers.get('content-type'), 'image/png');
assert.match(view.headers.get('content-disposition'), /^inline;/);
assert.equal(view.headers.get('x-content-type-options'), 'nosniff');
assert.match(view.headers.get('content-security-policy'), /sandbox/);
assert.deepEqual(Buffer.from(await view.arrayBuffer()), png);
const download = await fetch(base + delivered.downloadUrl);
assert.match(download.headers.get('content-disposition'), /^attachment; filename="cat\.png"/);
assert.equal((await fetch(base + '/api/media/' + 'a'.repeat(48))).status, 404, 'unknown token');
assert.equal((await fetch(base + '/api/media/not-a-token')).status, 404, 'malformed token');
assert.equal((await fetch(base + delivered.viewUrl + '/other')).status, 404, 'unknown sub-path');
assert.equal((await fetch(base + delivered.viewUrl + '/download/x')).status, 404, 'extra path parts');
const expiring = createMediaDelivery({ directory: dir, ttlMs: 1 });
const quick = await expiring.register(record('cat.png', png));
await new Promise(resolve => setTimeout(resolve, 15));
const short = http.createServer((request, response) => expiring.serve(request.url.slice('/api/media/'.length), response));
await new Promise(resolve => short.listen(0, '127.0.0.1', resolve));
assert.equal((await fetch(`http://127.0.0.1:${short.address().port}${quick.viewUrl}`)).status, 410, 'expired link');
short.close();
// The file changes after registration: it is no longer served.
await writeFile(join(dir, 'cat.png'), Buffer.concat([png.subarray(0, png.length - 1), Buffer.from([0])]));
assert.equal((await fetch(base + delivered.viewUrl)).status, 410, 'a changed file is not served');
server.close();

// ---- the dashboard card ----
const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
await writeFile(join(dir, 'cat.png'), png);
const ui = createMediaDelivery({ directory: dir });
const item = await ui.register(record('cat.png', png, { width: 64, height: 64 }));
const uiServer = http.createServer((request, response) => {
  if (request.url.startsWith('/api/media/')) return ui.serve(request.url.slice('/api/media/'.length), response);
  if (request.url === '/') { response.writeHead(200, {'content-type': 'text/html'}); return response.end(html); }
  if (request.url.startsWith('/api/state')) { response.writeHead(200, {'content-type': 'application/json'}); return response.end(JSON.stringify({ phase: 'finished', result: { status: 'verified_complete', images: [item] } })); }
  response.writeHead(404, {'content-type': 'application/json'}); response.end('{}');
});
await new Promise(resolve => uiServer.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${uiServer.address().port}/`);
  await page.waitForSelector('#imageCard:not([hidden])', { timeout: 5000 }); // the dashboard's own state load delivers the card
  const state = (patch = {}) => ({ phase: 'finished', result: { status: 'verified_complete', images: [item], ...patch.result }, ...patch.top });
  const shown = async next => page.evaluate(value => { renderImages(value); return !document.getElementById('imageCard').hidden; }, next);
  assert.equal(await shown(state()), true, 'a verified run with a valid picture shows the card');
  assert.equal(await page.textContent('#imageTitle'), 'Your image is ready to view');
  assert.equal(await page.locator('.image-item').count(), 1);
  assert.equal(await page.getAttribute('.image-item img', 'src'), item.viewUrl);
  assert.equal(await page.getAttribute('.image-actions a', 'href'), item.downloadUrl);
  assert.equal(await page.getAttribute('.image-actions a', 'download'), 'cat.png');
  await page.waitForFunction(() => document.querySelector('.image-item img').naturalWidth === 64);
  await page.click('text=Full Screen View');
  assert.equal(await page.isVisible('#imageViewer'), true, 'the viewer opens');
  assert.equal(await page.getAttribute('#imageViewerImg', 'src'), item.viewUrl);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#imageViewer', { state: 'hidden', timeout: 3000 });
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 3000 });
  const [downloaded] = await Promise.all([page.waitForEvent('download'), page.click('text=Download Image')]);
  assert.equal(downloaded.suggestedFilename(), 'cat.png');
  assert.deepEqual(await readFile(await downloaded.path()), png, 'the downloaded file is the saved picture');
  // The card must never show for an unverified run or an invalid link.
  assert.equal(await shown(state({ result: { status: 'unverified_completion_claim' } })), false, 'unverified run');
  assert.equal(await shown(state({ top: { phase: 'running' } })), false, 'run not finished');
  assert.equal(await shown(state({ result: { images: [{ ...item, viewUrl: 'https://evil.example/x.png' }] } })), false, 'foreign link');
  assert.equal(await shown(state({ result: { images: [{ ...item, downloadUrl: '/api/media/zz' }] } })), false, 'malformed link');
  assert.equal(await shown(state({ result: { images: [{ ...item, verified: false }] } })), false, 'unverified file');
  assert.equal(await shown(state({ result: { images: [{ ...item, expiresAt: Date.now() - 1 }] } })), false, 'expired link');
  assert.equal(await shown(state({ result: { images: [{ ...item, fileName: '../x.png' }] } })), false, 'unsafe file name');
  assert.equal(await shown(state({ result: { images: [{ ...item, kind: 'screenshot' }] } })), true);
  assert.equal(await page.textContent('#imageTitle'), 'Your screenshot is ready to view');
  assert.deepEqual(errors, [], 'the dashboard raised no script errors');
} finally {
  await browser.close(); uiServer.close();
  await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
}
console.log('media-delivery: all checks passed');
