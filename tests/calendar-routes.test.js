import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';

const connection = provider => ({ provider, purpose: 'calendar', email: `${provider}@example.com`, clientId: `${provider}-client`, clientSecret: 'private-client-secret', accessToken: 'private-access-token', refreshToken: 'private-refresh-token', expiresAt: Date.now() + 3600_000 });
const calendar = { id: 'primary-calendar', name: 'My calendar', primary: true, canWrite: true, timeZone: 'UTC' };
const eventInput = () => ({ calendarId: calendar.id, title: 'Planning', description: 'A meeting', location: 'Office', start: '2026-10-01T09:00:00+08:00', end: '2026-10-01T10:00:00+08:00', requestId: randomUUID(), connectionEmail: 'google@example.com' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function workspace(t, services = {}) {
  const directory = mkdtempSync(`${tmpdir()}/morrow-calendar-`), store = createStore(directory), server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const mocks = { refreshMail: async value => value, listCalendars: async () => [calendar], listCalendarEvents: async () => [], createCalendarEvent: async (_, value) => ({ id: 'event-1', ...value }), oauthFinish: async provider => connection(provider), ...services };
  const restart = () => { server.removeAllListeners('request'); server.on('request', createApp({ store, port, appUrl: origin, services: mocks })); };
  restart();
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const outgoing = httpRequest(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => { const raw = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, headers: response.headers, raw, data: response.headers['content-type']?.includes('application/json') ? JSON.parse(raw) : null }); });
    });
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { store, request, restart, directory, port };
}

test('calendar OAuth binds browser, uses calendar scopes, is single use, and leaves mailbox independent', async t => {
  const finished = [];
  const { store, request, directory, port } = await workspace(t, { oauthFinish: async (provider, value) => { finished.push(value); return connection(provider); } });
  store.setSettings({ activeAccount: 'mail@example.com', mail: { email: 'mail@example.com', provider: 'google' } });
  for (const provider of ['google', 'microsoft']) {
    const started = await request(`/api/calendars/${provider}/connect`, { clientId: `${provider}-client`, clientSecret: 'private-client-secret' });
    assert.equal(started.status, 200);
    const local = new URL(started.data.url);
    assert.equal(local.hostname, 'localhost');
    assert.equal(local.port, String(port));
    const authorize = await request(local.pathname + local.search, undefined, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(authorize.status, 302);
    const remote = new URL(authorize.headers.location);
    assert.match(remote.searchParams.get('scope'), provider === 'google' ? /calendar/ : /Calendars.ReadWrite/);
    assert.doesNotMatch(remote.searchParams.get('scope'), /gmail|Mail.Read|Mail.Send/);
    assert.equal(remote.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorize.headers['set-cookie'][0], /HttpOnly/);
    assert.match(authorize.headers['set-cookie'][0], /SameSite=Lax/);
    const cookie = authorize.headers['set-cookie'][0].split(';')[0];
    const callback = `/api/calendar-oauth/${provider}/callback?state=${local.searchParams.get('state')}&code=test-code`;
    const result = await request(callback, undefined, { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(new URL(result.headers.location).searchParams.get('calendarConnected'), provider);
    const replay = await request(callback, undefined, { Cookie: cookie });
    assert.match(new URL(replay.headers.location).searchParams.get('calendarError'), /expired/);
  }
  assert.equal(finished.length, 2);
  assert.ok(finished.every(value => value.purpose === 'calendar'));
  assert.equal(store.getSettings().activeAccount, 'mail@example.com');
  assert.equal(store.getSettings().mail.email, 'mail@example.com');
  const listed = await request('/api/calendars');
  assert.equal(listed.data.connections.filter(value => value.connected).length, 2);
  assert.equal(listed.data.calendars.length, 2);
  assert.doesNotMatch(listed.raw, /private-|accessToken|refreshToken|clientSecret/);
  assert.doesNotMatch(readFileSync(`${directory}/genmail.sqlite`, 'utf8'), /private-access-token|private-refresh-token|private-client-secret/);
  const start = await request('/api/calendars/google/connect', { clientId: 'google-client' });
  const local = new URL(start.data.url);
  await request(local.pathname + local.search);
  const bad = await request(`/api/calendar-oauth/google/callback?state=${local.searchParams.get('state')}&code=bad`, undefined, { Cookie: 'morrow_calendar_google=wrong' });
  assert.match(new URL(bad.headers.location).searchParams.get('calendarError'), /verified/);
  assert.equal(finished.length, 2);
});

test('calendar creation validates dates, explicit scope, connection, and write permission before writes', async t => {
  let creates = 0, lists = 0;
  const { store, request } = await workspace(t, { listCalendars: async () => { lists++; return [{ ...calendar, canWrite: false }]; }, createCalendarEvent: async () => { creates++; } });
  store.setSettings({ calendars: { google: connection('google') } });
  const valid = eventInput();
  for (const patch of [{ start: '2026-02-31T09:00:00Z' }, { start: '2026-10-01T09:00:00' }, { start: '2026-10-01T09:00:00+14:30' }, { end: valid.start }, { end: '2027-10-01T09:00:00Z' }, { requestId: 'not-a-uuid' }, { title: 'First\nSecond' }, { attendees: ['unexpected@example.com'] }]) {
    assert.equal((await request('/api/calendars/google/events', { ...valid, ...patch })).status, 400, JSON.stringify(patch));
  }
  assert.equal((await request('/api/calendars/google/events', { ...valid, connectionEmail: 'old@example.com' })).status, 409);
  assert.equal(lists, 0);
  assert.equal((await request('/api/calendars/google/events', valid)).status, 403);
  assert.equal(creates, 0);
  assert.equal(store.getSettings().calendarRequests, undefined);
  assert.equal((await request('/api/calendars/google/events?calendarId=primary&start=bad&end=bad')).status, 400);
});

test('calendar create retries persist across restart, reject changed details, and preserve uncertain request IDs', async t => {
  const calls = [];
  let uncertain = false;
  const { store, request, restart } = await workspace(t, { createCalendarEvent: async (_, value) => { calls.push(value); if (uncertain) throw new Error('private-access-token'); return { id: value.requestId, title: value.title, start: value.start, end: value.end }; } });
  store.setSettings({ calendars: { google: connection('google') } });
  const value = eventInput();
  const created = await request('/api/calendars/google/events', value);
  assert.equal(created.status, 200);
  assert.equal(calls[0].start, '2026-10-01T01:00:00.000Z');
  restart();
  assert.deepEqual((await request('/api/calendars/google/events', value)).data, created.data);
  assert.equal(calls.length, 1);
  assert.equal((await request('/api/calendars/google/events', { ...value, title: 'Changed' })).status, 409);
  uncertain = true;
  const second = eventInput();
  const failure = await request('/api/calendars/google/events', second);
  assert.equal(failure.status, 502);
  assert.doesNotMatch(failure.raw, /private-access-token/);
  assert.equal((await request('/api/calendars/google/events', { ...second, end: '2026-10-01T11:00:00+08:00' })).status, 409);
  restart();
  uncertain = false;
  assert.equal((await request('/api/calendars/google/events', second)).status, 200);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], calls[2]);
  assert.equal(store.getSettings().calendarRequests.length, 2);
});

test('ninety local calendar dates tolerate DST rollback while event durations remain bounded', async t => {
  const calls = [];
  const { store, request } = await workspace(t, { listCalendarEvents: async (_, value) => { calls.push(value); return []; } });
  store.setSettings({ calendars: { google: connection('google') } });
  const start = '2026-09-01T00:00:00-04:00', end = '2026-11-30T00:00:00-05:00';
  const list = end => request(`/api/calendars/google/events?${new URLSearchParams({ calendarId: calendar.id, start, end })}`);
  assert.equal((await list(end)).status, 200);
  assert.equal(Date.parse(calls[0].end) - Date.parse(calls[0].start), 90 * 86400_000 + 3600_000);
  assert.equal((await list('2026-11-30T01:00:00-05:00')).status, 200);
  assert.equal((await list('2026-11-30T01:00:01-05:00')).status, 400);
  assert.equal(calls.length, 2);
  assert.equal((await request('/api/calendars/google/events', { ...eventInput(), start, end })).status, 400);
});

test('calendar reads expose fixed all-day repair limits and timezone errors without provider details', async t => {
  let code = 'calendar_all_day_limit';
  const { store, request } = await workspace(t, { listCalendarEvents: async () => { throw Object.assign(new Error('private-provider-text'), { code }); } });
  store.setSettings({ calendars: { microsoft: connection('microsoft') } });
  const load = () => request('/api/calendars/microsoft/events?calendarId=primary&start=2026-09-01T00%3A00%3A00Z&end=2026-10-01T00%3A00%3A00Z');
  for (const [next, expected] of [['calendar_all_day_limit', /100.*smaller date range/], ['calendar_all_day_timezone', /original timezone.*custom or unrecognized/], ['provider_private_error', /Could not load events/]]) {
    code = next;
    const result = await load();
    assert.equal(result.status, 502); assert.match(result.data.error, expected);
    assert.doesNotMatch(result.raw, /private-provider-text|provider_private_error/);
  }
});

test('pending event creation blocks reconnect, disconnect, and duplicate creation while other provider works', async t => {
  const entered = deferred(), finish = deferred();
  const { store, request } = await workspace(t, { createCalendarEvent: async () => { entered.resolve(); await finish.promise; return { id: 'created' }; } });
  store.setSettings({ calendars: { google: connection('google'), microsoft: connection('microsoft') } });
  const value = eventInput(), creating = request('/api/calendars/google/events', value);
  await entered.promise;
  assert.equal((await request('/api/calendars/google/disconnect', { connectionEmail: 'google@example.com' })).status, 409);
  assert.equal((await request('/api/calendars/google/connect', { clientId: 'new-client' })).status, 409);
  assert.equal((await request('/api/calendars/google/events', value)).status, 409);
  assert.equal((await request('/api/calendars/microsoft/disconnect', { connectionEmail: 'microsoft@example.com' })).status, 200);
  finish.resolve();
  assert.equal((await creating).status, 200);
  assert.equal((await request('/api/calendars/google/disconnect', { connectionEmail: 'old@example.com' })).status, 409);
  assert.equal((await request('/api/calendars/google/disconnect', { connectionEmail: 'google@example.com' })).status, 200);
  assert.equal(store.getSettings().calendars.google, null);
  assert.equal(store.getSettings().calendarRequests.length, 1);
});

test('concurrent refresh is shared and disconnected connections cannot resurrect after a late refresh', async t => {
  const entered = deferred(), finish = deferred();
  let refreshes = 0;
  const { store, request } = await workspace(t, { refreshMail: async value => { refreshes++; entered.resolve(); await finish.promise; return { ...value, accessToken: 'new-private-token' }; } });
  store.setSettings({ calendars: { google: connection('google') } });
  const first = request('/api/calendars'), second = request('/api/calendars/google/events?calendarId=primary&start=2026-10-01T00%3A00%3A00Z&end=2026-10-02T00%3A00%3A00Z');
  await entered.promise;
  assert.equal((await request('/api/calendars/google/disconnect', { connectionEmail: 'google@example.com' })).status, 200);
  finish.resolve();
  const [listed, events] = await Promise.all([first, second]);
  assert.equal(refreshes, 1);
  assert.equal(listed.data.connections[0].connected, false);
  assert.equal(events.status, 409);
  assert.equal(store.getSettings().calendars.google, null);
  assert.doesNotMatch(listed.raw + events.raw, /new-private-token/);
});

test('reminder validation precedes provider calls and persists canonical review/hash through retries', async t => {
  let refreshes = 0, lists = 0, uncertain = false;
  const calls = [];
  const { store, request, restart } = await workspace(t, {
    refreshMail: async value => { refreshes++; return value; },
    listCalendars: async () => { lists++; return [calendar]; },
    createCalendarEvent: async (_, value) => { calls.push(structuredClone(value)); if (uncertain) throw new Error('uncertain'); return { id: value.requestId }; },
  });
  store.setSettings({ calendars: { google: connection('google'), microsoft: connection('microsoft') } });
  const value = eventInput();
  for (const reminder of [null, [], {}, { method: 'default' }, { method: 'popup' }, { method: 'popup', minutes: '30' }, { method: 'popup', minutes: true }, { method: 'popup', minutes: 0.5 }, { method: 'popup', minutes: -1 }, { method: 'email', minutes: 40321 }, { method: 'none', attendees: [] }]) {
    assert.equal((await request('/api/calendars/google/events', { ...value, reminder })).status, 400);
  }
  assert.equal((await request('/api/calendars/microsoft/events', { ...value, connectionEmail: 'microsoft@example.com', reminder: { method: 'email', minutes: 30 } })).status, 400);
  assert.deepEqual([refreshes, lists, calls.length], [0, 0, 0]);
  assert.equal(store.getSettings().calendarRequests, undefined);
  // A pre-reminder Node record has only the old fingerprint; no payload or reminder key.
  const legacyPayload = { calendarId: value.calendarId, title: value.title, description: value.description, location: value.location, start: '2026-10-01T01:00:00.000Z', end: '2026-10-01T02:00:00.000Z', requestId: value.requestId };
  const legacyHash = createHash('sha256').update(JSON.stringify(legacyPayload)).digest('hex');
  store.setSettings({ calendarRequests: [{ provider: 'google', email: 'google@example.com', requestId: value.requestId, payloadHash: legacyHash, event: { id: 'legacy' } }] });
  assert.equal((await request('/api/calendars/google/events', value)).data.event.id, 'legacy');
  assert.equal((await request('/api/calendars/google/events', { ...value, reminder: { method: 'none' } })).status, 409);
  assert.deepEqual([refreshes, lists, calls.length], [0, 0, 0]);
  const selected = { ...eventInput(), reminder: { method: 'popup', minutes: 0 } };
  uncertain = true;
  assert.equal((await request('/api/calendars/google/events', selected)).status, 502);
  const record = store.getSettings().calendarRequests[1];
  assert.deepEqual(record.payload.reminder, selected.reminder);
  assert.equal(record.payloadHash, createHash('sha256').update(JSON.stringify(record.payload)).digest('hex'));
  for (const reminder of [undefined, { method: 'none' }, { method: 'email', minutes: 0 }, { method: 'popup', minutes: 1 }]) {
    assert.equal((await request('/api/calendars/google/events', { ...selected, reminder })).status, 409);
  }
  restart(); uncertain = false;
  assert.equal((await request('/api/calendars/google/events', selected)).status, 200);
  assert.deepEqual(calls[0], calls[1]);
  const none = { ...eventInput(), reminder: { method: 'none', minutes: 999 } };
  assert.equal((await request('/api/calendars/google/events', none)).status, 200);
  assert.deepEqual(calls[2].reminder, { method: 'none' });
  assert.equal((await request('/api/calendars/google/events', { ...none, reminder: { method: 'none' } })).status, 200);
  assert.equal(calls.length, 3);
});
