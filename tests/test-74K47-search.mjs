import assert from 'node:assert/strict';
import { buildCatalog } from '../src/agent/local-reasoner.js';
const goal = { type: 'page_destination', heading: 'Hypatia of Alexandria' };
const textGoal = 'Read about the mathematician Hypatia of Alexandria';
const elements = [
  {ref:'e1', tag:'a', label:'English Wikipedia',href:'https://en.wikipedia.org/wiki/Main_Page',editable:false},
  {ref:'e2', tag:'a', label:'About Wikipedia',href:'https://en.wikipedia.org/wiki/Wikipedia',editable:false},
  {ref:'e3', tag:'input', label:'Search Wikipedia',name:'search',editable:true,currentValue:'',type:'search'},
  {ref:'e4', tag:'button',label:'Search',editable:false}
];
const search = buildCatalog({actionableElements:elements},[],goal,textGoal);
assert(search.some(x=>x.ref==='e3' && x.allowedOperations.includes('fill')));
assert(search.some(x=>x.ref==='e4' && x.allowedOperations.includes('click')));
assert(!search.some(x=>x.ref==='e1' || x.ref==='e2'));
console.log('PASS: Search-first when destination not linked');
const filled = buildCatalog({actionableElements:[...elements.slice(0,2),{...elements[2],currentValue:'Hypatia of Alexandria'},elements[3]]},[],goal,textGoal);
assert(filled.some(x=>x.ref==='e3' && x.currentValue==='Hypatia of Alexandria'));
console.log('PASS: Already-filled query preserved for submit');
const direct = buildCatalog({actionableElements:[...elements,{ref:'e110',tag:'a',label:'Hypatia of Alexandria',href:'https://en.wikipedia.org/wiki/Hypatia',editable:false}]},[],goal,textGoal);
assert(direct.some(x=>x.ref==='e110'));
assert(!direct.some(x=>x.ref==='e1' || x.ref==='e2'));
console.log('PASS: Direct destination link preserved and unrelated links excluded');
const generic = buildCatalog({actionableElements:elements},[],{type:'form_state',fieldLabel:'Search Wikipedia',expectedValue:'Example'},'Fill Search Wikipedia');
assert(generic.some(x=>x.ref==='e1'));
console.log('PASS: Non-destination workflows unaffected');
const many = Array.from({length:200},(_,i)=>({ref:`e${i+1}`,tag:'a',label:`Unrelated Article ${i}`,href:`https://example.com/${i}`,editable:false}));
many.push({ref:'e999',tag:'a',label:'Hypatia of Alexandria',href:'https://example.com/Hypatia_of_Alexandria',editable:false});
assert(buildCatalog({actionableElements:many},[],goal,textGoal).some(x=>x.ref==='e999'));
console.log('PASS: Matching link found after 200 unrelated elements');
