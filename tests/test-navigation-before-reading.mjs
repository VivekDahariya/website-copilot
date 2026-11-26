import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isReadOnlyQuestion } from '../src/agent/webpage-answer.js';
const trueCases = [
  'Read this webpage and explain what Playwright is. Do not click, navigate away, or modify anything.',
  'Open https://playwright.dev/docs/intro and explain the main steps. Do not modify anything.',
  'Read the current page. Do not open any other article.',
  'Explain how to open a Wikipedia article.',
  'How can I use Wikipedia search?',
  'What happens if I click Submit?',
  'List all eight components and explain the first three.',
  'Read this article and identify the main argument.'
];
const falseCases = [
  "Use Wikipedia's search to find Ada Lovelace. Open her Wikipedia article and identify her occupation and what she is best known for, using the article's introductory text. Do not edit Wikipedia, log in, or navigate to external websites.",
  'Search for Ada Lovelace, open her article, and explain her occupation.',
  'Navigate to the Ada Lovelace article and summarize its introduction.',
  'Read this page and then open the linked article and summarize it.',
  'Visit the documentation page and list its requirements.',
  'Go to the guide and explain its key steps.',
  'Open the article and identify its author.',
  'Read this page then click the Submit button.',
  'Explain this page and then download its PDF.'
];
for (const text of trueCases) assert.equal(isReadOnlyQuestion(text), true, `Read-only misclassified: ${text}`);
for (const text of falseCases) assert.equal(isReadOnlyQuestion(text), false, `Navigation/action misclassified: ${text}`);
// The task runner still calls the same classifier before reading; only the
// predicate changes. This test does not claim end-to-end article completion.
const source=readFileSync(new URL('../src/agent/natural-language-executor.js', import.meta.url),'utf8');
assert.match(source, /if \(isReadOnlyQuestion\(instruction\)\) \{/);
assert.match(source, /await interpretTask\(instruction,/);
console.log(`PASS: ${trueCases.length} read-only and ${falseCases.length} navigation/action routes correctly classified.`);
console.log('PASS: unchanged task executor still sends non-reading tasks through normal interpreter.');
