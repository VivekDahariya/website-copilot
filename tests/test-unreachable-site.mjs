// An address that cannot be opened (no such site, connection refused or dropped)
// used to end as "Task needs clarification: provide the exact URL", although the
// user had given one. Now the run says why the address could not be opened, with
// its own status, and does nothing else. Real browser, local servers.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { chromium } from 'playwright';
import { describeUnreachableSite } from '../src/browser/unreachable-site.js';
import { discoverWebsite, inferTargetDomain } from '../src/agent/website-discovery.js';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;
const realLog = console.log;
let passed = 0;
const ok = name => { passed += 1; realLog(`PASS: ${name}`); };

// The sentences.
const sentence = (code, url = 'https://shop.example.test/') => describeUnreachableSite(new Error(`page.goto: net::${code} at ${url}`), url);
assert.match(sentence('ERR_NAME_NOT_RESOLVED'), /^shop\.example\.test could not be opened: the address does not exist/);
assert.match(sentence('ERR_CONNECTION_REFUSED'), /refused the connection/);
assert.match(sentence('ERR_EMPTY_RESPONSE'), /closed the connection without answering/);
assert.match(sentence('ERR_CONNECTION_RESET'), /closed the connection/);
assert.match(sentence('ERR_INTERNET_DISCONNECTED'), /no working internet connection/);
assert.match(sentence('ERR_CERT_AUTHORITY_INVALID'), /certificate/);
assert.match(describeUnreachableSite(new Error('page.goto: Timeout 30000ms exceeded.'), 'https://a.test/'), /did not answer in time/);
assert.match(describeUnreachableSite(new Error('something odd'), 'not a url'), /^the website could not be opened: it could not be reached/);
for (const value of [undefined, null, {a: 1}, 'x']) assert.ok(!describeUnreachableSite(value, '').includes('[object Object]'));
ok('the causes are named in plain words');

// A full address is the user's destination whatever its ending; prose is not.
assert.equal(inferTargetDomain('Open https://stripe.co/pricing and click Home'), 'stripe.co');
assert.equal(inferTargetDomain('Open https://this-site-does-not-exist-wcp.invalid and click Home'), 'this-site-does-not-exist-wcp.invalid');
assert.equal(inferTargetDomain('Open http://127.0.0.1:5000/x and click Home.'), '127.0.0.1');
assert.equal(inferTargetDomain('Open http://localhost:3000, then click Home'), 'localhost');
assert.equal(inferTargetDomain('Compare github.com with https://shop.xyz/'), 'github.com', 'the first plain match still wins');
assert.equal(inferTargetDomain('Open https://docs.github.com/en'), 'docs.github.com', 'known endings are unchanged');
assert.equal(inferTargetDomain('Open docs.example.com.attacker.invalid'), null, 'no scheme, no explicit site');
assert.equal(inferTargetDomain('Open example.zzz and click Home'), null);
assert.equal(inferTargetDomain('Show the GitHub homepage'), null);
assert.equal(inferTargetDomain('Open https:// and click Home'), null);
ok('a full address with any ending is the destination; plain words are not');

// Real addresses: a closed port and a server that hangs up.
const free = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); });
const dropper = http.createServer((q, r) => q.socket.destroy());
await new Promise(done => dropper.listen(0, '127.0.0.1', done));
const dropPort = dropper.address().port;
const healthy = http.createServer((q, r) => { r.writeHead(200, {'content-type': 'text/html'}); r.end('<title>Local site</title><h1>Local site</h1><p>This page has enough readable text to count as a real, reachable website.</p>'); });
await new Promise(done => healthy.listen(0, '127.0.0.1', done));
const healthyPort = healthy.address().port;
const browser = await chromium.launch({headless: true});
try {
  const page = await (await browser.newContext()).newPage();

  const refused = await discoverWebsite(page, `Open http://127.0.0.1:${free}/ and click Home`);
  assert.equal(refused.status, 'site_unreachable');
  assert.match(refused.reason, new RegExp(`^127\\.0\\.0\\.1:${free} could not be opened: it refused the connection`));
  assert.ok(!/exact URL/i.test(refused.reason), 'it does not ask for a URL the user already gave');
  ok('a refused connection is reported as such');

  const dropped = await discoverWebsite(page, `Open http://127.0.0.1:${dropPort}/ and click Home`);
  assert.equal(dropped.status, 'site_unreachable');
  assert.match(dropped.reason, /closed the connection without answering/);
  ok('a dropped connection is reported as such');

  // A fresh tab: after a dropped connection a tab sits on Chrome's error page.
  const freshTab = await (await browser.newContext()).newPage();
  const found = await discoverWebsite(freshTab, `Open http://127.0.0.1:${healthyPort}/ and click Home`);
  assert.equal(found.status, 'found', JSON.stringify(found));
  assert.equal(new URL(found.url).port, String(healthyPort));
  ok('a reachable address with an unlisted ending is opened as given');

  const lastTab = await (await browser.newContext()).newPage();
  console.log = () => {};
  let result;
  try { result = await executeNaturalLanguageTask(lastTab, `Open http://127.0.0.1:${free}/ and click Home`, {urlLess: true}); }
  finally { console.log = realLog; }
  assert.equal(result.status, 'site_unreachable');
  assert.equal(result.executed, false);
  assert.match(result.reason, /refused the connection/);
  ok('the run ends with its own status and does nothing else');
} finally {
  await browser.close(); dropper.close(); healthy.close();
}
realLog(`unreachable-site: ${passed} groups passed`);
