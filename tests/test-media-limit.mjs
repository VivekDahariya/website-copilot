// How many pictures a request covers, and what happens once they are saved:
// the planner stops being offered pictures and is told the request is done.
// SVG pictures are never offered. When the local model cannot word the run
// report reliably, the report is worded directly from the recorded facts.
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { imageSaveLimit, asksToSaveImage } from '../src/agent/direct-instruction.js';
import { buildCatalog, decideNextAction } from '../src/agent/local-reasoner.js';
import { observePage } from '../src/observer/dom-observer.js';
import {
  collectRunExplanationEvidence, collectCompletionChecks, collectRunSteps,
  collectRunContext, findContradiction, buildRunFacts, explainFromFacts
} from '../src/ui/run-explanation.js';

// ---- how many pictures does the request cover? ----
const limits = [
  ['Download the main picture of the cat from this page.', 1], ['Save the first image on the page', 1],
  ['Save the first two images', 2], ['download 3 photos', 3], ['Save all the images on this page', 10],
  ['download the images', 10], ['Download the cat picture and the dog picture', 2], ['Save the 50 images', 10]
];
for (const [text, expected] of limits) assert.equal(imageSaveLimit(text), expected, text);
assert.equal(asksToSaveImage('Do not save the image'), false);

// ---- once covered, no pictures are offered; before that, they are ----
const pic = (ref, src, n) => ({ ref, tag: 'img', label: `Cat (image ${n})`, role: 'img', mediaTarget: true,
  mediaKind: 'image', mediaOrdinal: n, mediaWidth: 200, mediaHeight: 200, mediaSrc: src });
const elements = [pic('e1', 'http://x/a.png', 1), pic('e2', 'http://x/b.png', 2), pic('e3', 'http://x/c.png', 3)];
const offered = (task, saved) => buildCatalog({ actionableElements: elements, savedPictures: saved }, [], null, task)
  .filter(item => item.mediaKind === 'image').length;
assert.equal(offered('Download the main picture of the cat', []), 3);
assert.equal(offered('Download the main picture of the cat', ['http://x/a.png']), 0, 'the one picture asked for is saved: none offered');
assert.equal(offered('Save the first two images', ['http://x/a.png']), 2, 'two asked, one saved: the other two are offered');
assert.equal(offered('Save the first two images', ['http://x/a.png', 'http://x/b.png']), 0);

// ---- the planner is told how far the request is ----
const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (_u, request) => {
  seen.push(JSON.parse(JSON.parse(request.body).messages[1].content));
  return { ok: true, json: async () => ({ message: { content: JSON.stringify({ ref: '', operation: 'done', value: '' }) } }) };
};
const savedEntry = { step: 1, decision: { ref: 'e1', operation: 'save_image', value: '' },
  execution: { operation: 'save_image', verified: true, media: { verified: true, sourceKey: 'http://x/a.png' } } };
try {
  // A one-part request that is fully covered is finished without asking the planner.
  const covered = await decideNextAction('Download the main picture of the cat', { url: 'http://x/', title: 't', actionableElements: elements, headings: [] }, [savedEntry], [], null, null);
  assert.equal(covered.operation, 'done');
  assert.equal(seen.length, 0, 'the planner was not asked');
  // A request with more than the save still goes to the planner, with the count.
  await decideNextAction('Download the main picture of the cat and then check the page', { url: 'http://x/', title: 't', actionableElements: elements, headings: [] }, [savedEntry], [], null, null).catch(error => { globalThis.__err = error; });
} finally { globalThis.fetch = realFetch; }
const payload = seen.at(-1);
assert.ok(payload, 'the planner was asked: ' + globalThis.__err?.message);
assert.equal(payload.picturesSaved, 1);
assert.equal(payload.picturesRequested, 1);
assert.equal((payload.availableElements ?? []).filter(item => item.mediaKind === 'image').length, 0);

// ---- an SVG picture is never offered ----
const png = (() => {
  const t = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (n, d) => { const body = Buffer.concat([Buffer.from(n, 'latin1'), d]); const o = Buffer.alloc(12 + d.length); o.writeUInt32BE(d.length, 0); body.copy(o, 4); o.writeUInt32BE(crc(body), 8 + d.length); return o; };
  const h = Buffer.alloc(13); h.writeUInt32BE(64, 0); h.writeUInt32BE(64, 4); h[8] = 8; h[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(192, 120)]);
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(64).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
})();
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="red"/></svg>';
const server = http.createServer((request, response) => {
  if (request.url === '/p.png') { response.writeHead(200, {'content-type': 'image/png'}); return response.end(png); }
  if (request.url === '/v.svg') { response.writeHead(200, {'content-type': 'image/svg+xml'}); return response.end(svg); }
  response.writeHead(200, {'content-type': 'text/html'});
  response.end(`<!doctype html><body><img alt="Raster" src="/p.png" width="80" height="80">
    <img alt="Vector" src="/v.svg" width="80" height="80">
    <img alt="Inline vector" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="80" height="80"></body>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForTimeout(300);
  const shown = (await observePage(page)).actionableElements.filter(item => item.mediaTarget === true);
  assert.deepEqual(shown.map(item => item.label), ['Raster (image 1)'], 'only the raster picture is offered');
} finally { await browser.close(); server.close(); }

// ---- the report never dead-ends ----
const edge = (operation, label, status = 'observed_after_action') => ({ from: 'a', to: 'b', operation, label, status });
const state = {
  phase: 'finished', url: 'https://en.wikipedia.org/wiki/Cat',
  result: { status: 'unverified_completion_claim', reason: 'The most recent action failed or was not verified.' },
  actionTree: { nodes: [{ id: 'a', title: 'Cat' }, { id: 'b', title: 'Cat' }],
    edges: [edge('save_image', 'White cat with blue eyes (image 1)'), edge('save_image', 'Cat thumbnail (image 2)'),
            edge('save_image', 'Cat drawing (image 3)', 'failed')] },
  activity: []
};
const evidence = collectRunExplanationEvidence(state);
const options = { checks: collectCompletionChecks(state), steps: collectRunSteps(state), context: collectRunContext(state) };
const report = explainFromFacts(evidence, options);
assert.equal(report.outcome, 'failed');
assert.match(report.model, /none/);
assert.match(report.explanation.whatHappened, /^CoPilot /);
assert.match(report.explanation.whatHappened, /White cat with blue eyes \(image 1\)/);
assert.ok(report.explanation.why.length > 10 && report.explanation.whatToTry.length > 10);
assert.equal(findContradiction(buildRunFacts(evidence, options.checks, options.steps, options.context), report.explanation), null,
  'the facts-only text agrees with the record');
const passedState = { ...state, result: { status: 'verified_complete' }, actionTree: { ...state.actionTree, edges: [edge('save_image', 'White cat (image 1)')] } };
const passed = explainFromFacts(collectRunExplanationEvidence(passedState), { checks: collectCompletionChecks(passedState), steps: collectRunSteps(passedState), context: {} });
assert.equal(passed.outcome, 'passed');
assert.equal('whatToTry' in passed.explanation, false);
console.log('media-limit: all groups passed');
