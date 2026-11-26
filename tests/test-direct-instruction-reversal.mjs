// Regression for a false success seen with the real model on a real page:
// "Check the first checkbox" -> check, then uncheck the same box, then the
// run was reported verified_complete with the box back in its original state.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runAgent } from '../src/agent/agent.js';
import {
  DIRECT_INSTRUCTION_GOAL, verifyDirectCompletion, createDirectFormScope
} from '../src/agent/direct-instruction.js';

const browser = await chromium.launch({headless:true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM}:{}),
  args:['--no-sandbox']});

// Unlabelled checkboxes, second one pre-checked (same shape as the real page).
const html = `<!doctype html><html><head><title>The Internet</title></head><body>
<h3>Checkboxes</h3><form id="checkboxes">
<input type="checkbox"> checkbox 1<br><input type="checkbox" checked> checkbox 2</form></body></html>`;
const box = (obs, ordinal) => obs.actionableElements.find(
  e => e.type === 'checkbox' && e.ordinal === ordinal);
const boxes = page => page.locator('input[type=checkbox]');
let passed = 0;
const ok = message => { passed += 1; console.log('PASS:', message); };

try {
  // 1. Exact replay: check 1, then try to uncheck 1, then try checkbox 2.
  {
    const page = await browser.newPage(); await page.setContent(html);
    const proposals = [];
    const reasoner = async (_t, obs, history, rejected) => {
      const first = box(obs,1), second = box(obs,2);
      let decision;
      if (!history.length) decision = {ref:first.ref, operation:'check', value:'on'};
      else if (!rejected.length) decision = {ref:first.ref, operation:'uncheck', value:'Checkbox 1'};
      else decision = {ref:second.ref, operation:'uncheck', value:''};
      proposals.push(decision.operation + ':' + (decision.ref === first.ref ? 1 : 2));
      return decision;
    };
    const result = await runAgent(page,
      'Check the first checkbox. Leave the second checkbox unchanged.',
      DIRECT_INSTRUCTION_GOAL, {reasoner, maxSteps:6});
    assert.deepEqual(result.history.map(e=>e.decision.operation),['check'],
      'the reversing uncheck must never execute: ' + JSON.stringify(proposals));
    assert.equal(await boxes(page).nth(0).isChecked(),true,'first checkbox must end checked');
    assert.equal(await boxes(page).nth(1).isChecked(),true,'second checkbox must stay checked');
    assert.equal(result.status,'verified_complete',JSON.stringify(result.reason));
    assert(proposals.includes('uncheck:1') && proposals.includes('uncheck:2'));
    await page.close();
    ok('replay: reversing uncheck refused; run ends verified with the box actually checked');
  }

  // 2. The completion check itself: check + uncheck is not "checked".
  {
    const url = 'https://x.test/checkboxes';
    const observation = unchecked => ({url, title:'The Internet', headings:['Checkboxes'],
      visibleBodyText:'Checkboxes checkbox 1 checkbox 2', actionableElements:[
        {ref:'e3',tag:'input',type:'checkbox',label:'Checkbox 1',ordinal:1,checked:!unchecked},
        {ref:'e4',tag:'input',type:'checkbox',label:'Checkbox 2',ordinal:2,checked:true}]});
    const action = operation => ({decision:{ref:'e3',operation,value:''}, targetLabel:'Checkbox 1',
      execution:{executionCompleted:true,verified:true,previousUrl:url,urlAfter:url}});
    const instruction = 'Check the first checkbox. Leave the second checkbox unchanged.';
    const reverted = verifyDirectCompletion({instruction,
      observation:observation(true), history:[action('check'),action('uncheck')]});
    assert.equal(reverted.completed,false,'reverted state must not verify');
    const kept = verifyDirectCompletion({instruction,
      observation:observation(false), history:[action('check')]});
    assert.equal(kept.completed,true,JSON.stringify(kept.reason));
    const undone = verifyDirectCompletion({instruction,
      observation:observation(true), history:[action('check')]});
    assert.equal(undone.completed,false,'a check whose effect is gone is not evidence');
    ok('completion check judges the box state now, not that a check once happened');
  }

  // 3. Direction comes from the instruction.
  {
    const first = {type:'checkbox',ordinal:1,label:'Checkbox 1',checked:true};
    const second = {type:'checkbox',ordinal:2,label:'Checkbox 2',checked:true};
    const onlyCheck = createDirectFormScope('Check the first checkbox.');
    assert.equal(onlyCheck.reject(first,{operation:'uncheck'}),'reverses_requested_checkbox_state');
    assert.equal(onlyCheck.reject({...first,checked:false},{operation:'check'}),null);
    const onlyUncheck = createDirectFormScope('Uncheck the second checkbox.');
    assert.equal(onlyUncheck.reject(second,{operation:'uncheck'}),null);
    assert.equal(onlyUncheck.reject({...second,checked:false},{operation:'check'}),'reverses_requested_checkbox_state');
    const both = createDirectFormScope('Check the first checkbox and uncheck the second checkbox.');
    assert.equal(both.reject({...first,checked:false},{operation:'check'}),null);
    assert.equal(both.reject(second,{operation:'uncheck'}),null);
    ok('an instruction that only says check never permits an uncheck, and vice versa');
  }

  // 4. Mixed instruction: the agent may not undo its own verified change.
  {
    const page = await browser.newPage(); await page.setContent(html);
    let undoAttempted = false;
    const reasoner = async (_t, obs, history, rejected) => {
      const first = box(obs,1), second = box(obs,2);
      if (!first.checked) return {ref:first.ref, operation:'check', value:''};
      if (!undoAttempted && !rejected.length) { undoAttempted = true;
        return {ref:first.ref, operation:'uncheck', value:''}; }
      if (second.checked) return {ref:second.ref, operation:'uncheck', value:''};
      return {ref:'', operation:'done', value:'Checkboxes'};
    };
    const result = await runAgent(page,
      'Check the first checkbox and uncheck the second checkbox.',
      DIRECT_INSTRUCTION_GOAL, {reasoner, maxSteps:6});
    assert.equal(undoAttempted,true);
    assert.equal(result.status,'verified_complete',JSON.stringify(result.reason));
    assert.deepEqual(result.history.map(e=>e.decision.operation),['check','uncheck']);
    assert.equal(await boxes(page).nth(0).isChecked(),true);
    assert.equal(await boxes(page).nth(1).isChecked(),false);
    await page.close();
    ok('with both verbs requested, undoing an already verified change is still refused');
  }

  console.log(`direct-instruction-reversal: ${passed} groups passed`);
} finally {
  await browser.close();
}
