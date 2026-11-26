// A run that stops for approval (or a blocked action) must still report the
// actions it already carried out. Regression: the dashboard showed
// "Executed actions: 0" after a field had been filled and verified.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runAgent } from '../src/agent/agent.js';
import { DIRECT_INSTRUCTION_GOAL } from '../src/agent/direct-instruction.js';

const browser = await chromium.launch({headless:true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM}:{}),
  args:['--no-sandbox']});
let passed = 0;
const ok = message => { passed += 1; console.log('PASS:', message); };

try {
  const context = await browser.newContext();
  let posts = 0;
  await context.route('https://orders.test/**', route => {
    if (new URL(route.request().url()).pathname === '/post') posts += 1;
    route.fulfill({contentType:'text/html', body:`<!doctype html><html><body>
<form method="post" action="/post"><p><label>Customer name: <input name="custname"></label></p>
<p><button>Submit order</button></p></form></body></html>`});
  });
  const reasoner = async (_t, obs) => {
    const name = obs.actionableElements.find(e => /customer/i.test(e.label));
    return !name.currentValue ? {ref:name.ref, operation:'fill', value:'Vivek'}
      : {ref:obs.actionableElements.find(e => /submit/i.test(e.label)).ref, operation:'click', value:''};
  };
  const instruction = 'Fill Customer name with "Vivek" and submit the order.';

  {
    const page = await context.newPage(); await page.goto('https://orders.test/forms/post');
    const result = await runAgent(page, instruction, DIRECT_INSTRUCTION_GOAL,
      {reasoner, maxSteps:5, approvalProvider: async () => null});
    assert.equal(result.status,'approval_required');
    assert.equal(posts,0,'nothing may be submitted without approval');
    assert.equal(result.steps,1);
    assert.equal(result.history.length,1,'the verified fill must be reported');
    assert.equal(result.history[0].decision.operation,'fill');
    assert.equal(result.history[0].execution.executionCompleted,true);
    assert.equal(result.action.operation,'click','the held-back action is still named');
    assert.equal(result.finalUrl,'https://orders.test/forms/post');
    assert.equal(await page.locator('[name=custname]').inputValue(),'Vivek');
    await page.close();
    ok('denied approval: the earlier executed action is reported; nothing submitted');
  }
  {
    const page = await context.newPage(); await page.goto('https://orders.test/forms/post');
    const result = await runAgent(page, 'Submit the order.', DIRECT_INSTRUCTION_GOAL, {
      maxSteps:3, approvalProvider: async () => null,
      reasoner: async (_t, obs) => ({ref:obs.actionableElements.find(e => /submit/i.test(e.label)).ref, operation:'click', value:''})});
    assert.equal(result.status,'approval_required');
    assert.deepEqual(result.history,[]);
    assert.equal(result.steps,0);
    await page.close();
    ok('denied on the very first action: zero executed actions is reported truthfully');
  }
  await context.close();
  console.log(`stopped-run-history: ${passed} groups passed`);
} finally {
  await browser.close();
}
