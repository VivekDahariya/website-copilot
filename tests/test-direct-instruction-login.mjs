// Logging in through the direct loop. The password is typed by the person
// (a stand-in here), never by the model; "log in" is complete only once the
// page is past the login form. A scripted model picks the actions.
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { executeNaturalLanguageTask } from '../src/agent/natural-language-executor.js';
import { createActionApproval } from '../src/agent/action-approval.js';
import { createNavigationActionTree } from '../src/agent/navigation-tree.js';
process.env.COPILOT_HEADLESS = '1';
delete process.env.COPILOT_DIRECT_INSTRUCTION;

const SECRET = 's3cret';
const STATED = 'Zx9-stated';
const login = `<title>Login Page</title><h2>Login Page</h2>
<p>Enter tomsmith and ${SECRET} to continue.</p><div id="flash"></div>
<form id="login" action="/authenticate" method="post" onsubmit="var u=this.username.value,p=this.password.value;
if(u==='tomsmith'&&(p==='${SECRET}'||p==='${STATED}')){location='/secure'}else{document.getElementById('flash').textContent='Your password is invalid!';this.reset()}return false">
<input name="username" aria-label="Username"><input name="password" type="password" aria-label="Password">
<button type="submit">Login</button></form>`;
const pages = {
  '/': '<title>Welcome</title><h2>Welcome</h2><a href="/login">Sign in</a>',
  '/login': login,
  // Two password fields: a sign-up form, not a sign-in form.
  '/signup': '<title>Sign up</title><h2>Create account</h2><form action="/register" method="post" onsubmit="location=\'/secure\';return false"><input name="username" aria-label="Username"><input type="password" aria-label="Password"><input type="password" aria-label="Confirm password"><button type="submit">Sign in</button></form>',
  // A warning that was already there, and a form that answers with nothing at all.
  '/static': `<title>Login Page</title><h2>Login Page</h2><p>Invalid logins are recorded.</p><form onsubmit="this.reset();return false"><input name="username" aria-label="Username"><input name="password" type="password" aria-label="Password"><button type="submit">Login</button></form>`,
  '/secure': '<title>Secure Area</title><h2>Secure Area</h2><p>You logged into a secure area!</p><a href="/">Logout</a>'
};
const server = http.createServer((request, response) => {
  const body = pages[request.url];
  response.writeHead(body ? 200 : 404, {'content-type':'text/html'});
  response.end(body ? `<!doctype html><html><body>${body}</body></html>` : 'missing');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// Steps: [label pattern, operation, value].
const cases = [
 // Seen live: only the username was filled and the run claimed success.
 {name:'username alone is not a login', start:'/login', instruction:'Log in with username tomsmith',
  script:[[/Username/,'fill','tomsmith']], expect:'unverified_completion_claim', ops:['fill']},
 // The page prints the password; the model tries to type it. It must reach
 // the person instead, who types it. Then Login is clicked and verified.
 {name:'password is handed to the person', start:'/login', instruction:'Log in with username tomsmith',
  script:[[/Username/,'fill','tomsmith'],[/Password/,'fill',SECRET],[/^Login$/,'click','']],
  expect:'verified_complete', ops:['fill','human_handover','click'], final:'/secure', handovers:1},
 // Seen live: after the login worked the model clicked Logout, undoing it.
 {name:'a login is not undone by logging out', start:'/login', instruction:'Log in with username tomsmith',
  script:[[/Username/,'fill','tomsmith'],[/Password/,'fill',SECRET],[/^Login$/,'click',''],[/Logout/,'click','']],
  expect:'verified_complete', ops:['fill','human_handover','click'], final:'/secure', handovers:1},
 // Seen live: Login pressed with no password, then called complete.
 {name:'login with an empty password is not complete', start:'/login',
  instruction:'Log in with username tomsmith and then click Login',
  script:[[/Username/,'fill','tomsmith'],[/^Login$/,'click','']],
  // The site answers the empty login in its own words; those words are reported.
  expect:'login_rejected', ops:['fill','click'], final:'/login', said:'Your password is invalid!'},
 // Logging in is what was asked, so the login button needs no approval.
 // Only that button: the same click is still approved when the user did not
 // ask to log in, and a sign-up form's button is never exempt.
 {name:'the login button needs no approval when logging in was asked', start:'/login', instruction:'Log in with username tomsmith',
  script:[[/Username/,'fill','tomsmith'],[/Password/,'fill',SECRET],[/^Login$/,'click','']],
  expect:'verified_complete', ops:['fill','human_handover','click'], final:'/secure', handovers:1, approvals:0},
 {name:'clicking Login without asking to log in is still approved', start:'/login', instruction:'Fill username tomsmith and click Login',
  script:[[/Username/,'fill','tomsmith'],[/^Login$/,'click','']],
  expect:'approval_required', ops:['fill'], approvals:1, deny:true},
 {name:'a sign-up form button is still approved', start:'/signup', instruction:'Log in with username tomsmith',
  script:[[/Username/,'fill','tomsmith'],[/^Sign in$/,'click','']],
  expect:'approval_required', ops:['fill'], approvals:1, deny:true},
 // The user wrote the password in the task: it is typed from that text, not
 // from the model's proposal (a wrong one here) and not from the page. The
 // value never reaches the model or the run record.
 {name:'a password written in the task is typed from the task', start:'/login',
  instruction:`Log in with username tomsmith and password ${STATED}`,
  script:[[/Username/,'fill','tomsmith'],[/Password/,'fill','WRONG-FROM-MODEL'],[/^Login$/,'click','']],
  expect:'verified_complete', ops:['fill','fill','click'], final:'/secure', handovers:0, approvals:0, secrets:[STATED,'WRONG-FROM-MODEL'], tree:true},
 // Seen live: a wrong stated password was typed again and again. It is typed
 // once; when the site rejects it, the next password field goes to the person.
 // A rejected login ends the run at once, in the site's own words; the password is
 // never typed a second time and nothing else is tried.
 {name:'a rejected stated password ends the run, quoting the page', start:'/login',
  instruction:'Log in with username tomsmith and password "nope"',
  script:[[/Username/,'fill','tomsmith'],[/Password/,'fill',SECRET],[/^Login$/,'click',''],[/Username/,'fill','tomsmith'],[/Password/,'fill',SECRET],[/^Login$/,'click','']],
  expect:'login_rejected', ops:['fill','fill','click'], final:'/login', handovers:0, secrets:['nope'], tree:true, said:'Your password is invalid!', planned:3},
 // A wrong stated password is typed as written and the login fails honestly.
 {name:'a wrong stated password is not a login', start:'/login',
  instruction:'Log in with username tomsmith and password "nope"',
  script:[[/Username/,'fill','tomsmith'],[/Password/,'fill',SECRET],[/^Login$/,'click','']],
  expect:'login_rejected', ops:['fill','fill','click'], final:'/login', handovers:0, secrets:['nope'], said:'Your password is invalid!'},
 // A warning that was on the page before the button was pressed is not the site's answer.
 {name:'a warning already on the page is not a rejection', start:'/static',
  instruction:'Log in with username tomsmith and password "nope"',
  script:[[/Username/,'fill','tomsmith'],[/Password/,'fill',SECRET],[/^Login$/,'click','']],
  expect:'unverified_completion_claim', ops:['fill','fill','click'], final:'/static', handovers:0, secrets:['nope']},
 // Naming the link or button is not asking to log in.
 {name:'clicking the Sign in link is complete', start:'/', instruction:'Click the "Sign in" link',
  script:[[/Sign in/,'click','']], expect:'verified_complete', ops:['click'], final:'/login'}
];

const browser = await chromium.launch({headless:true});
const realFetch = globalThis.fetch; const realLog = console.log;
let passed = 0;
try {
  for (const c of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base + c.start);
    let calls = 0, handovers = 0, approvals = 0;
    const prompts = [];
    const tree = createNavigationActionTree();
    globalThis.fetch = async (_url, request) => {
      prompts.push(String(request.body));
      const payload = JSON.parse(JSON.parse(request.body).messages[1].content);
      const step = c.script[calls++];
      const reply = action => ({ok:true, json: async () => ({message:{content:JSON.stringify(action)}})});
      if (!step) return reply({ref:'', operation:'done', value:''});
      const element = (payload.availableElements ?? []).find(item => step[0].test(String(item.label ?? '')));
      assert.ok(element, `${c.name}: the planner is shown "${step[0].source}"`);
      return reply({ref:element.ref, operation:step[1], value:step[2]});
    };
    console.log = () => {};
    let result;
    try {
      result = await executeNaturalLanguageTask(page, c.instruction, {orchestratorOptions:{agentOptions:{
        maxSteps:8,
        onAgentEvent: event => tree.record(event),
        humanHandoverProvider: async ({targetHandle}) => {
          handovers += 1;
          await targetHandle.fill(SECRET);
          return {completed:true};
        },
        approvalProvider: async ctx => {
          approvals += 1;
          return c.deny ? null : createActionApproval(ctx.action,
            {pageUrl:ctx.pageUrl, targetIdentity:ctx.targetIdentity});
        }
      }}});
    } finally { console.log = realLog; }
    const run = result.execution?.result ?? {};
    assert.equal(result.status, c.expect, `${c.name}: ${run.reason ?? ''}`);
    assert.deepEqual((run.history ?? []).map(entry => entry.decision.operation), c.ops, c.name);
    if (c.final) assert.equal(String(run.finalUrl ?? '').replace(base, ''), c.final, `${c.name}: final page`);
    assert.equal(handovers, c.handovers ?? 0, `${c.name}: handovers`);
    if (c.tree) {
      const edges = tree.snapshot().edges;
      assert.ok(!edges.some(edge => edge.status === 'not_executed'), `${c.name}: no step is shown as not executed`);
      assert.equal(edges.length, c.ops.length, `${c.name}: one tree edge per action`);
    }
    if (c.approvals !== undefined) assert.equal(approvals, c.approvals, `${c.name}: approvals asked`);
    if (c.said) assert.ok(String(run.reason ?? '').includes(c.said) && run.pageMessage === c.said, `${c.name}: the site's own words are quoted: ${run.reason}`);
    if (c.planned) assert.equal(calls, c.planned, `${c.name}: the planner is not asked again after the rejection`);
    assert.ok(!JSON.stringify(run.history ?? []).includes(SECRET), `${c.name}: the password is not recorded`);
    for (const secret of c.secrets ?? []) {
      assert.ok(!prompts.some(body => body.includes(secret)), `${c.name}: "${secret}" never reaches the model`);
      assert.ok(!JSON.stringify(run.history ?? []).includes(secret), `${c.name}: "${secret}" is not recorded`);
    }
    await context.close();
    passed += 1;
    console.log(`PASS: ${c.name} -> ${result.status}`);
  }
  console.log(`direct-instruction-login: ${passed} groups passed`);
} finally {
  globalThis.fetch = realFetch; console.log = realLog;
  await browser.close();
  server.close();
}
