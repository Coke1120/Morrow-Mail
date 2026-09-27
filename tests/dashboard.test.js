import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('Today uses the local report day, safe account scope and downloaded totals without generating work', async t => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  t.after(() => vite.close());
  const { default: Dashboard, todayReports } = await vite.ssrLoadModule('/src/Dashboard.jsx');
  const { default: Studio } = await vite.ssrLoadModule('/src/Studio.jsx');
  const originalTZ = process.env.TZ;
  try {
    for (const zone of ['Asia/Hong_Kong', 'America/New_York']) {
      process.env.TZ = zone;
      for (const month of [2, 10]) {
        // US spring/fall DST days: calendar boundaries, not a fixed 24-hour window.
        const day = month === 2 ? 8 : 1;
        const now = new Date(2026, month, day, 12), start = new Date(2026, month, day), next = new Date(2026, month, day + 1);
        const yesterday = new Date(start.getTime() - 1).toISOString(), today = start.toISOString();
        const rows = [
          { id: 'finished-today', status: 'completed', createdAt: yesterday, completedAt: today },
          { id: 'finished-before', status: 'completed', createdAt: today, completedAt: yesterday },
          { id: 'queued-today', status: 'queued', createdAt: today },
          { id: 'running-before', status: 'running', createdAt: yesterday },
          { id: 'failed-today', status: 'failed', createdAt: today, completedAt: yesterday },
          { id: 'last-local-millisecond', status: 'completed', completedAt: new Date(next.getTime() - 1).toISOString() },
          { id: 'tomorrow', status: 'queued', createdAt: next.toISOString() },
          { id: 'missing-completion', status: 'completed', createdAt: today },
          { id: 'empty-completion', status: 'completed', completedAt: '', createdAt: today },
          { id: 'invalid', status: 'queued', createdAt: 'invalid' },
          null,
        ];
        assert.deepEqual(todayReports(rows, now).map(report => report.id), ['last-local-millisecond', 'finished-today', 'queued-today', 'failed-today', 'missing-completion', 'empty-completion'], zone);
        assert.equal(todayReports(Array.from({ length: 30 }, (_, id) => ({ id, status: 'queued', createdAt: today })), now).length, 20);
        assert.deepEqual(todayReports(null, now), []);
      }
    }
  } finally { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; }

  const now = new Date(2026, 8, 27, 12), date = now.toISOString();
  const one = { id: 'one@example.invalid', email: 'one@example.invalid', unread: 2, counts: { inbox: 11, drafts: 3 } };
  const two = { id: 'two@example.invalid', email: 'two@example.invalid', unread: 5, counts: { inbox: 17, drafts: 4 } };
  const reports = ['completed', 'queued', 'running', 'failed', 'interrupted'].map((status, index) => ({ id: String(index), status, kind: index ? 'arrival' : 'scheduled', createdAt: date, completedAt: date, messageIds: ['fixture-id'], ...(status === 'completed' ? { text: 'OWNER-ONE-SUMMARY <script>untrusted</script>' } : status === 'failed' ? { error: 'Summary could not be generated.' } : {}) }));
  const state = { account: one, accounts: [one, two], settings: {}, workspace: { summaries: reports } };
  const render = (value, busy = false) => renderToStaticMarkup(React.createElement(Dashboard, { state: value, busy, now, onSelectAccount() {}, onSettings() {}, onStudio() {}, onInbox() {} }));
  const html = render(state);
  assert.match(html, /Today’s summaries/); assert.match(html, /Local time/);
  assert.match(html, /Unread Inbox<\/dt><dd>2<\/dd>/); assert.match(html, /Inbox<\/dt><dd>11<\/dd>/); assert.match(html, /Drafts<\/dt><dd>3<\/dd>/);
  assert.match(html, /Downloaded mail totals, not messages received today/);
  assert.match(html, /latest 20 available reports/); assert.match(html, /does not generate AI work/);
  assert.match(html, /OWNER-ONE-SUMMARY &lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Waiting for background processing/); assert.match(html, /AI is preparing this summary/);
  assert.match(html, /Summary could not be generated/); assert.match(html, /does not retry jobs/);
  assert.match(html, /Summary history/); assert.match(html, /AI permissions/);
  assert.match(html, />Unread Inbox<\/button>/);
  const combined = render({ ...state, account: { id: 'all' } });
  assert.match(combined, /Unread Inbox<\/dt><dd>7<\/dd>/); assert.match(combined, /Inbox<\/dt><dd>28<\/dd>/); assert.match(combined, /Drafts<\/dt><dd>7<\/dd>/);
  assert.match(combined, /Show Today for one@example.invalid/); assert.match(combined, /Show Today for two@example.invalid/);
  assert.match(combined, /AI summaries stay separate for each account/); assert.doesNotMatch(combined, /OWNER-ONE-SUMMARY/);
  const switched = render({ ...state, account: two, workspace: { summaries: [{ ...reports[0], text: 'OWNER-TWO-SUMMARY' }] } });
  assert.match(switched, /OWNER-TWO-SUMMARY/); assert.doesNotMatch(switched, /OWNER-ONE-SUMMARY/);
  const disconnected = render({ ...state, accounts: [two] });
  assert.doesNotMatch(disconnected, /OWNER-ONE-SUMMARY/);
  assert.match(disconnected, /Show Today for two@example.invalid/);
  assert.match(render({ ...state, workspace: { summaries: [] } }), /No summaries for today/);
  assert.match(render(state, true), /aria-busy="true"/);
  assert.match(render(state, true), /aria-label="Show Today for two@example.invalid"[^>]*disabled=""/);
  const fresh = render({ account: { id: 'demo' }, accounts: [{ id: 'demo', email: 'hidden-demo' }], workspace: { summaries: reports } });
  assert.match(fresh, /Add your first account/); assert.doesNotMatch(fresh, /hidden-demo|OWNER-ONE-SUMMARY/);
  const history = renderToStaticMarkup(React.createElement(Studio, { state, initialTab: 'summaries' }));
  assert.match(history, /aria-label="Scheduled and new-mail summaries"/);
  assert.match(history, /OWNER-ONE-SUMMARY/);
  assert.doesNotMatch(history, /class="studio-feature-grid"/);
});
