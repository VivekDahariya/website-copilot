import assert from 'node:assert/strict';
import { verifyDirectCompletion } from '../src/agent/direct-instruction.js';

// The words of an instruction that describe HOW to get somewhere or WHAT to
// check ("through", "explains") are not text the page has to print. The words
// that name the destination or the thing to find still are.
const securityPage = {
  url: 'https://site.test/help/security', title: 'Security Guide - Help Center',
  headings: ['Security Guide'],
  visibleBodyText: 'Enable two-factor authentication to protect your account.',
  actionableElements: []
};
const helpPage = {
  url: 'https://site.test/help', title: 'Help Center', headings: ['Help Center'],
  visibleBodyText: 'Help Center Security Guide Billing',
  actionableElements: [{ ref: 'e2', tag: 'a', label: 'Security Guide' }]
};
const clicked = (label, from, to) => ({
  decision: { ref: 'e1', operation: 'click' }, targetLabel: label,
  execution: { executionCompleted: true, previousUrl: from, urlAfter: to }
});
const toHelp = clicked('Help Center', 'https://site.test/', 'https://site.test/help');
const toGuide = clicked('Security Guide', 'https://site.test/help', 'https://site.test/help/security');
const ask = 'Open https://site.test/, find the Security Guide through the Help Center, ' +
  'and verify that it explains two-factor authentication.';
const check = (instruction, observation, history) => verifyDirectCompletion({
  instruction, observation, history, preservation: { verified: true }
});

// 1. The right page, reached by the stated route, is complete.
assert.equal(check(ask, securityPage, [toHelp, toGuide]).completed, true);

// 2. The wrong page is still rejected, and for the content, not the phrasing.
const onHelp = check(ask, helpPage, [toHelp]);
assert.equal(onHelp.completed, false);
assert.match(onHelp.reason, /factor/);
assert.match(onHelp.reason, /authentication/);
assert.doesNotMatch(onHelp.reason, /through|explains/);

// 3. Dropping these words must not weaken content words. "news" must not be
//    mistaken for the listed word "new" through stemming.
const home = { url: 'https://site.test/', title: 'Home', headings: ['Home'],
  visibleBodyText: 'Welcome to Acme', actionableElements: [] };
assert.equal(check('Open the news page', home, []).completed, false);
assert.match(check('Open the news page', home, []).reason, /news/);

// 4. A destination named after a preposition-led phrase still has to exist.
const careers = check('Open the Careers page through the footer', home, []);
assert.equal(careers.completed, false);
assert.match(careers.reason, /careers/i);

// 5. Other forms of the reading verbs are not required on the page either.
for (const verb of ['describes', 'shows', 'mentions', 'confirms']) {
  const r = check(`Open https://site.test/, find the Security Guide, and verify that it ${verb} two-factor authentication.`,
    securityPage, [toHelp, toGuide]);
  assert.equal(r.completed, true, verb);
}
console.log('direct instruction wording: PASS');
