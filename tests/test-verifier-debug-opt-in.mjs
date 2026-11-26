import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runAgent } from '../src/agent/agent.js';

const browser = await chromium.launch({
  headless: true,
  ...(process.env.WC_TEST_CHROMIUM ? { executablePath: process.env.WC_TEST_CHROMIUM } : {}),
  args: ['--no-sandbox']
});
const oldSetting = process.env.COPILOT_VERIFIER_DEBUG;
const oldLog = console.log;
const marker = 'EXPECTED_PRIVATE_VALUE_739';
try {
  const page = await browser.newPage();
  async function trial(debugSetting) {
    if (debugSetting === undefined) delete process.env.COPILOT_VERIFIER_DEBUG;
    else process.env.COPILOT_VERIFIER_DEBUG = debugSetting;
    await page.setContent(`<title>Verifier debug privacy</title><button id="reveal" onclick="document.getElementById('result').textContent='${marker}'">Reveal result</button><div id="result"></div>`);
    const logs=[];
    let actions=0;
    console.log = (...args) => { logs.push(args.map(a=>String(a)).join(' ')); };
    let result;
    try {
      result = await runAgent(page, 'Click Reveal result to finish.',
        { type:'visible_content', text: marker },
        { maxSteps: 3, reasoner: async (_task, observation) => {
          const target=observation.actionableElements.find(e=>e.label==='Reveal result');
          assert.ok(target);
          actions++;
          return { ref:target.ref, operation:'click', value:'' };
        } });
    } finally {
      console.log=oldLog;
    }
    assert.equal(result.status,'verified_complete');
    assert.equal(actions,1);
    assert.equal(result.history.filter(e=>e.execution?.executionCompleted).length,1);
    return logs.join('\n');
  }
  const normal = await trial(undefined);
  assert.equal(normal.includes('[68P VERIFIER DEBUG]'), false, 'Verifier debug should default off');
  assert.equal(normal.includes(marker), false, 'Expected form/page values must not leak in routine logs');
  console.log('PASS: No raw goal values or verbose verifier JSON in default logs; independent goal still verified');
  const enabled = await trial('1');
  assert.equal(enabled.includes('[68P VERIFIER DEBUG]'), true, 'Explicit verifier debugging must remain available');
  assert.equal(enabled.includes(marker), true, 'Opt-in diagnostic still shows full context');
  console.log('PASS: Explicit COPILOT_VERIFIER_DEBUG=1 restores diagnostic; browser behavior remains identical');
} finally {
  console.log=oldLog;
  if (oldSetting===undefined) delete process.env.COPILOT_VERIFIER_DEBUG;
  else process.env.COPILOT_VERIFIER_DEBUG=oldSetting;
  await browser.close();
}
