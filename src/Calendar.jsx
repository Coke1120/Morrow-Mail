import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, ExternalLink, LoaderCircle, MapPin, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import './calendar.css';
import { storage } from './storage';
import { addDays, calendarColor, calendarEventKey, calendarKey, checkedCalendars, dateValue, eventOnDay, localValue, monthDates, shiftMonth } from './calendar-dates';

const PROVIDERS = { google: 'Google Calendar', microsoft: 'Outlook Calendar' };
const CHECKED_KEY = 'morrow.calendar.checked';
const initialForm = (day = addDays(dateValue(new Date()), 1)) => ({ title: '', description: '', location: '', start: `${day}T09:00`, end: `${day}T10:00`, reminderMethod: 'default', reminderMinutes: '15' });
const readableDate = value => { const date = new Date(value?.length === 10 ? `${value}T12:00:00` : value); return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); };
const readableTime = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Time unavailable' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); };
const safeWebUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } };

export async function calendarRequest(path, options = {}) {
  const response = await fetch(`/api/calendars${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Calendar request failed (${response.status}). Please try again.`);
  return body;
}

export function savedCalendarChoices(raw) {
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid calendar choices.');
  const result = {};
  for (const [key, checked] of Object.entries(value)) {
    const parts = JSON.parse(key);
    if (!Array.isArray(parts) || parts.length !== 2 || !PROVIDERS[parts[0]] || typeof parts[1] !== 'string' || typeof checked !== 'boolean') throw new Error('Invalid calendar choices.');
    result[key] = checked;
  }
  return result;
}

export function calendarReminder(method, minutes, provider) {
  if (method === 'default') return undefined;
  if (method === 'none') return { method: 'none' };
  if (!['popup', 'email'].includes(method) || (method === 'email' && provider !== 'google')) throw new Error('Outlook supports notification reminders only.');
  const value = Number(minutes);
  if (String(minutes).trim() === '' || !Number.isInteger(value) || value < 0 || value > 40320) throw new Error('Choose a whole number of minutes from 0 to 40320.');
  return { method, minutes: value };
}

export function calendarReview(form, selected, connection) {
  if (!selected?.canWrite || !connection?.connected || selected.provider !== connection.provider) throw new Error('Choose a connected writable calendar.');
  const start = new Date(form.start), end = new Date(form.end);
  if (!form.title.trim() || !Number.isFinite(+start) || !Number.isFinite(+end) || end <= start) throw new Error('Enter a title and an end time after the start time.');
  if (localValue(start) !== form.start || localValue(end) !== form.end) throw new Error('This local time does not exist because the clocks change. Choose another time.');
  const reminder = calendarReminder(form.reminderMethod, form.reminderMinutes, selected.provider);
  return { provider: selected.provider, calendarName: selected.name, calendarId: selected.id, connectionEmail: connection.email, title: form.title.trim(), description: form.description.trim(), location: form.location.trim(), start: start.toISOString(), end: end.toISOString(), ...(reminder ? { reminder } : {}) };
}

export function calendarSubmission(review, requestId) {
  const { provider, calendarName, ...payload } = review;
  return { provider, fingerprint: JSON.stringify({ provider, ...payload }), payload: { ...payload, requestId } };
}

export function restoreCalendarRequest(raw) {
  if (!raw) return null;
  const saved = JSON.parse(raw);
  if (!saved.review || !saved.requestId || !PROVIDERS[saved.review.provider]) throw new Error('Invalid saved calendar request.');
  // Keep the exact original review. In particular, do not add a default reminder to legacy requests.
  return saved;
}

export async function loadCalendarEvents(calendars, range, signal, request = calendarRequest) {
  calendars = calendars.slice(0, 12);
  const events = [], errors = [];
  let index = 0;
  async function worker() {
    while (index < calendars.length && !signal.aborted) {
      const calendar = calendars[index++];
      try {
        const query = new URLSearchParams({ calendarId: calendar.id, start: range.start, end: range.end });
        const result = await request(`/${calendar.provider}/events?${query}`, { signal });
        if (signal.aborted) return;
        if (!Array.isArray(result.events) || result.events.some(event => !event || typeof event.id !== 'string' || !Number.isFinite(Date.parse(event.start)) || !Number.isFinite(Date.parse(event.end)) || Date.parse(event.end) <= Date.parse(event.start) || (event.allDay && (!/^\d{4}-\d{2}-\d{2}$/.test(event.start) || !/^\d{4}-\d{2}-\d{2}$/.test(event.end))))) throw new Error('This calendar returned an invalid event list.');
        events.push(...result.events.map(event => ({ ...event, provider: calendar.provider, calendarId: calendar.id, calendarName: calendar.name, color: calendarColor(calendar) })));
      } catch (cause) { if (!signal.aborted) errors.push({ calendar, message: cause.message }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, calendars.length) }, worker));
  if (signal.aborted) throw new DOMException('Calendar read cancelled.', 'AbortError');
  const unique = [...new Map(events.map(event => [calendarEventKey(event), event])).values()];
  unique.sort((a, b) => a.start.localeCompare(b.start) || calendarEventKey(a).localeCompare(calendarEventKey(b)));
  return { events: unique, errors };
}

export function CalendarMonth({ month, selectedDay, events, disabled, onDay, today = dateValue(new Date()) }) {
  const { days } = monthDates(month);
  return <div className="calendar-month" aria-label="Month calendar">
    <div className="calendar-weekdays" aria-hidden="true">{days.slice(0, 7).map(day => <span key={day}>{new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short' })}</span>)}</div>
    <div className="calendar-month-days">{days.map(day => {
      const items = events.filter(event => eventOnDay(event, day));
      return <button type="button" key={day} disabled={disabled} className={`calendar-day ${day.startsWith(month) ? '' : 'outside-month'} ${day === today ? 'is-today' : ''}`} aria-pressed={day === selectedDay} aria-label={`${readableDate(day)} · ${items.length} loaded events`} onClick={() => onDay(day)}>
        <time dateTime={day}>{Number(day.slice(-2))}</time>{items.slice(0, 3).map(event => <span key={calendarEventKey(event)} className="calendar-day-event" style={{ '--event-color': event.color }} title={`${event.calendarName} · ${event.title}`}><span className="calendar-color" />{event.allDay ? '' : `${readableTime(event.start)} `}{event.title || '(Untitled event)'}</span>)}{items.length > 3 && <small>+{items.length - 3} more</small>}
      </button>;
    })}</div>
  </div>;
}

export function CalendarAgenda({ events, day, loading, incomplete, checkedCount }) {
  const items = events.filter(event => eventOnDay(event, day));
  return <section className="calendar-agenda" aria-label={`Events on ${readableDate(day)}`} aria-live="polite" aria-busy={loading}>
    {loading && <p className="calendar-status" role="status"><LoaderCircle size={17} className="calendar-spinner" />Loading events…</p>}
    {items.map(event => {
      const link = safeWebUrl(event.webUrl);
      const startDay = event.start.slice(0, 10), lastDay = addDays(event.end.slice(0, 10), -1);
      return <article className="calendar-event" key={calendarEventKey(event)} style={{ '--event-color': event.color }}><div className="calendar-event-date"><CalendarDays size={16} /><strong>{readableDate(event.allDay ? startDay : event.start)}</strong><span>{event.allDay ? 'All day' : readableTime(event.start)}</span></div><div className="calendar-event-content"><h3>{event.title || '(Untitled event)'}</h3><p><span className="calendar-color" />{PROVIDERS[event.provider]} · {event.calendarName}</p><p><Clock3 size={13} />{event.allDay ? `All day${lastDay !== startDay ? ` · through ${readableDate(lastDay)}` : ''}` : `${readableTime(event.start)} – ${readableDate(event.start) === readableDate(event.end) ? '' : `${readableDate(event.end)} · `}${readableTime(event.end)}`}{event.status === 'cancelled' ? ' · Cancelled' : ''}</p>{event.location && <p><MapPin size={13} />{event.location}</p>}{event.description && <details><summary>Description</summary><p className="calendar-description">{event.description}</p></details>}</div>{link && <a className="calendar-event-link" href={link} target="_blank" rel="noopener noreferrer" aria-label={`Open ${event.title || 'event'} in ${PROVIDERS[event.provider]}`}>Open<ExternalLink size={13} /></a>}</article>;
    })}
    {!loading && !items.length && <div className="calendar-empty-agenda"><CalendarDays size={25} /><p>{incomplete ? 'Some calendars could not be loaded. Events may be missing from this day.' : !checkedCount ? 'Check a calendar to view its events.' : 'No events on this day in the checked calendars.'}</p></div>}
  </section>;
}

export function CalendarReminder({ provider, value, onChange }) {
  return <><div className="calendar-form-columns"><label className="calendar-field">Reminder<select value={value.reminderMethod} onChange={event => onChange({ ...value, reminderMethod: event.target.value })}><option value="default">Provider default</option><option value="none">None</option><option value="popup">Notification</option>{provider === 'google' && <option value="email">Email from Google Calendar</option>}</select></label>{['popup', 'email'].includes(value.reminderMethod) && <label className="calendar-field">Minutes before<input type="number" required min="0" max="40320" step="1" list="calendar-reminder-minutes" value={value.reminderMinutes} onChange={event => onChange({ ...value, reminderMinutes: event.target.value })} /><datalist id="calendar-reminder-minutes">{[[0, 'At start'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [1440, '1 day'], [10080, '1 week']].map(([minutes, label]) => <option key={minutes} value={minutes}>{label}</option>)}</datalist><span>0 means at start. Up to 28 days before.</span></label>}</div>
          <p className="calendar-note">Reminders are handled by your provider and can work while Morrow is closed. Outlook supports notifications only; email reminders are available for Google Calendar. No attendees are added and Morrow sends no automatic email.</p></>;
}

export function CalendarEventReview({ review, creating, recovery, disabled, onEdit, onCreate }) {
  const reminder = review.reminder;
  return <><dl className="calendar-review"><div><dt>Calendar</dt><dd>{PROVIDERS[review.provider]} · {review.calendarName}<small>{review.connectionEmail}</small></dd></div><div><dt>Event</dt><dd>{review.title}</dd></div><div><dt>Starts</dt><dd>{readableDate(review.start)} · {readableTime(review.start)}</dd></div><div><dt>Ends</dt><dd>{readableDate(review.end)} · {readableTime(review.end)}</dd></div><div><dt>Timezone</dt><dd>{Intl.DateTimeFormat().resolvedOptions().timeZone}</dd></div><div><dt>Reminder</dt><dd>{!reminder ? 'Provider default' : reminder.method === 'none' ? 'None' : `${reminder.method === 'email' ? 'Google email' : 'Notification'} · ${reminder.minutes === 0 ? 'At start' : `${reminder.minutes} minutes before`}`}</dd></div>{review.location && <div><dt>Location</dt><dd>{review.location}</dd></div>}{review.description && <div><dt>Description</dt><dd>{review.description}</dd></div>}</dl><p className="calendar-note">This creates a real event. No attendees are added and Morrow sends no automatic email. Reminders are handled by your provider and can work while Morrow is closed. Outlook supports notifications only.</p><div className="calendar-form-actions"><button className="button secondary" disabled={creating || !!recovery} onClick={onEdit}>Edit details</button><button className="button primary" disabled={creating || disabled} onClick={onCreate}>{creating ? <LoaderCircle size={15} className="calendar-spinner" /> : <Check size={15} />}{creating ? 'Creating event…' : `Create event in ${PROVIDERS[review.provider]}`}</button></div></>;
}

export default function Calendar({ onNotify, onOpenSettings, onDirtyChange, onBusyChange }) {
  const [catalog, setCatalog] = useState({ connections: [], calendars: [], errors: [] });
  const [choices, setChoices] = useState({}), [choicesReady, setChoicesReady] = useState(false), [choicesError, setChoicesError] = useState('');
  const [selection, setSelection] = useState('');
  const [loading, setLoading] = useState(true), [catalogError, setCatalogError] = useState(''), [catalogRevision, setCatalogRevision] = useState(0);
  const [month, setMonth] = useState(() => dateValue(new Date()).slice(0, 7)), [day, setDay] = useState(() => dateValue(new Date()));
  const [eventRead, setEventRead] = useState({ key: '', events: [], errors: [], loading: false }), [eventsRevision, setEventsRevision] = useState(0);
  const eventGeneration = useRef(0), catalogGeneration = useRef(0);
  const [form, setForm] = useState(initialForm), savedForm = useRef(form);
  const [formOpen, setFormOpen] = useState(false), [review, setReview] = useState(null), [createError, setCreateError] = useState(''), [creating, setCreating] = useState(false);
  const pendingCreate = useRef(null), attempt = useRef(null), formHeading = useRef(null);
  const [recovery, setRecovery] = useState(null), [recoveryError, setRecoveryError] = useState('');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const available = catalog.calendars.filter(calendar => catalog.connections.some(connection => connection.connected && connection.provider === calendar.provider));
  const checked = checkedCalendars(available, choices), checkedKeys = new Set(checked.map(calendarKey));
  const writable = checked.filter(calendar => calendar.canWrite);
  const selected = writable.find(calendar => calendarKey(calendar) === selection);
  const connection = catalog.connections.find(item => item.provider === selected?.provider && item.connected);
  const readKey = JSON.stringify([month, checked.map(calendarKey), catalog, catalogRevision, eventsRevision]);
  const currentRead = eventRead.key === readKey && !loading && !catalogError;
  const events = currentRead ? eventRead.events : [], eventErrors = currentRead ? eventRead.errors : [];
  const eventLoading = loading || (!catalogError && checked.length > 0 && (!currentRead || eventRead.loading));
  const dirty = formOpen && (JSON.stringify(form) !== JSON.stringify(savedForm.current) || !!review);
  const targetValid = !loading && !catalogError && selected && connection && review?.provider === selected.provider && review?.calendarId === selected.id && review?.connectionEmail === connection.email;

  useEffect(() => {
    try { setChoices(savedCalendarChoices(storage.getItem(CHECKED_KEY))); } catch { setChoicesError('Saved calendar choices could not be read. Default calendars are shown for this session.'); }
    setChoicesReady(true);
    try { setRecovery(restoreCalendarRequest(storage.getItem('morrow.pendingCalendar'))); }
    catch { setRecoveryError('The saved calendar request could not be read. Resolve the saved request before creating another event.'); }
  }, []);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange?.(creating); return () => onBusyChange?.(false); }, [creating, onBusyChange]);
  useEffect(() => {
    const warn = event => { if (dirty || creating) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, creating]);
  useEffect(() => () => { pendingCreate.current?.abort(); }, []);

  useEffect(() => {
    const controller = new AbortController(), generation = ++catalogGeneration.current;
    setLoading(true); setCatalogError('');
    calendarRequest('', { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || generation !== catalogGeneration.current) return;
      if (!Array.isArray(result.calendars) || !Array.isArray(result.connections)) throw new Error('The calendar catalog could not be read.');
      setCatalog(result);
    }).catch(error => { if (!controller.signal.aborted && generation === catalogGeneration.current) setCatalogError(error.message); })
      .finally(() => { if (!controller.signal.aborted && generation === catalogGeneration.current) setLoading(false); });
    return () => { controller.abort(); catalogGeneration.current++; };
  }, [catalogRevision]);

  useEffect(() => {
    const controller = new AbortController(), generation = ++eventGeneration.current;
    if (loading || catalogError || !choicesReady) return () => { controller.abort(); eventGeneration.current++; };
    setEventRead({ key: readKey, events: [], errors: [], loading: true });
    loadCalendarEvents(checked, monthDates(month), controller.signal).then(result => {
      if (!controller.signal.aborted && generation === eventGeneration.current) setEventRead({ key: readKey, ...result, loading: false });
    }).catch(cause => {
      if (!controller.signal.aborted && generation === eventGeneration.current) setEventRead({ key: readKey, events: [], errors: checked.map(calendar => ({ calendar, message: cause.message })), loading: false });
    });
    return () => { controller.abort(); eventGeneration.current++; };
  }, [readKey, loading, catalogError, choicesReady]);

  function saveChoices(next) {
    setChoices(next);
    try { storage.setItem(CHECKED_KEY, JSON.stringify(next)); setChoicesError(''); }
    catch { setChoicesError('Calendar choices could not be saved. These choices apply only to this session.'); }
  }
  function resetForm(date) { const next = initialForm(date); savedForm.current = next; setForm(next); }
  function discardDraft(prompt) {
    if (creating || pendingCreate.current || (dirty && !window.confirm(prompt))) return false;
    setFormOpen(false); setReview(null); setCreateError(''); resetForm(); attempt.current = null;
    return true;
  }
  function openForm(date = day) {
    if (creating || pendingCreate.current) return;
    if (recovery || recoveryError) { setDay(date); setCreateError('Resolve the saved calendar request before creating another event.'); return; }
    if (!discardDraft('Discard this calendar event draft and choose another day?')) return;
    setDay(date);
    if (!writable.length || loading || catalogError) return;
    setSelection(calendarKey(selected || writable.find(calendar => calendar.primary) || writable[0]));
    resetForm(date); setFormOpen(true);
    requestAnimationFrame(() => formHeading.current?.focus());
  }
  function closeForm() { discardDraft('Discard this calendar event draft?'); }
  function changeMonth(next, nextDay = `${next}-01`) {
    if (!discardDraft('Discard this calendar event draft and change the month?')) return;
    setMonth(next); setDay(nextDay);
  }
  function changeChecked(calendar, checked) {
    if (!discardDraft('Discard this event draft and change the visible calendars?')) return;
    if (checked && !checkedKeys.has(calendarKey(calendar)) && checkedKeys.size >= 12) { setChoicesError('Choose up to 12 calendars at a time.'); return; }
    saveChoices({ ...choices, ...Object.fromEntries(catalog.calendars.map(item => [calendarKey(item), checkedKeys.has(calendarKey(item))])), [calendarKey(calendar)]: checked });
  }
  function reviewEvent(event) {
    event.preventDefault(); setCreateError('');
    if (creating || recovery || recoveryError || loading || catalogError) return;
    try { setReview(calendarReview(form, selected, connection)); } catch (cause) { setCreateError(cause.message); }
  }
  async function createEvent() {
    if (recoveryError || !review || pendingCreate.current || !targetValid) return;
    if (recovery && JSON.stringify(recovery.review) !== JSON.stringify(review)) { setCreateError('Resolve the original request before changing its details.'); return; }
    const { fingerprint } = calendarSubmission(review);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, requestId: crypto.randomUUID() };
    const { provider, payload } = calendarSubmission(review, attempt.current.requestId);
    try { const saved = { review, requestId: attempt.current.requestId }; storage.setItem('morrow.pendingCalendar', JSON.stringify(saved)); setRecovery(saved); }
    catch { setCreateError('Could not save the request for recovery. No event has been submitted.'); return; }
    const controller = new AbortController(); pendingCreate.current = controller;
    setCreating(true); setCreateError('');
    try {
      await calendarRequest(`/${provider}/events`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (controller.signal.aborted) return;
      storage.removeItem('morrow.pendingCalendar'); setRecovery(null);
      setFormOpen(false); setReview(null); resetForm(); attempt.current = null;
      setEventsRevision(value => value + 1); onNotify?.(`Event created in ${PROVIDERS[provider]}.`);
    } catch (error) {
      if (!controller.signal.aborted) setCreateError(`${error.message} Your reviewed event is kept. Retrying uses the same request ID to avoid creating a duplicate.`);
    } finally { if (pendingCreate.current === controller) { pendingCreate.current = null; if (!controller.signal.aborted) setCreating(false); } }
  }
  function restoreReview() {
    const restored = recovery.review;
    if (!catalog.connections.some(item => item.provider === restored.provider && item.email === restored.connectionEmail && item.connected) || !catalog.calendars.some(item => item.provider === restored.provider && item.id === restored.calendarId && item.canWrite)) { setRecoveryError('Reconnect the original writable calendar before retrying.'); return; }
    const key = calendarKey({ provider: restored.provider, id: restored.calendarId });
    if (!checkedKeys.has(key) && checkedKeys.size >= 12) { setRecoveryError('Uncheck a calendar before restoring the original request. Up to 12 calendars can be checked.'); return; }
    saveChoices({ ...choices, [key]: true }); setRecoveryError(''); setCreateError(''); setSelection(key); setReview(restored); setFormOpen(true);
    attempt.current = { fingerprint: calendarSubmission(restored).fingerprint, requestId: recovery.requestId };
  }

  return <section className="calendar-page" aria-label="Calendar"><div className="calendar-inner">
    {(recovery || recoveryError) && <div className="calendar-error" role="alert"><strong>Unconfirmed calendar request</strong><p>{recoveryError || `${recovery.review.title} · ${recovery.review.connectionEmail}. Check your calendar before retrying.`}</p>{recovery && <div className="calendar-button-row"><button className="button secondary" disabled={creating || loading || !!catalogError} onClick={restoreReview}>Review original request</button><button className="button secondary" disabled={creating} onClick={() => {
      if (!window.confirm('Have you checked the provider calendar? Clear this local request only after verifying whether the event exists. This will not delete any provider event.')) return;
      try { storage.removeItem('morrow.pendingCalendar'); setRecovery(null); setRecoveryError(''); setFormOpen(false); setReview(null); resetForm(); attempt.current = null; } catch { setCreateError('Could not clear the saved request.'); }
    }}>I checked the calendar — clear request</button></div>}</div>}
    <header className="calendar-heading"><h1>Calendar</h1><div className="calendar-button-row"><button className="icon-button" aria-label="Refresh calendars" disabled={creating || loading} onClick={() => setCatalogRevision(value => value + 1)}><RefreshCw size={16} /></button><button className="button secondary" onClick={onOpenSettings} disabled={creating}><Settings2 size={15} />Connections</button></div></header>
    {catalogError && <div className="calendar-error" role="alert"><p>{catalogError}</p><button className="button secondary" disabled={creating} onClick={() => setCatalogRevision(value => value + 1)}>Retry connections</button></div>}
    {catalog.errors?.map(error => <div className="calendar-error" role="alert" key={error.provider}><p><strong>{PROVIDERS[error.provider] || error.provider}:</strong> {error.message}</p><button className="button secondary" disabled={creating} onClick={onOpenSettings}>Manage connection</button></div>)}
    {choicesError && <p className="calendar-error" role="alert">{choicesError}</p>}
    {loading && <p className="calendar-status" role="status"><LoaderCircle size={17} className="calendar-spinner" />Loading calendars…</p>}
    {!loading && !catalog.calendars.length && !catalogError && !catalog.errors?.length && <section className="calendar-empty"><span className="calendar-empty-icon"><CalendarDays size={31} /></span><h2>Bring your day together.</h2><p>Connect Google Calendar or Outlook Calendar to view events and create plans. Calendar connections work independently of your mailbox.</p><button className="button primary" onClick={onOpenSettings}>Connect a calendar</button></section>}
    {!!catalog.calendars.length && <>
      <fieldset className="calendar-filters" disabled={creating || loading} aria-label="Visible calendars"><legend>Calendars to show · up to 12</legend>{catalog.calendars.map(calendar => <label key={calendarKey(calendar)} style={{ '--event-color': calendarColor(calendar) }}><input type="checkbox" checked={checkedKeys.has(calendarKey(calendar))} disabled={(!checkedKeys.has(calendarKey(calendar)) && checked.length >= 12) || !available.includes(calendar)} onChange={event => changeChecked(calendar, event.target.checked)} /><span className="calendar-color" /><span>{calendar.name}<small>{PROVIDERS[calendar.provider]}{calendar.canWrite ? '' : ' · Read only'}</small></span></label>)}</fieldset>
      <section className="calendar-month-heading" aria-label="Month navigation"><h2>{new Date(`${month}-01T12:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' })}</h2><div className="calendar-navigation"><button className="icon-button" aria-label="Previous month" disabled={creating} onClick={() => changeMonth(shiftMonth(month, -1))}><ChevronLeft size={17} /></button><button className="button ghost" disabled={creating} onClick={() => { const today = dateValue(new Date()); changeMonth(today.slice(0, 7), today); }}>Today</button><button className="icon-button" aria-label="Next month" disabled={creating} onClick={() => changeMonth(shiftMonth(month, 1))}><ChevronRight size={17} /></button></div></section>
      {eventErrors.map(error => <p className="calendar-error" role="alert" key={calendarKey(error.calendar)}><strong>{PROVIDERS[error.calendar.provider]} · {error.calendar.name}:</strong> {error.message}</p>)}
      <CalendarMonth month={month} selectedDay={day} events={events} disabled={creating} onDay={openForm} />
      <div className="calendar-agenda-heading"><div><h2>{readableDate(day)}</h2><p>Times shown in {timezone}. Click a day to plan an event.</p></div><div className="calendar-button-row"><button className="icon-button" aria-label="Refresh calendar events" disabled={eventLoading || creating || loading || !!catalogError} onClick={() => setEventsRevision(value => value + 1)}><RefreshCw size={16} className={eventLoading ? 'calendar-spinner' : ''} /></button><button className="button primary" disabled={!writable.length || loading || !!catalogError || formOpen || creating || !!recovery || !!recoveryError} onClick={() => openForm()}><Plus size={15} />New event</button></div></div>
      {!writable.length && <p className="calendar-note">Check a writable calendar to create an event. Read-only calendars can still be viewed.</p>}
      {createError && !formOpen && <p className="calendar-error" role="alert">{createError}</p>}
      {formOpen && <section className="calendar-event-form" aria-labelledby="calendar-new-event"><div className="calendar-form-heading"><h2 id="calendar-new-event" tabIndex={-1} ref={formHeading}>{review ? 'Review your event' : 'Make a little time.'}</h2><button className="icon-button" aria-label="Close event draft" onClick={closeForm} disabled={creating}><X size={18} /></button></div>
        {createError && <p className="calendar-error" role="alert">{createError}</p>}
        {review && !loading && !targetValid && <p className="calendar-error" role="alert">The original writable calendar is unavailable. Reconnect it and check it before creating this reviewed event.</p>}
        {review ? <CalendarEventReview review={review} creating={creating} recovery={recovery} disabled={!targetValid || !!recoveryError} onEdit={() => { setReview(null); setCreateError(''); }} onCreate={createEvent} /> : <form onSubmit={reviewEvent}><fieldset disabled={creating || loading || !!catalogError}>
          <label className="calendar-field">Create in checked calendar<select value={selection} onChange={event => { setSelection(event.target.value); setCreateError(''); setForm(value => ({ ...value, reminderMethod: value.reminderMethod === 'email' && writable.find(calendar => calendarKey(calendar) === event.target.value)?.provider !== 'google' ? 'default' : value.reminderMethod })); }}>{!selected && <option value="">Choose a writable calendar</option>}{writable.map(calendar => <option key={calendarKey(calendar)} value={calendarKey(calendar)}>{PROVIDERS[calendar.provider]} · {calendar.name}</option>)}</select><span>{connection?.email}{selected?.timeZone && selected.timeZone !== timezone ? ` · Calendar timezone: ${selected.timeZone}` : ''}</span></label>
          <label className="calendar-field">Event title<input required maxLength={200} value={form.title} onChange={event => setForm(value => ({ ...value, title: event.target.value }))} placeholder="Time to catch up" /></label><div className="calendar-form-columns"><label className="calendar-field">Starts<input type="datetime-local" required value={form.start} onChange={event => setForm(value => ({ ...value, start: event.target.value }))} /></label><label className="calendar-field">Ends<input type="datetime-local" required value={form.end} onChange={event => setForm(value => ({ ...value, end: event.target.value }))} /></label></div><p className="calendar-note">Enter times in {timezone}. Review the exact date and time before creating.</p>
          <CalendarReminder provider={selected?.provider} value={form} onChange={setForm} />
          <label className="calendar-field">Location <span>(optional)</span><input maxLength={500} value={form.location} onChange={event => setForm(value => ({ ...value, location: event.target.value }))} /></label><label className="calendar-field">Description <span>(optional)</span><textarea rows={3} maxLength={5000} value={form.description} onChange={event => setForm(value => ({ ...value, description: event.target.value }))} /></label><div className="calendar-form-actions"><button type="button" className="button secondary" onClick={closeForm}>Cancel</button><button className="button primary" type="submit" disabled={!selected || !connection}>Review event<ChevronRight size={15} /></button></div>
        </fieldset></form>}
      </section>}
      <CalendarAgenda events={events} day={day} loading={eventLoading} incomplete={!!catalogError || !!catalog.errors?.length || eventErrors.length > 0} checkedCount={checked.length} />
    </>}
  </div></section>;
}
