import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runAgent } from '../src/agent/agent.js';
import { createConversationalApprovalProvider } from '../src/agent/conversational-approval.js';
import { createFormMutationPolicy, isSubmitAction } from '../src/agent/form-mutation-policy.js';

// ---- Group 1: what counts as a submit ------------------------------------
assert.equal(isSubmitAction({operation:'click'},{type:'submit'}),true);
assert.equal(isSubmitAction({operation:'click'},{type:'image'}),true);
assert.equal(isSubmitAction({operation:'click'},{type:'button'}),false);
assert.equal(isSubmitAction({operation:'click'},{type:'checkbox'}),false);
assert.equal(isSubmitAction({operation:'click'},null),false);
assert.equal(isSubmitAction({operation:'fill',value:'Enter'},{type:'submit'}),false);
assert.equal(isSubmitAction({operation:'press',value:'Enter'},{type:'text'}),true);
assert.equal(isSubmitAction({operation:'press',value:'Tab'},{type:'text'}),false);

// ---- Group 2: policy behaviour on synthetic observations ------------------
const field=(over)=>({tag:'input',type:'text',editable:true,currentValue:'',...over});
const obs=(url,elements)=>({url,actionableElements:elements});
const name=(v='')=>field({stableKey:'text:1',name:'name',label:'Name',currentValue:v});
const news=(c=false)=>field({stableKey:'checkbox:1',type:'checkbox',editable:false,name:'news',label:'News',checked:c});
const other=(v='')=>field({stableKey:'text:2',name:'other',label:'Other',currentValue:v});
const goal={type:'all_of',conditions:[{type:'form_state',fieldLabel:'Name',expectedValue:'Ada'}]};
const make=()=>{const p=createFormMutationPolicy({goal,instruction:'Fill Name with Ada'});p.observe(obs('http://x/form',[name(),news(false),other('keep')]));return p;};

{ // baseline: without acknowledgement a vanished control is flagged
  const p=make();
  const r=p.verify(obs('http://x/form',[name('Ada')]));
  assert.equal(r.verified,false);
  assert.deepEqual(r.issues.map(i=>i.reason).sort(),['protected_field_missing','protected_field_missing']);
}
{ // acknowledged submit: vanished controls are not compared
  const p=make();
  const after=obs('http://x/form',[]);
  p.acknowledgeSubmit(after);
  assert.equal(p.verify(after).verified,true);
}
{ // NEGATIVE: submit acknowledged, but a surviving unrequested field changed
  const p=make();
  const after=obs('http://x/form',[name('Ada'),other('tampered')]);
  p.acknowledgeSubmit(after);
  const r=p.verify(after);
  assert.equal(r.verified,false);
  assert.deepEqual(r.issues.map(i=>[i.field,i.reason]),[['stable:text:2#1','protected_field_changed']]);
}
{ // NEGATIVE: surviving unrequested checkbox flipped
  const p=make();
  const after=obs('http://x/form',[name('Ada'),news(true),other('keep')]);
  p.acknowledgeSubmit(after);
  assert.equal(p.verify(after).verified,false);
}
{ // acknowledging on a URL that was never observed changes nothing
  const p=make();
  p.acknowledgeSubmit(obs('http://x/other',[]));
  assert.equal(p.verify(obs('http://x/form',[name('Ada')])).verified,false);
}
{ // inactive policy stays inactive
  const p=createFormMutationPolicy({goal:null,instruction:'Open the page'});
  p.acknowledgeSubmit(obs('http://x/form',[]));
  assert.equal(p.verify(obs('http://x/form',[])).verified,true);
}

// ---- Group 3: real Chromium ----------------------------------------------
globalThis.fetch=async()=>{throw new Error('offline')};
const browser=await chromium.launch({headless:true,
  ...(process.env.WC_TEST_CHROMIUM?{executablePath:process.env.WC_TEST_CHROMIUM}:{}),args:['--no-sandbox']});
const html=`<!doctype html><html><head><title>Form</title></head><body>
<form id="f" onsubmit="event.preventDefault();window.submitted=true;document.body.innerHTML='<p>Thank you</p>'">
<label>Name <input name="name" aria-label="Name"></label>
<label>Note <input name="note" aria-label="Note"></label>
<label>News <input type="checkbox" name="news" aria-label="News"></label>
<button type="submit">Send</button></form>
<button type="button" id="wipe" onclick="document.querySelector('[name=news]').closest('label').remove()">Refresh layout</button></body></html>`;
const pick=(o,pred)=>o.actionableElements.find(pred);
const goalName={type:'all_of',conditions:[{type:'form_state',fieldLabel:'Name',expectedValue:'Ada'}]};
const goalNameNote={type:'all_of',conditions:[{type:'form_state',fieldLabel:'Name',expectedValue:'Ada'},{type:'form_state',fieldLabel:'Note',expectedValue:'Hi'}]};
try{
  { // NEGATIVE: a NON-submit action removes an unrequested control -> still blocked
    const page=await browser.newPage(); await page.setContent(html);
    let i=0;
    const reasoner=async(_t,o)=>{
      if(i++===0){const e=pick(o,x=>x.name==='name');return {ref:e.ref,operation:'fill',value:'Ada'};}
      const e=pick(o,x=>/Refresh layout/.test(x.label??x.text??''));
      return e?{ref:e.ref,operation:'click',value:''}:{ref:'',operation:'done',value:''};
    };
    const r=await runAgent(page,'Fill Name with Ada and Note with Hi. Leave every other field unchanged.',goalNameNote,{reasoner,maxSteps:5});
    assert.equal(r.status,'protected_form_state_changed',JSON.stringify(r).slice(0,400));
    assert.equal(await page.locator('[name="note"]').inputValue(),'','Note should not have been filled after the block');
    await page.close();
  }
  { // POSITIVE: a real submit replaces the form; not reported as tampering
    const page=await browser.newPage(); await page.setContent(html);
    let i=0;
    const reasoner=async(_t,o)=>{
      i++;
      if(i===1){const e=pick(o,x=>x.name==='name');return {ref:e.ref,operation:'fill',value:'Ada'};}
      const e=pick(o,x=>x.type==='submit');
      return e?{ref:e.ref,operation:'click',value:''}:{ref:'',operation:'done',value:''};
    };
    const r=await runAgent(page,'Fill Name with Ada. Leave every other field unchanged. Then click Send.',goalName,{reasoner,maxSteps:5,
      approvalProvider:createConversationalApprovalProvider({requestUser:async()=>({optionId:'approve'})})});
    assert.notEqual(r.status,'protected_form_state_changed',JSON.stringify(r).slice(0,400));
    assert.notEqual(r.status,'approval_required',JSON.stringify(r).slice(0,400));
    assert.equal(await page.evaluate(()=>window.submitted),true,'submit did not happen');
    await page.close();
  }
}finally{await browser.close();}
console.log('PASS test-form-submit-acknowledge');
