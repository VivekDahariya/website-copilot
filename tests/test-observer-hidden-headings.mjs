import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { observePage } from '../src/observer/dom-observer.js';
import { verifyDirectCompletion } from '../src/agent/direct-instruction.js';

// A heading nobody can see is not evidence of anything: not a success
// message that has not appeared yet, not a collapsed panel.
const html = `<!DOCTYPE html><html><head><title>Hidden Lab</title></head><body>
<h1>Hidden Lab</h1>
<section id="form"><h2>Edit preferences</h2><button id="save">Save</button></section>
<section id="done" style="display:none"><h2>Preferences saved successfully</h2></section>
<section id="attr" hidden><h3>Secret panel</h3></section>
<script>
document.getElementById('save').onclick = () => {
  document.getElementById('done').style.display = 'block';
};
</script></body></html>`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('https://hidden-lab.example/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto('https://hidden-lab.example/');

  const before = await observePage(page);
  const clean = before.headings.map(h => h.trim());
  assert.deepEqual(clean, ['Hidden Lab', 'Edit preferences'],
    'only the visible headings are reported');

  // The verifier must not accept the unseen message.
  const ask = 'Click Save. Finish only when the page says Preferences saved successfully.';
  const early = verifyDirectCompletion({
    instruction: ask, observation: before, history: [],
    preservation: { verified: true }
  });
  assert.equal(early.completed, false, 'hidden text is not evidence');

  // Once the message is really shown, it is evidence.
  await page.click('#save');
  const after = await observePage(page);
  assert.ok(after.headings.some(h => /saved successfully/i.test(h)),
    'a heading that has become visible is reported');
} finally {
  await browser.close();
}
console.log('observer hidden headings: PASS');
