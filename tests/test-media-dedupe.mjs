// A picture saved in this run is not offered again, even when its element
// reference changed. A different picture is still offered. Real browser and
// a local server; a scripted model picks the actions.
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { buildCatalog } from '../src/agent/local-reasoner.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { pictureKey } from '../src/executor/media-save.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

// ---- unit: same picture under a new reference is hidden, another stays ----
const pic = (ref, src, ordinal) => ({ ref, tag: 'img', label: `Cat (image ${ordinal})`, role: 'img',
  mediaTarget: true, mediaKind: 'image', mediaOrdinal: ordinal, mediaWidth: 100, mediaHeight: 100, mediaSrc: src });
const task = 'Download the first two cat images';
const before = buildCatalog({ actionableElements: [pic('e5', 'http://x/a.png', 1), pic('e6', 'http://x/b.png', 2)] }, [], null, task);
assert.equal(before.filter(item => item.mediaKind === 'image').length, 2);
const after = buildCatalog({ savedPictures: [pictureKey('http://x/a.png')],
  actionableElements: [pic('e21', 'http://x/a.png', 1), pic('e22', 'http://x/b.png', 2)] }, [], null, task);
assert.deepEqual(after.filter(item => item.mediaKind === 'image').map(item => item.ref), ['e22'],
  'the saved picture is hidden under its new reference; the other one stays');
assert.equal(pictureKey('data:image/png;base64,AAAA'), 'data:26:' + 'data:image/png;base64,AAAA'.slice(-80));

// ---- end to end ------------------------------------------------------------
const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const body = Buffer.concat([Buffer.from(t, 'latin1'), d]); const o = Buffer.alloc(12 + d.length); o.writeUInt32BE(d.length, 0); body.copy(o, 4); o.writeUInt32BE(crc(body), 8 + d.length); return o; };
const makePng = (size, color) => { const h = Buffer.alloc(13); h.writeUInt32BE(size, 0); h.writeUInt32BE(size, 4); h[8] = 8; h[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, color)]);
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(size).fill(row)))), chunk('IEND', Buffer.alloc(0))]); };
const cat = makePng(64, 120), inline = makePng(48, 200);
const server = http.createServer((request, response) => {
  if (request.url === '/cat.png') { response.writeHead(200, {'content-type': 'image/png'}); return response.end(cat); }
  response.writeHead(200, {'content-type': 'text/html'});
  response.end(`<!doctype html><body><img alt="Tabby cat" src="/cat.png" width="80" height="80">
    <img alt="Inline dot" src="data:image/png;base64,${inline.toString('base64')}" width="60" height="60"></body>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const realFetch = globalThis.fetch, realLog = console.log;
const directory = await mkdtemp(join(tmpdir(), 'wcp-dedupe-'));

async function run(instruction, picks) {
  const context = await browser.newContext(); const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  let calls = 0; const offeredPerCall = [];
  globalThis.fetch = async (_u, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    const savers = (payload.availableElements ?? []).filter(item => (item.allowedOperations ?? []).includes('save_image'));
    offeredPerCall.push(savers.map(item => item.label));
    const pick = picks[calls++];
    const reply = action => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(action) } }) });
    if (!pick) return reply({ ref: '', operation: 'done', value: '' });
    const element = savers.find(item => pick.test(item.label)); assert.ok(element, `offered: ${pick}`);
    return reply({ ref: element.ref, operation: 'save_image', value: '' });
  };
  console.log = () => {};
  let result;
  try { result = await executeNaturalLanguageTask(page, instruction, { orchestratorOptions: { agentOptions: {
    maxSteps: 6, mediaDirectory: directory, approvalProvider: async () => null } } }); }
  finally { console.log = realLog; globalThis.fetch = realFetch; }
  await context.close();
  return { result, offeredPerCall };
}
try {
  // A picture from the web server: after it is saved it is no longer offered; the other one is.
  const one = await run('Download the tabby cat image and the inline dot image', [/Tabby cat/]);
  assert.equal(one.result.status, 'verified_complete');
  assert.equal(one.offeredPerCall[0].length, 2);
  assert.ok(!one.offeredPerCall[1].some(label => /Tabby cat/.test(label)), 'saved picture not offered again');
  assert.ok(one.offeredPerCall[1].some(label => /Inline dot/.test(label)), 'the other picture is still offered');
  // An inline (data URL) picture: the browser-side key must equal the one made when saving.
  const two = await run('Save the inline dot picture and the tabby cat picture', [/Inline dot/]);
  assert.equal(two.result.status, 'verified_complete');
  assert.ok(!two.offeredPerCall[1].some(label => /Inline dot/.test(label)), 'saved inline picture not offered again');
  assert.equal((await readdir(directory)).length, 2, 'exactly the two pictures, once each');
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close(); server.close(); await rm(directory, { recursive: true, force: true });
}
console.log('media-dedupe: all groups passed');
