import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { unmetSteps } from '../src/agent/instruction-steps.js';
import { verifyDirectCompletion } from '../src/agent/direct-instruction.js';
import { runAgent } from '../src/agent/agent.js';
import { DIRECT_INSTRUCTION_GOAL } from '../src/agent/direct-instruction.js';
import { createConversationalApprovalProvider } from '../src/agent/conversational-approval.js';

// "Click X" is done when X was clicked, not when the word X is on the page.
const clicked = (label, from = 'http://s.test/', to = 'http://s.test/') => ({
  decision: { ref: 'e1', operation: 'click' }, targetLabel: label,
  execution: { executionCompleted: true, previousUrl: from, urlAfter: to }
});
const filled = { decision: { ref: 'e2', operation: 'fill', value: '' }, targetLabel: 'Name',
  execution: { executionCompleted: true, verified: true } };

// 1. The step model.
const ask = 'Type Alice in the Name field and click Continue.';
assert.deepEqual(unmetSteps(ask, [filled]).missing, ['Continue']);
assert.deepEqual(unmetSteps(ask, [filled, clicked('Continue')]).missing, []);
assert.deepEqual(unmetSteps(ask, [filled, clicked('Cancel')]).missing, ['Continue'], 'another control is not it');
assert.equal(unmetSteps('Type Alice in the Name field.', [filled]).applies, false, 'no click was asked for');
assert.equal(unmetSteps('Click the first link.', []).applies, false, 'an unnamed control is not a named step');
assert.equal(unmetSteps('Click Products, then click Widget.', []).applies, true, 'several steps still apply');

// 2. The verifier, with the word printed on the page.
const page = { url: 'http://s.test/', title: 'Enquiry', headings: ['Enquiry'],
  visibleBodyText: 'Enquiry Name Continue', actionableElements: [
    { ref: 'e2', tag: 'input', label: 'Name', editable: true, currentValue: 'Alice' },
    { ref: 'e3', tag: 'button', type: 'submit', label: 'Continue' }] };
const check = history => verifyDirectCompletion({
  instruction: ask, observation: page, history, preservation: { verified: true }
});
const notClicked = check([filled]);
assert.equal(notClicked.completed, false, 'the word on the page is not a click');
assert.match(notClicked.reason, /Continue/);
assert.equal(check([filled, clicked('Continue')]).completed, true);

// 3. In a real run: a claim of "done" without the click is not a success.
const html = `<!DOCTYPE html><html><body><h1>Enquiry</h1>
<form id="f"><label>Name <input aria-label="Name"></label><button type="submit">Continue</button></form>
<p id="r" style="display:none">Form submitted</p>
<script>document.getElementById('f').onsubmit = e => { e.preventDefault(); window.__s = true;
  document.getElementById('r').style.display = 'block'; };</script></body></html>`;
const browser = await chromium.launch({ headless: true });
try {
  async function run(clickToo) {
    const pageHandle = await browser.newPage();
    await pageHandle.route('https://click-lab.example/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await pageHandle.goto('https://click-lab.example/');
    const reasoner = async (task, observation) => {
      const name = observation.actionableElements.find(e => e.label === 'Name');
      if (name && !name.currentValue) return { ref: name.ref, operation: 'fill', value: 'Alice' };
      const go = observation.actionableElements.find(e => e.label === 'Continue');
      if (clickToo && go && !/Form submitted/.test(observation.visibleBodyText)) return { ref: go.ref, operation: 'click', value: '' };
      return { ref: '', operation: 'done', value: '' };
    };
    const result = await runAgent(pageHandle, ask, DIRECT_INSTRUCTION_GOAL, {
      reasoner, originalInstruction: ask, maxSteps: 8,
      approvalProvider: createConversationalApprovalProvider({ requestUser: async () => ({ optionId: 'approve' }) })
    });
    const submitted = await pageHandle.evaluate(() => window.__s === true);
    await pageHandle.close();
    return { result, submitted };
  }
  const skipped = await run(false);
  assert.equal(skipped.submitted, false);
  assert.notEqual(skipped.result.status, 'verified_complete', 'done without the click is not verified');
  const real = await run(true);
  assert.equal(real.submitted, true);
  assert.equal(real.result.status, 'verified_complete');
} finally {
  await browser.close();
}
console.log('click step evidence: PASS');
