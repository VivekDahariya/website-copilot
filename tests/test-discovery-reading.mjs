// "Open <site>, then tell me <answer>": when the run itself finds and opens the
// page, that page is where the answer is read. It used to end as
// answer_unavailable with no model call, because opening the page by discovery
// was not counted as having navigated. Real browser, local server, scripted reader.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { isUsableAnswerLength, isReadOnlyQuestion, isInformationRequest, stripModelReasoning } from '../src/agent/webpage-answer.js';
import { deliveredReason } from '../src/ui/delivered-reason.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;
const realLog = console.log;
let passed = 0;
const ok = name => { passed += 1; realLog(`PASS: ${name}`); };

const body = "Jensen Huang is a businessman and the CEO of Nvidia. His wife's name is Lori Mills, whom he met at university. " + 'Nvidia designs graphics processors. '.repeat(40);
const site = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<title>Jensen Huang - Wikipedia</title><main><h1>Jensen Huang</h1><p>${body}</p></main>`);
});
await new Promise(done => site.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${site.address().port}`;
const browser = await chromium.launch({ headless: true });

async function run(instruction, readReply, answerExtra = {}) {
  const page = await (await browser.newContext()).newPage();
  const prompts = [], models = [], systems = [];
  console.log = () => {};
  try {
    const result = await executeNaturalLanguageTask(page, instruction, {
      urlLess: true,
      orchestratorOptions: { agentOptions: { maxSteps: 3, approvalProvider: async () => null } },
      answerOptions: { ...answerExtra, fetchImpl: async (_url, options) => {
        const sent = JSON.parse(options.body);
        prompts.push(sent.prompt); models.push(sent.model); systems.push(sent.system);
        return { ok: true, json: async () => readReply };
      } }
    });
    return { result, prompts, models, systems, finalUrl: page.url() };
  } finally { console.log = realLog; await page.context().close(); }
}

try {
  const task = `Open ${base}/wiki/Jensen_Huang and search for Jensen Huang , then tell me his wife's name .`;
  const good = await run(task, { response: "Jensen Huang's wife is Lori Mills.", done: true, done_reason: 'stop' });
  assert.equal(good.result.status, 'answer_ready', String(good.result.reason) + ' | ' + JSON.stringify(good.result.reading ?? {}).slice(0, 400));
  assert.equal(good.prompts.length, 1, 'the reader model is asked exactly once');
  assert.match(good.prompts[0], /Lori Mills/, 'the reader is given the opened page');
  assert.equal(good.result.sourceUrl, `${base}/wiki/Jensen_Huang`);
  assert.equal(good.result.answer, "Jensen Huang's wife is Lori Mills.");
  assert.equal(good.result.execution.status, 'verified_complete');
  ok('a page opened by the run itself is read and the answer is delivered');

  // The model's thinking is never part of the answer.
  const thinking = 'We are given a user request: "tell me facebook release year".\n The key information: founded February 4, 2004.\n So, we output: 2004\n</think>\n\n2004';
  const traced = await run(task, { response: thinking, done: true, done_reason: 'stop' });
  assert.equal(traced.result.status, 'answer_ready', String(traced.result.reason));
  assert.equal(traced.result.answer, '2004', 'only the text after the thinking is the answer');
  assert.ok(!/We are given|<\/think>/.test(traced.result.answer));
  const unfinished = await run(task, { response: '<think>Let me look at the page. The year is', done: true, done_reason: 'stop' });
  assert.equal(unfinished.result.status, 'answer_unavailable', 'thinking that never ended is not an answer');
  assert.equal(unfinished.result.answer, undefined);
  // The reader is the small direct-answer model unless configured otherwise; a qwen3 reader is told not to think aloud.
  assert.equal(traced.models[0], process.env.COPILOT_READING_MODEL || 'qwen2.5:3b');
  if (!process.env.COPILOT_READING_MODEL) assert.ok(!traced.prompts[0].includes('/no_think'));
  const thinker = await run(task, { response: '2004', done: true, done_reason: 'stop' }, { model: 'qwen3:4b' });
  assert.equal(thinker.models[0], 'qwen3:4b');
  assert.ok(thinker.prompts[0].startsWith('/no_think'), 'qwen3 is told not to think aloud');
  for (const [raw, expected] of [
    ['2004', '2004'], ['<think>a</think>2004', '2004'], ['a\n</think>\n\n2004', '2004'],
    ['<THINK>a</THINK>\nLori Mills', 'Lori Mills'], ['<think>a</think>x<think>b</think>y', 'xy'],
    ['x</think>y</think>z', 'z'], ['<think>never ends', ''], ['answer <think>trailing', 'answer'], ['', ''], [null, '']
  ]) assert.equal(stripModelReasoning(raw), expected, String(raw));
  ok('the model\'s thinking is removed from the answer, and unfinished thinking gives no answer');

  // A direct question is correctly answered in a few words.
  const brief = await run(task, { response: 'Lori Mills.', done: true, done_reason: 'stop' });
  assert.equal(brief.result.status, 'answer_ready', String(brief.result.reason));
  assert.equal(brief.result.answer, 'Lori Mills.');
  const none = await run(task, { response: "I don't know.", done: true, done_reason: 'stop' });
  assert.equal(none.result.status, 'answer_unavailable', 'a reply that only says the answer is missing is not delivered');
  assert.equal(none.result.answer, undefined);
  ok('a short direct answer is delivered; a short non-answer is not');

  const cut = await run(task, { response: 'An incomplete answer.', done: true, done_reason: 'length' });
  assert.equal(cut.result.status, 'answer_unavailable');
  assert.equal(cut.result.answer, undefined, 'a cut-off answer is not delivered');
  assert.ok(cut.prompts.length >= 1, 'the reader was asked');
  ok('an unusable answer is still refused');

  for (const [answer, question, expected] of [
    ['Lori Mills.', "tell me his wife's name", true],
    ['2004', 'tell me facebook release year', true],
    ['Yes.', 'is he married', true],
    ['Facebook was launched in 2004.', 'when was facebook released', true],
    ['', 'tell me his wife', false],
    ['OK', 'tell me his wife', false],
    ['-', 'tell me his wife', false],
    ["I don't know.", 'tell me his wife', false],
    ['Unknown.', 'tell me his wife', false],
    ['N/A', 'tell me the year', false],
    ['Not mentioned.', 'tell me the year', false],
    ['The page does not say.', 'tell me the year', false],
    ['It is a company.', 'explain what the company does', false],
    ['It is software.', 'summarize the page', false],
    ['A long enough explanation of the company and what it does for customers.', 'explain what the company does', true]
  ]) assert.equal(isUsableAnswerLength(answer, question), expected, `${answer} | ${question}`);
  ok('the length rule: short answers to direct questions pass, empty, missing-answer and too-short explanations do not');

  // Asking to be told a fact is a question, like who/what/when.
  for (const asked of ['tell me facebook release year', "get me facebook's release year", "Tell me Jensen Huang's wife",
    'Can you tell me the CEO of Nvidia?', 'let me know the price', 'give me the founder name']) {
    assert.equal(isReadOnlyQuestion(asked), true, asked);
  }
  for (const action of ['show me the pricing page', 'get me the PDF report', 'give me the contact page', 'find the Contact page',
    'tell me the heading and then click Login', 'show me the picture', 'show me the release date', 'open the Sport page']) {
    assert.equal(isReadOnlyQuestion(action), false, action);
  }
  assert.equal(isInformationRequest('tell me the title'), true);
  assert.equal(isInformationRequest('click tell me'), false);
  ok('"tell me / get me <fact>" is a question; navigation and file requests are not');

  const direct = await run(`Tell me Jensen Huang's wife's name from ${base}/wiki/Jensen_Huang`, { response: 'Lori Mills.', done: true, done_reason: 'stop' });
  assert.equal(direct.result.status, 'answer_ready', String(direct.result.reason));
  assert.equal(direct.result.answer, 'Lori Mills.');
  assert.equal(direct.prompts.length, 1);
  assert.match(direct.prompts[0], /Lori Mills/);
  ok('"tell me <fact>" reads the opened page and answers instead of reporting success without an answer');

  // Direct questions ask for the fact; explanations keep their own instructions.
  const factual = await run(task, { response: 'Facebook was launched in 2004.', done: true, done_reason: 'stop' });
  assert.match(factual.systems[0], /direct question, answer in one short sentence/);
  assert.match(factual.systems[0], /Never state a fact that the source does not contain/);
  const explained = await run(`Explain what the page at ${base}/wiki/Jensen_Huang says about Nvidia`, { response: 'It describes Nvidia as a company that designs graphics processors for computers.', done: true, done_reason: 'stop' });
  assert.equal(explained.result.status, 'answer_ready', String(explained.result.reason));
  assert.ok(!/direct question/.test(explained.systems[0]), 'explanations are not forced into one sentence');
  ok('a direct question is answered with the fact in one sentence; an explanation is not shortened');

  // A reading model that is not installed says how to install it.
  const page404 = await (await browser.newContext()).newPage();
  console.log = () => {};
  let missing;
  try {
    missing = await executeNaturalLanguageTask(page404, task, { urlLess: true,
      orchestratorOptions: { agentOptions: { maxSteps: 3, approvalProvider: async () => null } },
      answerOptions: { model: 'not-installed:1b', fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) } });
  } finally { console.log = realLog; await page404.context().close(); }
  assert.equal(missing.status, 'answer_unavailable');
  assert.match(missing.reason, /"not-installed:1b" is not installed\. Run: ollama pull not-installed:1b/);
  ok('a reading model that is not installed is reported with the command to install it');

  // The reason shown with a failed answer is the answer step's own.
  const agentResult = { reason: 'Every requirement of the instruction is backed by browser evidence.' };
  assert.equal(
    deliveredReason({ result: { status: 'answer_unavailable', reason: 'No readable answer could be generated.' }, agentResult, deliveredStatus: 'answer_unavailable' }),
    'No readable answer could be generated.');
  assert.equal(
    deliveredReason({ result: { status: 'answer_ready' }, agentResult, deliveredStatus: 'answer_unavailable' }),
    'No usable answer was delivered.');
  assert.equal(
    deliveredReason({ result: { status: 'answer_unavailable' }, agentResult, deliveredStatus: 'answer_unavailable' }),
    'No usable answer was delivered.');
  assert.equal(deliveredReason({ result: { status: 'verified_complete' }, agentResult, deliveredStatus: 'verified_complete' }), agentResult.reason);
  assert.equal(deliveredReason({ result: { status: 'x', reason: 'r' }, agentResult: {}, deliveredStatus: 'x' }), 'r');
  assert.equal(deliveredReason({ result: {}, agentResult: {}, deliveredStatus: 'x' }), null);
  ok('a failed answer shows its own reason, not the agent\'s "verified" one');
} finally {
  console.log = realLog;
  await browser.close(); site.close();
}
realLog(`discovery-reading: ${passed} groups passed`);
