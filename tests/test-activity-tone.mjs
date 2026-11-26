// The colour of each activity line in the dashboard. A failed or unverified run
// must never look like a success (the old rule matched "verified" inside
// "unverified_completion_claim" and "successful" inside "unsuccessful").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const start = html.indexOf('/*tone-start*/'), end = html.indexOf('/*tone-end*/');
assert.ok(start >= 0 && end > start, 'activityTone is present in the dashboard');
const statuses = html.match(/const successStatuses=new Set\(\[([^\]]*)\]\)/);
assert.ok(statuses, 'success statuses are defined in the dashboard');
const successStatuses = new Set(statuses[1].split(',').map(item => item.trim().replace(/['"]/g, '')));
const activityTone = new Function('successStatuses',
  html.slice(start + '/*tone-start*/'.length, end) + '; return activityTone;')(successStatuses);

const cases = [
  ['Agent finished: verified_complete', 'success'],
  ['Agent finished: persisted_complete', 'success'],
  ['Agent finished: answer_ready', 'success'],
  ['Agent finished: download_ready', 'success'],
  ['Agent finished: unverified_completion_claim', 'danger'],
  ['Agent finished: login_rejected', 'danger'],
  ['Agent finished: refused_by_policy', 'danger'],
  ['Agent finished: action_outcome_unverified', 'warning'],
  ['Agent finished: step_limit_reached', 'warning'],
  ['Agent finished: needs_clarification', 'warning'],
  ['Browser closed after terminal unsuccessful run.', 'danger'],
  ['Goal verified against current browser state.', 'success'],
  ['Selected click on e1', ''],
  ['Observed: The Internet', ''],
  ['click on e8: executed; verification pending', ''],
  ['Evidence ledger: 1 checks tracked · 5 verifier snapshots · 1 action receipts · 0 protected-state alerts.', ''],
  ['Run metrics: 4 Ollama HTTP calls · 26789 ms model', ''],
  ['Login rejected by the site: Your password is invalid!', 'danger'],
  ['Approval required before continuing', 'warning']
];
for (const [text, expected] of cases) assert.equal(activityTone(text), expected, text);
console.log(`activity-tone: ${cases.length} cases passed`);
