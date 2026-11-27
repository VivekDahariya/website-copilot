// Three findings from the real local model on the pointer/key battery cases,
// replayed here with a scripted model and the REAL agent, executor, verifier
// and the same fixture pages the battery uses:
//   1. hover-menu : the run reached the page it was asked for, then clicked the
//                   header "Contact" link and the verifier still said "done".
//   2. drag-card  : the card was already in "Done"; the model dragged it there
//                   again (the drop zones had swapped references) and the repeat
//                   was not recognised, so the finished task was reported as failed.
//   3. key-twice  : the second Tab press was refused as "ineffective" although
//                   the instruction said twice.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createFixtureSite } from './battery/fixtures.mjs';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { unmetSteps } from '../src/agent/instruction-steps.js';

const browser = await chromium.launch({headless: true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath: process.env.WC_TEST_CHROMIUM} : {}),
  args: ['--no-sandbox']});
const site = await createFixtureSite();
const realFetch = globalThis.fetch;
const previousFlag = process.env.COPILOT_DIRECT_INSTRUCTION;
let passed = 0;
const ok = message => { passed += 1; console.log('PASS:', message); };

async function run(path, instruction, script, after) {
  globalThis.fetch = async (_url, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    const el = label => payload.availableElements.find(e => e.label === label);
    const count = operation => (payload.previousActions ?? [])
      .filter(item => item.operation === operation && item.status === 'done').length;
    return {ok: true, json: async () => ({message: {content: JSON.stringify(script(payload, {el, count}))}})};
  };
  const page = await browser.newPage();
  try {
    await page.goto(site.base + path, {waitUntil: 'domcontentloaded'});
    const result = await executeNaturalLanguageTask(page, instruction,
      {orchestratorOptions: {agentOptions: {maxSteps: 10}}});
    const history = result.execution?.result?.history ?? [];
    return {result, history, state: await after(page), path: new URL(page.url()).pathname};
  } finally { await page.close(); }
}

try {
  process.env.COPILOT_DIRECT_INSTRUCTION = '1';

  // 1. hover-menu --------------------------------------------------------------
  const hoverInstruction = 'Hover over the Support menu and click the Contact desk link.';
  const hoverWork = (el, count) =>
    count('hover') === 0 ? {ref: el('Support menu').ref, operation: 'hover', value: ''}
    : count('click') === 0 ? {ref: el('Contact desk').ref, operation: 'click', value: ''}
    : null;
  {
    const {result, path} = await run('/controls/menu', hoverInstruction, (payload, {el, count}) =>
      hoverWork(el, count) ?? (count('click') === 1
        ? {ref: el('Contact').ref, operation: 'click', value: ''}
        : {ref: '', operation: 'done', value: 'Contact'}), async () => null);
    assert.equal(path, '/contact', 'the scripted run did leave the desk page');
    assert.notEqual(result.status, 'verified_complete',
      'a run that clicked the desk link and then moved on must not be verified');
    ok('hover-menu: leaving the page the link led to is not "complete"');
  }
  {
    const {result, path} = await run('/controls/menu', hoverInstruction, (payload, {el, count}) =>
      hoverWork(el, count) ?? {ref: '', operation: 'done', value: 'The desk is open on weekdays'},
      async () => null);
    assert.equal(result.status, 'verified_complete', JSON.stringify(result.reason ?? result.status));
    assert.equal(path, '/controls/menu/contact-desk');
    ok('hover-menu: hover, click the link, stay there -> complete');
  }
  {
    const desk = {kind: 'click', decision: {operation: 'click'}, targetLabel: 'Contact desk',
      execution: {executionCompleted: true, verified: true,
        previousUrl: 'http://x.test/controls/menu', urlAfter: 'http://x.test/controls/menu/contact-desk'}};
    const header = {decision: {operation: 'click'}, targetLabel: 'Contact',
      execution: {executionCompleted: true, verified: true,
        previousUrl: 'http://x.test/controls/menu/contact-desk', urlAfter: 'http://x.test/contact'}};
    const steps = unmetSteps('Click the Contact desk link.', [desk, header]);
    assert.equal(steps.lastIndex, 0, 'the click that carries the whole name is the last step, not the later partial one');
    assert.deepEqual(steps.missing, []);
    const partOnly = unmetSteps('Click the Contact desk link.', [header]);
    assert.deepEqual(partOnly.missing, [], 'a label that is part of the name still counts when nothing better exists');
    ok('step evidence prefers the click that carries the whole name');
  }

  // 2. drag-card ---------------------------------------------------------------
  const dragInstruction = 'Drag "Card A" into the "Done" column.';
  const inDone = page => page.evaluate(() => document.querySelector('#done #a') !== null);
  {
    const {result, history, state} = await run('/controls/board', dragInstruction,
      (payload, {el}) => ({ref: el('Card A').ref, operation: 'drag', value: el('Done').ref}), inDone);
    assert.equal(result.status, 'verified_complete', JSON.stringify(result.reason ?? result.status));
    assert.equal(state, true);
    assert.equal(history.filter(item => item.decision?.operation === 'drag').length, 1,
      'the finished drag is not repeated');
    ok('drag-card: the same drag proposed again after the drop zones swapped is not repeated');
  }
  {
    const {history, state} = await run('/controls/board', 'Drag "Card A" into the "Done" column, then drag it back into the "To do" column.',
      (payload, {el, count}) => count('drag') === 0
        ? {ref: el('Card A').ref, operation: 'drag', value: el('Done').ref}
        : {ref: el('Card A').ref, operation: 'drag', value: el('To do').ref}, inDone);
    const drags = history.filter(item => item.decision?.operation === 'drag');
    assert.equal(drags.length >= 2, true, 'a drag to a different place is still carried out');
    assert.equal(state, false, 'the card was moved back');
    ok('drag-card: a drag to a different column is not blocked');
  }

  // 3. key-twice ---------------------------------------------------------------
  const tabs = page => page.evaluate(() => window.__tabs);
  {
    const {result, history, state} = await run('/controls/keys', 'Press the Tab key twice in the Name field.',
      (payload, {el}) => ({ref: el('Name').ref, operation: 'press', value: 'Tab'}), tabs);
    assert.equal(result.status, 'verified_complete', JSON.stringify(result.reason ?? result.status));
    assert.equal(history.filter(item => item.decision?.operation === 'press').length, 2);
    assert.equal(state, 2, 'Tab was pressed exactly twice in the browser');
    ok('key-twice: both presses happen although the first changed nothing');
  }
  {
    const {state} = await run('/controls/keys', 'Press the Tab key twice in the Name field.',
      (payload, {el}) => ({ref: el('Name').ref, operation: 'press', value: 'Tab'}), tabs);
    assert.equal(state, 2, 'a third press is never made');
    ok('key-twice: no press beyond the asked number');
  }
  {
    const {state} = await run('/controls/keys', 'Press the Tab key in the Name field.',
      (payload, {el}) => ({ref: el('Name').ref, operation: 'press', value: 'Tab'}), tabs);
    assert.equal(state, 1, 'one press asked, one press made');
    ok('key-once: an unrequested second press is still refused');
  }

  console.log(`pointer-run-findings: ${passed} groups passed`);
} finally {
  globalThis.fetch = realFetch;
  if (previousFlag === undefined) delete process.env.COPILOT_DIRECT_INSTRUCTION;
  else process.env.COPILOT_DIRECT_INSTRUCTION = previousFlag;
  await browser.close();
  await site.close();
}
