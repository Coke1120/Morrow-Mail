import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { providerRequest } from './providers.js';

const origins = { google: 'https://www.googleapis.com', microsoft: 'https://graph.microsoft.com' };
const roots = { google: '/calendar/v3', microsoft: '/v1.0/me' };
export const CALENDAR_READ_ERRORS = Object.freeze({
  calendar_all_day_limit: 'More than 100 Outlook all-day events need timezone verification. Select a smaller date range.',
  calendar_all_day_timezone: 'Outlook could not verify all-day dates in their original timezone. Open the affected calendar in Outlook; custom or unrecognized timezones are not supported.',
});
function allDayError(code = 'calendar_all_day_timezone') {
  return Object.assign(new Error(CALENDAR_READ_ERRORS[code]), { status: 502, code });
}

function connectionProvider(connection) {
  if (!Object.hasOwn(origins, connection?.provider) || typeof connection.accessToken !== 'string' || !connection.accessToken) {
    throw new Error('A connected Google or Microsoft calendar is required.');
  }
  return connection.provider;
}

function calendarPath(provider, calendarId) {
  if (typeof calendarId !== 'string' || !calendarId || calendarId.length > 2048 || /[\x00-\x1f\x7f]/.test(calendarId) || ['.', '..'].includes(calendarId)) {
    throw new Error('A valid calendar ID is required.');
  }
  return `${roots[provider]}/calendars/${encodeURIComponent(calendarId)}`;
}

function api(connection, path, options = {}) {
  const provider = connectionProvider(connection);
  return providerRequest(`${origins[provider]}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      ...(provider === 'microsoft' ? { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' } : {}),
      ...options.headers,
    },
  }, provider === 'google' ? 'Google Calendar' : 'Outlook Calendar');
}

async function pages(connection, path, limit) {
  const provider = connectionProvider(connection);
  const original = new URL(path, origins[provider]);
  const items = [];
  const seen = new Set();
  let next = original;
  // ponytail: bounded complete reads; add incremental sync if a calendar exceeds these limits.
  for (let page = 0; page < 10; page++) {
    if (seen.has(next.href)) throw new Error('The calendar provider returned a repeated page.');
    seen.add(next.href);
    const result = await api(connection, `${next.pathname}${next.search}`);
    const entries = provider === 'google' ? result?.items : result?.value;
    if (entries !== undefined && !Array.isArray(entries)) throw new Error('The calendar provider returned an invalid list.');
    if (!result || typeof result !== 'object') throw new Error('The calendar provider returned an invalid list.');
    items.push(...(entries || []));
    if (items.length > limit) throw new Error(`This calendar request exceeds ${limit} items. Select a smaller date range.`);
    const cursor = provider === 'google' ? result.nextPageToken : result['@odata.nextLink'];
    if (!cursor) return items;
    if (typeof cursor !== 'string' || cursor.length > 8192) throw new Error('The calendar provider returned an invalid next page.');
    if (provider === 'google') {
      next = new URL(original);
      next.searchParams.set('pageToken', cursor);
    } else {
      try { next = new URL(cursor); } catch { throw new Error('The calendar provider returned an invalid next page.'); }
      if (next.origin !== original.origin || next.pathname !== original.pathname || next.username || next.password || next.hash) {
        throw new Error('The calendar provider returned an unsafe next page.');
      }
    }
  }
  throw new Error('This calendar request has too many pages. Select a smaller date range.');
}

export async function listCalendars(connection) {
  const provider = connectionProvider(connection);
  const items = await pages(connection, provider === 'google'
    ? '/calendar/v3/users/me/calendarList?maxResults=100'
    : '/v1.0/me/calendars?$top=100&$select=id,name,isDefaultCalendar,canEdit,hexColor', 500);
  return items.filter(item => item && typeof item.id === 'string' && !item.deleted).map(item => {
    const color = provider === 'google' ? item.backgroundColor : item.hexColor;
    return {
      id: item.id,
      name: String(provider === 'google' ? item.summaryOverride || item.summary || 'Untitled calendar' : item.name || 'Untitled calendar').slice(0, 500),
      primary: provider === 'google' ? !!item.primary : !!item.isDefaultCalendar,
      canWrite: provider === 'google' ? ['owner', 'writer'].includes(item.accessRole) : item.canEdit === true,
      timeZone: provider === 'google' && typeof item.timeZone === 'string' ? item.timeZone : 'UTC',
      ...(typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? { color } : {}),
    };
  });
}

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error('Calendar dates must be valid ISO timestamps with a time zone.');
  }
  return new Date(value).toISOString();
}

function eventDate(value, provider, allDay) {
  if (allDay) {
    // An all-day event is a civil date range; its exclusive end must not shift with timezones.
    const date = provider === 'google' ? value?.date : typeof value?.dateTime === 'string' ? value.dateTime.slice(0, 10) : undefined;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('The calendar provider returned an invalid event date.');
    }
    instant(`${date}T00:00:00Z`);
    return date;
  }
  let date = value?.dateTime;
  if (provider === 'microsoft' && typeof date === 'string' && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(date)) {
    if (value?.timeZone && !['UTC', 'Etc/UTC'].includes(value.timeZone)) throw new Error('Outlook Calendar did not return the requested UTC event times.');
    date += 'Z';
  }
  return instant(date);
}

async function normalizedEvent(item, provider, calendarId) {
  if (!item || typeof item.id !== 'string' || !item.id) throw new Error('The calendar provider returned an invalid event.');
  const allDay = provider === 'google' ? !!item.start?.date : !!item.isAllDay;
  let description = String(provider === 'google' ? item.description || '' : item.body?.content || '').slice(0, 100000);
  if (provider === 'google' || item.body?.contentType?.toLowerCase() === 'html') {
    description = (await simpleParser(`Content-Type: text/html; charset=utf-8\r\n\r\n${description}`, { skipTextToHtml: true })).text || '';
  }
  let webUrl = provider === 'google' ? item.htmlLink || '' : item.webLink || '';
  try {
    const parsed = new URL(webUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) webUrl = '';
  } catch { webUrl = ''; }
  return {
    id: item.id, title: String(provider === 'google' ? item.summary || '(No title)' : item.subject || '(No title)').slice(0, 1000),
    description, location: String(provider === 'google' ? item.location || '' : item.location?.displayName || '').slice(0, 2000),
    start: eventDate(item.start, provider, allDay), end: eventDate(item.end, provider, allDay), allDay,
    webUrl, calendarId, status: item.status === 'cancelled' || item.isCancelled ? 'cancelled' : 'confirmed',
  };
}

function originalZone(item) {
  const zone = item.originalStartTimeZone;
  if (typeof zone !== 'string' || zone !== item.originalEndTimeZone || zone.trim() !== zone || !/^[A-Za-z0-9_ .+/-]{1,128}$/.test(zone) || /custom/i.test(zone)) throw allDayError();
  return zone;
}
function midnightBounds(item, zone) {
  const midnight = value => value?.timeZone === zone && typeof value.dateTime === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0{1,7})?$/.test(value.dateTime);
  if (item?.isAllDay !== true || item.isCancelled || !midnight(item.start) || !midnight(item.end)) return false;
  try { return eventDate(item.start, 'microsoft', true) < eventDate(item.end, 'microsoft', true); } catch { return false; }
}
function verifiedAllDay(item, zone) {
  return item?.originalStartTimeZone === zone && item.originalEndTimeZone === zone && midnightBounds(item, zone);
}
async function repairAllDay(connection, base, items) {
  const repairs = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item.isAllDay) continue;
    if (midnightBounds(item, 'UTC') || midnightBounds(item, 'Etc/UTC')) continue;
    const zone = originalZone(item);
    if (!verifiedAllDay(item, zone)) repairs.push({ index, zone, id: item.id });
  }
  if (repairs.length > 100) throw allDayError('calendar_all_day_limit');
  // Let Graph convert its own Windows/IANA zone. Never guess a civil date from UTC.
  for (let start = 0; start < repairs.length; start += 4) {
    const batch = await Promise.allSettled(repairs.slice(start, start + 4).map(async ({ index, zone, id }) => {
      if (typeof id !== 'string' || !id || id.length > 2048 || /[\x00-\x1f\x7f]/.test(id) || ['.', '..'].includes(id)) throw allDayError();
      let repaired;
      try {
        repaired = await api(connection, `${base}/events/${encodeURIComponent(id)}?$select=id,isAllDay,isCancelled,start,end,originalStartTimeZone,originalEndTimeZone`, { headers: { Prefer: `outlook.timezone="${zone}", outlook.body-content-type="text"` } });
      } catch { throw allDayError(); }
      if (repaired?.id !== id || !verifiedAllDay(repaired, zone)) throw allDayError();
      return { index, start: repaired.start, end: repaired.end };
    }));
    for (const result of batch) {
      if (result.status === 'rejected') throw result.reason;
      const { index, start, end } = result.value;
      items[index] = { ...items[index], start, end };
    }
  }
}

export async function listCalendarEvents(connection, { calendarId, start, end }) {
  const provider = connectionProvider(connection);
  const base = calendarPath(provider, calendarId);
  const from = instant(start);
  const to = instant(end);
  if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 366 * 86400000) throw new Error('Choose a calendar date range of no more than 366 days.');
  const query = provider === 'google'
    ? new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: '250' })
    : new URLSearchParams({ startDateTime: from, endDateTime: to, $top: '250', $orderby: 'start/dateTime', $select: 'id,subject,body,location,start,end,isAllDay,isCancelled,webLink,type,originalStartTimeZone,originalEndTimeZone' });
  const items = (await pages(connection, `${base}/${provider === 'google' ? 'events' : 'calendarView'}?${query}`, 1000)).filter(item => item && item.status !== 'cancelled' && !item.isCancelled);
  if (provider === 'microsoft') await repairAllDay(connection, base, items);
  return Promise.all(items.map(item => normalizedEvent(item, provider, calendarId)));
}

export function normalizeCalendarReminder(value, provider) {
  if (value === undefined) return undefined;
  const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['method', 'minutes'].includes(key)) || !['none', 'popup', 'email'].includes(value.method)) {
    invalid('Choose no reminder, a popup reminder or a supported email reminder.');
  }
  if (value.method === 'none') return { method: 'none' };
  if (provider === 'microsoft' && value.method === 'email') invalid('Outlook Calendar supports popup reminders only. Choose popup, none or the provider default.');
  if (!Number.isInteger(value.minutes) || value.minutes < 0 || value.minutes > 40320) invalid('Reminder minutes must be an integer between 0 and 40320.');
  return { method: value.method, minutes: value.minutes };
}

function sameGoogleReminder(saved, expected) {
  if (!expected) return true; // Legacy requests did not select or fingerprint reminders.
  const overrides = saved?.overrides === undefined ? [] : saved.overrides;
  return saved?.useDefault === false && Array.isArray(overrides) && overrides.length === expected.overrides.length
    && overrides.every((entry, index) => entry?.method === expected.overrides[index].method && entry?.minutes === expected.overrides[index].minutes);
}

export async function createCalendarEvent(connection, { calendarId, title, description = '', location = '', start, end, requestId, reminder: selectedReminder }) {
  const provider = connectionProvider(connection);
  const reminder = normalizeCalendarReminder(selectedReminder, provider);
  const base = calendarPath(provider, calendarId);
  if (typeof title !== 'string' || !title.trim() || title.length > 300 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('A calendar event title of up to 300 characters is required.');
  if (typeof description !== 'string' || description.length > 10000 || typeof location !== 'string' || location.length > 1000) throw new Error('The calendar event description or location is too long.');
  if (typeof requestId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(requestId)) throw new Error('A UUID request ID is required to create a calendar event.');
  const from = instant(start);
  const to = instant(end);
  if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 366 * 86400000) throw new Error('The calendar event must end after it starts and last no more than 366 days.');
  const id = `m${createHash('sha256').update(requestId.toLowerCase()).digest('hex')}`;
  const escapedDescription = description.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  const body = provider === 'google'
    ? { id, summary: title.trim(), description: escapedDescription, location, start: { dateTime: from }, end: { dateTime: to } }
    : { transactionId: requestId.toLowerCase(), subject: title.trim(), body: { contentType: 'text', content: description }, location: { displayName: location }, start: { dateTime: from.slice(0, -1), timeZone: 'UTC' }, end: { dateTime: to.slice(0, -1), timeZone: 'UTC' } };
  if (reminder) {
    if (provider === 'google') body.reminders = { useDefault: false, overrides: reminder.method === 'none' ? [] : [reminder] };
    else {
      body.isReminderOn = reminder.method !== 'none';
      if (reminder.method === 'popup') body.reminderMinutesBeforeStart = reminder.minutes;
    }
  }
  let result;
  try {
    result = await api(connection, `${base}/events${provider === 'google' ? '?sendUpdates=none' : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch (error) {
    if (provider !== 'google' || error.providerStatus !== 409) throw error;
    result = await api(connection, `${base}/events/${id}`);
    if (result?.status === 'cancelled' || result?.summary !== body.summary || (result?.description || '') !== body.description || (result?.location || '') !== body.location
      || eventDate(result.start, provider, false) !== from || eventDate(result.end, provider, false) !== to
      || !sameGoogleReminder(result.reminders, body.reminders)) {
      throw new Error('This calendar request ID was already used for different event details. Refresh before creating a new event.');
    }
  }
  return normalizedEvent(result, provider, calendarId);
}
