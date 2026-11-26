// Generic, source-grounded enumeration reader.
// This module handles semantic sections and lists; it never recognizes a
// particular website, task title, or domain.

const NUMBERS = new Map([
  ['one',1],['two',2],['three',3],['four',4],['five',5],
  ['six',6],['seven',7],['eight',8],['nine',9],['ten',10],
  ['eleven',11],['twelve',12],['thirteen',13],['fourteen',14],
  ['fifteen',15],['sixteen',16],['seventeen',17],['eighteen',18],
  ['nineteen',19],['twenty',20]
]);

function quantity(value) {
  if (!value) return null;
  const v = String(value).toLowerCase();
  return /^\d+$/.test(v) ? Number(v) : NUMBERS.get(v) ?? null;
}

export function requestedExplanationCount(instruction, maxCount) {
  const text = String(instruction ?? '');
  const m = text.match(/\b(?:explain|describe|detail|summari[sz]e)\s+(?:the\s+)?first\s+(\d{1,2}|[a-z]+)\b/i);
  const n = quantity(m?.[1]);
  return n && n <= maxCount ? n : 0;
}

const STOP_WORDS = new Set([
  'list','all','the','a','an','and','or','on','in','of','for','from','with',
  'first','please','read','current','webpage','page','website','briefly',
  'explain','describe','mentioned','under','identify','name','enumerate',
  'eight','seven','six','five','four','three','two','one','ten','nine',
  'eleven','twelve','items','parts'
]);
function topicTokens(text) {
  return [...new Set((String(text).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g)||[])
    .filter(x=>!STOP_WORDS.has(x)))];
}

export async function extractStructuredEnumeration(page, instruction, count) {
  if (!page || typeof page.evaluate !== 'function' || !Number.isInteger(count) || count < 2 || count > 20) return null;
  const before = page.url();
  const quotes = [...String(instruction).matchAll(/["“‘']([^"”’']{4,120})["”’']/g)]
    .map(m=>m[1].trim()).filter(Boolean);
  const topic = topicTokens(instruction);
  const result = await page.evaluate(({ count, quotes, topic }) => {
    const mainRoot = document.querySelector('main') ||
      document.querySelector('[role="main"]');
    // Include sibling articles under the same content region, not just the first.
    const root = (mainRoot?.querySelectorAll('article').length > 1 ? mainRoot : null) ||
      document.querySelector('main article') || document.querySelector('article') ||
      mainRoot || document.body;
    if (!root) return null;
    const excluded = 'nav,header,footer,aside,form,[hidden],[aria-hidden="true"],[role="navigation"],[role="dialog"],script,style,template';
    const good = el => {
      if (el.closest(excluded) || !el.getClientRects().length) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const clean = value => String(value || '').replace(/\s+/g,' ').trim();
    const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .filter(good).map(el=>({el, level:Number(el.tagName.slice(1)),text:clean(el.innerText)}));
    const canon = s => clean(s).toLowerCase().replace(/[^a-z0-9 ]/g,'');
    const quote = quotes.map(canon).filter(Boolean);
    let matches = headings.map((h,i)=>{
      const norm = canon(h.text);
      const words = topic.filter(w=>norm.includes(w));
      const matchedQuote = quote.some(q=>norm === q || norm.includes(q));
      return { i,h, score: matchedQuote ? 100+words.length : words.length, matchedQuote };
    }).sort((a,b)=>b.score-a.score||a.i-b.i);
    // Explicitly quoted section labels must actually exist on the page.
    if (quote.length) matches=matches.filter(m=>m.matchedQuote);
    else matches=matches.filter(m=>m.score>=1);
    const anchor=matches[0];
    if (!anchor) return null;
    const anchorIndex=anchor.i;
    const base=anchor.h;
    let end=headings.length;
    for (let i=anchorIndex+1;i<headings.length;i++) {
      if (headings[i].level<=base.level) { end=i; break; }
    }
    const descendants=headings.slice(anchorIndex+1,end);
    let method=null;
    let items=[];
    let insufficient=false;
    // Numbered heading hierarchy: 1. Title, 2. Title, etc.
    const numbered=descendants.map((h,i)=>{
      const m=h.text.match(/^\s*(\d{1,2})\s*[.)-]\s*(.+)$/);
      return m?{...h, index:i,number:Number(m[1]),title:clean(m[2])}:null;
    }).filter(Boolean);
    if (numbered.length) {
      const used=new Set();
      const sequence=[];
      for (let i=1;i<=count;i++) {
        const candidates=numbered.filter(h=>h.number===i && !used.has(h));
        if (candidates.length!==1) break;
        sequence.push(candidates[0]);used.add(candidates[0]);
      }
      if (sequence.length===count) {
        const seqLevel=sequence[0].level;
        if (sequence.every(h=>h.level===seqLevel)) {
          method='numbered_headings';
          items=sequence.map((h,j)=>({el:h.el,title:h.title,next:sequence[j+1]?.el??null,level:h.level}));
        }
      } else insufficient=true;
    }
    // Unnumbered subsections are reliable only when the child-level count
    // equals the requested count, never arbitrarily take the first N.
    if (!items.length && !numbered.length && descendants.length) {
      const minLevel=Math.min(...descendants.map(h=>h.level));
      const top=descendants.filter(h=>h.level===minLevel);
      if(top.length===count){
        method='section_headings';
        items=top.map((h,j)=>({el:h.el,title:h.text,next:top[j+1]?.el??null,level:h.level}));
      }
    }
    // Semantic list fallback: select an actual list inside the matched
    // section, not a navigation/sidebar list or arbitrary global list.
    if(!items.length){
      const nodes=[...root.querySelectorAll('h1,h2,h3,h4,h5,h6,ol,ul')];
      let started=false; const lists=[];
      for(const el of nodes){
        if(el===base.el){started=true;continue;}
        if(!started)continue;
        if(/^H[1-6]$/.test(el.tagName)&&Number(el.tagName.slice(1))<=base.level)break;
        if(!['OL','UL'].includes(el.tagName) || el.closest('ol li,ul li') || !good(el))continue;
        const li=[...el.children].filter(x=>x.tagName==='LI'&&good(x));
        if(li.length===count)lists.push(li);
      }
      if(lists.length===1){
        method='semantic_list';
        items=lists[0].map(li=>{
          const bold=li.querySelector(':scope > strong,:scope > b,:scope > h3,:scope > h4,:scope > a');
          const plain=clean(li.innerText);
          let title=bold?clean(bold.innerText):'';
          if(!title) {
            const first=plain.split(/\s+[—–-]\s+|[.:;\n]/)[0];
            title=first.length>110?first.slice(0,110):first;
          }
          const remainder=clean(plain.startsWith(title)?plain.slice(title.length):plain);
          return {el:li,title,context:remainder};
        });
      } else if(lists.length>1) insufficient=true;
    }
    if(!items.length)return {found:false,reason:insufficient?'incomplete_numbered_section':'no_unambiguous_list',section:base.text};
    const docNodes=[...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,pre,li')].filter(good);
    const summaries=items.map((item)=>{
      let context=item.context||'';
      let example='';
      if(method!=='semantic_list') {
        let active=false;const snippets=[];
        for(const el of docNodes){
          if(el===item.el){active=true;continue;}
          if(!active)continue;
          if(/^H[1-6]$/.test(el.tagName)&&Number(el.tagName.slice(1))<=item.level)break;
          if(el.tagName==='P'){
            const sentence=clean(el.innerText);
            if(sentence && !/^(?:view (?:complete )?code|copy|close)$/i.test(sentence))snippets.push(sentence);
          }
          if(el.tagName==='PRE'&&!example){
            const lines=String(el.innerText||'').split('\n').map(clean).filter(Boolean);
            // Only retain short concrete snippets, not full source listings.
            const short=lines.filter(l=>l.length<=110 && !/^(?:package|import |\/\/|#)/.test(l));
            if(short.length===1 && lines.length<=3) example=short[0];
          }
          if(snippets.join(' ').length>480)break;
        }
        context=snippets.slice(0,2).join(' ').slice(0,420);
      }
      return { title:item.title, context:clean(context).slice(0,420), example:example.slice(0,110) };
    });
    if(summaries.some(x=>!x.title||x.title.length>180))return {found:false,reason:'invalid_item_titles',section:base.text};
    return { found:true,section:base.text,method,items:summaries };
  }, {count,quotes,topic});
  if (page.url()!==before) return null;
  return result;
}

function compress(text, max=190) {
  let val=String(text||'').replace(/\s+/g,' ').trim();
  if(val.length<=max)return val;
  const sentences=val.match(/^.{1,190}?[.!?](?=\s|$)/);
  if(sentences)return sentences[0];
  return val.slice(0,max).replace(/\s+\S*$/,'').trim()+'…';
}

export function assembleStructuredAnswer(extraction, explainCount, generated=[]) {
  if (!extraction?.found || !Array.isArray(extraction.items))return null;
  const missing=[];
  const lines=extraction.items.map((item,i)=>{
    const title=item.title.trim();
    const explanation=String(generated[i]||'').trim();
    // A cross-reference ("For more details...") is not an explanation.
    // Prefer the original example if the page provides one.
    const crossReference = /^(?:for more details|see (?:also|our)|read (?:our|the) documentation)\b/i
      .test(item.context || "");
    const sourceNote = crossReference && item.example
      ? `The page demonstrates this with \`${item.example}\`.`
      : item.context ? compress(item.context)
      : item.example ? `Example shown: \`${item.example}\`.` : "";
    if(i>=explainCount)return `${i+1}. **${title}**`;
    if(explanation) return `${i+1}. **${title}** — ${compress(explanation,240)}`;
    if(sourceNote) return `${i+1}. **${title}** — ${sourceNote}`;
    missing.push(i+1);
    return `${i+1}. **${title}**`;
  });
  return {answer:lines.join('\n'), complete:missing.length===0, missing};
}
