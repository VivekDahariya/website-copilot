import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {isReadOnlyQuestion,isNavigationThenReadingTask,answerWebpage} from '../src/agent/webpage-answer.js';

const task=`Use Wikipedia's search to find Ada Lovelace. Open her Wikipedia article and identify her occupation and what she is best known for, using the article's introductory text. Do not edit Wikipedia, log in, or navigate to external websites.`;
const cases=[
 [task,true],
 ['Read the documentation and explain the features. Do not navigate.',false],
 ['Open the Ada Lovelace article.',false],
 ['Click the link to open a new tab and read its heading, then return to the original tab.',false],
 ['Fill this form, then explain the result.',false],
 ['Search the site, then submit a payment and summarize.',false],
 ['Explain how to search the site and open an article.',false],
];
for(const [s,want] of cases) assert.equal(isNavigationThenReadingTask(s),want,s);
assert.equal(isReadOnlyQuestion(task),false);
const invalidRead=await answerWebpage({},'Submit the payment and explain it.',{navigationCompleted:true});
assert.equal(invalidRead.status,'unsupported_reading_intent');
console.log('PASS: Exact Wikipedia task recognized, read-only and consequential tasks excluded');

const dir=await mkdtemp(join(tmpdir(),'wc-read-handoff-'));
const root=new URL('../',import.meta.url);
const executorPath=new URL('../src/agent/natural-language-executor.js',import.meta.url);
try {
  const mocksFile=join(dir,'mocks.mjs');
  const executorFile=join(dir,'executor.mjs');
  const stub=`const t=()=>globalThis.__handoffTest;
export const discoverWebsite=async()=>{throw Error('Unexpected discovery')};
export const buildVerifiedDiscoveredNavigationGoal=async()=>{throw Error('Unexpected discovered navigation')};
export const buildRepositoryDestinationGoal=()=>null;
export const createExplicitTabWorkflow=()=>null;
export const isReadOnlyQuestion=(s)=>t().readOnly(s);
export const isNavigationThenReadingTask=(s)=>t().navThenRead(s);
export const answerWebpage=async(p,s,o)=>{t().calls.read++;t().calls.readOptions=o;return t().readResult(p,s,o)};
export const interpretTask=async(s)=>{t().calls.interpret++;return {status:'interpreted',task:{type:'browser_goal',instruction:s,goal:t().goal}}};
export const executeTask=async(p)=>{t().calls.execute++;if(t().changeUrl)p.final=t().destination;return {status:t().execStatus,taskType:'browser_goal',result:{status:t().execStatus,finalUrl:p.url(),verification:{completed:t().verified},history:[{step:1,decision:{operation:'click'}}]}}};
`;
  await writeFile(mocksFile,stub);
  const source=await readFile(executorPath,'utf8');
  const stubUrl=pathToFileURL(mocksFile).href;
  const rewritten=source.replace(/from\s+["']\.\/[^"']+["']/g,`from '${stubUrl}'`);
  assert.notEqual(rewritten,source);
  assert.equal((rewritten.match(/from\s+'file:\/\//g)||[]).length,7,'All seven module import groups must be overridden');
  await writeFile(executorFile,rewritten);
  const {executeNaturalLanguageTask}=await import(pathToFileURL(executorFile));
  const destination='https://en.wikipedia.org/wiki/Ada_Lovelace';
  const fakePage=()=>({final:'https://en.wikipedia.org/wiki/Main_Page',url(){return this.final},goto:async()=>{},evaluate:async()=>[]});
  const reset=()=>{globalThis.__handoffTest={
    readOnly:isReadOnlyQuestion,navThenRead:isNavigationThenReadingTask,
    calls:{read:0,interpret:0,execute:0},
    goal:{type:'page_destination',heading:'Ada Lovelace'},
    changeUrl:true,verified:true,execStatus:'verified_complete',destination,
    readResult:async(p,s,o)=>({status:'answer_ready',answer:'Ada Lovelace was an English mathematician and writer who worked on Charles Babbage’s proposed Analytical Engine.',sourceUrl:p.url(),sourceTitle:'Ada Lovelace',evidence:{extractedCharacters:321}})
  };return globalThis.__handoffTest;};
  let m=reset();
  const good=await executeNaturalLanguageTask(fakePage(),task);
  assert.equal(good.status,'answer_ready');
  assert.equal(good.sourceUrl,destination);
  assert.equal(good.execution.result.history.length,1);
  assert.equal(m.calls.read,1);
  assert.equal(m.calls.interpret,1);
  assert.equal(m.calls.execute,1);
  assert.equal(m.calls.readOptions.navigationCompleted,true);
  console.log('PASS: Production executor delivers article answer after independent destination verification');
  m=reset();m.readResult=async()=>({status:'answer_unavailable',reason:'Model reached its output limit.'});
  const failed=await executeNaturalLanguageTask(fakePage(),task);
  assert.equal(failed.status,'answer_unavailable');
  assert.match(failed.reason,/output limit/);
  assert.equal(failed.execution.result.history.length,1);
  console.log('PASS: Model output-limit failure never inherits navigation success status');
  m=reset();m.changeUrl=false;
  const noDestination=await executeNaturalLanguageTask(fakePage(),task);
  assert.equal(noDestination.status,'answer_unavailable');
  assert.equal(m.calls.read,0);
  console.log('PASS: No destination URL change blocks reading and premature completion');
  m=reset();m.verified=false;
  const unverified=await executeNaturalLanguageTask(fakePage(),task);
  assert.equal(unverified.status,'answer_unavailable');
  assert.equal(m.calls.read,0);
  console.log('PASS: Independent browser verification required before reading');
  m=reset();m.goal={type:'visible_content',text:'Ada Lovelace'};
  const wrongGoal=await executeNaturalLanguageTask(fakePage(),task);
  assert.equal(wrongGoal.status,'answer_unavailable');
  assert.equal(m.calls.read,0);
  console.log('PASS: Non-destination goals cannot falsely complete composite request');
  m=reset();
  const ordinary=await executeNaturalLanguageTask(fakePage(),'Open the Ada Lovelace article.');
  assert.equal(ordinary.status,'verified_complete');
  assert.equal(m.calls.read,0);
  console.log('PASS: Navigation-only tasks retain original verified_complete result');
  m=reset();m.execStatus='needs_clarification';
  const blocked=await executeNaturalLanguageTask(fakePage(),task);
  assert.equal(blocked.status,'needs_clarification');
  assert.equal(m.calls.read,0);
  console.log('PASS: Interrupted navigation never calls reader');
} finally {
  delete globalThis.__handoffTest;
  await rm(dir,{recursive:true,force:true});
}
