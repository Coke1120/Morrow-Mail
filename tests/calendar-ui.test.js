import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { parseDocument } from 'htmlparser2';
import { addDays, calendarColor, calendarEventKey, calendarKey, checkedCalendars, dateValue, eventOnDay, monthDates, shiftMonth } from '../src/calendar-dates.js';

let vite, ui;
before(async () => {
  vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ui = await vite.ssrLoadModule('/src/Calendar.jsx');
});
after(async () => { await vite?.close(); });
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const text = node => node.data || (node.children || []).map(text).join('');
const elements = (node, predicate) => [...(node.name && predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => elements(child, predicate))];
const calendar = { provider: 'google', id: 'same-calendar', name: 'Personal', primary: true, canWrite: true };
const connection = { provider: 'google', connected: true, email: 'owner@example.invalid' };
const event = { provider: 'google', calendarId: calendar.id, calendarName: calendar.name, id: 'same-event', title: 'Trip', start: '2026-03-07', end: '2026-03-10', allDay: true, color: calendarColor(calendar) };
const form = { title: 'Reviewed event', description: 'Original description', location: 'Library', start: '2026-03-09T09:00', end: '2026-03-09T10:00', reminderMethod: 'default', reminderMinutes: '15' };
function inTimezone(zone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { return fn(); } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}

test('month grid uses civil-day arithmetic, rolls years, and reads full local days across DST', () => {
  inTimezone('America/New_York', () => {
    for (const [month, hourChange] of [['2026-03', -1], ['2026-11', 1]]) {
      const range = monthDates(month);
      assert.equal(range.days.length, 42); assert.equal(new Set(range.days).size, 42);
      assert.equal(new Date(`${range.days[0]}T12:00:00`).getDay(), 0);
      assert.equal(new Date(range.start).getHours(), 0); assert.equal(new Date(range.end).getHours(), 0);
      assert.equal(Date.parse(range.end) - Date.parse(range.start), (42 * 24 + hourChange) * 3600000);
    }
    assert.equal(addDays('2026-03-08', 1), '2026-03-09');
    assert.equal(addDays('2026-11-01', -1), '2026-10-31');
    assert.equal(shiftMonth('2026-12', 1), '2027-01');
    assert.equal(shiftMonth('2026-01', -1), '2025-12');
    assert.ok(monthDates('2028-02').days.includes('2028-02-29'));
  });
});

test('all-day exclusive ends never shift timezone; timed spanning events cover every overlapping local day', () => {
  for (const zone of ['America/New_York', 'Asia/Tokyo']) inTimezone(zone, () => {
    assert.equal(eventOnDay(event, '2026-03-06'), false);
    for (const day of ['2026-03-07', '2026-03-08', '2026-03-09']) assert.equal(eventOnDay(event, day), true);
    assert.equal(eventOnDay(event, '2026-03-10'), false);
  });
  inTimezone('America/New_York', () => {
    const spanning = { ...event, allDay: false, start: '2026-03-07T23:30:00-05:00', end: '2026-03-09T00:00:00-04:00' };
    assert.equal(eventOnDay(spanning, '2026-03-07'), true);
    assert.equal(eventOnDay(spanning, '2026-03-08'), true);
    assert.equal(eventOnDay(spanning, '2026-03-09'), false);
    assert.throws(() => ui.calendarReview({ ...form, start: '2026-03-08T02:30', end: '2026-03-08T04:30' }, calendar, connection), /clocks change/);
    const valid = ui.calendarReview({ ...form, start: '2026-03-08T01:30', end: '2026-03-08T03:30' }, calendar, connection);
    assert.equal(Date.parse(valid.end) - Date.parse(valid.start), 3600000);
  });
});

test('calendar selections default to provider primaries, persist explicit empty selection, and cap reads at twelve', () => {
  const calendars = [{ ...calendar, primary: false, id: 'readonly', canWrite: false }, calendar, { ...calendar, provider: 'microsoft' }];
  assert.deepEqual(checkedCalendars(calendars, {}).map(calendarKey), [calendarKey(calendar), calendarKey(calendars[2])]);
  const choices = Object.fromEntries(calendars.map(item => [calendarKey(item), false]));
  assert.deepEqual(checkedCalendars(calendars, ui.savedCalendarChoices(JSON.stringify(choices))), []);
  choices[calendarKey(calendars[0])] = true;
  assert.equal(checkedCalendars(calendars, choices)[0].canWrite, false);
  assert.equal(ui.savedCalendarChoices(JSON.stringify(choices))[calendarKey(calendar)], false);
  const many = Array.from({ length: 20 }, (_, index) => ({ ...calendar, id: String(index) }));
  assert.equal(checkedCalendars(many, Object.fromEntries(many.map(item => [calendarKey(item), true]))).length, 12);
  assert.throws(() => ui.savedCalendarChoices('{"invalid":true}'));
});

test('event identity includes provider and calendar; provider colors are validated with deterministic fallback', () => {
  assert.notEqual(calendarEventKey(event), calendarEventKey({ ...event, provider: 'microsoft' }));
  assert.notEqual(calendarEventKey(event), calendarEventKey({ ...event, calendarId: 'other-calendar' }));
  assert.equal(calendarColor({ ...calendar, color: '#123aBC' }), '#123aBC');
  assert.equal(calendarColor({ ...calendar, name: 'Renamed' }), calendarColor(calendar));
  for (const color of ['red', '#123', 'url(https://example.invalid)', '#123456;']) assert.equal(calendarColor({ ...calendar, color }), calendarColor(calendar));
});

test('month and agenda render spans, selected day and incomplete reads without claiming an empty day', () => {
  const html = render(ui.CalendarMonth, { month: '2026-03', selectedDay: '2026-03-08', events: [event], today: '2026-03-08' });
  const buttons = elements(parseDocument(html), node => node.name === 'button');
  assert.equal(buttons.length, 42);
  assert.equal(buttons.filter(node => node.attribs['aria-pressed'] === 'true').length, 1);
  assert.equal(buttons.filter(node => text(node).includes('Trip')).length, 3);
  const selected = buttons.find(node => node.attribs['aria-pressed'] === 'true');
  assert.match(text(selected), /Trip/); assert.match(selected.attribs.class, /is-today/);
  assert.ok(elements(parseDocument(render(ui.CalendarMonth, { month: '2026-03', events: [], disabled: true })), node => node.name === 'button').every(node => Object.hasOwn(node.attribs, 'disabled')));
  const agenda = render(ui.CalendarAgenda, { day: '2026-03-09', events: [event, { ...event, provider: 'microsoft', title: '<Unsafe>' }], checkedCount: 2 });
  assert.match(agenda, /Google Calendar|Outlook Calendar/); assert.match(agenda, /All day · through/); assert.match(agenda, /&lt;Unsafe&gt;/);
  const missing = render(ui.CalendarAgenda, { day: '2026-03-10', events: [], incomplete: true, checkedCount: 2 });
  assert.match(missing, /Events may be missing/); assert.doesNotMatch(missing, /No events on/);
  const loading = render(ui.CalendarAgenda, { day: '2026-03-10', events: [], loading: true, checkedCount: 2 });
  assert.match(loading, /Loading events/); assert.doesNotMatch(loading, /No events on/);
  assert.match(render(ui.CalendarAgenda, { day: '2026-03-10', events: [], checkedCount: 0 }), /Check a calendar/);
});

test('bounded calendar reads preserve other calendars on failure, deduplicate complete identities and forward abort signals', async () => {
  const calendars = Array.from({ length: 15 }, (_, index) => ({ ...calendar, provider: index % 2 ? 'microsoft' : 'google', id: String(index) }));
  const controller = new AbortController(); let active = 0, peak = 0, calls = 0;
  const result = await ui.loadCalendarEvents(calendars, monthDates('2026-03'), controller.signal, async (path, options) => {
    assert.equal(options.signal, controller.signal);
    active++; peak = Math.max(peak, active); calls++;
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    const id = new URL(path, 'https://fixture.invalid').searchParams.get('calendarId');
    if (id === '2') throw new Error('Permission expired');
    if (id === '3') return {}; // A malformed list must not become successful empty data.
    if (id === '4') return { events: [{ ...event, start: '2026-03-07T08:00:00Z', end: '2026-03-10T07:00:00Z' }] }; // Do not guess original all-day dates from UTC timestamps.
    return { events: [event, event] };
  });
  assert.equal(calls, 12); assert.equal(peak, 3);
  assert.equal(result.events.length, 9); assert.equal(new Set(result.events.map(calendarEventKey)).size, 9);
  assert.deepEqual(result.errors.map(item => item.calendar.id).sort(), ['2', '3', '4']);
  assert.ok(result.events.some(item => item.provider === 'microsoft'));
  assert.ok(result.events.every(item => item.calendarId !== 'same-calendar'));
});

test('aborting a read discards late responses and never starts queued calendar requests', async () => {
  const controller = new AbortController(), finishes = []; let calls = 0;
  const promise = ui.loadCalendarEvents(Array.from({ length: 8 }, (_, index) => ({ ...calendar, id: String(index) })), monthDates('2026-03'), controller.signal, () => {
    calls++; return new Promise(resolve => finishes.push(() => resolve({ events: [event] })));
  });
  assert.equal(calls, 3);
  controller.abort(); finishes.forEach(finish => finish());
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(calls, 3);
});

test('reminders omit defaults and none minutes, accept at-start, and reject unsupported methods or ranges', () => {
  const defaults = ui.calendarReview(form, calendar, connection);
  assert.equal(Object.hasOwn(defaults, 'reminder'), false);
  assert.deepEqual(ui.calendarReminder('none', 'invalid', 'google'), { method: 'none' });
  assert.deepEqual(ui.calendarReminder('popup', '0', 'microsoft'), { method: 'popup', minutes: 0 });
  assert.deepEqual(ui.calendarReminder('email', '40320', 'google'), { method: 'email', minutes: 40320 });
  assert.throws(() => ui.calendarReminder('email', 15, 'microsoft'), /notifications? reminders? only/);
  for (const minutes of ['', -1, 40321, 2.5, 'abc']) assert.throws(() => ui.calendarReminder('popup', minutes, 'google'), /whole number/);
  const google = render(ui.CalendarReminder, { provider: 'google', value: { ...form, reminderMethod: 'popup' } });
  const outlook = render(ui.CalendarReminder, { provider: 'microsoft', value: { ...form, reminderMethod: 'popup' } });
  assert.match(google, /value="email"/); assert.doesNotMatch(outlook, /value="email"/);
  assert.match(outlook, /value="0">At start/); assert.match(outlook, /value="1440">1 day/);
  const arbitrary = render(ui.CalendarReminder, { provider: 'microsoft', value: { ...form, reminderMethod: 'popup', reminderMinutes: '37' } });
  assert.match(arbitrary, /list="calendar-reminder-minutes"[^>]*value="37"/);
  assert.deepEqual(ui.calendarReminder('popup', '37', 'microsoft'), { method: 'popup', minutes: 37 });
});

test('legacy and reminder-bearing recovery preserve exact payload/requestId; review stays immutable during recovery or creation', () => {
  const base = ui.calendarReview(form, calendar, connection);
  const requestId = '3b8bb0ec-52ad-4dd6-a9c4-b55ecc678daf';
  for (const reminder of [undefined, { method: 'none' }, { method: 'popup', minutes: 0 }, { method: 'popup', minutes: 37 }, { method: 'email', minutes: 15 }]) {
    const review = { ...base, ...(reminder ? { reminder } : {}) };
    const saved = ui.restoreCalendarRequest(JSON.stringify({ requestId, review }));
    assert.deepEqual(saved, { requestId, review });
    const submission = ui.calendarSubmission(saved.review, saved.requestId);
    const { provider, calendarName, ...original } = review;
    assert.deepEqual(submission.payload, { ...original, requestId });
    assert.equal(submission.fingerprint, JSON.stringify({ provider, ...original }));
    assert.equal(Object.hasOwn(submission.payload, 'reminder'), !!reminder);
    const buttons = elements(parseDocument(render(ui.CalendarEventReview, { review, recovery: saved })), node => node.name === 'button');
    assert.ok(Object.hasOwn(buttons[0].attribs, 'disabled')); assert.equal(Object.hasOwn(buttons[1].attribs, 'disabled'), false);
    assert.ok(elements(parseDocument(render(ui.CalendarEventReview, { review, creating: true })), node => node.name === 'button').every(node => Object.hasOwn(node.attribs, 'disabled')));
    assert.match(render(ui.CalendarEventReview, { review }), /No attendees are added|Morrow sends no automatic email/);
    if (reminder?.minutes === 37) assert.match(render(ui.CalendarEventReview, { review }), /37 minutes before/);
  }
  const fingerprints = [base, { ...base, reminder: { method: 'none' } }, { ...base, reminder: { method: 'popup', minutes: 0 } }, { ...base, reminder: { method: 'popup', minutes: 15 } }].map(review => ui.calendarSubmission(review).fingerprint);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
  assert.throws(() => ui.calendarReview(form, { ...calendar, canWrite: false }, connection), /writable/);
  assert.throws(() => ui.calendarReview(form, calendar, { ...connection, provider: 'microsoft' }), /writable/);
});
