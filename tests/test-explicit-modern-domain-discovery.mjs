import assert from 'node:assert/strict';
import { inferTargetDomain, buildDiscoveryQuery, chooseDiscoveryCandidate, discoverWebsite } from '../src/agent/website-discovery.js';

const cases = [
  ['Open docs.playwright.dev', 'docs.playwright.dev'],
  ['Visit studio.example.ai for documentation', 'studio.example.ai'],
  ['Open portal.example.app now', 'portal.example.app'],
  ['Read the guidance at university.example.edu', 'university.example.edu'],
  ['Visit example.gov official website', 'example.gov'],
  ['Open developer.example.co.uk', 'developer.example.co.uk'],
  ['Open developer.example.com.au', 'developer.example.com.au'],
  ['Open developer.example.org.uk', 'developer.example.org.uk'],
  ['Open university.example.ac.uk', 'university.example.ac.uk'],
  ['Navigate to https://docs.example.com/path', 'docs.example.com']
];
for (const [task, host] of cases) {
  assert.equal(inferTargetDomain(task), host, task);
  assert.match(buildDiscoveryQuery(task), new RegExp('site:' + host.replace(/\./g,'\\.')));
}
assert.equal(inferTargetDomain('Open docs.example.com.attacker.invalid'), null,
  'Do not truncate unrecognized hostname suffixes to a misleading valid prefix');
assert.equal(inferTargetDomain('Open docs.example.dev.attacker.invalid'), null);
// A site that is only named has no built-in address; it is found by search.
assert.equal(inferTargetDomain('Show the GitHub homepage'), null);
assert.equal(buildDiscoveryQuery('Find docs.playwright.dev using my password'), null);
console.log('PASS: Modern and multi-label TLDs preserve exact host; suffix spoof, known-site and private-query rules unchanged');

const host = 'docs.playwright.dev';
const mockPage = {
  seen: [], current: 'about:blank',
  async goto(url) { this.seen.push(url); this.current=url; },
  url() { return this.current; },
  async title() {return 'Playwright Docs';},
  locator(selector) {
    assert.equal(selector,'body');
    return {innerText: async () => 'Verified public documentation with enough readable content to satisfy the existing identity check.'};
  }
};
const result=await discoverWebsite(mockPage, 'Open docs.playwright.dev for instructions');
assert.equal(result.status,'found',JSON.stringify(result));
assert.equal(result.discoveryMethod,'direct_domain');
assert.deepEqual(mockPage.seen,['https://' + host + '/']);
console.log('PASS: Explicit .dev hostname uses direct domain navigation, not search results');

const redirectPage={...mockPage, seen:[], async goto(url){this.seen.push(url);this.current='https://docs.playwright.dev.attacker.invalid/';}};
const unsafe=await discoverWebsite(redirectPage,'Open docs.playwright.dev');
assert.equal(unsafe.status,'needs_clarification');
assert.equal(redirectPage.seen.length,1);
console.log('PASS: Redirect to lookalike host fails closed');

const searchResults = [
  {url:'https://docs.playwright.dev.attacker.invalid/',title:'Official Playwright docs'},
  {url:'https://docs.playwright.dev/guide',title:'Playwright docs'}
];
assert.equal(chooseDiscoveryCandidate(searchResults,'Read docs.playwright.dev')?.url,'https://docs.playwright.dev/guide');
console.log('PASS: Search candidates must still match exact requested domain');
