// A small local website for the reliability battery. Every page is plain HTML,
// served from this machine, so a run depends only on CoPilot and the model.
// The site records what was submitted or deleted, so the battery can check the
// real outcome itself instead of trusting what CoPilot reports.
import http from 'node:http';
import net from 'node:net';

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>` +
  `<header><nav><a href="/">Home</a> <a href="/products">Products</a> <a href="/about">About</a> ` +
  `<a href="/contact">Contact</a> <a href="/pricing">Pricing</a></nav></header><main>${body}</main></body></html>`;

const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export async function createFixtureSite() {
  const state = { submissions: [], deleted: false };
  const pages = {
    '/': page('Acme Studio', '<h1>Acme Studio</h1><p>Welcome to Acme Studio. We build small tools for teams.</p>'),
    '/products': page('Products - Acme', '<h1>Products</h1><ul><li><a href="/products/widget">Widget</a></li><li><a href="/products/gadget">Gadget</a></li></ul>'),
    '/products/widget': page('Widget - Acme', '<h1>Widget</h1><p>The Widget costs $49 and ships in 3 days.</p>'),
    '/products/gadget': page('Gadget - Acme', '<h1>Gadget</h1><p>The Gadget costs $89 and ships in 5 days.</p>'),
    '/about': page('About - Acme', '<h1>About Acme</h1><p>Acme was founded in 1998 in Lisbon by Maria Santos. The team has 42 people and works remotely.</p>'),
    '/pricing': page('Pricing - Acme', '<h1>Pricing</h1><p>Plans: Starter $10 per month, Team $30 per month.</p>'),
    '/contact': page('Contact - Acme', '<h1>Contact us</h1><form method="post" action="/contact">' +
      '<p><label>Name <input type="text" name="name"></label></p>' +
      '<p><label>Topic <select name="topic"><option value="">Choose a topic</option><option value="sales">Sales</option><option value="support">Support</option><option value="billing">Billing</option></select></label></p>' +
      '<p><label><input type="checkbox" name="subscribe" value="yes"> Subscribe to the newsletter</label></p>' +
      '<p><label>Message <textarea name="message"></textarea></label></p>' +
      '<p><button type="submit">Send message</button></p></form>'),
    // Hard-situation pages. They are reached from /resources, /press or their own
    // address, so the original cases and their navigation are unchanged.
    '/resources': page('Resources - Acme', '<h1>Resources</h1><ul>' +
      '<li><a href="/reports">Reports</a></li>' +
      '<li><a href="/docs/guide" target="_blank">User guide</a></li>' +
      '<li><a href="/press">Press room</a></li></ul>'),
    // Answers only after a pause, like a page that is slow to respond.
    '/reports': page('Reports - Acme', '<h1>Reports</h1><p>The total revenue for 2023 was 1,240 thousand dollars across all regions.</p>'),
    '/docs/guide': page('User guide - Acme', '<h1>User guide</h1><p>For help, write to help@acme.test. Support answers within one working day.</p>'),
    // A cookie notice that covers the whole window and blocks every click
    // underneath it until it is answered.
    '/press': page('Press room - Acme', '<h1>Press room</h1><p>Downloads and contacts for journalists.</p>' +
      '<p><a href="/press/annual-report">Annual report</a></p>' +
      '<div id="cookie" role="dialog" aria-label="Cookie consent" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:flex-end">' +
      '<div style="background:#fff;padding:24px;width:100%"><p>We use cookies to improve your experience.</p>' +
      '<button type="button" onclick="document.getElementById(\'cookie\').remove()">Accept all cookies</button></div></div>'),
    '/press/annual-report': page('Annual report - Acme', '<h1>Annual report</h1><p>The annual report covers the year 2023 in full.</p>'),
    '/account': page('Account - Acme', '<h1>Account</h1><p>Signed in as a demo user.</p><form method="post" action="/account/delete"><button type="submit">Delete account</button></form>')
  };
  const server = http.createServer((request, response) => {
    const path = new URL(request.url, 'http://x').pathname;
    const send = (status, html) => { response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); };
    if (request.method === 'POST') {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(raw));
        if (path === '/contact') {
          state.submissions.push(form);
          return send(200, page('Thank you', `<h1>Thank you, ${escapeHtml(form.name || 'friend')}</h1><p>We received your message.</p>`));
        }
        if (path === '/account/delete') {
          state.deleted = true;
          return send(200, page('Account deleted', '<h1>Account deleted</h1>'));
        }
        send(404, page('Not found', '<h1>Not found</h1>'));
      });
      return;
    }
    if (pages[path]) {
      const pause = path === '/reports' ? Number(process.env.COPILOT_BATTERY_SLOW_MS ?? 4000) : 0;
      return pause > 0 ? void setTimeout(() => send(200, pages[path]), pause) : send(200, pages[path]);
    }
    send(404, page('Not found', '<h1>Not found</h1><p>No such page.</p>'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // An address on this machine where nothing is listening.
  const deadBase = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(`http://127.0.0.1:${port}`)); });
  });
  return {
    base, deadBase, state,
    reset() { state.submissions.length = 0; state.deleted = false; },
    close: () => new Promise(resolve => server.close(resolve))
  };
}
