import assert from "node:assert/strict";
import {
  createExplicitTabWorkflow
} from "../src/agent/explicit-tab-workflow.js";
import {
  buildCatalog
} from "../src/agent/local-reasoner.js";

const task =
  'Click the "Click Here" link to open a new browser tab or window. ' +
  'Switch to the newly opened tab and verify that its heading says ' +
  '"New Window". Then switch back to the original tab and leave it ' +
  'active. Keep both tabs open. Do not navigate to any unrelated website.';

const origin = {
  context() {
    return { pages: () => [origin] };
  },
  isClosed() {
    return false;
  }
};

const popup = {
  isClosed() {
    return false;
  }
};

const workflow = createExplicitTabWorkflow(task, origin);

assert.ok(
  workflow,
  "Explicit workflow must recognize 'verify its heading'"
);

console.log("PASS: Real user instruction activates tab workflow");

const observation = {
  actionableElements: [
    {
      ref: "e3",
      label: "Click Here",
      tag: "a",
      role: "link",
      href: "https://the-internet.herokuapp.com/windows/new",
      editable: false,
      type: "",
      checked: false,
      hasValue: false,
      currentValue: ""
    }
  ]
};

const catalog = buildCatalog(
  observation, [], { type: "tab_workflow" }, task
);

assert.ok(
  catalog.some(item =>
    item.ref === "e3" &&
    item.allowedOperations.includes("click")
  ),
  "Related navigation must retain the Click Here action"
);

console.log("PASS: Related navigation remains available");

const trulyInPlace = buildCatalog(
  observation,
  [],
  null,
  "Do not navigate from this page. Read the visible content."
);

assert.equal(
  trulyInPlace.some(item => item.tag === "a"),
  false,
  "Strict no-navigation instruction must still restrict links"
);

console.log("PASS: Strict no-navigation restriction preserved");

assert.equal(workflow.registerSourcePopup(popup), true);

const resolveTab = ref => (
  ref === "tab_2" ? popup : origin
);

const wrongObservation = {
  availableTabs: [
    { ref: "tab_1", active: false },
    { ref: "tab_2", active: true }
  ],
  headings: ["Wrong Heading"],
  url: "https://the-internet.herokuapp.com/windows/new",
  title: "Wrong Heading"
};

workflow.observe(
  popup,
  wrongObservation,
  { completed: false },
  resolveTab
);

assert.equal(workflow.evidence().observedHeading, null);
assert.equal(workflow.nextAction(popup), null);

console.log("PASS: Wrong heading cannot satisfy verification");

workflow.observe(
  popup,
  {
    ...wrongObservation,
    headings: ["New Window"],
    title: "New Window"
  },
  { completed: false },
  resolveTab
);

assert.equal(
  workflow.evidence().observedHeading,
  "New Window"
);

assert.deepEqual(workflow.nextAction(popup), {
  ref: "tab_1",
  operation: "switch_tab",
  value: ""
});

console.log("PASS: Exact heading permits return to original tab");
