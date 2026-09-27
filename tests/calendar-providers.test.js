import test from 'node:test';
import assert from 'node:assert/strict';
import { oauthStart, oauthFinish, refreshMail, providerRequest } from '../server/providers.js';
import { listCalendars, listCalendarEvents, createCalendarEvent } from '../server/calendar-providers.js';

const connection = provider => ({ provider, purpose: 'calendar', clientId: 'client', accessToken: 'secret', refreshToken: 'refresh', expiresAt: 0 });
const range = { calendarId: 'work@example.com', start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' };
const creation = { calendarId: 'work@example.com', title: 'Review', description: 'First line\n<script>plain text</script>', location: 'Desk', start: '2026-09-23T10:00:00+08:00', end: '2026-09-23T11:00:00+08:00', requestId: '5c4b819c-b301-4ed5-bd2d-997315b47835' };
const response = value => new Response(JSON.stringify(value));

test('calendar OAuth has separate scopes, Google userinfo, and calendar scopes on Microsoft refresh', async t => {
  for (const provider of ['google', 'microsoft']) {
    const start = oauthStart(provider, { clientId: 'client', clientSecret: 'private' }, 'http://localhost/callback', 'calendar');
    assert.equal(start.config.purpose, 'calendar');
    assert.equal(start.purpose, 'calendar');
    const scope = new URL(start.url).searchParams.get('scope');
    assert.match(scope, provider === 'google' ? /calendar\.calendarlist\.readonly.*calendar\.events/ : /offline_access.*User.Read.*Calendars.ReadWrite/);
    assert.doesNotMatch(scope, /gmail\.|Mail\.Read|Mail\.Send/);
    assert.doesNotMatch(start.url, /private/);
  }
  const calls = [];
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return response(url.includes('userinfo') ? { email: 'PERSON@example.com' } : { access_token: 'new', expires_in: 3600 });
  });
  const result = await oauthFinish('google', { code: 'code', verifier: 'v'.repeat(64), config: { clientId: 'client', purpose: 'calendar' }, redirectUri: 'http://localhost/callback' });
  assert.equal(result.purpose, 'calendar');
  assert.equal(result.email, 'person@example.com');
  assert.equal(calls[1].url, 'https://openidconnect.googleapis.com/v1/userinfo');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer new');
  fetch.mock.mockImplementation(async (url, options) => {
    assert.match(options.body.get('scope'), /Calendars.ReadWrite/);
    assert.doesNotMatch(options.body.get('scope'), /Mail\./);
    return response({ access_token: 'refreshed', refresh_token: 'rotated', expires_in: 3600 });
  });
  const refreshed = await refreshMail(connection('microsoft'));
  assert.equal(refreshed.purpose, 'calendar');
  assert.equal(refreshed.refreshToken, 'rotated');
});

test('Google lists calendars and expanded recurring events across pages, preserves all-day dates and excludes cancellations', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    assert.equal(options.headers.Authorization, 'Bearer secret');
    assert.equal(options.redirect, 'error');
    if (parsed.pathname.endsWith('/calendarList')) {
      return response(parsed.searchParams.has('pageToken')
        ? { items: [{ id: 'shared', summary: 'Shared', accessRole: 'reader', timeZone: 'Asia/Hong_Kong', backgroundColor: 'url(unsafe)' }] }
        : { items: [{ id: 'primary', summary: 'Personal', primary: true, accessRole: 'owner', timeZone: 'Asia/Hong_Kong', backgroundColor: '#ab12CD' }], nextPageToken: 'next/token' });
    }
    assert.equal(parsed.searchParams.get('singleEvents'), 'true');
    assert.equal(parsed.searchParams.get('showDeleted'), 'false');
    return response({ items: [
      { id: 'occurrence', summary: 'Recurring occurrence', description: '<b>Agenda</b>', start: { dateTime: '2026-09-23T10:00:00+08:00' }, end: { dateTime: '2026-09-23T11:00:00+08:00' }, recurringEventId: 'master', htmlLink: 'https://calendar.google.com/event?id=occurrence' },
      { id: 'holiday', start: { date: '2026-09-24' }, end: { date: '2026-09-25' } },
      { id: 'removed', status: 'cancelled' },
    ] });
  });
  const calendars = await listCalendars(connection('google'));
  assert.equal(calendars.length, 2);
  assert.deepEqual(calendars[0], { id: 'primary', name: 'Personal', primary: true, canWrite: true, timeZone: 'Asia/Hong_Kong', color: '#ab12CD' });
  assert.equal(calendars[1].canWrite, false);
  assert.equal(calendars[1].color, undefined);
  const events = await listCalendarEvents(connection('google'), range);
  assert.equal(events.length, 2);
  assert.equal(events[0].start, '2026-09-23T02:00:00.000Z');
  assert.equal(events[0].description.trim(), 'Agenda');
  assert.equal(events[1].allDay, true);
  assert.equal(events[1].start, '2026-09-24');
  assert.equal(events[1].end, '2026-09-25');
});

test('Microsoft calendarView requests UTC, follows only same-resource pages, and strips HTML and unsafe web links', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.match(options.headers.Prefer, /timezone="UTC"/);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/calendars')) {
      assert.match(parsed.searchParams.get('$select'), /hexColor/);
      return response({ value: [{ id: 'c1', name: 'Work', isDefaultCalendar: true, canEdit: true, hexColor: '#123ABC' }, { id: 'c2', name: 'Malformed color', hexColor: ['#123456'] }] });
    }
    assert.match(parsed.pathname, /calendarView$/);
    const event = { id: 'event', subject: 'Meeting', body: { contentType: 'html', content: '<p>Prepare</p><script>secret()</script>' }, location: { displayName: 'Desk' }, start: { dateTime: '2026-09-23T02:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-09-23T03:00:00.0000000', timeZone: 'UTC' }, webLink: 'javascript:alert(1)' };
    return response(parsed.searchParams.has('$skiptoken') ? { value: [{ id: 'cancelled', isCancelled: true }] }
      : { value: [event, { id: 'all-day', isAllDay: true, start: { dateTime: '2026-09-24T00:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-09-26T00:00:00', timeZone: 'UTC' } }], '@odata.nextLink': `${parsed.origin}${parsed.pathname}?$skiptoken=next` });
  });
  const calendars = await listCalendars(connection('microsoft'));
  assert.equal(calendars[0].canWrite, true); assert.equal(calendars[0].color, '#123ABC'); assert.equal(calendars[1].color, undefined);
  const events = await listCalendarEvents(connection('microsoft'), range);
  assert.equal(calls.length, 3);
  assert.equal(events.length, 2);
  assert.equal(events[0].start, '2026-09-23T02:00:00.000Z');
  assert.equal(events[0].description.trim(), 'Prepare');
  assert.equal(events[0].webUrl, '');
  assert.equal(events[1].allDay, true); assert.equal(events[1].start, '2026-09-24'); assert.equal(events[1].end, '2026-09-26');
});

function outlookAllDay(id, positive = true, local = false) {
  const zone = positive ? 'Line Islands Standard Time' : 'Pacific Standard Time';
  return {
    id, isAllDay: true, subject: 'All day', originalStartTimeZone: zone, originalEndTimeZone: zone,
    start: { dateTime: local ? '2026-09-24T00:00:00.0000000' : positive ? '2026-09-23T10:00:00.0000000' : '2026-09-24T07:00:00.0000000', timeZone: local ? zone : 'UTC' },
    end: { dateTime: local ? '2026-09-26T00:00:00.0000000' : positive ? '2026-09-25T10:00:00.0000000' : '2026-09-26T07:00:00.0000000', timeZone: local ? zone : 'UTC' },
  };
}

test('Outlook all-day reads repair converted positive/negative zones with four bounded reads, skipping UTC midnight dates', async t => {
  const converted = Array.from({ length: 6 }, (_, i) => outlookAllDay(`converted/${i}`, i % 2 === 0));
  const utc = Array.from({ length: 101 }, (_, i) => ({ ...outlookAllDay(`utc-${i}`), start: { dateTime: '2026-09-24T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-09-26T00:00:00', timeZone: 'UTC' } }));
  let items = [...converted, ...utc], repairs = 0, active = 0, peak = 0, delayed = true;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://graph.microsoft.com');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    assert.equal(options.redirect, 'error');
    if (parsed.pathname.endsWith('/calendarView')) {
      assert.match(options.headers.Prefer, /timezone="UTC"/);
      assert.match(parsed.searchParams.get('$select') || '', /originalStartTimeZone,originalEndTimeZone/);
      return response({ value: items });
    }
    assert.ok(parsed.pathname.startsWith('/v1.0/me/calendars/work%2Fpart/events/'));
    const id = decodeURIComponent(parsed.pathname.split('/').at(-1)), item = items.find(value => value.id === id);
    assert.ok(item); assert.equal(options.headers.Prefer, `outlook.timezone="${item.originalStartTimeZone}", outlook.body-content-type="text"`);
    repairs++; peak = Math.max(peak, ++active);
    if (delayed) await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return response(outlookAllDay(id, item.originalStartTimeZone === 'Line Islands Standard Time', true));
  });
  const load = () => listCalendarEvents(connection('microsoft'), { ...range, calendarId: 'work/part' });
  const events = await load();
  assert.equal(events.length, 107); assert.equal(repairs, 6); assert.equal(peak, 4);
  assert.ok(events.every(event => event.allDay && event.start === '2026-09-24' && event.end === '2026-09-26'));
  // The cap applies to extra reads, not total all-day events. Reject before partial repairs.
  items = Array.from({ length: 101 }, (_, i) => outlookAllDay(`bounded-${i}`));
  repairs = 0; delayed = false;
  await assert.rejects(load(), error => error.code === 'calendar_all_day_limit' && /100/.test(error.message));
  assert.equal(repairs, 0);
  items.pop();
  assert.equal((await load()).length, 100); assert.equal(repairs, 100);
});

test('Outlook all-day timezone verification rejects unsafe metadata and mismatched repair responses without exposing provider text', async t => {
  let listed = outlookAllDay('source'), repaired = outlookAllDay('source', true, true), status = 200, gets = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (new URL(url).pathname.endsWith('/calendarView')) return response({ value: [listed] });
    gets++;
    return new Response(JSON.stringify(status === 200 ? repaired : { error: 'private provider text' }), { status });
  });
  const rejects = () => assert.rejects(listCalendarEvents(connection('microsoft'), range), error => error.code === 'calendar_all_day_timezone' && !/private provider text/.test(error.message));
  for (const zone of [undefined, 'tzone://Microsoft/Custom', 'UTC"\r\nInjected: true', 'UTC ']) {
    listed = { ...outlookAllDay('source'), originalStartTimeZone: zone, originalEndTimeZone: zone };
    await rejects();
  }
  listed = { ...outlookAllDay('source'), originalEndTimeZone: 'UTC' }; await rejects();
  assert.equal(gets, 0);
  listed = outlookAllDay('source');
  for (const patch of [{ id: 'other' }, { isAllDay: false }, { isCancelled: true }, { originalStartTimeZone: 'UTC' }, { originalEndTimeZone: 'UTC' }, { start: { dateTime: '2026-09-24T01:00:00', timeZone: 'Line Islands Standard Time' } }, { end: { dateTime: '2026-09-26T00:00:00', timeZone: 'UTC' } }, { end: { dateTime: '2026-09-23T00:00:00', timeZone: 'Line Islands Standard Time' } }]) {
    repaired = { ...outlookAllDay('source', true, true), ...patch }; await rejects();
  }
  listed = { ...outlookAllDay('source'), originalStartTimeZone: 'Not A Timezone', originalEndTimeZone: 'Not A Timezone' };
  status = 400; await rejects(); // Graph, rather than a guessed mapping, decides supported zone names.
});

test('calendar pagination rejects token-leaking URLs, loops, and item limits', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => response({ value: [], '@odata.nextLink': 'https://attacker.example/v1.0/me/calendars' }));
  await assert.rejects(listCalendars(connection('microsoft')), /unsafe next page/);
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => response({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages' }));
  await assert.rejects(listCalendars(connection('microsoft')), /unsafe next page/);
  fetch.mock.mockImplementation(async () => response({ items: [], nextPageToken: 'repeated' }));
  await assert.rejects(listCalendars(connection('google')), /repeated page/);
  fetch.mock.mockImplementation(async () => response({ value: Array.from({ length: 501 }, (_, index) => ({ id: String(index) })) }));
  await assert.rejects(listCalendars(connection('microsoft')), /exceeds 500/);
});

test('event creation has no attendees, uses stable provider idempotency, and Google retries recover only matching events', async t => {
  let saved;
  let conflict = false;
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.attendees, undefined);
      assert.equal(body.recurrence, undefined);
      assert.equal(body.reminders, undefined);
      assert.equal(body.isReminderOn, undefined);
      assert.equal(body.reminderMinutesBeforeStart, undefined);
      if (url.includes('googleapis.com')) {
        assert.match(body.id, /^[0-9a-v]{5,1024}$/);
        assert.match(body.description, /&lt;script&gt;/);
        assert.equal(new URL(url).searchParams.get('sendUpdates'), 'none');
        if (conflict) return new Response('sensitive error', { status: 409 });
        saved = body;
        return response({ ...body, htmlLink: 'https://calendar.google.com/event' });
      }
      assert.equal(body.transactionId, creation.requestId);
      assert.equal(body.start.timeZone, 'UTC');
      assert.equal(body.start.dateTime, '2026-09-23T02:00:00.000');
      assert.equal(body.body.contentType, 'text');
      return response({ ...body, id: 'microsoft-event', webLink: 'https://outlook.office.com/calendar/event' });
    }
    assert.ok(url.endsWith(`/events/${saved.id}`));
    return response(saved);
  });
  const first = await createCalendarEvent(connection('google'), creation);
  assert.equal(first.title, 'Review');
  assert.match(first.description, /<script>plain text<\/script>/);
  conflict = true;
  const replay = await createCalendarEvent(connection('google'), creation);
  assert.equal(first.id, replay.id);
  await assert.rejects(createCalendarEvent(connection('google'), { ...creation, title: 'Different' }), /already used/);
  const microsoft = await createCalendarEvent(connection('microsoft'), creation);
  assert.equal(microsoft.id, 'microsoft-event');
  assert.equal(microsoft.start, '2026-09-23T02:00:00.000Z');
  assert.equal(fetch.mock.callCount(), 6);
});

test('invalid calendar dates/IDs and creation inputs fail before network, response errors are bounded and sanitized', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('private token'); });
  for (const invalid of [{ start: '2026-02-30T00:00:00Z' }, { start: '2026-09-23T24:00:00Z' }, { start: '2026-09-23T02:00:00' }, { end: range.start }, { calendarId: '..' }]) {
    await assert.rejects(listCalendarEvents(connection('google'), { ...range, ...invalid }));
  }
  await assert.rejects(createCalendarEvent(connection('google'), { ...creation, requestId: 'not-a-uuid' }), /UUID/);
  await assert.rejects(createCalendarEvent(connection('google'), { ...creation, title: 'bad\r\nheader' }), /title/);
  assert.equal(fetch.mock.callCount(), 0);
  fetch.mock.mockImplementation(async () => new Response('private token', { status: 401 }));
  await assert.rejects(listCalendars(connection('google')), error => /authorization expired/.test(error.message) && !/private token/.test(error.message));
  fetch.mock.mockImplementation(async () => new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } }));
  await assert.rejects(providerRequest('https://www.googleapis.com', {}, 'Google Calendar'), /too large/);
});

test('explicit reminders map to native provider fields and Google conflict recovery verifies the reviewed reminder', async t => {
  const saved = new Map(), submitted = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (options.method !== 'POST') return response(saved.get(url.split('/').at(-1)));
    const body = JSON.parse(options.body); submitted.push(body);
    assert.equal(body.attendees, undefined);
    if (url.includes('googleapis.com')) {
      assert.equal(new URL(url).searchParams.get('sendUpdates'), 'none');
      if (saved.has(body.id)) return new Response('{}', { status: 409 });
      saved.set(body.id, body); return response(body);
    }
    assert.equal(body.reminders, undefined);
    return response({ ...body, id: 'outlook-reminder' });
  });
  for (const [index, reminder] of [{ method: 'none', minutes: 30 }, { method: 'popup', minutes: 0 }, { method: 'email', minutes: 40320 }].entries()) {
    const value = { ...creation, requestId: `5c4b819c-b301-4ed5-bd2d-997315b4783${index}`, reminder };
    const first = await createCalendarEvent(connection('google'), value);
    const raw = submitted.at(-1);
    assert.deepEqual(raw.reminders, { useDefault: false, overrides: reminder.method === 'none' ? [] : [reminder] });
    if (reminder.method === 'none') delete saved.get(raw.id).reminders.overrides; // Google can omit an empty list.
    assert.equal((await createCalendarEvent(connection('google'), value)).id, first.id);
    saved.get(raw.id).reminders = { useDefault: true };
    await assert.rejects(createCalendarEvent(connection('google'), value), /already used/);
    if (reminder.method !== 'email') {
      await createCalendarEvent(connection('microsoft'), value);
      assert.equal(submitted.at(-1).isReminderOn, reminder.method !== 'none');
      assert.equal(submitted.at(-1).reminderMinutesBeforeStart, reminder.method === 'popup' ? 0 : undefined);
    }
  }
  const count = submitted.length;
  for (const reminder of [null, [], {}, { method: 'default' }, { method: 'popup' }, { method: 'popup', minutes: '30' }, { method: 'popup', minutes: true }, { method: 'popup', minutes: 0.5 }, { method: 'popup', minutes: -1 }, { method: 'email', minutes: 40321 }, { method: 'none', attendees: ['hidden@example.invalid'] }]) {
    await assert.rejects(createCalendarEvent(connection('google'), { ...creation, reminder }));
  }
  await assert.rejects(createCalendarEvent(connection('microsoft'), { ...creation, reminder: { method: 'email', minutes: 30 } }), /popup reminders only/);
  assert.equal(submitted.length, count);
});
