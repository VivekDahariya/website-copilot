// A page with hundreds of links that match the task words must not hide the
// pictures when the user asked to save one. Real browser for the size check,
// synthetic observation for the crowded-page check.
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { buildCatalog } from '../src/agent/local-reasoner.js';
import { observePage } from '../src/observer/dom-observer.js';

const task = 'Download the main picture of the cat from this page';
const link = n => ({ ref: `e${n}`, tag: 'a', label: n % 2 ? 'Cat' : `Cat breed ${n}`, href: `/wiki/Cat_${n}`, role: 'link' });
const picture = (n, ordinal, alt, w, h) => ({
  ref: `e${n}`, tag: 'img', label: `${alt} (image ${ordinal})`, role: 'img',
  mediaTarget: true, mediaKind: 'image', mediaOrdinal: ordinal, mediaWidth: w, mediaHeight: h
});
const links = Array.from({ length: 300 }, (_, i) => link(i + 1));
const pictures = [
  picture(1001, 1, 'padlock icon', 40, 40),
  picture(1002, 2, 'flag icon', 40, 30),
  picture(1003, 3, 'A cat resting', 260, 300),
  picture(1004, 4, 'Cat thumbnail', 60, 60),
  picture(1005, 5, 'Cat thumbnail', 60, 60)
];
const observation = { actionableElements: [...links, ...pictures] };

// 1. Asked to save: pictures are in view and the largest cat picture leads them.
const asked = buildCatalog(observation, [], null, task);
const askedPictures = asked.filter(item => item.mediaKind === 'image');
assert.ok(askedPictures.length >= 3, 'pictures are offered on a crowded page');
assert.ok(asked.slice(0, 14).some(item => item.ref === 'e1003'), 'the largest matching picture is in the first 14');
assert.ok(asked.slice(0, 14).some(item => item.ref === 'e1001'), 'the first picture on the page is kept in view');
assert.equal(asked.find(item => item.ref === 'e1003').mediaSize, '260x300');
assert.ok(askedPictures.every(item => item.allowedOperations.includes('save_image')));

// 2. A task that does not ask to save: no pictures, and the link list is unchanged.
const notAsked = buildCatalog(observation, [], null, 'Open the Cat page');
assert.equal(notAsked.filter(item => item.mediaKind === 'image').length, 0);
assert.ok(notAsked.every(item => item.tag === 'a'));

// 3. Asked to save, but a navigation link is still reachable (not all slots are pictures).
assert.ok(asked.slice(0, 14).some(item => item.tag === 'a'), 'links stay available');

// 4. The observer records how large each picture is shown.
const png = (() => {
  const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const body = Buffer.concat([Buffer.from(t, 'latin1'), d]); const o = Buffer.alloc(12 + d.length); o.writeUInt32BE(d.length, 0); body.copy(o, 4); o.writeUInt32BE(crc(body), 8 + d.length); return o; };
  const h = Buffer.alloc(13); h.writeUInt32BE(64, 0); h.writeUInt32BE(64, 4); h[8] = 8; h[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 3, 120)]);
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(64).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
})();
const server = http.createServer((request, response) => {
  if (request.url === '/p.png') { response.writeHead(200, {'content-type': 'image/png'}); return response.end(png); }
  response.writeHead(200, {'content-type': 'text/html'});
  response.end('<!doctype html><body><img alt="Big" src="/p.png" width="200" height="150"><img alt="Small" src="/p.png" width="50" height="50"></body>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const observed = await observePage(page);
  const shown = observed.actionableElements.filter(item => item.mediaTarget === true);
  assert.equal(shown.length, 2);
  assert.deepEqual([shown[0].mediaWidth, shown[0].mediaHeight], [200, 150]);
  assert.deepEqual([shown[1].mediaWidth, shown[1].mediaHeight], [50, 50]);
} finally { await browser.close(); server.close(); }
console.log('media-ranking: all groups passed');
