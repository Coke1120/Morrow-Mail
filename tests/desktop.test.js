import test from 'node:test';
import assert from 'node:assert/strict';
import { isSignInURL, isExternalURL } from '../desktop/security.cjs';
test('desktop opens only the issued loopback sign-in shape or confirmed HTTPS links', () => {
  const base = 'http://127.0.0.1:39123', state = 'a'.repeat(64);
  for (const kind of ['oauth', 'calendar-oauth']) for (const provider of ['google', 'microsoft']) assert.equal(isSignInURL(`http://localhost:39123/api/${kind}/${provider}/authorize?state=${state}`, base), true);
  for (const url of [`http://localhost:39124/api/oauth/google/authorize?state=${state}`, `http://localhost:39123/api/oauth/google/callback?state=${state}`, `http://localhost:39123/api/oauth/google/authorize?state=${state}&next=https://bad.example`, `http://user@localhost:39123/api/oauth/google/authorize?state=${state}`, 'file:///C:/Windows/system32/cmd.exe', 'javascript:alert(1)', 'https://bad.example/', 'invalid']) assert.equal(isSignInURL(url, base), false);
  assert.equal(isExternalURL('https://github.com/Coke1120/Morrow-Mail'), true);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://localhost:22', 'https://user:pass@example.com', 'ms-settings:']) assert.equal(isExternalURL(url), false);
});

import { clientState } from '../desktop/client-state.cjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('desktop state persists recovery and disclosure across origins, validates keys and fails closed on corruption', t => {
  const directory = mkdtempSync(join(tmpdir(), 'morrow-state-')), file = join(directory, 'client-state.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pending = JSON.stringify({ requestId: 'original-id', review: { provider: 'google', title: 'Reviewed event' } });
  clientState(file, 'set', 'morrow.pendingCalendar', pending);
  clientState(file, 'set', 'morrow.account.collapsed.work@example.com', 'true');
  const calendars = JSON.stringify({ '["google","primary"]': true, '["microsoft","primary"]': false });
  clientState(file, 'set', 'morrow.calendar.checked', calendars);
  assert.equal(clientState(file, 'get', 'morrow.calendar.checked'), calendars);
  assert.throws(() => clientState(file, 'set', 'morrow.calendar.checked', 'x'.repeat(32769)));
  assert.equal(clientState(file, 'get', 'morrow.pendingCalendar'), pending);
  assert.equal(clientState(file, 'get', 'morrow.account.collapsed.work@example.com'), 'true');
  assert.throws(() => clientState(file, 'set', '__proto__', 'bad'));
  assert.throws(() => clientState(file, 'set', 'morrow.calendar.arbitrary', 'bad'));
  assert.throws(() => clientState(file, 'set', 'morrow.pendingCalendar', 'x'.repeat(32769)));
  assert.equal(clientState(file, 'get', 'morrow.pendingCalendar'), pending);
  clientState(file, 'remove', 'morrow.pendingCalendar');
  assert.equal(clientState(file, 'get', 'morrow.pendingCalendar'), null);
  writeFileSync(file, '{');
  assert.throws(() => clientState(file, 'set', 'morrow.pendingCalendar', pending));
});
