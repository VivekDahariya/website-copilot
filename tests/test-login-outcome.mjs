// What the site said in answer to a login: only messages that appeared after
// the button was pressed, read from the live page, quoted as the page wrote
// them. The report states the verdict from the record; the page's words are a
// quoted detail, never a verdict.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readPageMessages, newMessages, cleanMessage } from '../src/agent/login-outcome.js';
import {
  collectRunExplanationEvidence, collectCompletionChecks, collectRunSteps,
  collectRunContext, buildRunFacts, findContradiction, explainFromFacts
} from '../src/ui/run-explanation.js';

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  // A labelled alert with a close mark, plus ordinary text that must not match.
  await page.setContent(`<body><p>Welcome back. Sign in to continue.</p>
    <div class="flash error" role="alert">Your password is invalid! ${String.fromCharCode(215)}</div>
    <span>Wrong box</span><p style="display:none">Invalid hidden text</p>
    <p>${'Long text '.repeat(40)} invalid</p></body>`);
  const messages = await readPageMessages(page);
  assert.equal(messages[0], 'Your password is invalid!', 'the alert comes first and the close mark is dropped');
  assert.ok(messages.includes('Wrong box'), 'a trailing letter is never cut off');
  assert.ok(!messages.some(text => /hidden/i.test(text)), 'hidden text is ignored');
  assert.ok(!messages.some(text => text.length > 200), 'long paragraphs are ignored');
  assert.ok(!messages.some(text => /Welcome/.test(text)), 'ordinary text is ignored');
} finally { await browser.close(); }

assert.deepEqual(newMessages(['Invalid logins are recorded.'], ['Invalid logins are recorded.', 'Your password is invalid!']),
  ['Your password is invalid!'], 'what was already there is not an answer to the login');
assert.deepEqual(newMessages([], []), []);
assert.equal(cleanMessage('  a\u0000b \n c  '), 'a b c');
assert.equal(cleanMessage('x'.repeat(500)).length, 160);

// The report: verdict from the record, the page's words as a quoted detail.
const state = {
  phase: 'finished', url: 'https://the-internet.herokuapp.com/login',
  result: { status: 'login_rejected', reason: 'The page said: "Your password is invalid!"' },
  actionTree: { nodes: [{ id: 'a', title: 'Login Page' }, { id: 'b', title: 'Login Page' }],
    edges: [{ from: 'a', to: 'b', operation: 'click', label: 'Login', status: 'observed_after_action' }] },
  activity: []
};
const evidence = collectRunExplanationEvidence(state);
const options = { checks: collectCompletionChecks(state), steps: collectRunSteps(state), context: collectRunContext(state) };
const run = buildRunFacts(evidence, options.checks, options.steps, options.context);
assert.equal(run.passed, false);
assert.ok(run.facts.whyItFailed.some(line => /rejected the login/.test(line)));
assert.ok(run.facts.whyItFailed.some(line => line.includes('Your password is invalid!')), 'the site\'s words are in the facts');
assert.ok(run.facts.whatTheUserCanTry[0].includes('never retries'));
const report = explainFromFacts(evidence, options);
assert.equal(report.outcome, 'failed');
assert.equal(findContradiction(run, report.explanation), null);
console.log('login-outcome: all groups passed');
