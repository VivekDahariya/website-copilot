import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";

import {
  createNavigationActionTree,
  createBoundedNavigationBacktracker
} from "../src/agent/navigation-tree.js";

const tree=createNavigationActionTree();

tree.record({
  type:"page_observed",
  title:"Starting page",
  url:"https://example.test/"
});

tree.record({
  type:"action_selected",
  operation:"click",
  ref:"e7",
  targetLabel:"First option"
});

tree.record({
  type:"action_executed",
  executionCompleted:true,
  verified:false
});

tree.record({
  type:"page_observed",
  title:"Wrong branch",
  url:"https://example.test/wrong"
});

tree.record({
  type:"navigation_backtracked",
  fromUrl:"https://example.test/wrong",
  url:"https://example.test/"
});

tree.record({
  type:"action_selected",
  operation:"click",
  ref:"e9",
  targetLabel:"Second option"
});

tree.record({
  type:"action_executed",
  executionCompleted:true,
  verified:false
});

tree.record({
  type:"page_observed",
  title:"Target",
  url:"https://example.test/target",
  goalVerified:true
});

tree.record({
  type:"goal_verified",
  url:"https://example.test/target"
});

const graph=tree.snapshot();

assert.equal(graph.nodes.length,3);
assert.equal(graph.edges.length,3);
assert.equal(graph.edges[1].operation,"back");
assert.equal(graph.nodes[2].verified,true);
assert.equal(graph.edges[2].from,graph.nodes[0].id);

console.log("PASS: Branches and backtracking represented");

const from="https://example.test/";
const to="https://example.test/docs";

const backtracker=createBoundedNavigationBacktracker({
  maxBacktracks:2
});

backtracker.record({
  observation:{url:from},
  element:{ref:"e1",label:"Documentation",href:to},
  decision:{ref:"e1",operation:"click"},
  result:{executionCompleted:true},
  actualUrl:to
});

let current=to;

const recovery=await backtracker.attempt({
  url:()=>current,
  goBack:async()=>{
    current=from;
    return {url:from};
  }
});

assert.equal(recovery.completed,true);
assert.equal(recovery.url,from);
assert.equal(backtracker.getStatus().backtracks,1);

console.log("PASS: Bounded navigation backtracking");

const unsafe=createBoundedNavigationBacktracker();

unsafe.record({
  observation:{url:from},
  element:{
    ref:"e5",
    label:"Checkout",
    href:"https://example.test/checkout"
  },
  decision:{operation:"click",ref:"e5"},
  result:{executionCompleted:true},
  actualUrl:"https://example.test/checkout"
});

assert.equal(unsafe.getStatus().checkpoints,0);

const crossOrigin=createBoundedNavigationBacktracker();

crossOrigin.record({
  observation:{url:from},
  element:{
    ref:"e3",
    label:"External",
    href:"https://other.test/docs"
  },
  decision:{operation:"click",ref:"e3"},
  result:{executionCompleted:true},
  actualUrl:"https://other.test/docs"
});

assert.equal(crossOrigin.getStatus().checkpoints,0);

console.log("PASS: Unsafe and cross-origin paths excluded");

// A field handed to the person is one step, not a fill that never happened.
{
  const handed=createNavigationActionTree();
  handed.record({type:"page_observed",title:"Login",url:"https://example.test/login"});
  handed.record({type:"action_selected",operation:"fill",ref:"e3",targetLabel:"Username"});
  handed.record({type:"action_executed",executionCompleted:true,verified:true});
  handed.record({type:"page_observed",title:"Login",url:"https://example.test/login"});
  handed.record({type:"action_selected",operation:"fill",ref:"e4",targetLabel:"Password"});
  handed.record({type:"action_selected",operation:"human_handover",ref:"e4",targetLabel:"Password"});
  handed.record({type:"action_executed",executionCompleted:true,verified:true});
  const edges=handed.snapshot().edges;
  assert.deepEqual(edges.map(e=>e.operation),["fill","human_handover"]);
  assert.ok(edges.every(e=>e.status!=="not_executed"&&e.status!=="selected"));
  assert.equal(new Set(edges.map(e=>e.id)).size,edges.length);
}
console.log("PASS: A handed-over field is not shown as a failed fill");

const html=readFileSync("src/ui/index.html","utf8");
const server=readFileSync("src/ui/server.js","utf8");
const agent=readFileSync("src/agent/agent.js","utf8");

for(const id of [
  "visualizeActionsBtn",
  "actionTreePanel",
  "actionTreeContent"
]){
  assert.ok(html.includes('id="'+id+'"'));
}

assert.match(html,/function renderActionTree\(state\)/);
assert.match(server,/navigationActionTree\.record\(event\)/);
assert.match(agent,/attemptTreeBacktrack\(step\)/);

for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))
  new Script(match[1]);

console.log("PASS: UI and integration checks");
console.log("PASS: Step 7F.26B tree regressions");
