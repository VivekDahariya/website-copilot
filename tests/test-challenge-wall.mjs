import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { observePage } from '../src/observer/dom-observer.js';
import { detectChallenge } from '../src/agent/challenge-wall.js';
import { runAgent } from '../src/agent/agent.js';
import { DIRECT_INSTRUCTION_GOAL } from '../src/agent/direct-instruction.js';
import { createConversationalApprovalProvider } from '../src/agent/conversational-approval.js';

// Stand-ins for the standard provider frames. The detector sees the same
// frame URLs it would see on a real site; nothing here reaches the internet.
const FRAME_BODY = '<html><body><div style="width:300px;height:70px;border:1px solid #888">I am not a robot</div></body></html>';
const frame = (src, w = 304, h = 78) => `<iframe title="challenge" src="${src}" width="${w}" height="${h}"></iframe>`;
const RECAPTCHA = 'https://www.google.com/recaptcha/api2/anchor?k=test&size=normal';
const INVISIBLE = 'https://www.google.com/recaptcha/api2/anchor?k=test&size=invisible';
const TURNSTILE = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/0x4/light/fbE/new/normal/auto/';

const pages = {
  article: `<title>How CAPTCHAs verify you are human</title><h1>How CAPTCHAs work</h1>
    <p>${'A CAPTCHA asks you to verify you are human. Providers such as reCAPTCHA, hCaptcha and Turnstile do this. '.repeat(30)}</p>
    ${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `<a href="/p${n}">Related article ${n}</a>`).join(' ')}`,
  loginHelp: `<title>Sign in</title><h1>Sign in</h1>
    <label>Email <input aria-label="Email" type="email"></label>
    <label>Name <input aria-label="Name"></label>
    <button type="submit">Continue</button>
    <p>If you ever see a CAPTCHA, just complete it and try again.</p>`,
  widgetForm: `<title>Enquiry</title><h1>Enquiry</h1>
    <form id="f"><label>Name <input aria-label="Name" name="name"></label>
    ${frame(RECAPTCHA)}
    <textarea name="g-recaptcha-response" style="display:none"></textarea>
    <button type="submit">Continue</button></form>
    <p id="result" style="display:none">Form submitted</p>
    <script>
      document.getElementById('f').onsubmit = e => { e.preventDefault();
        window.__submitted = true;
        document.getElementById('result').style.display = 'block'; };
    </script>`,
  plainForm: `<title>Enquiry</title><h1>Enquiry</h1>
    <form id="f"><label>Name <input aria-label="Name" name="name"></label>
    <button type="submit">Continue</button></form>
    <p id="result" style="display:none">Form submitted</p>
    <script>
      document.getElementById('f').onsubmit = e => { e.preventDefault();
        window.__submitted = true;
        document.getElementById('result').style.display = 'block'; };
    </script>`,
  invisibleBadge: `<title>Contact</title><h1>Contact</h1>
    <label>Name <input aria-label="Name"></label>${frame(INVISIBLE, 256, 60)}
    <button type="submit">Continue</button>`,
  wall: `<title>Just a moment...</title><h1>Checking your browser</h1>
    ${frame(TURNSTILE, 300, 65)}<input type="hidden" name="cf-turnstile-response" value="">`,
  titleOnlyWall: `<title>Attention Required! | Cloudflare</title><h1>Please verify you are human</h1>
    <p>Complete the check to continue.</p>`,
  busyJustAMoment: `<title>Just a moment - travel notes</title><h1>Travel notes</h1>
    <p>${'Photographs and stories from a long journey. '.repeat(40)}</p>
    ${[1, 2, 3, 4, 5, 6].map(n => `<a href="/n${n}">Note ${n}</a>`).join(' ')}`
};

const HOST = 'https://wall-lab.example';
const browser = await chromium.launch({ headless: true });
try {
  async function open(name) {
    const page = await browser.newPage();
    await page.route('https://www.google.com/recaptcha/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: FRAME_BODY }));
    await page.route('https://challenges.cloudflare.com/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: FRAME_BODY }));
    await page.route(`${HOST}/**`, r => r.fulfill({ status: 200, contentType: 'text/html', body: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${pages[name]}</body></html>` }));
    await page.goto(`${HOST}/${name}`);
    await page.waitForTimeout(300);
    return page;
  }
  const kindOf = async name => {
    const page = await open(name);
    const kind = (await detectChallenge(page, await observePage(page))).kind;
    await page.close();
    return kind;
  };

  // 1. Not needed: no handover for pages that only talk about CAPTCHAs.
  assert.equal(await kindOf('article'), null, 'an article about CAPTCHAs is not a wall');
  assert.equal(await kindOf('loginHelp'), null, 'help text that mentions a CAPTCHA is not a wall');
  assert.equal(await kindOf('invisibleBadge'), null, 'an invisible challenge asks nothing of a person');
  assert.equal(await kindOf('plainForm'), null);
  assert.equal(await kindOf('busyJustAMoment'), null, 'a content-rich page with a similar title is not a wall');

  // 2. Needed: a real challenge, in both of its forms.
  assert.equal(await kindOf('wall'), 'interstitial');
  assert.equal(await kindOf('titleOnlyWall'), 'interstitial');
  assert.equal(await kindOf('widgetForm'), 'widget');
  {
    const page = await open('widgetForm');
    await page.evaluate(() => { document.querySelector('textarea[name="g-recaptcha-response"]').value = 'solved-token'; });
    assert.equal((await detectChallenge(page, await observePage(page))).kind, null, 'a solved challenge needs no one');
    await page.close();
  }

  // 3. In the agent: the person is asked just before the submit, not earlier.
  const instruction = 'Type Alice in the Name field and click Continue.';
  async function run(name, { provider, solve = true } = {}) {
    const page = await open(name);
    const seen = { providerCalls: 0, submittedAtHandover: null, handover: null, reasonerCallsAtHandover: null };
    let reasonerCalls = 0;
    const reasoner = async (task, observation) => {
      reasonerCalls++;
      const text = String(observation.visibleBodyText ?? '');
      if (/Form submitted/.test(text)) return { ref: '', operation: 'done', value: '' };
      const nameField = observation.actionableElements.find(e => e.label === 'Name');
      if (nameField && !nameField.currentValue) return { ref: nameField.ref, operation: 'fill', value: 'Alice' };
      const go = observation.actionableElements.find(e => e.label === 'Continue');
      return { ref: go.ref, operation: 'click', value: '' };
    };
    const humanHandoverProvider = provider === false ? undefined : async ({ handover }) => {
      seen.providerCalls++;
      seen.handover = handover;
      seen.reasonerCallsAtHandover = reasonerCalls;
      seen.submittedAtHandover = await page.evaluate(() => window.__submitted === true);
      if (solve) await page.evaluate(() => {
        const field = document.querySelector('textarea[name="g-recaptcha-response"]');
        if (field) field.value = 'solved-token';
      });
      return { completed: true };
    };
    const result = await runAgent(page, instruction, DIRECT_INSTRUCTION_GOAL, {
      reasoner, humanHandoverProvider, originalInstruction: instruction, maxSteps: 10,
      // A form submit is consequential and goes through the real approval gate.
      approvalProvider: createConversationalApprovalProvider({
        requestUser: async () => ({ optionId: 'approve' })
      })
    });
    const submitted = await page.evaluate(() => window.__submitted === true);
    await page.close();
    return { result, seen, submitted, reasonerCalls };
  }

  const solved = await run('widgetForm', { provider: true });
  assert.equal(solved.seen.providerCalls, 1, 'asked once');
  assert.equal(solved.seen.handover.field.type, 'captcha');
  assert.equal(solved.seen.submittedAtHandover, false, 'asked BEFORE the form was submitted');
  assert.ok(solved.seen.reasonerCallsAtHandover >= 2, 'the form was filled first: reading and filling need no person');
  assert.equal(solved.submitted, true, 'after the person solved it, the agent submitted');

  const plain = await run('plainForm', { provider: true });
  assert.equal(plain.seen.providerCalls, 0, 'a form without a challenge never asks');
  assert.equal(plain.submitted, true);

  const noProvider = await run('widgetForm', { provider: false });
  assert.equal(noProvider.result.status, 'human_handover_required');
  assert.equal(noProvider.result.handover.field.type, 'captcha');
  assert.equal(noProvider.submitted, false, 'never submitted past an unsolved challenge');

  const notSolved = await run('widgetForm', { provider: true, solve: false });
  assert.equal(notSolved.result.status, 'human_handover_unverified', 'still there after the manual step: stop');
  assert.equal(notSolved.seen.providerCalls, 1, 'does not ask again and again');
  assert.equal(notSolved.submitted, false);

  const wall = await run('wall', { provider: true, solve: false });
  assert.equal(wall.seen.providerCalls, 1);
  assert.equal(wall.seen.reasonerCallsAtHandover, 0, 'a wall is handed over before any planning');
} finally {
  await browser.close();
}
console.log('challenge wall: PASS');
