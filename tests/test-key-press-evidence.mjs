import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { keyRequirements, keyShortfall, normalizedKey } from '../src/agent/instruction-steps.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

// A key the user names needs its own verified key press, as often as asked.
const need = text => keyRequirements(text).map(k => `${k.key}x${k.count}`);
assert.deepEqual(need('Type "hello" in the Search field and press Enter.'), ['enterx1']);
assert.deepEqual(need('Press the Tab key twice in the text field'), ['tabx2']);
assert.deepEqual(need('Press Tab 3 times'), ['tabx3']);
assert.deepEqual(need('Hit Return, then press Esc'), ['enterx1', 'escapex1']);
assert.deepEqual(need('Press Ctrl+A'), ['control+ax1']);
assert.deepEqual(need('press the Down arrow key twice'), ['arrowdownx2']);
assert.deepEqual(need('Press Tab, then press Tab again'), ['tabx2'], 'the same key named twice adds up');
assert.deepEqual(need('Press the Submit button'), [], 'a button is not a key');
assert.deepEqual(need('Press Home'), [], 'a bare ambiguous word may be a button');
assert.deepEqual(need('Press the Home key'), ['homex1'], 'with the word key it is a key');
assert.deepEqual(need('Click the Press Release link'), [], 'a link name is not a key');
assert.equal(normalizedKey('Return'), normalizedKey('Enter'));
assert.equal(normalizedKey('ArrowDown'), normalizedKey('Down arrow'));
assert.equal(normalizedKey('Ctrl+a'), normalizedKey('Control+A'));

const pressed = (key, ok = true) => ({ decision: { operation: 'press', value: key }, execution: { executionCompleted: true, verified: ok } });
const typed = { decision: { operation: 'fill', value: 'hello' }, execution: { executionCompleted: true, verified: true } };
assert.deepEqual(keyShortfall('Type hello and press Enter.', [typed]), ['press Enter'], 'typing is not pressing');
assert.deepEqual(keyShortfall('Type hello and press Enter.', [typed, pressed('Enter')]), []);
assert.deepEqual(keyShortfall('Type hello and press Enter.', [typed, pressed('Return')]), [], 'an alias of the key counts');
assert.deepEqual(keyShortfall('Type hello and press Enter.', [typed, pressed('Tab')]), ['press Enter'], 'another key is not it');
assert.deepEqual(keyShortfall('Type hello and press Enter.', [typed, pressed('Enter', false)]), ['press Enter'], 'an unverified press does not count');
assert.deepEqual(keyShortfall('Press the Tab key twice.', [pressed('Tab')]), ['press Tab 2 times (1 done)']);
assert.deepEqual(keyShortfall('Press the Tab key twice.', [pressed('Tab'), pressed('Tab')]), []);
assert.deepEqual(keyShortfall('Type hello.', [typed]), [], 'no key named, nothing required');

// The same through the real agent and a real page, with a scripted planner.
const html = `<!doctype html><html><head><title>Keys</title></head><body><h1>Keys</h1>
<input id="target" type="text" aria-label="target"><p id="r"></p>
<script>target.addEventListener('keydown', e => { r.textContent = 'You entered: ' + e.key.toUpperCase(); });</script></body></html>`;
const browser = await chromium.launch({ headless: true });
const realFetch = globalThis.fetch, realLog = console.log;
async function run(instruction, script) {
  let calls = 0;
  globalThis.fetch = async (_u, request) => {
    const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
    const step = script[calls++];
    const reply = action => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(action) } }) });
    if (!step) return reply({ ref: '', operation: 'done', value: '' });
    const element = (payload.availableElements ?? []).find(e => /target/.test(String(e.label ?? '')));
    return reply({ ref: element?.ref ?? '', operation: step[0], value: step[1] });
  };
  const page = await browser.newPage();
  await page.setContent(html);
  console.log = () => {};
  let result;
  try { result = await executeNaturalLanguageTask(page, instruction, { orchestratorOptions: { agentOptions: { maxSteps: 6 } } }); }
  finally { console.log = realLog; await page.close(); }
  const history = result.execution?.result?.history ?? [];
  return { status: result.status, reason: String(result.execution?.result?.reason ?? ''), ops: history.map(h => h.decision.operation) };
}
try {
  const twice = 'Press the Tab key twice in the text field';
  const once = await run(twice, [['press', 'Tab']]);
  assert.notEqual(once.status, 'verified_complete', 'one press is not "twice"');
  assert.match(once.reason, /Tab/);
  assert.equal((await run(twice, [['press', 'Tab'], ['press', 'Tab']])).status, 'verified_complete');
  assert.notEqual((await run(twice, [['press', 'Escape'], ['press', 'Escape']])).status, 'verified_complete', 'another key twice is not Tab twice');

  const typeAndTab = 'Type "hello" in the text field and press Tab';
  const typedOnly = await run(typeAndTab, [['fill', 'hello']]);
  assert.notEqual(typedOnly.status, 'verified_complete', 'typing without the key press is not done');
  assert.match(typedOnly.reason, /press Tab/);
  const both = await run(typeAndTab, [['fill', 'hello'], ['press', 'Tab']]);
  assert.equal(both.status, 'verified_complete');
  assert.deepEqual(both.ops, ['fill', 'press']);

  // Seen in the probe: pressing Enter was never required when only typing happened.
  const enterMissing = await run('Type "hello" in the text field and press Enter.', [['fill', 'hello']]);
  assert.notEqual(enterMissing.status, 'verified_complete', 'typing alone is not "press Enter"');
  assert.match(enterMissing.reason, /Enter/);

  // No key named: nothing extra is asked for.
  assert.equal((await run('Type "hello" in the text field.', [['fill', 'hello']])).status, 'verified_complete');
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close();
}
console.log('key press evidence: PASS');
