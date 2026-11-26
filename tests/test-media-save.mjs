// Saving an image: the file must be a real image, written, and read back with
// the same size and hash. The model's word is never evidence. A scripted model
// picks actions; the browser and the local web server are real.
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { sniffImageType, safeBaseName } from '../src/executor/media-save.js';
import { asksToSaveImage } from '../src/agent/direct-instruction.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

const crcTable = Array.from({length: 256}, (_, n) => {
  let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
const crc = buffer => { let c = 0xffffffff; for (const b of buffer) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length); return out;
};
function makePng(size, [r, g, b]) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({length: size}, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({length: size}, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const cat = makePng(64, [200, 120, 40]);
const logo = makePng(48, [20, 60, 200]);
const dot = makePng(40, [10, 160, 10]);
// A valid picture followed by padding: decoders ignore it, but it is over the size limit.
const huge = Buffer.concat([makePng(40, [90, 90, 90]), Buffer.alloc(21 * 1024 * 1024)]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="red"/></svg>';

// ---- unit checks ----------------------------------------------------------
assert.equal(sniffImageType(cat), 'png');
assert.equal(sniffImageType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])), 'jpg');
assert.equal(sniffImageType(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)])), 'gif');
assert.equal(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])), 'webp');
assert.equal(sniffImageType(Buffer.from('<html><body>not an image at all</body></html>')), null, 'html is not an image');
assert.equal(sniffImageType(Buffer.from(svg)), null, 'svg is never saved');
assert.equal(safeBaseName('Tabby Cat!!', '', 'x.png'), 'tabby-cat');
assert.equal(safeBaseName('../../etc/passwd'), 'etc-passwd', 'no path pieces survive');
assert.equal(safeBaseName('', '', ''), 'image');
for (const text of ['Download the cat image', 'save the logo picture', 'Grab the photo of the team', 'Save the banner image and then open pricing'])
  assert.equal(asksToSaveImage(text), true, text);
for (const text of ['Describe the image', 'Do not download the image', 'Open the image gallery page', 'Save the form', 'Download the PDF report'])
  assert.equal(asksToSaveImage(text), false, text);

// ---- local web server -----------------------------------------------------
const pages = {
  '/': `<title>Gallery</title><h2>Gallery</h2>
    <img alt="Tabby cat" src="/cat.png" width="80" height="80">
    <img alt="Blue logo" src="/logo.png" width="60" height="60">
    <img alt="Swapped picture" src="/swap.png" width="60" height="60">
    <img alt="Vector art" src="/vector.svg" width="80" height="80">
    <img alt="Huge photo" src="/huge.png" width="60" height="60">
    <img alt="Inline dot" src="data:image/png;base64,${dot.toString('base64')}" width="50" height="50">
    <img alt="Pixel" src="/cat.png" width="1" height="1">`
};
const files = {
  '/cat.png': ['image/png', cat], '/logo.png': ['image/png', logo],
  '/vector.svg': ['image/svg+xml', Buffer.from(svg)], '/huge.png': ['image/png', huge]
};
let fetched = [];
const server = http.createServer((request, response) => {
  // Shows the page a real picture, but answers a separate download with a web
  // page: what some sites do against hotlinking.
  if (request.url === '/swap.png') {
    const asImage = request.headers['sec-fetch-dest'] === 'image';
    const body = asImage ? logo : Buffer.from('<html><body>this is a web page, not an image, with enough text</body></html>');
    response.writeHead(200, {'content-type': asImage ? 'image/png' : 'text/html', 'content-length': body.length});
    return response.end(body);
  }
  if (files[request.url]) {
    fetched.push(request.url);
    response.writeHead(200, {'content-type': files[request.url][0], 'content-length': files[request.url][1].length});
    return response.end(files[request.url][1]);
  }
  const body = pages[request.url];
  response.writeHead(body ? 200 : 404, {'content-type': 'text/html'});
  response.end(body ? `<!doctype html><html><body>${body}</body></html>` : 'missing');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({headless: true});
const realFetch = globalThis.fetch; const realLog = console.log;
const directories = [];
let passed = 0;

async function run({name, instruction, script, expect, saved, approvals = 0, noFile = false, listed = null, failure = null}) {
  const directory = await mkdtemp(join(tmpdir(), 'wcp-media-'));
  directories.push(directory);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base + '/');
  let calls = 0, approvalsAsked = 0;
  const offered = [];
  fetched = [];
  globalThis.fetch = async (_url, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    offered.push(...(payload.availableElements ?? []));
    const step = script[calls++];
    const reply = action => ({ok: true, json: async () => ({message: {content: JSON.stringify(action)}})});
    if (!step) return reply({ref: '', operation: 'done', value: ''});
    const element = (payload.availableElements ?? []).find(item => step[0].test(String(item.label ?? '')));
    assert.ok(element, `${name}: the planner is shown "${step[0].source}"`);
    return reply({ref: element.ref, operation: step[1], value: step[2]});
  };
  console.log = () => {};
  let result;
  try {
    result = await executeNaturalLanguageTask(page, instruction, {orchestratorOptions: {agentOptions: {
      maxSteps: 6, mediaDirectory: directory,
      approvalProvider: async () => { approvalsAsked += 1; return null; }
    }}});
  } finally { console.log = realLog; globalThis.fetch = realFetch; }
  const run = result.execution?.result ?? {};
  if (expect !== null) assert.equal(result.status, expect, `${name}: ${run.reason ?? ''}`);
  assert.equal(approvalsAsked, approvals, `${name}: approvals asked`);
  const entries = await readdir(directory);
  if (noFile) assert.deepEqual(entries, [], `${name}: nothing was written`);
  if (saved) {
    assert.equal(entries.length, 1, `${name}: exactly one file`);
    const bytes = await readFile(join(directory, entries[0]));
    assert.equal(sha(bytes), sha(saved), `${name}: the file is the picture the site served`);
    const entry = (run.history ?? []).find(item => item.decision.operation === 'save_image');
    assert.equal(entry.execution.verified, true, `${name}: verified`);
    assert.equal(entry.execution.media.bytes, saved.length, `${name}: receipt size`);
    assert.equal(entry.execution.media.sha256, sha(saved), `${name}: receipt hash`);
  }
  if (failure) {
    const attempt = (run.history ?? []).find(item => item.decision.operation === 'save_image');
    assert.equal(attempt?.execution?.verified, false, `${name}: the attempt is recorded as failed`);
    assert.match(String(attempt?.execution?.errorDetail ?? ''), failure, `${name}: reason`);
  }
  if (listed !== null) {
    const savers = offered.filter(item => (item.allowedOperations ?? []).includes('save_image'));
    assert.equal(savers.length > 0, listed, `${name}: pictures offered to the planner = ${listed}`);
  }
  await context.close();
  passed += 1;
  console.log(`PASS: ${name} -> ${result.status}`);
  return {run, offered};
}

try {
  await run({name: 'a picture is saved and verified from the file', instruction: 'Download the tabby cat image',
    script: [[/Tabby cat/, 'save_image', '']], expect: 'verified_complete', saved: cat, listed: true});
  await run({name: 'an inline (data URL) picture is saved', instruction: 'Save the inline dot picture',
    script: [[/Inline dot/, 'save_image', '']], expect: 'verified_complete', saved: dot});
  // Done without any save: the completion check refuses.
  await run({name: 'done without a saved file is not complete', instruction: 'Download the tabby cat image',
    script: [], expect: 'unverified_completion_claim', noFile: true});
  // A page posing as a picture, a vector image and an oversized file.
  await run({name: 'a web page posing as a picture is not saved', instruction: 'Download the swapped picture image',
    script: [[/Swapped picture/, 'save_image', '']], expect: 'unverified_completion_claim', noFile: true, failure: /not a supported image/});
  // An SVG can carry script: it is never offered, so it cannot be chosen at all.
  const vector = await run({name: 'an SVG is never offered, so nothing is saved', instruction: 'Download the vector art image',
    script: [], expect: 'unverified_completion_claim', noFile: true});
  assert.ok(!vector.offered.some(item => /Vector art/.test(String(item.label ?? ''))), 'the SVG picture is not listed');
  await run({name: 'a picture over the size limit is not saved', instruction: 'Download the huge photo image',
    script: [[/Huge photo/, 'save_image', '']], expect: 'unverified_completion_claim', noFile: true, failure: /20 MB/});
  // Pictures are offered only when the task asks to save one.
  await run({name: 'pictures are not offered unless asked', instruction: 'Scroll down the page',
    script: [], expect: null, listed: false, noFile: true});
  // The one-pixel image is never offered.
  const { offered } = await run({name: 'tiny pictures are never offered', instruction: 'Download the tabby cat image',
    script: [[/Tabby cat/, 'save_image', '']], expect: 'verified_complete', saved: cat});
  assert.ok(!offered.some(item => /Pixel/.test(String(item.label ?? ''))), 'the 1x1 picture is not listed');
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close(); server.close();
  await Promise.all(directories.map(directory => rm(directory, {recursive: true, force: true})));
}
console.log(`media-save: ${passed} groups passed`);
