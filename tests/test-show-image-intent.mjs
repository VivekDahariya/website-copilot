// What counts as asking to SEE a picture (fetched to a file and shown in the
// dashboard), as opposed to clicking one, saving one, or naming a gallery link.
import assert from 'node:assert/strict';
import { asksToShowImage, asksForImageFile, asksToSaveImage } from '../src/agent/direct-instruction.js';

const cases = [
  ['Show me the main image on the page', true],
  ['Open the first image', true],
  ['View the picture', true],
  ['Display all the images', true],
  ['Preview the first photo', true],
  ['Open the first image and download it', true],
  ['Click the first image on the page', false],
  ['Open the image gallery link', false],
  ['Open the pictures page', false],
  ['Do not show the image', false],
  ['Save the first image', false],
  ['Show me the page', false],
  ['Open the login page', false]
];
for (const [text, expected] of cases) assert.equal(asksToShowImage(text), expected, text);
// A file is needed for either wording.
assert.equal(asksForImageFile('Save the first image'), true);
assert.equal(asksForImageFile('Show me the first image'), true);
assert.equal(asksForImageFile('Click the first image'), false);
assert.equal(asksToSaveImage('Show me the first image'), false, 'saving is still its own request');
console.log(`show-image-intent: ${cases.length + 4} checks passed`);
