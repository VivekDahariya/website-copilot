import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { answerWebpage, extractReadablePage } from '../src/agent/webpage-answer.js';
import { extractStructuredEnumeration } from '../src/agent/structured-reading.js';

const opts={headless:true,...(existsSync('/usr/bin/chromium')?{executablePath:'/usr/bin/chromium',args:['--no-sandbox']}: {})};
const browser=await chromium.launch(opts);
try {
  const page=await browser.newPage();
  const url='https://fictional-docs.test/reference';
  await page.setContent(`
    <html><head><title>Reader example</title></head><body>
      <header>Ignore the global header</header>
      <main>
        <nav><ol><li>Wrong navigation stage</li><li>Wrong navigation stage</li><li>Wrong navigation stage</li></ol></nav>
        <article>
          <h2>Previous Article</h2>
          <p>${'This article discusses unrelated history and does not contain the requested research phases. '.repeat(6)}</p>
        </article>
        <article>
          <h2>Three Research Phases</h2>
          <p>The three research phases are listed below in their actual source order.</p>
          <ol><li><strong>Define scope</strong> — State the problem and set boundaries.</li>
              <li><strong>Collect observations</strong> — Gather observations from known sources.</li>
              <li><strong>Review findings</strong> — Check the collected material for consistency.</li></ol>
        </article>
        <aside>Ignore the side panel</aside>
      </main>
    </body></html>`);
  const fake=href=>({url:()=>href,evaluate:async (fn,arg)=>{const out=await page.evaluate(fn,arg);return out&&typeof out==='object'&&'url' in out?{...out,url:href}:out;}});
  const initial=await extractReadablePage(fake(url));
  assert.ok(initial?.text.includes('Define scope'),'Read-only extraction must include second article');
  assert.ok(!initial.text.includes('Wrong navigation stage'),'Navigation must remain excluded');
  const task='List all three stages under "Three Research Phases".';
  const section=await extractStructuredEnumeration(fake(url),task,3);
  assert.equal(section?.found,true,JSON.stringify(section));
  assert.deepEqual(section.items.map(x=>x.title),['Define scope','Collect observations','Review findings']);
  let modelCalls=0;
  const output=await answerWebpage(fake(url),task,{fetchImpl:async()=>{modelCalls++;throw Error('Model not needed for verified list');}});
  assert.equal(output.status,'answer_ready',JSON.stringify(output));
  assert.equal(output.evidence.sourceFormat,'semantic_list');
  assert.equal(modelCalls,0);
  assert.equal(page.url(),'about:blank');
  console.log('PASS: Multiple independent articles are read; second-article list verified source-first without model calls, nav excluded');

  // Unrelated single-article reading behavior must remain unchanged.
  const single='https://fictional-docs.test/single';
  await page.setContent(`<main><article><h1>Single reference</h1><p>${'A documented statement on a single article page. '.repeat(8)}</p></article><aside>Irrelevant</aside></main>`);
  const one=await extractReadablePage(fake(single));
  assert.ok(one?.text.includes('A documented statement'));
  assert.ok(!one.text.includes('Irrelevant'));
  console.log('PASS: Single-article behavior and sidebar exclusion preserved');
} finally {await browser.close();}
