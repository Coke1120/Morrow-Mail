export const dateValue = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const localValue = date => `${dateValue(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
export const addDays = (value, days) => { const date = new Date(`${value}T12:00:00`); date.setDate(date.getDate() + days); return dateValue(date); };
export const shiftMonth = (month, offset) => { const date = new Date(`${month}-01T12:00:00`); date.setMonth(date.getMonth() + offset); return dateValue(date).slice(0, 7); };

export function monthDates(month) {
  const first = `${month}-01`, start = addDays(first, -new Date(`${first}T12:00:00`).getDay());
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));
  return { days, start: new Date(`${start}T00:00:00`).toISOString(), end: new Date(`${addDays(start, 42)}T00:00:00`).toISOString() };
}

export function eventOnDay(event, day) {
  // All-day dates are provider calendar dates, not instants to shift into another timezone.
  if (event.allDay) return day >= event.start.slice(0, 10) && day < event.end.slice(0, 10);
  const start = +new Date(`${day}T00:00:00`), end = +new Date(`${addDays(day, 1)}T00:00:00`);
  return Date.parse(event.start) < end && Date.parse(event.end) > start;
}

export const calendarKey = calendar => JSON.stringify([calendar.provider, calendar.id]);
export const calendarEventKey = event => JSON.stringify([event.provider, event.calendarId, event.id]);
export function checkedCalendars(calendars, choices) {
  const defaults = new Set(['google', 'microsoft'].map(provider => {
    const group = calendars.filter(calendar => calendar.provider === provider);
    return group.length ? calendarKey(group.find(calendar => calendar.primary) || group[0]) : '';
  }));
  return calendars.filter(calendar => choices[calendarKey(calendar)] ?? defaults.has(calendarKey(calendar))).slice(0, 12);
}
const colors = ['#487845', '#467bbb', '#a25d9c', '#b47826', '#34848b', '#b76459'];
export function calendarColor(calendar) {
  if (/^#[a-f\d]{6}$/i.test(calendar.color || '')) return calendar.color;
  const hash = [...calendarKey(calendar)].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
  return colors[hash % colors.length];
}
