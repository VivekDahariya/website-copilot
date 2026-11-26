import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const originalModel = process.env.COPILOT_OLLAMA_MODEL;
const originalReadModel = process.env.COPILOT_READING_MODEL;

const defaultModel = 'qwen3:4b';
const readingModel = 'qwen2.5:3b';
process.env.COPILOT_OLLAMA_MODEL = defaultModel;
process.env.COPILOT_READING_MODEL = readingModel;

const [{ answerWebpage, isReadOnlyQuestion }, { interpretTask }] = await Promise.all([
  import('../src/agent/webpage-answer.js?model-routing=reading'),
  import('../src/agent/task-interpreter.js')
]);

const browser = await chromium.launch({
  headless: true,
  ...(existsSync('/usr/bin/chromium')
    ? { executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] }
    : {})
});
try {
  const page = await browser.newPage();
  await page.setContent(`<html><head><title>Widget guide</title></head><body>
    <main><h1>Widget toolkit</h1>
    <p>The Widget toolkit lets developers create accessible user interfaces.
    It provides reusable buttons, dialogs, navigation, input controls and menus.</p>
    <p>The documented system supports keyboard interaction and screen reader
    descriptions for common components. The guide describes tests and examples.</p></main>
  </body></html>`);
  const url = 'https://reading-fixture.test/widgets';
  const readingPage = {
    url: () => url,
    evaluate: async callback => {
      const value = await page.evaluate(callback);
      return value && typeof value === 'object' && 'url' in value
        ? { ...value, url }
        : value;
    }
  };
  const instruction = 'Explain the widget toolkit and its documented capabilities. Do not modify anything.';
  assert.equal(isReadOnlyQuestion(instruction), true);
  const htmlBefore = await page.locator('body').innerHTML();
  const checkReadingModel = async (answerFn, expectedModel, explicitModel) => {
    const models = [];
    const response = await answerFn(readingPage, instruction, {
      ...(explicitModel ? { model: explicitModel } : {}),
      fetchImpl: async (_url, options) => {
        models.push(JSON.parse(options.body).model);
        return {
          ok: true,
          json: async () => ({
            response: 'The Widget toolkit provides reusable user-interface components such as buttons, dialogs, navigation, input controls and menus. It supports accessibility and keyboard interaction.',
            done: true,
            done_reason: 'stop'
          })
        };
      }
    });
    assert.equal(response.status, 'answer_ready', JSON.stringify(response));
    assert.deepEqual(models, [expectedModel], 'Read-only model selection must be deterministic');
    assert.equal(await page.locator('body').innerHTML(), htmlBefore, 'Reading must not edit page');
  };
  await checkReadingModel(answerWebpage, readingModel);
  console.log('PASS: Reading uses COPILOT_READING_MODEL while preserving read-only browser state.');

  const browserModels = [];
  const interpreted = await interpretTask('Open the widget documentation page.', {
    fetchImpl: async (_url, options) => {
      browserModels.push(JSON.parse(options.body).model);
      return {
        ok: true,
        json: async () => ({
          response: JSON.stringify({
            type: 'browser_goal', goal: { type: 'page_destination', heading: 'Widget toolkit' }
          }),
          done: true, done_reason: 'stop'
        })
      };
    },
    currentUrl: url
  });
  assert.equal(interpreted.status, 'interpreted', JSON.stringify(interpreted));
  assert.deepEqual(browserModels, [defaultModel]);
  console.log('PASS: Browser-goal interpretation still uses COPILOT_OLLAMA_MODEL.');

  await checkReadingModel(answerWebpage, 'injected-model-for-test', 'injected-model-for-test');
  console.log('PASS: Explicit caller model overrides the configured reading default.');

  delete process.env.COPILOT_READING_MODEL;
  const { answerWebpage: fallbackAnswer } = await import('../src/agent/webpage-answer.js?model-routing=fallback');
  await checkReadingModel(fallbackAnswer, 'qwen2.5:3b');
  console.log('PASS: Without a reading override, reading uses the small direct-answer model, not the planner model.');
} finally {
  await browser.close();
  if (originalModel === undefined) delete process.env.COPILOT_OLLAMA_MODEL;
  else process.env.COPILOT_OLLAMA_MODEL = originalModel;
  if (originalReadModel === undefined) delete process.env.COPILOT_READING_MODEL;
  else process.env.COPILOT_READING_MODEL = originalReadModel;
}
