import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { createFixtureSite } from './battery/fixtures.mjs';
import { observePage } from '../src/observer/dom-observer.js';
import { reachableElements, waitForCoveringLayer } from '../src/agent/covered-elements.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { createConversationalApprovalProvider } from '../src/agent/conversational-approval.js';

process.env.COPILOT_HEADLESS = '1';
globalThis.fetch = async () => { throw new Error('offline'); };
console.warn = () => {};
const site = await createFixtureSite();
const browser = await chromium.launch({ headless: true,
  ...(process.env.WC_TEST_CHROMIUM ? { executablePath: process.env.WC_TEST_CHROMIUM } : {}), args: ['--no-sandbox'] });
const labels = list => list.map(e => e.label);
const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

try {
  // 1. Under a full-window notice only the notice's own control can be clicked.
  {
    const page = await (await browser.newContext()).newPage();
    await page.goto(site.base + '/press');
    const obs = await observePage(page);
    assert.ok(labels(obs.actionableElements).includes('Annual report'));
    const reachable = await reachableElements(page, obs.actionableElements);
    assert.deepEqual(labels(reachable), ['Accept all cookies']);
    // 2. Once the notice is gone nothing is hidden from the planner.
    await page.getByRole('button', { name: /accept all/i }).click();
    const after = await observePage(page);
    const all = await reachableElements(page, after.actionableElements);
    assert.equal(all.length, after.actionableElements.length);
    assert.ok(labels(all).includes('Annual report'));
    // 3. Empty or unmeasurable input is returned as given.
    assert.deepEqual(await reachableElements(page, []), []);
    const stale = [{ ref: 'e999', label: 'Ghost' }];
    assert.deepEqual(await reachableElements(page, stale), stale);
    await page.close();
  }
  // 4. End to end with a planner that, like a weak model, keeps choosing the covered link
  //    for as long as it is offered, and only picks another control when it is not.
  async function run(path, instruction) {
    const page = await (await browser.newContext()).newPage();
    await page.goto(site.base + path);
    const offered = [];
    const reasoner = async (_task, obs) => {
      offered.push(labels(obs.actionableElements));
      const link = obs.actionableElements.find(e => e.label === 'Annual report');
      if (link) return { ref: link.ref, operation: 'click', value: '' };
      const accept = obs.actionableElements.find(e => /accept/i.test(e.label));
      return accept ? { ref: accept.ref, operation: 'click', value: '' } : { ref: '', operation: 'done', value: '' };
    };
    const result = await quiet(() => executeNaturalLanguageTask(page, instruction, { urlLess: false, orchestratorOptions: { agentOptions: {
      maxSteps: 8, reasoner,
      approvalProvider: createConversationalApprovalProvider({ requestUser: async () => ({ optionId: 'approve' }) }) } } }));
    const out = { result, offered, url: page.url() };
    await page.close();
    return out;
  }
  {
    const r = await run('/press', 'Click the Annual report link.');
    assert.match(r.url, /\/press\/annual-report$/, JSON.stringify(r.result).slice(0, 300));
    assert.equal(r.result.status, 'verified_complete');
    assert.ok(r.offered.length >= 2, 'the first click was covered, so the planner was asked again');
    assert.ok(r.offered[0].includes('Annual report'), 'before any block the planner sees everything');
    assert.deepEqual(r.offered[1], ['Accept all cookies'], 'after a covered click it sees only what a click can reach');
  }
  { // NEGATIVE: with no overlay nothing is filtered and the first click goes through
    const r = await run('/resources', 'Click the Reports link.');
    assert.ok(r.offered.every(list => list.length > 1), 'no block, no narrowing');
  }
  // 5-7. A long page. Most links are below the visible area, and there are more than
  //      the filter once measured. A layer fixed to the screen covers the middle of the
  //      screen, where a scroll would bring any of them, so none of them can be clicked.
  {
    const rows = Array.from({ length: 150 }, (_, n) => `<div style="height:70px"><a href="/item${n}">Item ${n}</a></div>`).join('');
    const long = tail => `<!doctype html><html><body style="margin:0">${rows}${tail}</body></html>`;
    const pages = {
      '/modal': long('<div role="dialog" style="position:fixed;left:0;top:0;width:100vw;height:100vh;background:#fff;z-index:9"><button>Accept</button></div>'),
      '/banner': long('<div role="dialog" style="position:fixed;left:0;bottom:0;width:100vw;height:60px;background:#fff;z-index:9"><button>Accept</button></div>'),
      '/plain': long('')
    };
    const longSite = http.createServer((request, response) => {
      response.writeHead(pages[request.url] ? 200 : 404, { 'content-type': 'text/html' });
      response.end(pages[request.url] ?? 'missing');
    });
    await new Promise(resolve => longSite.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${longSite.address().port}`;
    const open = async path => {
      const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
      await page.goto(root + path);
      return { page, observed: await observePage(page) };
    };
    try {
      { // a full-screen fixed layer: only its own control is left, including links far below
        const { page, observed } = await open('/modal');
        assert.equal(observed.actionableElements.length, 151);
        assert.deepEqual(labels(await reachableElements(page, observed.actionableElements)), ['Accept']);
        await page.close();
      }
      { // a small fixed banner at the bottom covers only what is under it; links far
        // below the fold can be scrolled to the middle of the screen, which it does not cover
        const { page, observed } = await open('/banner');
        const reachable = labels(await reachableElements(page, observed.actionableElements));
        assert.ok(reachable.includes('Item 0') && reachable.includes('Item 149') && reachable.includes('Accept'));
        assert.ok(reachable.length >= 150, `banner hid too much: ${reachable.length}`);
        await page.close();
      }
      { // NEGATIVE: no fixed layer, nothing is removed
        const { page, observed } = await open('/plain');
        assert.equal((await reachableElements(page, observed.actionableElements)).length, 150);
        await page.close();
      }
    } finally { await new Promise(resolve => longSite.close(resolve)); }
  }
  // 8. A control inside the notice goes through but leaves the notice standing (a
  //    "Partners" panel opening, say). The covered link must stay out of the planner's
  //    list: an action that went through is not evidence that the notice is gone.
  {
    const pages = {
      '/': '<title>Home</title><a href="/target">Annual report</a><div id="n" role="dialog" style="position:fixed;left:0;top:0;width:100vw;height:100vh;background:#fff;z-index:9"><button id="p" onclick="document.getElementById(\'more\').textContent=\'Our partners: A, B, C\'">Partners</button><p id="more"></p><button onclick="document.getElementById(\'n\').remove()">Accept all</button></div>',
      '/target': '<title>Target</title><h1>Annual report</h1>'
    };
    const server = http.createServer((request, response) => {
      response.writeHead(pages[request.url] ? 200 : 404, { 'content-type': 'text/html' });
      response.end(pages[request.url] ? `<!doctype html><html><body>${pages[request.url]}</body></html>` : 'missing');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const offered = [];
      let partnersClicked = false;
      const reasoner = async (_task, obs) => {
        offered.push(labels(obs.actionableElements));
        const link = obs.actionableElements.find(e => e.label === 'Annual report');
        if (link) return { ref: link.ref, operation: 'click', value: '' };
        const partners = obs.actionableElements.find(e => e.label === 'Partners');
        if (partners && !partnersClicked) { partnersClicked = true; return { ref: partners.ref, operation: 'click', value: '' }; }
        const accept = obs.actionableElements.find(e => /accept/i.test(e.label));
        return accept ? { ref: accept.ref, operation: 'click', value: '' } : { ref: '', operation: 'done', value: '' };
      };
      const result = await quiet(() => executeNaturalLanguageTask(page, 'Click the Annual report link.', { urlLess: false, orchestratorOptions: { agentOptions: {
        maxSteps: 10, reasoner,
        approvalProvider: createConversationalApprovalProvider({ requestUser: async () => ({ optionId: 'approve' }) }) } } }));
      assert.ok(offered[0].includes('Annual report'), 'before any block the planner sees everything');
      assert.ok(!offered[1].includes('Annual report'), 'after the covered click the covered link is not offered');
      assert.ok(partnersClicked, 'the scripted planner took the notice\'s other control');
      assert.ok(!offered[2].includes('Annual report'), `the notice still stands after Partners went through, so the covered link stays out: ${JSON.stringify(offered[2])}`);
      assert.ok(offered[2].includes('Accept all'));
      assert.match(page.url(), /\/target$/, JSON.stringify(result).slice(0, 300));
      assert.equal(result.status, 'verified_complete');
      await page.close();
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
  // 9-10. A notice that is replaced by another a moment after a click. For that moment
  //       nothing covers the page; it must not be taken for "the notice is gone".
  {
    const layer = (id, buttons) => `<div id="${id}" role="dialog" style="position:fixed;left:0;top:0;width:100vw;height:100vh;background:#fff;z-index:9">${buttons}</div>`;
    const replace = '<button onclick="openSecond()">Partners</button><button onclick="document.getElementById(\'first\').remove()">Accept all</button>';
    const replaceScript = `<script>
      function openSecond() {
        document.getElementById('first').remove();
        setTimeout(function () {
          var d = document.createElement('div');
          d.id = 'second'; d.setAttribute('role', 'dialog');
          d.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;background:#fff;z-index:9';
          d.innerHTML = '<button id="av">Accept vendors</button><button>Reject vendors</button>';
          document.body.appendChild(d);
          document.getElementById('av').onclick = function () { d.remove(); };
        }, 1200);
      }
    </script>`;
    const pages = {
      '/replaced': `<title>Home</title><a href="/target">Annual report</a>${layer('first', replace)}${replaceScript}`,
      '/target': '<title>Target</title><h1>Annual report</h1>',
      '/late': '<title>Late</title><p>text</p><script>setTimeout(()=>document.body.insertAdjacentHTML("beforeend",\'<div role="dialog" style="position:fixed;inset:0;background:#fff;z-index:9">late</div>\'),600)</script>',
      '/never': '<title>Never</title><p>text</p>',
      '/now': `<title>Now</title><p>text</p>${layer('x', '<button>OK</button>')}`,
      '/bodyfixed': '<title>Body</title><body style="position:fixed;width:100%"><a href="/x">link</a></body>'
    };
    const server = http.createServer((request, response) => {
      response.writeHead(pages[request.url] ? 200 : 404, { 'content-type': 'text/html' });
      response.end(pages[request.url] ? `<!doctype html><html><body>${pages[request.url]}</body></html>` : 'missing');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${server.address().port}`;
    const open = async path => { const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage(); await page.goto(root + path); return page; };
    try {
      { // the wait helper
        let page = await open('/now');
        assert.equal(await waitForCoveringLayer(page, { timeoutMs: 400 }), true, 'a layer already there is found at once');
        await page.close();
        page = await open('/late');
        assert.equal(await waitForCoveringLayer(page, { timeoutMs: 400 }), false, 'too short a wait does not see a layer that comes later');
        assert.equal(await waitForCoveringLayer(page, { timeoutMs: 2000 }), true, 'a layer that appears within the bound is found');
        await page.close();
        page = await open('/never');
        const started = Date.now();
        assert.equal(await waitForCoveringLayer(page, { timeoutMs: 500, intervalMs: 100 }), false);
        assert.ok(Date.now() - started < 1500, 'the wait is bounded');
        await page.close();
        page = await open('/bodyfixed');
        assert.equal(await waitForCoveringLayer(page, { timeoutMs: 300 }), false, 'a page with a fixed body is not a covering layer');
        await page.close();
      }
      { // the whole run
        const page = await open('/replaced');
        const calls = [];
        let partnersClicked = false;
        const reasoner = async (_task, obs) => {
          calls.push({ labels: labels(obs.actionableElements), controls: obs.overlayControls ?? [] });
          const link = obs.actionableElements.find(e => e.label === 'Annual report');
          if (link) return { ref: link.ref, operation: 'click', value: '' };
          const partners = obs.actionableElements.find(e => e.label === 'Partners');
          if (partners && !partnersClicked) { partnersClicked = true; return { ref: partners.ref, operation: 'click', value: '' }; }
          const accept = obs.actionableElements.find(e => /accept/i.test(e.label));
          return accept ? { ref: accept.ref, operation: 'click', value: '' } : { ref: '', operation: 'done', value: '' };
        };
        const result = await quiet(() => executeNaturalLanguageTask(page, 'Click the Annual report link.', { urlLess: false, orchestratorOptions: { agentOptions: {
          maxSteps: 10, reasoner,
          approvalProvider: createConversationalApprovalProvider({ requestUser: async () => ({ optionId: 'approve' }) }) } } }));
        assert.ok(partnersClicked);
        assert.ok(calls.length >= 3, JSON.stringify(calls));
        assert.ok(!calls[2].labels.includes('Annual report'), `the replacement notice was waited for, so the covered link stays out: ${JSON.stringify(calls[2])}`);
        assert.ok(calls[2].labels.includes('Accept vendors'), 'the planner sees the replacement notice\'s button');
        assert.ok(calls[2].controls.includes('Accept vendors'), `the notice is described again: ${JSON.stringify(calls[2].controls)}`);
        assert.match(page.url(), /\/target$/, JSON.stringify(result).slice(0, 300));
        assert.equal(result.status, 'verified_complete');
        await page.close();
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
} finally { await browser.close(); await site.close(); }
console.log('PASS test-covered-elements');
