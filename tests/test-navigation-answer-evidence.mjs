import assert from 'node:assert/strict';
import { navigationPartOf, isNavigationThenReadingTask, hasReadableSubstance } from '../src/agent/webpage-answer.js';
import { verifyDirectCompletion } from '../src/agent/direct-instruction.js';
import { sequencedTargets, unmetSteps } from '../src/agent/instruction-steps.js';

// 1. Splitting: only the part that asks the browser to go somewhere.
assert.equal(navigationPartOf('Open the About page and tell me which city the company was founded in.').trim(),
  'Open the About page');
assert.equal(navigationPartOf('Open the Products page, open Gadget, and tell me its price.').trim(),
  'Open the Products page, open Gadget,');
assert.equal(navigationPartOf('Open the About page.'), 'Open the About page.');
assert.equal(navigationPartOf('Who founded the company?'), 'Who founded the company?');
// not a navigation-then-reading task (it writes): returned unchanged
const writes = 'Fill the form and then tell me the result.';
assert.equal(isNavigationThenReadingTask(writes), false);
assert.equal(navigationPartOf(writes), writes);
const submits = 'Open the contact page, submit the form and then tell me what it says.';
assert.equal(navigationPartOf(submits), submits);

// 2. The verifier: question words need not be printed on the page.
const about = {url:'http://site.test/about', title:'About - Acme', headings:['About Acme'],
  visibleBodyText:'Acme was founded in 1998 in Lisbon by Maria Santos. The team has 42 people.', actionableElements:[]};
const gadget = {url:'http://site.test/products/gadget', title:'Gadget - Acme', headings:['Gadget'],
  visibleBodyText:'The Gadget costs $89 and ships in 5 days.', actionableElements:[]};
const check = (instruction, observation) => verifyDirectCompletion({
  instruction, observation, history:[], preservation:{verified:true}, arrivedByDiscovery:true});

assert.equal(check('Open the About page and tell me which city the company was founded in.', about).completed, true,
  '"city" is the question, not something the page must print');
assert.equal(check('Open the Gadget page and tell me its price.', gadget).completed, true);

// 3. Negatives: the navigation part still needs its evidence.
const wrongPage = check('Open the Pricing page and tell me which city the company was founded in.', about);
assert.equal(wrongPage.completed, false, 'a different page was named');
const missingNav = check('Open the Careers page and tell me the city.', about);
assert.equal(missingNav.completed, false, 'a destination the page does not show is not reached');
// An ordinary instruction (not navigation-then-reading) keeps requiring every word.
const plain = check('Open the About page and click the Subscribe button for the city newsletter.', about);
assert.equal(plain.completed, false);

// 4. "open A page, open B": B is a further step, not a word that is merely on the page.
{
  const names = text => sequencedTargets(text).map(t => `${t.kind}:${t.name.join(' ')}`);
  assert.deepEqual(names('Open the Products page, open Gadget'), ['page:product', 'click:gadget']);
  assert.deepEqual(names('Open the Products page and open Gadget'), ['page:product', 'click:gadget']);
  // a first bare "open NAME" is not read as a step (it may be a site name found by search)
  assert.deepEqual(names('Open Wikipedia and search for Alan Turing'), []);
  // addresses are not link names
  assert.deepEqual(names('Open the Products page, open https://example.com/x'), ['page:product']);
  const obs = {url:'http://x/products', title:'Products - Acme', headings:['Products'],
    visibleBodyText:'Products Widget Gadget', actionableElements:[{ref:'e7',tag:'a',label:'Gadget'}]};
  const clicked = (label, from, to) => ({decision:{ref:'e1',operation:'click'}, targetLabel:label,
    execution:{executionCompleted:true, previousUrl:from, urlAfter:to}});
  const first = [clicked('Products','http://x/','http://x/products')];
  const both = [...first, clicked('Gadget','http://x/products','http://x/products/gadget')];
  const ask = 'Open the Products page, open Gadget, and tell me its price.';
  const onProducts = verifyDirectCompletion({instruction:ask, observation:obs, history:first, preservation:{verified:true}});
  assert.equal(onProducts.completed, false, 'the first step alone is not the task');
  assert.match(onProducts.reason, /Gadget/);
  const gadgetObs = {url:'http://x/products/gadget', title:'Gadget - Acme', headings:['Gadget'],
    visibleBodyText:'The Gadget costs $89.', actionableElements:[]};
  assert.equal(verifyDirectCompletion({instruction:ask, observation:gadgetObs, history:both, preservation:{verified:true}}).completed, true);
  assert.equal(unmetSteps('Open the Products page, open Gadget', both).missing.length, 0);
}

// 5. A short page can hold a real answer; a page with nothing on it cannot.
assert.equal(hasReadableSubstance('Gadget\n\nThe Gadget costs $89 and ships in 5 days.'), true);
assert.equal(hasReadableSubstance('Loading...'), false);
assert.equal(hasReadableSubstance('404 Not Found'), false);
assert.equal(hasReadableSubstance(''), false);
assert.equal(hasReadableSubstance('Page not found. Go back.'), false);

console.log('PASS test-navigation-answer-evidence');
