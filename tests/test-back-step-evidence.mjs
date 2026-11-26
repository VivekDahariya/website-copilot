import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { sequencedTargets, unmetSteps } from '../src/agent/instruction-steps.js';
import { runAgent } from '../src/agent/agent.js';
import { DIRECT_INSTRUCTION_GOAL } from '../src/agent/direct-instruction.js';
import { createConversationalApprovalProvider } from '../src/agent/conversational-approval.js';

// "Go back" is done when the browser went back to a page it had left, not when
// some other click happened afterwards.
const kinds = text => sequencedTargets(text).map(t => t.kind);
assert.deepEqual(kinds('Click Products, then go back.'), ['click', 'back']);
assert.deepEqual(kinds('Click Products, then return to the home page.'), ['click', 'back']);
assert.deepEqual(kinds('Go back to the previous page.'), ['back']);
assert.deepEqual(kinds('Open the Reports page and return the total revenue.'), ['page'], '"return" with an object is not navigation');
assert.deepEqual(kinds('Click Products, then return the price.'), ['click'], '"return the price" is not a back step');

const entry = (operation, label, from, to) => ({
  decision: { operation }, targetLabel: label,
  execution: { executionCompleted: true, verified: true, previousUrl: from, urlAfter: to }
});
const H = 'http://s.test/', P = 'http://s.test/products', A = 'http://s.test/about';
const ask = 'Click the Products link, then go back.';
const products = entry('click', 'Products', H, P);
assert.deepEqual(unmetSteps(ask, [products]).missing, ['go back'], 'no back yet');
assert.deepEqual(unmetSteps(ask, [products, entry('back', '', P, H)]).missing, [], 'a real back counts');
assert.deepEqual(unmetSteps(ask, [products, entry('click', 'Back to home', P, H)]).missing, [], 'a click that returned to the page left earlier counts');
assert.deepEqual(unmetSteps(ask, [products, entry('click', 'About', P, A)]).missing, ['go back'], 'a click that went somewhere new is not going back');
assert.deepEqual(unmetSteps(ask, [products, entry('click', 'Refresh', P, P)]).missing, ['go back'], 'a click that stayed put is not going back');
assert.deepEqual(unmetSteps(ask, [products, entry('switch_tab', '', P, H)]).missing, [], 'switching back to the first tab counts');
assert.deepEqual(unmetSteps(ask, [entry('click', 'About', H, A), entry('click', 'Products', A, P)]).missing, ['go back'], 'a click to a page never visited before');

// The same in a real browser, through the agent, with a scripted planner.
const pages = {
  '/': '<title>Home</title><h1>Home</h1><a href="/products">Products</a> <a href="/about">About</a>',
  '/products': '<title>Products</title><h1>Products</h1><p>Our products.</p><a href="/">Back to home</a> <a href="/about">About</a>',
  '/about': '<title>About</title><h1>About</h1><p>About us.</p>'
};
const browser = await chromium.launch({ headless: true });
async function run(instruction, script) {
  const page = await browser.newPage();
  await page.route('https://back-lab.example/**', route => {
    const path = new URL(route.request().url()).pathname;
    route.fulfill({ status: pages[path] ? 200 : 404, contentType: 'text/html', body: pages[path] ?? 'nope' });
  });
  await page.goto('https://back-lab.example/');
  let index = 0;
  const reasoner = async (_task, observation) => {
    const step = script[index++] ?? 'done';
    if (step === 'done') return { ref: '', operation: 'done', value: '' };
    if (step === 'back') return { ref: '', operation: 'back', value: '' };
    const element = observation.actionableElements.find(e => e.label === step);
    return element ? { ref: element.ref, operation: 'click', value: '' } : { ref: '', operation: 'done', value: '' };
  };
  const result = await runAgent(page, instruction, DIRECT_INSTRUCTION_GOAL, {
    reasoner, originalInstruction: instruction, maxSteps: 8,
    approvalProvider: createConversationalApprovalProvider({ requestUser: async () => ({ optionId: 'approve' }) })
  });
  const out = { status: result.status, ops: (result.history ?? []).map(h => h.decision.operation), path: new URL(page.url()).pathname };
  await page.close();
  return out;
}
try {
  const real = await run(ask, ['Products', 'back', 'done']);
  assert.equal(real.status, 'verified_complete');
  assert.deepEqual(real.ops, ['click', 'back']);
  assert.equal(real.path, '/', 'the browser really went back');

  const never = await run(ask, ['Products', 'done']);
  assert.notEqual(never.status, 'verified_complete', 'done without going back');
  assert.equal(never.path, '/products');

  const elsewhere = await run(ask, ['Products', 'About', 'done']);
  assert.notEqual(elsewhere.status, 'verified_complete', 'clicking another link is not going back');
  assert.equal(elsewhere.path, '/about');

  const viaLink = await run(ask, ['Products', 'Back to home', 'done']);
  assert.equal(viaLink.status, 'verified_complete', 'an in-page link back to the earlier page is going back');
  assert.equal(viaLink.path, '/');

  const nothing = await run('Go back to the previous page.', ['back', 'done']);
  assert.notEqual(nothing.status, 'verified_complete', 'nothing to go back to');
  assert.deepEqual(nothing.ops, [], 'a back with no earlier navigation is not executed');
} finally {
  await browser.close();
}
console.log('back step evidence: PASS');
