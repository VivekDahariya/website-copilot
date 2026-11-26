// A password the user wrote into the task: what counts as one, and that the
// redacted text keeps everything else.
import assert from 'node:assert/strict';
import { extractStatedPassword, redactStatedPassword } from '../src/agent/direct-instruction.js';

const cases = [
  ['Log in with username tomsmith and password SuperSecretPassword!', 'SuperSecretPassword!',
   'Log in with username tomsmith and password'],
  ['Log in as tomsmith, password: hunter2, then open the profile', 'hunter2',
   'Log in as tomsmith, password, then open the profile'],
  ['Sign in with password "my pass phrase." and username bob', 'my pass phrase.',
   'Sign in with password and username bob'],
  ['login with password is abc123.', 'abc123', 'login with password.'],
  ['Log in with Password=Zx9-stated', 'Zx9-stated', 'Log in with Password'],
  // Not a stated password: nothing to hand to the field.
  ['Log in with username tomsmith', null, 'Log in with username tomsmith'],
  ['Fill the password field and click Login', null, 'Fill the password field and click Login'],
  ['Enter the password and continue', null, 'Enter the password and continue'],
  ['Open the password reset page', null, 'Open the password reset page']
];
for (const [text, value, redacted] of cases) {
  assert.equal(extractStatedPassword(text), value, text);
  assert.equal(redactStatedPassword(text), redacted, text);
  if (value) assert.ok(!redactStatedPassword(text).includes(value), `${text}: value removed`);
}
console.log(`stated-password: ${cases.length} groups passed`);
