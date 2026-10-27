import assert from "node:assert/strict";

import {
  createPageState,
  hasPageStateChanged
} from "./src/agent/page-state.js";

const base = {
  url: "https://site.test/profile",
  headings: ["Profile"],
  visibleBodyText: "Edit your profile",
  actionableElements: [
    {
      ref: "e1",
      tag: "input",
      type: "text",
      label: "Full Name",
      currentValue: ""
    }
  ]
};

const identical = structuredClone(base);

assert.equal(
  createPageState(base).fingerprint,
  createPageState(identical).fingerprint
);

const filled = structuredClone(base);

filled.actionableElements[0].currentValue = "Vivek";

assert.equal(
  hasPageStateChanged(base, filled),
  true
);

const differentText = structuredClone(base);

differentText.visibleBodyText = "Profile saved";

assert.equal(
  hasPageStateChanged(base, differentText),
  true
);

const differentUrl = structuredClone(base);

differentUrl.url = "https://site.test/settings";

assert.equal(
  hasPageStateChanged(base, differentUrl),
  true
);

const differentRef = structuredClone(base);

differentRef.actionableElements[0].ref = "e99";

assert.equal(
  hasPageStateChanged(base, differentRef),
  false
);

console.log("PAGE STATE TESTS: 5/5 PASSED");
