// Named-site discovery without a built-in list of brands.
// A site the user only names ("search instagram ...") is found through web
// search. The result registered under exactly that name is chosen, and an
// address that merely imitates the name is never accepted.
import assert from "node:assert/strict";

import {
  inferTargetDomain,
  buildDiscoveryQuery,
  chooseDiscoveryCandidate
} from "../src/agent/website-discovery.js";

const instruction=
  "search instagram, then search exampleuser "+
  "account, then show the browser.";

for (const text of [instruction, "open GitHub", "open YouTube", "open LinkedIn"]) {
  assert.equal(inferTargetDomain(text), null);
}
assert.equal(inferTargetDomain("open docs.github.com"), "docs.github.com");
console.log("PASS: No built-in brand list; explicit addresses still recognised");

const query=buildDiscoveryQuery(instruction);
assert.ok(query);
assert.match(query,/instagram/i);
assert.match(query,/exampleuser/i);
console.log("PASS: Site name and username preserved in discovery query");

const official={
  title:"Instagram account",
  url:"https://www.instagram.com/exampleuser/"
};
const spoof={
  title:"Instagram account",
  url:"https://instagram.com.evil.example/profile"
};
const blog={
  title:"How to search an Instagram account",
  url:"https://socialtips.example/instagram-account-search"
};

assert.equal(
  chooseDiscoveryCandidate([spoof,official],instruction)?.url,
  official.url
);
assert.equal(
  chooseDiscoveryCandidate([blog,spoof,official],instruction)?.url,
  official.url
);
console.log("PASS: Result registered under the named site is selected");
console.log("PASS: Imitating address excluded");

assert.equal(chooseDiscoveryCandidate([spoof],instruction),null);
assert.equal(
  chooseDiscoveryCandidate(
    [{title:"Instagram account login", url:"https://instagram.com.account.example/"}],
    instruction),
  null
);
console.log("PASS: Imitation-only results rejected");

const pick=(text,results)=>chooseDiscoveryCandidate(results,text)?.url ?? null;
assert.equal(
  pick("open YouTube and search for lofi music",[
    {title:"YouTube",url:"https://www.youtube.com/"},
    {title:"YouTube - Wikipedia",url:"https://en.wikipedia.org/wiki/YouTube"}]),
  "https://www.youtube.com/"
);
assert.equal(
  pick("open GitHub",[
    {title:"GitHub: Let's build from here",url:"https://github.com/"},
    {title:"GitHub Docs",url:"https://docs.github.com/"}]),
  "https://github.com/"
);
assert.equal(
  pick("open Wikipedia and find Alan Turing",[
    {title:"Wikipedia",url:"https://www.wikipedia.org/"},
    {title:"Alan Turing - Wikipedia",url:"https://en.wikipedia.org/wiki/Alan_Turing"}]),
  "https://www.wikipedia.org/"
);
console.log("PASS: Named sites are resolved from search results, any site");

// A name nobody on the first results is registered under selects nothing
// by name; two different named sites are ambiguous.
assert.equal(
  pick("open Zentrio",[
    {title:"Zentrio review",url:"https://reviews.example/zentrio"}]),
  null
);
assert.equal(
  pick("compare amazon and flipkart prices",[
    {title:"Amazon",url:"https://www.amazon.in/"},
    {title:"Flipkart",url:"https://www.flipkart.com/"}]),
  null
);
// A name that is only the topic of the request does not select its site.
assert.equal(
  pick("Find a Playwright automation tutorial",[
    {title:"Playwright Automation Framework: Tutorial | BrowserStack",url:"https://www.browserstack.com/guide/playwright-tutorial"},
    {title:"Auto-waiting | Playwright",url:"https://playwright.dev/docs/actionability"}]),
  "https://www.browserstack.com/guide/playwright-tutorial"
);
assert.equal(
  pick("Find the cheapest laptop on Flipkart",[
    {title:"Laptops - Flipkart",url:"https://www.flipkart.com/laptops"},
    {title:"Cheapest laptop deals",url:"https://deals.example/cheapest-laptop"}]),
  "https://www.flipkart.com/laptops"
);
console.log("PASS: Unknown or ambiguous names are not guessed");

console.log(
  "PASS: Step 7F.36B named-site discovery regression"
);
