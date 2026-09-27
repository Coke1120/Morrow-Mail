import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutOfOffice, capability, providerPayload, OUT_OF_OFFICE_SCOPES } from '../server/out-of-office.js';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const A = 'one@example.invalid', B = 'two@example.invalid';
const input = { action: 'save', confirmed: true, mode: 'scheduled', start: '2090-10-01T08:00:00.000Z', end: '2090-10-02T09:00:00.000Z', subject: 'Away', message: '<script>literal</script>\nBack soon.', externalMessage: 'External only', audience: 'contacts', restrictToDomain: false };
function fixture(provider = 'google') {
  const accounts = { [A]: { email: A, provider, accessToken: 'PRIVATE-TOKEN', grantedScopes: OUT_OF_OFFICE_SCOPES[provider] }, [B]: { email: B, provider: 'imap', password: 'PRIVATE-PASSWORD' } };
  const f = { accounts, calls: [], busy: false, raw: provider === 'google' ? { enableAutoReply: true, responseBodyHtml: '<b>Provider formatted</b>', responseBodyPlainText: 'stale alternative', responseSubject: 'Original', restrictToContacts: true, restrictToDomain: true, startTime: '3810528000000', endTime: '3810614400000' } : { status: 'scheduled', internalReplyMessage: '<b>Inside</b>', externalReplyMessage: '<p>Outside</p>', externalAudience: 'all', scheduledStartDateTime: { dateTime: '2090-10-01T08:00:00.0000000', timeZone: 'UTC' }, scheduledEndDateTime: { dateTime: '2090-10-02T09:00:00', timeZone: 'UTC' } } };
  f.api = createOutOfOffice({ connections: () => accounts, currentMail: async account => accounts[account], lock: async work => { if (f.busy) throw Object.assign(new Error('busy'), { status: 409 }); f.busy = true; try { return await work(); } finally { f.busy = false; } }, request: async (url, options) => {
    assert.match(url, provider === 'google' ? /^https:\/\/gmail.googleapis.com\/gmail\/v1\/users\/me\/settings\/vacation$/ : /^https:\/\/graph.microsoft.com\/v1.0\/me\/mailboxSettings(?:\/automaticRepliesSetting)?$/);
    assert.equal(options.headers.Authorization, 'Bearer PRIVATE-TOKEN');
    f.calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (f.wait) await f.wait;
    if (options.method !== 'GET') { if (f.failWrite) throw new Error('SECRET-PROVIDER-ERROR'); f.raw = provider === 'google' ? JSON.parse(options.body) : { ...f.raw, ...JSON.parse(options.body).automaticRepliesSetting }; }
    return structuredClone(provider === 'microsoft' && options.method !== 'GET' ? { automaticRepliesSetting: f.raw } : f.raw);
  } });
  return f;
}

test('explicit settings consent, exact owner, IMAP unsupported and validation precede network', async () => {
  const f = fixture(); f.accounts[A].grantedScopes = 'https://www.googleapis.com/auth/gmail.modify';
  const value = await f.api.get(A); assert.equal(value.requiresReconnect, true); assert.equal(value.canRead, false);
  await assert.rejects(f.api.put(A, input), { status: 403 });
  for (const owner of ['', undefined, 'all', 'demo', A.toUpperCase(), '__proto__']) await assert.rejects(f.api.get(owner), { status: 409 });
  assert.equal((await f.api.get(B)).supported, false);
  await assert.rejects(f.api.put(B, input), /IMAP does not support/);
  assert.equal(f.calls.length, 0);
  assert.equal(capability({ provider: 'microsoft', grantedScopes: 'https://graph.microsoft.com/MailboxSettings.ReadWrite' }, A).canWrite, true);
  assert.equal(capability({ provider: 'microsoft', grantedScopes: 'MailboxSettings.Read' }, A).canWrite, false);
  for (const patch of [{ confirmed: false }, { action: 'send' }, { message: '' }, { subject: 'bad\r\nsubject' }, { message: 'a'.repeat(10001) }, { message: 'bad\0' }, { mode: 'unknown' }, { start: '2090-02-30T08:00:00Z' }, { start: '2090-10-03T08:00:00Z' }, { end: '2020-10-01T08:00:00Z' }]) assert.throws(() => providerPayload('google', { ...input, ...patch }));
  assert.throws(() => providerPayload('microsoft', { ...input, end: '' }));
  const gmail = providerPayload('google', { ...input, mode: 'always' });
  assert.equal(gmail.responseBodyPlainText, input.message); assert.ok(!('responseBodyHtml' in gmail)); assert.ok(!('startTime' in gmail)); assert.ok(!('endTime' in gmail));
  const graph = providerPayload('microsoft', input).automaticRepliesSetting;
  assert.equal(graph.internalReplyMessage, '&lt;script&gt;literal&lt;/script&gt;<br>Back soon.'); assert.equal(graph.externalReplyMessage, input.externalMessage); assert.equal(graph.externalAudience, 'contactsOnly'); assert.equal(graph.scheduledEndDateTime.timeZone, 'UTC');
});

test('Google provider GET/PUT uses revision, preserves rich templates on disable, rejects stale saves and busy writes', async () => {
  const f = fixture(), before = structuredClone(f.raw), loaded = await f.api.get(A);
  assert.equal(loaded.settings.message, 'Provider formatted'); assert.equal(loaded.settings.restrictToDomain, true);
  assert.doesNotMatch(JSON.stringify(loaded), /PRIVATE-|accessToken|<b>/);
  const disabled = await f.api.put(A, { action: 'disable', confirmed: true, revision: loaded.revision });
  assert.equal(disabled.settings.mode, 'disabled'); assert.deepEqual(f.raw, { ...before, enableAutoReply: false });
  const writes = f.calls.filter(c => c.method === 'PUT').length;
  await assert.rejects(f.api.put(A, { ...input, revision: loaded.revision }), { status: 409 });
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, writes);
  let release; f.wait = new Promise(resolve => { release = resolve; });
  const pending = f.api.get(A); await assert.rejects(f.api.put(A, { ...input, revision: disabled.revision }), { status: 409 }); release(); await pending; f.wait = null;
  const saved = await f.api.put(A, { ...input, revision: disabled.revision });
  assert.equal(saved.settings.mode, 'scheduled'); assert.equal(saved.settings.start, input.start);
  assert.equal(f.accounts[B].password, 'PRIVATE-PASSWORD');
});

test('Outlook separate messages, unknown timezone warning, failed write no retry and connection race discard', async () => {
  const f = fixture('microsoft');
  const loaded = await f.api.get(A); assert.equal(loaded.settings.message, 'Inside'); assert.equal(loaded.settings.externalMessage, 'Outside'); assert.equal(loaded.settings.start, input.start);
  f.raw.scheduledStartDateTime.timeZone = 'Pacific Standard Time';
  const unknown = await f.api.get(A); assert.equal(unknown.settings.start, ''); assert.match(unknown.scheduleWarning, /Re-enter/);
  const saved = await f.api.put(A, { ...input, revision: unknown.revision }); assert.equal(saved.settings.message, input.message); assert.equal(saved.settings.externalMessage, input.externalMessage);
  const before = structuredClone(f.raw);
  const off = await f.api.put(A, { action: 'disable', confirmed: true, revision: saved.revision }); assert.equal(off.settings.mode, 'disabled'); assert.deepEqual(f.raw, { ...before, status: 'disabled' });
  f.failWrite = true; const count = f.calls.length;
  await assert.rejects(f.api.put(A, { ...input, revision: off.revision }), error => error.status === 502 && !error.message.includes('SECRET') && error.message.includes('Refresh'));
  assert.equal(f.calls.length - count, 2);
  let release; f.wait = new Promise(resolve => { release = resolve; }); const work = f.api.get(A);
  await new Promise(resolve => setImmediate(resolve)); f.accounts[A] = { ...f.accounts[A], accessToken: 'REPLACED' }; release();
  await assert.rejects(work, { status: 409 });
});

test('standalone Out of Office view renders the provider-managed contract without local autosending', async t => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' }); t.after(() => vite.close());
  const { default: OutOfOffice } = await vite.ssrLoadModule('/src/OutOfOffice.jsx');
  const html = renderToStaticMarkup(React.createElement(OutOfOffice, { state: { account: { id: 'all', mode: 'all' } } }));
  assert.match(html, /continue while Morrow is closed/); assert.match(html, /Choose an individual connected mailbox/); assert.doesNotMatch(html, /Save and enable|Disable automatic replies/);
});
