import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

import {
  createProgressGuard
} from "../src/agent/progress-guard.js";

import {
  createNavigationActionTree,
  createBoundedNavigationBacktracker
} from "../src/agent/navigation-tree.js";

const root="https://example.test/start";
const wrong="https://example.test/wrong";
const correct="https://example.test/correct";

const obs=(url,text="same")=>({
  url,
  title:url,
  headings:["Reference"],
  actionableElements:[],
  visibleBodyText:text
});

const guard=createProgressGuard(root);
const self=createProgressGuard(wrong);

const link={
  ref:"e19",label:"Map",href:wrong
};
const click={
  ref:"e19",operation:"click"
};

assert.equal(
  self.check(obs(wrong,"first"),link,click).allowed,
  true
);

self.recordAttempt(obs(wrong,"first"),link,click);

assert.equal(
  self.check(obs(wrong,"changed"),link,click).reason,
  "repeated_self_navigation"
);

guard.blockNavigation(root,wrong);

assert.equal(
  guard.check(
    obs(root),
    {ref:"e1",label:"Map",href:wrong},
    {ref:"e1",operation:"click"}
  ).reason,
  "previously_abandoned_branch"
);

console.log("PASS: Repeated self-navigation blocked");
console.log("PASS: Abandoned branch blocked");

const backtracker=createBoundedNavigationBacktracker({
  maxBacktracks:2
});

backtracker.record({
  observation:obs(root),
  element:{ref:"e1",label:"Map",href:wrong},
  decision:{ref:"e1",operation:"click"},
  result:{executionCompleted:true},
  actualUrl:wrong
});

backtracker.record({
  observation:obs(wrong),
  element:{ref:"e19",label:"Map",href:wrong},
  decision:{ref:"e19",operation:"click"},
  result:{executionCompleted:true},
  actualUrl:wrong
});

assert.equal(backtracker.getStatus().checkpoints,1);

let current=wrong;
let hops=0;

const returned=await backtracker.attempt({
  url:()=>current,
  goBack:async()=>{
    hops++;
    if(hops===2)current=root;
    return {ok:true};
  }
});

assert.equal(returned.completed,true);
assert.equal(returned.url,root);
assert.equal(hops,2);

console.log("PASS: Two-hop browser history recovery");

const tree=createNavigationActionTree();

tree.record({
  type:"page_observed",title:"Start",url:root
});

tree.record({
  type:"action_selected",operation:"click",
  ref:"e1",targetLabel:"Map",targetIsLink:true
});

tree.record({
  type:"action_executed",executionCompleted:true
});

tree.record({
  type:"page_observed",title:"Map",url:wrong
});

tree.record({
  type:"action_selected",operation:"click",
  ref:"e19",targetLabel:"Map",targetIsLink:true
});

tree.record({
  type:"action_executed",executionCompleted:true
});

tree.record({
  type:"page_observed",title:"Map",url:wrong
});

assert.equal(tree.snapshot().nodes.length,2);
assert.equal(
  tree.snapshot().edges.at(-1).status,
  "no_navigation_change"
);

tree.record({
  type:"navigation_backtracked",url:root
});

tree.record({
  type:"page_observed",title:"Start",url:root
});

tree.record({
  type:"action_selected",operation:"click",
  ref:"e2",targetLabel:"Array",targetIsLink:true
});

tree.record({
  type:"action_executed",executionCompleted:true
});

tree.record({
  type:"page_observed",title:"Array",
  url:correct,goalVerified:true
});

const graph=tree.snapshot();
const start=graph.nodes.find(n=>n.url===root);
const destination=graph.nodes.find(n=>n.url===correct);

assert.equal(graph.nodes.length,3);
assert.equal(destination.parentId,start.id);
assert.equal(destination.verified,true);
assert.equal(
  graph.edges.filter(e=>e.operation==="back").length,
  1
);

const agent=readFileSync("src/agent/agent.js","utf8");

assert.match(agent,/ineffectiveSelfNavigation/);
assert.match(agent,/targetIsLink: Boolean/);
assert.match(agent,/progressGuard\.blockNavigation/);

console.log("PASS: Tree branches after recovery");
console.log("PASS: Normal agent integration");
console.log("PASS: Step 7F.29E new regression");
