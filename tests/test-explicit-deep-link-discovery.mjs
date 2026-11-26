import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { discoverWebsite } from '../src/agent/website-discovery.js';

const browser = await chromium.launch({headless:true, executablePath: process.env.WC_TEST_CHROMIUM || undefined});
try {
  const context = await browser.newContext();
  const browserPage = await context.newPage();
  const visits=[];
  let current='about:blank';
  const page = {
    async goto(url) {
      visits.push(url);
      current = url;
      const pathname = new URL(url).pathname;
      if(pathname === '/redirect') current='https://attacker.example.com/fake';
      await browserPage.setContent(`<html><title>Playwright Docs</title><body><h1>Documentation ${pathname}</h1><p>This is real browser-rendered page content with adequate text to pass the identity check.</p></body></html>`);
    },
    url() { return current; },
    async title() { return browserPage.title(); },
    locator(selector) { return browserPage.locator(selector); }
  };

  const instruction='Open https://docs.playwright.dev/docs/intro?view=quick#install and read the documentation';
  const result=await discoverWebsite(page,instruction);
  assert.equal(result.status,'found',JSON.stringify(result));
  assert.equal(new URL(page.url()).pathname, '/docs/intro','Preserve expressly requested document path');
  assert.equal(new URL(page.url()).search,'?view=quick','Preserve requested deep-link query');
  assert.equal(new URL(page.url()).hash,'#install','Preserve requested anchor');
  assert.ok(!visits.includes('https://docs.playwright.dev/'),'Do not silently navigate to homepage first');
  console.log('PASS: Real Chromium direct URL discovery retains path, query and fragment without unnecessary homepage navigation');

  visits.length=0;
  const bare=await discoverWebsite(page,'Open docs.playwright.dev for reference');
  assert.equal(bare.status,'found',JSON.stringify(bare));
  assert.deepEqual(visits,['https://docs.playwright.dev/']);
  console.log('PASS: Bare domain discovery retains existing homepage behavior');

  visits.length=0;
  const quoted=await discoverWebsite(page,'Read (https://docs.playwright.dev/docs/api).');
  assert.equal(quoted.status,'found',JSON.stringify(quoted));
  assert.equal(new URL(page.url()).pathname,'/docs/api');
  console.log('PASS: Common adjacent punctuation does not corrupt requested path');

  visits.length=0;
  const unsafe=await discoverWebsite(page,'Open https://docs.playwright.dev/redirect');
  assert.equal(unsafe.status,'needs_clarification');
  assert.equal(new URL(page.url()).hostname,'attacker.example.com');
  console.log('PASS: Redirect to unrelated host remains rejected');
  await context.close();
} finally {await browser.close();}
