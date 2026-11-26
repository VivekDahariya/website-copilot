// Clicking or opening a picture: the picture must be in the list the planner
// sees (it was hidden unless the task was to save one, so the planner could only
// pick an unrelated link). Pictures are offered to click only when the task asks
// to click/open one, never for save tasks or plain mentions. Real browser, local
// server, scripted model.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQ0lEQVR4nO3PQQ0AAAgEIL9/6c2hAy4KQM/IOw5iAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBLwPjWAE5k8Tb7wAAAABJRU5ErkJggg==';
const html = `<!doctype html><title>Gallery</title><a href="#c" style="position:absolute;left:-999px">Skip to content</a>
<a href="/">Home</a><div id="c"><h3>Gallery</h3>${[1, 2, 3].map(i =>
  `<div style="display:inline-block"><img src="${png}" alt="Avatar" width="100" height="100" onclick="document.title='clicked ${i}'"><div style="display:none">caption ${i}</div></div>`).join('')}</div>
<a href="https://example.test/about">About us</a>`;
const server = http.createServer((_q, r) => { r.writeHead(200, {'content-type': 'text/html'}); r.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({headless: true});
const realFetch = globalThis.fetch, realLog = console.log;
let passed = 0;
const mediaDir = await mkdtemp(join(tmpdir(), 'wcp-show-'));

async function run(name, instruction, pick, check) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(url);
  let first = null, second = null, secondPayload = null, calls = 0;
  globalThis.fetch = async (_u, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    first ??= payload.availableElements;
    if (calls === 1) { second = payload.availableElements; secondPayload = payload; }
    const action = calls++ === 0 ? pick(payload.availableElements) : {ref: '', operation: 'done', value: ''};
    return {ok: true, json: async () => ({message: {content: JSON.stringify(action)}})};
  };
  console.log = () => {};
  let result;
  try { result = await executeNaturalLanguageTask(page, instruction, {orchestratorOptions: {agentOptions: {
    maxSteps: 4, mediaDirectory: mediaDir, approvalProvider: async () => null}}}); }
  finally { console.log = realLog; globalThis.fetch = realFetch; }
  await check({result, catalog: first, secondCatalog: second, secondPayload, calls, title: await page.title()});
  await page.context().close();
  passed += 1; console.log(`PASS: ${name}`);
}
const imageRef = (catalog, n) => catalog.find(item => new RegExp(`image ${n}\\)`).test(item.label))?.ref ?? '';

try {
  await run('the pictures are offered, and clicking the first one is verified', 'Click the first image on the page',
    catalog => ({ref: imageRef(catalog, 1), operation: 'click', value: ''}),
    ({result, catalog, title}) => {
      assert.ok(imageRef(catalog, 1), 'picture 1 is in the planner list');
      assert.deepEqual(catalog.find(item => item.ref === imageRef(catalog, 1)).allowedOperations, ['click']);
      assert.equal(result.status, 'verified_complete');
      assert.equal(title, 'clicked 1', 'the page really received the click on picture 1');
    });
  // The small planner does not reliably answer "done" after a click (it picked an
  // unrelated link), so once the pictures the request covers were clicked the
  // agent proposes "done" itself. The planner is not asked again, and the result
  // is still decided by the completion verifier, from the browser.
  await run('after the requested picture is clicked, done is proposed without asking the planner', 'Click the first image on the page',
    catalog => ({ref: imageRef(catalog, 1), operation: 'click', value: ''}),
    ({result, calls, title}) => {
      assert.equal(calls, 1, 'the planner was asked only once');
      assert.equal(result.status, 'verified_complete');
      assert.equal(title, 'clicked 1');
    });
  // The agent proposes "done" only for a one-part instruction. When the request
  // names more than the picture click, the planner is asked again.
  await run('a longer instruction is not ended by the proposed done', 'Click the first image, then click the Home link',
    catalog => ({ref: imageRef(catalog, 1), operation: 'click', value: ''}),
    ({result, calls}) => {
      assert.ok(calls >= 2, 'the planner was asked again (calls ' + calls + ')');
      const clicked = (result.execution?.result?.history ?? []).map(entry => entry.decision.operation);
      assert.ok(clicked.length >= 1);
    });
  // "Open <site> and show me ..." is the usual wording. Opening the site is
  // already done on arrival, so the request is still one part.
  await run('"Open <site> and show me the main image" ends after the verified save', `Open ${url} and show me the main image on the page`,
    catalog => ({ref: imageRef(catalog, 1), operation: 'save_image', value: ''}),
    ({result, calls}) => {
      assert.equal(result.status, 'verified_complete');
      assert.equal(calls, 1, 'the planner was not asked again (calls ' + calls + ')');
    });
  await run('"Open <site> and click the first image, then ..." is not ended early', `Open ${url} and click the first image, then click the Home link`,
    catalog => ({ref: imageRef(catalog, 1), operation: 'click', value: ''}),
    ({calls}) => assert.ok(calls >= 2, 'the planner was asked again (calls ' + calls + ')'));
  await run('a request for two pictures offers the second after the first', 'Click the first two images',
    catalog => ({ref: imageRef(catalog, 1), operation: 'click', value: ''}),
    ({secondCatalog, secondPayload}) => {
      assert.equal(secondPayload.picturesRequested, 2);
      assert.ok(secondCatalog.some(item => /image 2\)/.test(item.label)));
      assert.equal(secondCatalog.some(item => /image 1\)/.test(item.label)), false);
    });
  await run('"click every image" is never cut short', 'Click every image on the page',
    catalog => ({ref: imageRef(catalog, 1), operation: 'click', value: ''}),
    ({secondCatalog, secondPayload}) => {
      assert.equal(secondPayload.picturesRequested, undefined);
      assert.ok(secondCatalog.some(item => /image 2\)/.test(item.label)));
    });
  // "Show / view / open the image" is not a click: the picture is fetched to a file
  // (verified from the file, like a save) so the dashboard can show it with a
  // full-screen view and a download button.
  for (const wording of ['Open the first image', 'Show me the first image on the page', 'View the first picture', 'Show me the main image on the page', 'Save the largest picture']) {
    await run(`"${wording}" offers the picture as a file, never as a click`, wording,
      catalog => ({ref: imageRef(catalog, 1), operation: 'save_image', value: ''}),
      async ({result, catalog, calls}) => {
        const ops = catalog.find(item => item.ref === imageRef(catalog, 1)).allowedOperations;
        assert.deepEqual(ops, ['save_image']);
        assert.equal(result.status, 'verified_complete');
        assert.ok((await readdir(mediaDir)).length >= 1, 'the picture is on disk');
        assert.equal(calls, 1, 'the planner was not asked again after the verified save');
      });
  }
  await run('"Show me the page" is not a picture request', 'Show me the page',
    catalog => ({ref: '', operation: 'done', value: ''}),
    ({catalog}) => assert.equal((catalog ?? []).some(item => item.mediaKind === 'image'), false));
  await run('"Open the image gallery link" is not a picture request', 'Open the image gallery link',
    catalog => ({ref: '', operation: 'done', value: ''}),
    ({catalog}) => assert.equal((catalog ?? []).some(item => item.mediaKind === 'image'), false));
  await run('a save task still offers save, never click', 'Save the first image',
    catalog => ({ref: '', operation: 'done', value: ''}),
    ({catalog}) => {
      const ops = catalog.find(item => item.ref === imageRef(catalog, 1)).allowedOperations;
      assert.deepEqual(ops, ['save_image']);
    });
  await run('a task that is not about a picture does not list pictures', 'Click the About us link',
    catalog => ({ref: catalog.find(item => item.label === 'About us').ref, operation: 'click', value: ''}),
    ({catalog}) => assert.equal((catalog ?? []).some(item => item.mediaKind === 'image'), false));
  await run('only mentioning a picture does not make it a click target', 'Describe the image on the page',
    catalog => ({ref: '', operation: 'done', value: ''}),
    ({catalog}) => assert.equal((catalog ?? []).some(item => item.mediaKind === 'image'), false));
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close(); server.close();
  await rm(mediaDir, {recursive: true, force: true});
}
console.log(`image-click: ${passed} groups passed`);
