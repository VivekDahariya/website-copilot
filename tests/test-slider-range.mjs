import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { observePage } from '../src/observer/dom-observer.js';
import { executeAction } from '../src/executor/action-executor.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

// A slider value outside the slider's range must never crash a run or look like
// a success: it is refused before anything changes, the planner is told, and a
// second refusal ends the run with the real range in the reason.
const slider = (attrs, extra = '') => `<!doctype html><html><head><title>Level</title></head><body><h1>Level</h1>
<label for="s">Level</label><input id="s" type="range" ${attrs}><span id="o"></span>${extra}
<script>s.addEventListener('input', () => o.textContent = s.value)</script></body></html>`;
const browser = await chromium.launch({ headless: true });
const realFetch = globalThis.fetch, realLog = console.log;
try {
  // 1. The observer lists the allowed range, including the browser's defaults.
  {
    const page = await browser.newPage();
    await page.setContent(slider('min="0" max="5" step="0.5" value="1"'));
    const found = (await observePage(page)).actionableElements.find(e => e.type === 'range');
    assert.deepEqual(found.range, { min: 0, max: 5, step: 0.5 });
    await page.setContent(slider('value="40"'));
    assert.deepEqual((await observePage(page)).actionableElements.find(e => e.type === 'range').range, { min: 0, max: 100, step: 1 }, 'defaults of a bare slider');
    await page.setContent(slider('min="-10" max="10" step="any" value="0"'));
    assert.deepEqual((await observePage(page)).actionableElements.find(e => e.type === 'range').range, { min: -10, max: 10, step: 'any' });
    await page.close();
  }

  // 2. The executor refuses an impossible value before changing anything and says why.
  {
    const page = await browser.newPage();
    await page.setContent(slider('min="0" max="5" step="0.5" value="1"'));
    const ref = (await observePage(page)).actionableElements.find(e => e.type === 'range').ref;
    for (const bad of ['9', '-1', 'abc', '', '5.5']) {
      await assert.rejects(executeAction(page, { ref, operation: 'set_range', value: bad }),
        error => error.code === 'RANGE_VALUE_INVALID' && error.range.min === 0 && error.range.max === 5,
        `value ${JSON.stringify(bad)} is refused with the real range`);
      assert.equal(await page.locator('#s').inputValue(), '1', `the slider is unchanged after ${JSON.stringify(bad)}`);
    }
    const ok = await executeAction(page, { ref, operation: 'set_range', value: '3.5' });
    assert.equal(ok.executionCompleted, true);
    assert.equal(await page.locator('#s').inputValue(), '3.5');
    await page.close();
  }

  // 3. Through the real agent, with a scripted planner.
  async function run(instruction, values) {
    let calls = 0;
    globalThis.fetch = async (_u, request) => {
      const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
      const value = values[calls++];
      const reply = action => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(action) } }) });
      if (value === undefined) return reply({ ref: '', operation: 'done', value: '' });
      const element = (payload.availableElements ?? []).find(e => e.type === 'range');
      assert.deepEqual(element?.range, { min: 0, max: 5, step: 0.5 }, 'the planner is shown the slider range');
      return reply({ ref: element.ref, operation: 'set_range', value });
    };
    const page = await browser.newPage();
    await page.setContent(slider('min="0" max="5" step="0.5" value="1"'));
    console.log = () => {};
    let result;
    try { result = await executeNaturalLanguageTask(page, instruction, { orchestratorOptions: { agentOptions: { maxSteps: 6 } } }); }
    finally { console.log = realLog; }
    const final = await page.locator('#s').inputValue();
    await page.close();
    const inner = result.execution?.result ?? {};
    return { status: result.status, reason: String(inner.reason ?? ''), history: inner.history ?? [], final };
  }

  // Two different impossible values: the run ends and names the real range.
  const twice = await run('Set the Level slider to 9.', ['9', '8']);
  assert.notEqual(twice.status, 'verified_complete', 'an impossible value is never a success');
  assert.equal(twice.status, 'stagnation_detected');
  assert.match(twice.reason, /0 to 5/);
  assert.equal(twice.final, '1', 'nothing was changed');
  assert.deepEqual(twice.history.map(h => h.execution.errorCode), ['RANGE_VALUE_INVALID', 'RANGE_VALUE_INVALID']);

  // The same impossible value again is suppressed as a repeat; the "done" that
  // follows is rejected because the last action failed. Honest, not a success.
  const repeated = await run('Set the Level slider to 9.', ['9', '9']);
  assert.notEqual(repeated.status, 'verified_complete');
  assert.equal(repeated.status, 'unverified_completion_claim');
  assert.equal(repeated.final, '1', 'nothing was changed');
  assert.deepEqual(repeated.history.map(h => h.execution.errorCode), ['RANGE_VALUE_INVALID']);

  const recovers = await run('Set the Level slider to 3.', ['9', '3']);
  assert.equal(recovers.status, 'verified_complete', 'after one refusal a valid value completes the task');
  assert.equal(recovers.final, '3');
  assert.deepEqual(recovers.history.map(h => h.execution.errorCode ?? 'ok'), ['RANGE_VALUE_INVALID', 'ok']);

  const nonsense = await run('Set the Level slider to 3.', ['lots', 'many']);
  assert.notEqual(nonsense.status, 'verified_complete');
  assert.equal(nonsense.final, '1');
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close();
}
console.log('slider range: PASS');
