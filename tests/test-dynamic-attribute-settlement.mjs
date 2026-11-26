import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { getDomRevision, waitForRelevantDomChange } from '../src/observer/dom-change-watcher.js';
import { runAgent } from '../src/agent/agent.js';

const browser = await chromium.launch({
  headless: true,
  ...(process.env.WC_TEST_CHROMIUM ? { executablePath: process.env.WC_TEST_CHROMIUM } : {}),
  args: ['--no-sandbox']
});
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>Attribute settling</title><p>Loading</p><div id="switch" aria-expanded="false" data-state="closed">Menu</div>');
  const first = await getDomRevision(page);
  await page.locator('#switch').evaluate(el => el.setAttribute('aria-expanded', 'true'));
  assert.equal(await waitForRelevantDomChange(page, { sinceRevision: first, timeoutMs: 150 }), true);
  const second = await getDomRevision(page);
  await page.locator('#switch').evaluate(el => el.setAttribute('data-state', 'open'));
  assert.equal(await waitForRelevantDomChange(page, { sinceRevision: second, timeoutMs: 150 }), true);
  const third = await getDomRevision(page);
  await page.locator('#switch').evaluate(el => el.classList.add('open'));
  assert.equal(await waitForRelevantDomChange(page, { sinceRevision: third, timeoutMs: 150 }), true);
  const fourth = await getDomRevision(page);
  assert.equal(await waitForRelevantDomChange(page, { sinceRevision: fourth, timeoutMs: 80 }), false);
  console.log('PASS: Class, ARIA expansion and data-state changes trigger settlement; unchanged pages do not');

  await page.setContent(`<!doctype html><html><head><title>Dynamic class reveal</title><style>
    .hidden {display:none}
  </style></head><body><p>Waiting for the gated control</p>
    <button id="go" class="hidden" onclick="document.querySelector('#result').textContent='Gate opened'">Reveal result</button>
    <div id="result">Not ready</div></body></html>`);
  let armed = false;
  let initialPlannerMissing = false;
  let modelCalls = 0;
  const reasoner = async (_task, observation) => {
    modelCalls++;
    const target = observation.actionableElements.find(e => e.label.includes('Reveal result'));
    if (target) return { ref: target.ref, operation: 'click', value: '' };
    initialPlannerMissing = true;
    if (!armed) {
      armed = true;
      await page.evaluate(() => setTimeout(() =>
        document.querySelector('#go').classList.remove('hidden'), 260));
    }
    throw new Error('Control not observed yet');
  };
  const outcome = await runAgent(
    page,
    'When Reveal result becomes available, click it and verify Gate opened.',
    { type: 'visible_content', text: 'Gate opened' },
    { reasoner, maxSteps: 5 }
  );
  assert.equal(initialPlannerMissing, true);
  assert.equal(outcome.status, 'verified_complete', JSON.stringify({status:outcome.status,reason:outcome.reason}));
  assert.equal(outcome.history.filter(e => e?.decision?.operation === 'click').length, 1);
  assert.equal(await page.locator('#result').textContent(), 'Gate opened');
  assert.ok(modelCalls >= 3);
  console.log('PASS: Real Chromium delayed class-only reveal causes bounded reobservation and one verified click');
} finally {
  await browser.close();
}
