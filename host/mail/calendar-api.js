const { apiJson, safeId, cleanName, safeNext } = require("./provider-http");

const GOOGLE_ROOT = "https://www.googleapis.com/calendar/v3";
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0/me";
const MAX_PAGES = 5;
const MAX_EVENTS = 500;

function calendarPath(provider, calendarId, suffix) {
  const id = safeId(calendarId);
  if (!id) return "";
  if (provider === "google") {
    return `${GOOGLE_ROOT}/calendars/${encodeURIComponent(id)}${suffix}`;
  }
  if (provider === "microsoft") {
    return `${GRAPH_ROOT}/calendars/${encodeURIComponent(id)}${suffix}`;
  }
  return "";
}

function normalizeGoogleCalendar(item) {
  if (!item || !safeId(item.id)) return null;
  const id = safeId(item.id);
  return {
    id,
    name: cleanName(item.summary) || id,
    primary: item.primary === true,
  };
}

function normalizeGraphCalendar(item) {
  if (!item || !safeId(item.id)) return null;
  const id = safeId(item.id);
  return {
    id,
    name: cleanName(item.name) || id,
    primary: item.isDefaultCalendar === true,
  };
}

function normalizeGoogleEvent(item, calendarId) {
  if (!item || !safeId(item.id) || item.status === "cancelled") return null;
  const start = item.start && (item.start.dateTime || item.start.date) || "";
  const end = item.end && (item.end.dateTime || item.end.date) || "";
  if (!start) return null;
  const allDay = !!(item.start && item.start.date && !item.start.dateTime);
  return {
    id: safeId(item.id),
    calendarId: safeId(calendarId) || "",
    title: cleanName(item.summary) || "(no title)",
    start: allDay ? String(start).slice(0, 10) : start,
    end: end ? (allDay ? String(end).slice(0, 10) : end) : "",
    allDay,
    location: cleanName(item.location) || "",
  };
}

function zonedDateTime(value, timeZone, allDay) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (allDay) return raw.slice(0, 10);
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) return raw;
  if (String(timeZone || "").toUpperCase() === "UTC") return raw.replace(/\.\d+$/, "") + "Z";
  return raw;
}

function normalizeGraphEvent(item, calendarId) {
  if (!item || !safeId(item.id)) return null;
  const rawStart = item.start && item.start.dateTime || "";
  const rawEnd = item.end && item.end.dateTime || "";
  if (!rawStart) return null;
  const allDay = item.isAllDay === true;
  const startZone = item.start && item.start.timeZone;
  const endZone = item.end && item.end.timeZone;
  return {
    id: safeId(item.id),
    calendarId: safeId(calendarId) || "",
    title: cleanName(item.subject) || "(no title)",
    start: zonedDateTime(rawStart, startZone, allDay),
    end: rawEnd ? zonedDateTime(rawEnd, endZone, allDay) : "",
    allDay,
    location: cleanName(item.location && item.location.displayName) || "",
  };
}

function googleEventBody(draft) {
  const body = {
    summary: draft.title,
    start: { dateTime: draft.start, timeZone: "UTC" },
    end: { dateTime: draft.end, timeZone: "UTC" },
  };
  const location = cleanName(draft && draft.location);
  if (location) body.location = location;
  return body;
}

function graphEventBody(draft) {
  const body = {
    subject: draft.title,
    start: { dateTime: draft.start, timeZone: "UTC" },
    end: { dateTime: draft.end, timeZone: "UTC" },
    isAllDay: false,
  };
  const location = cleanName(draft && draft.location);
  if (location) body.location = { displayName: location };
  return body;
}

function pageToken(value) {
  const token = String(value || "");
  if (!/^[A-Za-z0-9_\-]{1,512}$/.test(token)) return "";
  return token;
}

async function listGoogleCalendars(accessToken, fetchImpl) {
  const url = new URL(`${GOOGLE_ROOT}/users/me/calendarList`);
  url.searchParams.set("maxResults", "100");
  const json = await apiJson(url.toString(), accessToken, { fetchImpl });
  const items = Array.isArray(json.items) ? json.items : null;
  if (!items) {
    const error = new Error("Google Calendar did not return a calendar list.");
    error.code = "provider";
    throw error;
  }
  return items.map(normalizeGoogleCalendar).filter(Boolean);
}

async function listGraphCalendars(accessToken, fetchImpl) {
  const url = new URL(`${GRAPH_ROOT}/calendars`);
  url.searchParams.set("$top", "100");
  url.searchParams.set("$select", "id,name,isDefaultCalendar");
  const rows = [];
  let next = url.toString();
  const seen = new Set();
  let pages = 0;
  while (next) {
    pages += 1;
    if (pages > MAX_PAGES || seen.has(next)) break;
    seen.add(next);
    const json = await apiJson(next, accessToken, { fetchImpl });
    const items = Array.isArray(json.value) ? json.value : null;
    if (!items) {
      const error = new Error("Outlook did not return a calendar list.");
      error.code = "provider";
      throw error;
    }
    rows.push(...items.map(normalizeGraphCalendar).filter(Boolean));
    next = safeNext(json["@odata.nextLink"], "graph.microsoft.com");
  }
  return rows;
}

async function listCalendars(provider, accessToken, fetchImpl) {
  if (provider === "google") return listGoogleCalendars(accessToken, fetchImpl);
  if (provider === "microsoft") return listGraphCalendars(accessToken, fetchImpl);
  return [];
}

async function listGoogleEvents(accessToken, calendarId, range, fetchImpl) {
  const events = [];
  let token = "";
  let truncated = false;
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(calendarPath("google", calendarId, "/events"));
    url.searchParams.set("timeMin", range.timeMin);
    url.searchParams.set("timeMax", range.timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "100");
    if (token) url.searchParams.set("pageToken", token);
    const key = url.toString();
    if (seen.has(key)) break;
    seen.add(key);
    const json = await apiJson(key, accessToken, { fetchImpl });
    const items = Array.isArray(json.items) ? json.items : null;
    if (!items) {
      const error = new Error("Google Calendar did not return events.");
      error.code = "provider";
      throw error;
    }
    for (const item of items) {
      const event = normalizeGoogleEvent(item, calendarId);
      if (event) events.push(event);
      if (events.length >= MAX_EVENTS) {
        truncated = true;
        return { events, truncated };
      }
    }
    token = pageToken(json.nextPageToken);
    if (!token) return { events, truncated };
  }
  return { events, truncated: truncated || Boolean(token) };
}

async function listGraphEvents(accessToken, calendarId, range, fetchImpl) {
  const events = [];
  const url = new URL(calendarPath("microsoft", calendarId, "/calendarView"));
  url.searchParams.set("startDateTime", range.timeMin);
  url.searchParams.set("endDateTime", range.timeMax);
  url.searchParams.set("$top", "100");
  url.searchParams.set("$select", "id,subject,start,end,isAllDay,location");
  let next = url.toString();
  const seen = new Set();
  let pages = 0;
  let truncated = false;
  while (next) {
    pages += 1;
    if (pages > MAX_PAGES || seen.has(next)) {
      truncated = true;
      break;
    }
    seen.add(next);
    const json = await apiJson(next, accessToken, { fetchImpl });
    const items = Array.isArray(json.value) ? json.value : null;
    if (!items) {
      const error = new Error("Outlook did not return events.");
      error.code = "provider";
      throw error;
    }
    for (const item of items) {
      const event = normalizeGraphEvent(item, calendarId);
      if (event) events.push(event);
      if (events.length >= MAX_EVENTS) return { events, truncated: true };
    }
    next = safeNext(json["@odata.nextLink"], "graph.microsoft.com");
  }
  return { events, truncated };
}

async function listEvents(provider, accessToken, calendarId, range, fetchImpl) {
  if (!calendarPath(provider, calendarId, "")) {
    const error = new Error("Choose a calendar.");
    error.code = "invalid";
    throw error;
  }
  if (provider === "google") return listGoogleEvents(accessToken, calendarId, range, fetchImpl);
  if (provider === "microsoft") return listGraphEvents(accessToken, calendarId, range, fetchImpl);
  return { events: [], truncated: false };
}

async function createEvent(provider, accessToken, calendarId, draft, fetchImpl) {
  const title = cleanName(draft && draft.title);
  const start = draft && draft.start;
  const end = draft && draft.end;
  if (!title) {
    const error = new Error("Add a title.");
    error.code = "invalid";
    throw error;
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    const error = new Error("Pick a start and a later end.");
    error.code = "invalid";
    throw error;
  }
  const body = { title, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
  const location = cleanName(draft && draft.location);
  if (location) body.location = location;
  if (provider === "google") {
    const url = calendarPath("google", calendarId, "/events");
    const json = await apiJson(url, accessToken, { method: "POST", fetchImpl, body: googleEventBody(body) });
    const event = normalizeGoogleEvent(json, calendarId);
    if (!event) {
      const error = new Error("Google Calendar did not return the new event.");
      error.code = "provider";
      throw error;
    }
    return event;
  }
  if (provider === "microsoft") {
    const url = calendarPath("microsoft", calendarId, "/events");
    const json = await apiJson(url, accessToken, { method: "POST", fetchImpl, body: graphEventBody(body) });
    const event = normalizeGraphEvent(json, calendarId);
    if (!event) {
      const error = new Error("Outlook did not return the new event.");
      error.code = "provider";
      throw error;
    }
    return event;
  }
  const error = new Error("Calendar needs a Google or Microsoft account.");
  error.code = "imap_only";
  throw error;
}

function preferredCalendarId(calendars) {
  const rows = Array.isArray(calendars) ? calendars : [];
  const primary = rows.find((calendar) => calendar && calendar.primary && calendar.id);
  if (primary) return primary.id;
  const first = rows.find((calendar) => calendar && calendar.id);
  return first ? first.id : "";
}

module.exports = {
  GOOGLE_ROOT,
  normalizeGoogleCalendar,
  normalizeGraphCalendar,
  normalizeGoogleEvent,
  normalizeGraphEvent,
  googleEventBody,
  graphEventBody,
  calendarPath,
  listCalendars,
  listEvents,
  createEvent,
  preferredCalendarId,
  pageToken,
};
