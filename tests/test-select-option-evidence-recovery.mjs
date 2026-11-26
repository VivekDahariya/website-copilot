import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runAgent } from '../src/agent/agent.js';

const browser = await chromium.launch({
  headless: true,
  ...(process.env.WC_TEST_CHROMIUM ? { executablePath: process.env.WC_TEST_CHROMIUM } : {}),
  args: ['--no-sandbox']
});

try {
  const page = await browser.newPage();
  await page.setContent(`<!DOCTYPE html><title>Select recovery</title>
    <label for="route">Route</label>
    <select id="route" onchange="document.querySelector('#result').textContent = this.value === 'good' ? 'Recovery successful' : 'Not completed'">
      <option value="start">Start</option>
      <option value="good">Verified route</option>
    </select>
    <p id="result">Not completed</p>`);

  const selected = [];
  const events = [];
  const reasoner = async (_task, observation, _history, rejected) => {
    const target = observation.actionableElements.find(x => x.tag === 'select');
    assert.ok(target, 'Select must be observed');
    const value = rejected.some(x => x.ref === target.ref && x.value === 'unavailable')
      ? 'good' : 'unavailable';
    selected.push(value);
    return {ref:target.ref, operation:'select', value};
  };

  const result = await runAgent(page,
    'Select the route that displays Recovery successful.',
    {type:'visible_content', text:'Recovery successful'},
    {reasoner, maxSteps:5, onAgentEvent:event=>events.push(event)});
  assert.equal(result.status,'verified_complete',JSON.stringify(result));
  assert.equal(await page.locator('select').inputValue(),'good');
  assert.equal(await page.locator('#result').textContent(),'Recovery successful');
  assert.deepEqual(selected,['unavailable','unavailable','good']);
  assert.equal(result.history.filter(x=>x.execution?.errorCode==='SELECT_OPTION_UNAVAILABLE').length,1);
  assert.equal(result.history.filter(x=>x.execution?.executionCompleted===true).length,1);
  assert.ok(events.some(x=>x.type==='action_failed' && x.reason==='select_option_unavailable'));
  console.log('PASS: Real Chromium unavailable select is recorded once, identical retry rejected, alternate selection verified');

  // If no supported option is offered, fail closed without treating a failed
  // action as progress. A different reasoner can safely decline all options.
  await page.setContent(`<title>Unsolvable select</title>
    <select><option value="start">Start</option></select>
    <p>Not completed</p>`);
  const alwaysInvalid = async (_task, obs) => ({
    ref:obs.actionableElements.find(x=>x.tag==='select').ref,
    operation:'select',value:'unavailable'
  });
  const failed = await runAgent(page,'Select the route that displays Recovery successful.',
    {type:'visible_content',text:'Recovery successful'},
    {reasoner:alwaysInvalid,maxSteps:4});
  assert.notEqual(failed.status,'verified_complete');
  assert.equal(await page.locator('select').inputValue(),'start');
  assert.equal(failed.history.filter(x=>x.execution?.errorCode==='SELECT_OPTION_UNAVAILABLE').length,1);
  console.log('PASS: No valid option yields an unsuccessful task without modifying the dropdown');
} finally { await browser.close(); }
