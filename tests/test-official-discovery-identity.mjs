import assert from 'node:assert/strict';
import {chooseDiscoveryCandidate, discoverWebsite, buildDiscoveryQuery} from '../src/agent/website-discovery.js';

const task='Find the official documentation website for Playwright browser automation. Navigate to its Auto-waiting documentation page, where actionability checks are explained. Do not stop at search results or the homepage. Finish only when the actual documentation page is open and its heading says Auto-waiting. Do not modify anything.';
const thirdParty={url:'https://www.browserstack.com/guide/playwright-tutorial',title:'Playwright Automation Framework: Tutorial [2026] | BrowserStack'};
const official={url:'https://playwright.dev/docs/actionability',title:'Auto-waiting | Playwright'};

assert.equal(chooseDiscoveryCandidate([thirdParty,official],task)?.url,official.url);
assert.equal(chooseDiscoveryCandidate([thirdParty],task),null);
assert.equal(chooseDiscoveryCandidate([{url:'https://playwright.browserstack.com/docs/actionability',title:'Official Playwright docs'}],task),null);
assert.equal(chooseDiscoveryCandidate([{url:'https://playwright.dev/docs/actionability',title:'Auto-waiting | Playwright'}],task)?.url,official.url);
console.log('PASS: Explicit official request chooses publisher domain, not keyword-stuffed third-party result');

assert.equal(chooseDiscoveryCandidate([thirdParty], 'Find official documentation for Playwright'),null);
assert.equal(chooseDiscoveryCandidate([{url:'https://docs.python.org/3/',title:'Python docs'}],'Find official documentation for Python')?.hostname,'docs.python.org');
assert.equal(chooseDiscoveryCandidate([{url:'https://playwright.dev/',title:'Playwright'}],'Find the official documentation of Playwright')?.hostname,'playwright.dev');
assert.equal(chooseDiscoveryCandidate([thirdParty], 'Find the official documentation website'),null);
assert.equal(chooseDiscoveryCandidate([thirdParty,official], 'Find a Playwright automation tutorial')?.url,thirdParty.url);
assert.match(buildDiscoveryQuery(task),/playwright/);
console.log('PASS: Domain ownership guard applies only to explicit official intent, not general web search');

function mockSearchPage(resultsByProvider, {redirectTo}={}) {
 return {
  seen:[],
  currentUrl:'about:blank',
  url(){return this.currentUrl;},
  async goto(url){
    this.seen.push(url);
    if (/\/search\?q=|duckduckgo\.com\/html\/\?q=/.test(url)) {
      this.currentUrl=url;
    } else {
      this.currentUrl=redirectTo || url;
    }
  },
  async title(){return this.currentUrl.includes('playwright.dev') ? 'Auto-waiting | Playwright' : 'BrowserStack';},
  locator(selector){
    if(selector==='body') return {innerText:async()=> 'This documentation explains browser actionability auto-waiting checks and how the browser automation works correctly.'};
    const provider = this.currentUrl.includes('google.com') ? 'google' :
      this.currentUrl.includes('bing.com') ? 'bing' : 'duckduckgo';
    return {
      first(){return {waitFor:async()=>{}};},
      async evaluateAll(){return resultsByProvider[provider] || [];}
    };
  }
 };
}
const page=mockSearchPage({google:[thirdParty,official]});
const discovered=await discoverWebsite(page,task);
assert.equal(discovered.status,'found',JSON.stringify(discovered));
assert.equal(discovered.url,official.url);
assert.equal(discovered.discoveryMethod,'search_google');
assert(page.seen.some(u=>/official%20documentation/i.test(u)));
assert(!page.seen.some(u=>u === thirdParty.url));
console.log('PASS: End-to-end discovery decision navigates only to official result (simulated search UI)');

const pageOther=mockSearchPage({google:[thirdParty],bing:[thirdParty],duckduckgo:[thirdParty]});
const unresolved=await discoverWebsite(pageOther,task);
assert.equal(unresolved.status,'needs_clarification');
assert(!pageOther.seen.some(u=>u===thirdParty.url));
console.log('PASS: Third-party-only results fail closed without visiting an unrelated website');

const redirectPage=mockSearchPage({google:[official]}, {redirectTo:thirdParty.url});
const redirected=await discoverWebsite(redirectPage,task);
assert.equal(redirected.status,'needs_clarification');
console.log('PASS: Redirect outside selected publisher domain is not accepted');
