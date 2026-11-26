import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";
import {chromium} from "playwright";

import {
  collectRunExplanationEvidence,
  explainRecordedRun
} from "../src/ui/run-explanation.js";

const state={
  phase:"finished",
  url:"https://developer.mozilla.org/en-US/?token=private",
  result:{status:"verified_complete",reason:null},
  activity:[
    {text:"Ollama planning · attempt 1"},
    {text:"Goal verified against current browser state."},
    {text:"password=secret-value"}
  ],
  actionTree:{
    nodes:[
      {id:"p1",title:"MDN Web Docs"},
      {id:"p2",title:"Array.prototype.map()"}
    ],
    edges:[{
      id:"a1",from:"p1",to:"p2",
      operation:"click",label:"JavaScript",
      status:"goal_verified"
    }]
  }
};

const evidence=collectRunExplanationEvidence(state);

assert.equal(evidence.status,"verified_complete");
assert.equal(evidence.actions.length,1);
assert.ok(!JSON.stringify(evidence).includes("secret-value"));
assert.ok(!JSON.stringify(evidence).includes("?token="));

console.log("PASS: Recorded evidence is bounded and sanitized");

const fakeFetch=async(url,options)=>{
  assert.ok(url.endsWith("/api/chat"));
  const sent=JSON.parse(options.body);
  assert.equal(sent.stream,false);

  return {
    ok:true,
    json:async()=>({
      message:{
        content:JSON.stringify({
          whatHappened:
            "CoPilot navigated from the homepage to the article.",
          whyOutcome:
            "The application recorded verified completion.",
          limitations:
            "No broader website coverage was tested."
        })
      }
    })
  };
};

const result=await explainRecordedRun(
  evidence,{fetchImpl:fakeFetch}
);

assert.equal(result.status,"verified_complete");
assert.equal(result.actions.length,1);
assert.match(result.explanation.whatHappened,/navigated/);

console.log("PASS: Mock Ollama explanation and fixed outcome");

const html=readFileSync("src/ui/index.html","utf8");
const server=readFileSync("src/ui/server.js","utf8");

for(const id of [
  "resultDetailsBtn","runDetailsOverlay",
  "runDetailsDialog","runDetailsClose",
  "runDetailsOutput","runDetailsRetry"
]){
  assert.equal(
    html.split('id="'+id+'"').length-1,1,
    "Missing or duplicated "+id
  );
}

assert.match(server,/\/api\/run-explanation/);

for(const match of html.matchAll(
  /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g
)) new Script(match[1]);

console.log("PASS: Dashboard JavaScript parses");

const browser=await chromium.launch({headless:true});

try {
  const page=await browser.newPage({
    viewport:{width:1440,height:900}
  });

  await page.route('http://copilot-ui.test/**',route=>{
    const pathname=new URL(route.request().url()).pathname;

    if(pathname==='/')
      return route.fulfill({
        status:200,contentType:"text/html",body:html
      });

    if(pathname==='/api/state')
      return route.fulfill({
        status:200,
        contentType:"application/json",
        body:JSON.stringify({
          phase:"idle",activity:[],result:null,
          actionTree:{nodes:[],edges:[]}
        })
      });

    if(pathname==='/api/run-explanation')
      return route.fulfill({
        status:200,
        contentType:"application/json",
        body:JSON.stringify(result)
      });

    return route.fulfill({
      status:200,
      contentType:"application/json",
      body:"{}"
    });
  });

  await page.goto('http://copilot-ui.test/');

  await page.evaluate(()=>{
    renderState({
      phase:"finished",activity:[],
      result:{status:"verified_complete",history:[]},
      actionTree:{nodes:[],edges:[]}
    });
  });

  await page.locator('#resultDetailsBtn').click();

  await page.locator('#runDetailsOutput')
    .waitFor({state:"visible"});

  assert.equal(
    await page.locator('#runDetailsOverlay').isVisible(),
    true
  );

  assert.match(
    await page.locator('#runDetailsWhat').innerText(),
    /navigated/
  );

  assert.equal(
    await page.locator('#runDetailsActions li').count(),
    1
  );

  await page.keyboard.press("Escape");

  assert.equal(
    await page.locator('#runDetailsOverlay').isHidden(),
    true
  );

  console.log("PASS: Browser popup, explanation and close");
} finally {
  await browser.close();
}

console.log("PASS: Step 7F.27B regression");
