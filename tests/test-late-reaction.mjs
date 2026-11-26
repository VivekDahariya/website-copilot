import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runAgent } from '../src/agent/agent.js';
import { DIRECT_INSTRUCTION_GOAL } from '../src/agent/direct-instruction.js';
import { observationFingerprint, mayReactLate } from '../src/agent/late-reaction.js';

// 1. Which actions may be given a moment to take effect.
{
  const page = { url: 'http://x/', headings: ['A'], visibleBodyText: 'one',
    actionableElements: [{ ref: 'e1', label: 'Go', initialChecked: null }] };
  const same = { ...page, actionableElements: [{ ref: 'e1', label: 'Go', initialChecked: true }] };
  const other = { ...page, visibleBodyText: 'two' };
  assert.equal(observationFingerprint(page), observationFingerprint(same), 'initialChecked is metadata');
  assert.notEqual(observationFingerprint(page), observationFingerprint(other));
  const args = { decision: { operation: 'click' }, result: { executionCompleted: true },
    before: page, after: same, urlBefore: 'http://x/', urlNow: 'http://x/' };
  assert.equal(mayReactLate(args), true);
  assert.equal(mayReactLate({ ...args, after: other }), false, 'something already changed');
  assert.equal(mayReactLate({ ...args, urlNow: 'http://x/next' }), false, 'a navigation is a change');
  assert.equal(mayReactLate({ ...args, result: { executionCompleted: false } }), false);
  assert.equal(mayReactLate({ ...args, decision: { operation: 'hover' } }), false);
  assert.equal(mayReactLate({ ...args, decision: { operation: 'fill' } }), false);
}

// 2. In a real browser: the page answers 500 ms after the click.
const html = `<!DOCTYPE html><html><head><title>Late Lab</title></head><body>
<h1>Late Lab</h1>
<button id="reveal">Reveal details</button>
<button id="inert">Inert button</button>
<section id="late" style="display:none"><h2>Late details panel</h2><p>Arrived after the click.</p></section>
<script>
document.getElementById('reveal').onclick = () =>
  setTimeout(() => { document.getElementById('late').style.display = 'block'; }, 500);
</script></body></html>`;

const BASE = 'https://late-lab.example';
const browser = await chromium.launch({ headless: true });
try {
  async function run(label) {
    const page = await browser.newPage();
    await page.route(`${BASE}/**`, route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto(`${BASE}/`);
    const seen = [];
    const reasoner = async (task, observation) => {
      seen.push(String(observation.visibleBodyText ?? ''));
      if (seen.length === 1) {
        const el = observation.actionableElements.find(e => e.label === label);
        return { ref: el.ref, operation: 'click', value: '' };
      }
      return { ref: '', operation: 'done', value: '' };
    };
    const instruction = `Click ${label}.`;
    const started = Date.now();
    const result = await runAgent(page, instruction, DIRECT_INSTRUCTION_GOAL,
      { reasoner, originalInstruction: instruction, maxSteps: 4 });
    const elapsedMs = Date.now() - started;
    await page.close();
    return { seen, result, elapsedMs };
  }

  const late = await run('Reveal details');
  assert.ok(late.seen.length >= 2, 'the agent planned again after the click');
  assert.match(late.seen[1], /Late details panel/,
    'the next observation already shows what the click caused');

  // 3. A click that really does nothing is not waited on for long.
  const inert = await run('Inert button');
  assert.ok(inert.seen.length >= 2);
  assert.doesNotMatch(inert.seen[1], /Late details panel/);
  assert.ok(inert.elapsedMs < 20000, `a no-op click cost ${inert.elapsedMs} ms`);
} finally {
  await browser.close();
}
console.log('late reaction: PASS');
