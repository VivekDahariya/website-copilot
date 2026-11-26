// Runs that start without a URL: the run finds and opens the site itself.
// Regression for a real run: discovery landed directly on the requested
// "Installation | Playwright" page, yet the agent wandered and the run was
// reported as planning_stagnation. Also covers "open the X page" evidence
// and a run-report rejection caused by a step that has no control name.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runAgent } from '../src/agent/agent.js';
import {
  DIRECT_INSTRUCTION_GOAL, verifyDirectCompletion, requestedPages
} from '../src/agent/direct-instruction.js';
import { buildRunFacts, findContradiction } from '../src/ui/run-explanation.js';

const browser = await chromium.launch({headless:true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM}:{}),
  args:['--no-sandbox']});
let passed = 0;
const ok = message => { passed += 1; console.log('PASS:', message); };

const nav = '<nav><a href="/docs/intro">Installation</a> <a href="/community">Community</a> <a href="/">Docs home</a></nav>';
const pages = {
  '/': `<title>Fast and reliable testing | Toolkit</title><h1>Toolkit enables reliable testing</h1>${nav}<p>Read the docs to get started.</p>`,
  '/docs/intro': `<title>Installation | Toolkit</title><h1>Installation</h1>${nav}<p>Toolkit docs. <a href="#how">How to install Toolkit</a></p><h2 id="how">How to install Toolkit</h2>`,
  '/community': `<title>Welcome | Toolkit</title><h1>Welcome</h1>${nav}<p>Join the community. Docs are linked above.</p>`
};
const context = await browser.newContext();
await context.route('https://toolkit.test/**', route => {
  const body = pages[new URL(route.request().url()).pathname] ?? pages['/'];
  route.fulfill({contentType:'text/html', body:`<!doctype html><html><body>${body}</body></html>`});
});
const link = (obs, label) => obs.actionableElements.find(e => e.label === label);
const instruction = 'Find the official Toolkit documentation website and open its Installation page.';

try {
  // 1. Replay: discovery lands on the requested page. No action is needed.
  {
    const page = await context.newPage(); await page.goto('https://toolkit.test/docs/intro');
    let plannerCalls = 0;
    const result = await runAgent(page, instruction, DIRECT_INSTRUCTION_GOAL, {
      arrivedByDiscovery:true, maxSteps:6,
      reasoner: async (_t, obs) => { plannerCalls += 1;
        return {ref:link(obs,'How to install Toolkit').ref, operation:'click', value:''}; }});
    assert.equal(result.status,'verified_complete',JSON.stringify(result.reason ?? result.status));
    assert.equal(result.steps,0);
    assert.equal(plannerCalls,0,'no model call is needed when the page is already right');
    assert.match(page.url(),/\/docs\/intro$/);
    await page.close();
    ok('discovery already opened the requested page: verified with no wandering');
  }

  // 2. Discovery lands on the home page: a link named "Installation" there
  //    is not the Installation page. The agent must still open it.
  {
    const page = await context.newPage(); await page.goto('https://toolkit.test/');
    const result = await runAgent(page, instruction, DIRECT_INSTRUCTION_GOAL, {
      arrivedByDiscovery:true, maxSteps:6,
      reasoner: async (_t, obs) => /\/docs\/intro$/.test(obs.url)
        ? {ref:'', operation:'done', value:'Installation'}
        : {ref:link(obs,'Installation').ref, operation:'click', value:''}});
    assert.equal(result.status,'verified_complete',JSON.stringify(result.reason ?? result.status));
    assert.deepEqual(result.history.map(e => e.decision.operation),['click']);
    assert.match(page.url(),/\/docs\/intro$/);
    await page.close();
    ok('home page with an "Installation" link is not accepted; the page is opened first');
  }

  // 3. Wrong page that merely links to the right one is never a success.
  {
    const page = await context.newPage(); await page.goto('https://toolkit.test/');
    const result = await runAgent(page, 'Open the Installation page.', DIRECT_INSTRUCTION_GOAL, {
      maxSteps:4,
      reasoner: async (_t, obs) => /\/community$/.test(obs.url)
        ? {ref:'', operation:'done', value:'Installation'}
        : {ref:link(obs,'Community').ref, operation:'click', value:''}});
    assert.notEqual(result.status,'verified_complete');
    assert.match(String(result.reason),/not the installation page/i);
    await page.close();
    ok('clicking a wrong link and claiming done is rejected: the page itself must match');
  }

  // 4. Arrival never completes a task that still needs an action.
  {
    const page = await context.newPage(); await page.goto('https://toolkit.test/docs/intro');
    const result = await runAgent(page,
      'Find the Toolkit documentation website, open its Installation page and click How to install Toolkit.',
      DIRECT_INSTRUCTION_GOAL, {arrivedByDiscovery:true, maxSteps:4,
        reasoner: async (_t, obs, history) => history.length
          ? {ref:'', operation:'done', value:'How to install Toolkit'}
          : {ref:link(obs,'How to install Toolkit').ref, operation:'click', value:''}});
    assert.equal(result.status,'verified_complete',JSON.stringify(result.reason ?? result.status));
    assert.equal(result.history.length,1,'the requested click must actually happen');
    await page.close();
    ok('a requested click is still required after arriving by discovery');
  }

  // 4b. Seen live: "Open Wikipedia and search for Alan Turing" arrived on the
  // Alan Turing article through the run's own web search, then made a
  // pointless click because "search" demanded an action.
  {
    const article = {url:'https://en.wikipedia.org/wiki/Alan_Turing', title:'Alan Turing - Wikipedia',
      headings:['Alan Turing'], visibleBodyText:'Alan Turing was an English mathematician. Wikipedia, the free encyclopedia.',
      actionableElements:[]};
    const home = {url:'https://www.wikipedia.org/', title:'Wikipedia', headings:['Wikipedia'],
      visibleBodyText:'Wikipedia The Free Encyclopedia. Featured: Alan Turing.', actionableElements:[]};
    const check = (instruction, observation, arrivedByDiscovery=true) => verifyDirectCompletion({
      instruction, observation, history:[], preservation:{verified:true}, arrivedByDiscovery}).completed;
    assert.equal(check('Open Wikipedia and search for Alan Turing', article), true);
    assert.equal(check('Open Wikipedia and search for Alan Turing', home), false,
      'a page that only mentions the subject is not the result of the search');
    assert.equal(check('Open Wikipedia and search for Alan Turing', article, false), false,
      'without the run\'s own web search an action is still required');
    assert.equal(check('Open Wikipedia, search for Alan Turing and click Edit', article), false,
      'another requested change still needs its own action');
    assert.equal(check('Open Wikipedia and search for Grace Hopper', article), false);
    ok('a search the run already carried out is accepted on arrival; nothing else is waived');
  }

  // 5. Evidence rules.
  {
    assert.deepEqual(requestedPages('Find the site and open its Installation page.'),[['installation']]);
    assert.deepEqual(requestedPages('Go to the Form Authentication page and log in.'),[['form','authentication']]);
    assert.deepEqual(requestedPages('Open the menu and click Save.'),[]);
    assert.deepEqual(requestedPages('Open GitHub and go to the Explore page'),[['explore']]);
    assert.deepEqual(requestedPages('Open Wikipedia, then open the Contents page.'),[['contents']]);
    assert.deepEqual(requestedPages('Visit the site and click the Pricing page link'),[]);
    const observation = {url:'https://toolkit.test/docs/intro', title:'Installation | Toolkit',
      headings:['Installation'], visibleBodyText:'Toolkit docs. How to install Toolkit', actionableElements:[]};
    const base = {instruction, observation, history:[]};
    assert.equal(verifyDirectCompletion({...base, arrivedByDiscovery:true}).completed,true,
      '"official" needs no page text and "documentation" matches "docs"');
    const typed = verifyDirectCompletion(base);
    assert.equal(typed.completed,false,'without discovery, opening still needs a verified action');
    assert.match(typed.reason,/not opened by any verified browser action/);
    const home = verifyDirectCompletion({...base, arrivedByDiscovery:true, observation:{
      url:'https://toolkit.test/', title:'Fast and reliable testing | Toolkit', headings:['Toolkit enables reliable testing'],
      visibleBodyText:'Read the docs to get started.', actionableElements:[{ref:'e1',tag:'a',label:'Installation'}]}});
    assert.equal(home.completed,false);
    assert.deepEqual(home.evidence.missing,['installation']);
    ok('page identity comes from address, title and headings, not from link text');
  }

  // 6. Run report: a "went back" step has no control name to mention.
  {
    const steps = [
      {operation:'click', label:'Installation', done:true, failed:false},
      {operation:'click', label:'How to install Toolkit', done:true, failed:false},
      {operation:'back', label:'Backtrack to previous page', done:true, failed:false}];
    const run = buildRunFacts({status:'planning_stagnation', reason:'No valid action available during planning.'}, [], steps);
    assert.deepEqual(run.labels,['Installation','How to install Toolkit']);
    const text = {
      whatHappened:"CoPilot clicked 'Installation' and then clicked 'How to install Toolkit' on the website toolkit.test.",
      why:'The run failed because CoPilot could not find a useful next action on the page.',
      whatToTry:'Rephrase the task using the exact names of the buttons or fields as they appear on the page.'};
    assert.equal(findContradiction(run, text), null, 'the real model text is acceptable');
    assert.match(findContradiction(run, {...text,
      whatHappened:'2 or 3 sentences telling what CoPilot did, in order, naming every control exactly as written inside the quotation marks.'}),
      /repeats the writing instructions/);
    ok('report accepts the honest text and refuses an echo of its own instructions');
  }

  console.log(`direct-instruction-discovery: ${passed} groups passed`);
} finally {
  await browser.close();
}
