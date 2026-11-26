// Pointer and keyboard actions through the direct loop: hover, drag, slider,
// right-click, key press and scroll. A scripted stand-in model picks the
// action a correct planner would pick; everything after that (allowed
// operations, execution, browser verification, completion check) is real.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;
const page0 = (title, body, script='') => `<!doctype html><html><head><title>${title}</title>
<style>.menu ul{display:none}.menu:hover ul{display:block}.col{border:1px solid #333;min-height:80px;width:200px;display:inline-block;vertical-align:top;margin:8px;padding:8px}</style>
</head><body><h1>${title}</h1>${body}<script>${script}</script></body></html>`;
const cases = [
 {name:'hover', expect:'verified_complete', ops:["hover", "click"], instruction:'Hover over the "Products" menu and click the "Pricing" link.',
  html: page0('Store','<div class="menu"><button type="button">Products</button><ul><li><a href="#pricing">Pricing</a></li></ul></div><h2 id="pricing">Pricing</h2>'),
  script:[[/^Products$/,'hover',''],[/^Pricing$/,'click','']]},
 // Image cards that reveal a caption and a link only while hovered. The
 // cards are plain containers; the page's own ":hover" style rule is what
 // marks them as hover areas. Three identical cards are told apart by order.
 {name:'hover-card', expect:'verified_complete', ops:["hover", "click"], instruction:'Hover over the second user avatar and click "View profile".',
  html: page0('Hovers','<style>.figure{float:left;margin:10px}.figcaption{display:none}.figure:hover .figcaption{display:block}a:hover{color:red}</style>' +
   [1,2,3].map(n => '<div class="figure"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="120" height="120" alt="User Avatar"><div class="figcaption"><h5>name: user' + n + '</h5><a href="#users/' + n + '">View profile</a></div></div>').join('')),
  script:[[/hover area 2\)/,'hover',''],[/^View profile$/,'click','']],
  final: async page => assert.ok(page.url().endsWith('#users/2'), 'the link revealed by the second card was clicked')},
 // Seen live: hovering revealed a link, which renumbered the cards, and the
 // model hovered the same card again under its new reference.
 {name:'hover-not-repeated', expect:'verified_complete', ops:["hover"], instruction:'Hover over the second user avatar',
  html: page0('Hovers','<style>.figure{float:left;margin:10px}.figcaption{display:none}.figure:hover .figcaption{display:block}</style>' +
   [1,2,3].map(n => '<div class="figure"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="120" height="120" alt="User Avatar"><div class="figcaption"><h5>name: user' + n + '</h5><a href="#users/' + n + '">View profile</a></div></div>').join('')),
  script:[[/hover area 2\)/,'hover',''],[/hover area 2\)/,'hover','User Avatar'],[/hover area 2\)/,'hover','again']],
  final: async page => assert.equal(await page.locator('.figcaption:visible h5').innerText(), 'name: user2')},
 {name:'drag', expect:'verified_complete', ops:["drag"], instruction:'Drag "Card A" into the "Done" column.',
  html: page0('Board','<div class="col" id="todo" aria-label="To do"><h2>To do</h2><div id="a" draggable="true">Card A</div></div><div class="col" id="done" aria-label="Done"><h2>Done</h2></div>',
   `a.addEventListener('dragstart',e=>e.dataTransfer.setData('text','a'));for(const c of document.querySelectorAll('.col')){c.addEventListener('dragover',e=>e.preventDefault());c.addEventListener('drop',e=>{e.preventDefault();c.appendChild(a)})}`),
  script:[[/Card A/,'drag',/^Done/]]},
 {name:'drag-ignored', expect:'unverified_completion_claim', ops:["drag"], instruction:'Drag "Card A" into the "Done" column.',
  html: page0('Board','<div class="col" id="todo" aria-label="To do"><h2>To do</h2><div id="a" draggable="true">Card A</div></div><div class="col" id="done" aria-label="Done"><h2>Done</h2></div>',
   `a.addEventListener('dragstart',e=>e.dataTransfer.setData('text','a'));`),
  script:[[/Card A/,'drag',/^Done/]]},
 {name:'drag-swap', expect:'verified_complete', ops:["drag"], instruction:'Drag box "A" onto box "B".',
  html: page0('Swap','<div id="cols"><div class="col" id="ca" draggable="true">A</div><div class="col" id="cb" draggable="true">B</div></div>',
   `let src;for(const c of document.querySelectorAll('.col')){c.addEventListener('dragstart',e=>{src=c;e.dataTransfer.setData('text',c.innerHTML)});c.addEventListener('dragover',e=>e.preventDefault());c.addEventListener('drop',e=>{e.preventDefault();if(src&&src!==c){src.innerHTML=c.innerHTML;c.innerHTML=e.dataTransfer.getData('text')}})}`),
  script:[[/^A$/,'drag',/^B$/]]},
 // Seen live: after the swap the model dragged the boxes again, which put
 // them back where they started, and the run was still reported complete.
 {name:'drag-not-undone', expect:'verified_complete', ops:["drag"], instruction:'Drag box "A" onto box "B".',
  html: page0('Swap','<div id="cols"><div class="col" id="ca" draggable="true">A</div><div class="col" id="cb" draggable="true">B</div></div>',
   `let src;for(const c of document.querySelectorAll('.col')){c.addEventListener('dragstart',e=>{src=c;e.dataTransfer.setData('text',c.innerHTML)});c.addEventListener('dragover',e=>e.preventDefault());c.addEventListener('drop',e=>{e.preventDefault();if(src&&src!==c){src.innerHTML=c.innerHTML;c.innerHTML=e.dataTransfer.getData('text')}})}`),
  script:[[/^A$/,'drag',/^B$/],[/^B$/,'drag',/^A$/],[/^B$/,'drag',/^A$/]],
  final: async page => assert.equal(await page.locator('#ca').innerText(), 'B',
    'the boxes stay swapped; the move is not cancelled')},
 {name:'slider', expect:'verified_complete', ops:["set_range"], instruction:'Set the Volume slider to 7.',
  html: page0('Player','<label for="v">Volume</label><input id="v" type="range" min="0" max="10" value="2"><p>Volume: <span id="o">2</span></p>',`v.addEventListener('input',()=>o.textContent=v.value)`),
  script:[[/Volume/,'set_range','7']]},
 // Seen live: a slider with no name was listed under its position ("0"),
 // and the model set the same value twice.
 {name:'slider-unnamed', expect:'verified_complete', ops:["set_range"], instruction:'Set the slider to 3.5',
  html: page0('Horizontal Slider','<input id="s" type="range" min="0" max="5" step="0.5" value="0"><span id="o">0</span>',`s.removeAttribute('id');const el=document.querySelector('input');el.addEventListener('input',()=>o.textContent=el.value)`),
  script:[[/^Slider$/,'set_range','3.5'],[/^Slider$/,'set_range','3.5'],[/^Slider$/,'set_range','3.5']],
  final: async page => assert.equal(await page.locator('input').inputValue(), '3.5')},
 {name:'right_click', expect:'verified_complete', ops:["right_click"], instruction:'Right-click the "Hot spot" box.',
  html: page0('Context','<div id="h" style="width:200px;height:80px;border:2px dashed #333" role="button" tabindex="0">Hot spot</div><p id="r"></p>',`h.addEventListener('contextmenu',e=>{e.preventDefault();r.textContent='Context menu opened'})`),
  script:[[/Hot spot/,'right_click','']]},
 // Seen live: the page answers a right-click with a plain alert. An alert
 // asks for no decision, so the run continues instead of ending as an error.
 {name:'right_click-alert', expect:'verified_complete', ops:["right_click"], instruction:'Right-click the box on the page',
  html: page0('Context Menu','<div id="hot-spot" oncontextmenu="alert(\'You selected a context menu\');return false" style="width:200px;height:80px;border:2px dashed #333"></div>'),
  script:[[/hot-spot/,'right_click','']],
  final: async page => assert.equal(page.listenerCount('dialog'), 0)},
 // Seen live: the model right-clicked again with different free text in the
 // value field ("e3", then "hot-spot"), so the repeat was not recognised.
 {name:'right_click-not-repeated', expect:'verified_complete', ops:["right_click"], instruction:'Right-click the box on the page',
  html: page0('Context Menu','<div id="hot-spot" oncontextmenu="alert(\'You selected a context menu\');return false" style="width:200px;height:80px;border:2px dashed #333"></div>'),
  script:[[/hot-spot/,'right_click','e1'],[/hot-spot/,'right_click','hot-spot'],[/hot-spot/,'right_click','the box']]},
 {name:'press', expect:'approval_required', ops:["fill"], instruction:'Type "hello" in the Search field and press Enter.',
  html: page0('Keys','<label for="q">Search</label><input id="q" type="text"><p id="r"></p>',`q.addEventListener('keydown',e=>{if(e.key==='Enter')r.textContent='You entered: '+q.value})`),
  script:[[/Search/,'fill','hello'],[/Search/,'press','Enter']]},
 // The pages below never print the words "bottom" or "top": where to scroll
 // is proven by the browser's scroll position, not by words on the page.
 // (Seen live: a page without the word "bottom" could not be completed.)
 // "To the bottom" means all the way: one screenful is not enough, and the
 // browser itself must report the end of the page. Seen in review: a single
 // 700px step on a long page used to be accepted as "the bottom".
 {name:'scroll-bottom', expect:'verified_complete', ops:["scroll"], instruction:'Scroll down to the bottom of the page.',
  html: page0('Long','<div style="height:3000px">Intro text</div><p>Last line of the article</p>'),
  script:[[null,'scroll','down'],[null,'scroll','down'],[null,'scroll','down']],
  final: async page => assert.ok(await page.evaluate(() =>
    window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2), 'the page is at its bottom')},
 {name:'scroll-top', expect:'verified_complete', ops:["scroll", "scroll"], instruction:'Scroll to the bottom of the page, then scroll back to the top.',
  html: page0('Long','<div style="height:3000px">Intro text</div><p>Last line of the article</p>'),
  script:[[null,'scroll','bottom'],[null,'scroll','top']],
  final: async page => assert.equal(await page.evaluate(() => Math.round(window.scrollY)), 0)},
 // One screen down is one step, and the page is not claimed to be at an end.
 {name:'scroll-step', expect:'verified_complete', ops:["scroll"], instruction:'Scroll down the page.',
  html: page0('Long','<div style="height:3000px">Intro text</div><p>Last line of the article</p>'),
  script:[[null,'scroll','down']],
  final: async page => assert.ok(await page.evaluate(() => window.scrollY > 300 &&
    window.scrollY + window.innerHeight < document.documentElement.scrollHeight - 2))},
 // A page too short to scroll: nothing moved, so it is never called done.
 {name:'scroll-impossible', expect:'unverified_completion_claim', ops:[], instruction:'Scroll down to the bottom of the page.',
  html: page0('Short','<p>Only one line.</p>'),
  script:[[null,'scroll','down'],[null,'scroll','bottom']]},
 // Seen live: Tab was pressed twice because the first press looked
 // unfinished to the planner. The second identical press is the test here.
 {name:'press-key', expect:'verified_complete', ops:["press"], instruction:'Press the Tab key in the text field',
  html: page0('Key Presses','<input id="target" type="text" aria-label="target"><p id="r"></p>',`target.addEventListener('keydown',e=>{r.textContent='You entered: '+e.key.toUpperCase()})`),
  script:[[/target/,'press','Tab'],[/target/,'press','Tab'],[/target/,'press','Tab']],
  seesStatus: true},
 // More than one press is carried out when the user asks for it.
 {name:'press-key-twice', expect:'verified_complete', ops:["press", "press"], instruction:'Press the Tab key twice in the text field',
  html: page0('Key Presses','<input id="target" type="text" aria-label="target"><p id="r"></p>',`target.addEventListener('keydown',e=>{r.textContent='You entered: '+e.key.toUpperCase()})`),
  script:[[/target/,'press','Tab'],[/target/,'press','Tab']]},
];
const browser = await chromium.launch({headless:true});
const realFetch = globalThis.fetch; const realLog = console.log;
let passed = 0;
try {
  for (const c of cases) {
    let calls = 0;
    globalThis.fetch = async (_u, request) => {
      const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
      calls += 1;
      const step = c.script[calls - 1];
      if (c.seesStatus && calls === 2) {
        assert.equal(payload.previousActions[0].status, 'done', 'the planner is told the key press was done');
        assert.equal(payload.previousActions[0].value, 'Tab', 'and which key it was');
      }
      const reply = action => ({ok:true, json: async()=>({message:{content:JSON.stringify(action)}})});
      if (!step) return reply({ref:'',operation:'done',value:''});
      const els = payload.availableElements ?? [];
      const find = rx => els.find(e => rx.test(String(e.label ?? '')));
      const el = step[0] ? find(step[0]) : null;
      if (step[0]) {
        assert.ok(el, `${c.name}: the planner is shown the element for ${step[1]}`);
        assert.ok(el.allowedOperations.includes(step[1]), `${c.name}: ${step[1]} is offered on it`);
      }
      const value = step[2] instanceof RegExp ? find(step[2])?.ref : step[2];
      assert.equal(typeof value, 'string', `${c.name}: the destination is shown to the planner`);
      return reply({ref:el?.ref ?? '',operation:step[1],value});
    };
    const page = await browser.newPage();
    await page.setContent(c.html);
    console.log = () => {};
    let result;
    try {
      result = await executeNaturalLanguageTask(page, c.instruction,
        {orchestratorOptions:{agentOptions:{maxSteps:6}}});
      if (c.final) await c.final(page);
    } finally { console.log = realLog; await page.close(); }
    const run = result.execution?.result ?? {};
    assert.equal(result.status, c.expect, `${c.name}: ${run.reason ?? ''}`);
    assert.deepEqual((run.history ?? []).map(h => h.decision.operation), c.ops, c.name);
    if (c.name === 'drag-ignored') {
      assert.equal(run.history[0].execution.verified, false,
        'a drag the page ignored is never reported as verified');
    }
    passed += 1;
    console.log(`PASS: ${c.name} -> ${result.status}`);
  }
  console.log(`direct-instruction-pointer: ${passed} groups passed`);
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close();
}
