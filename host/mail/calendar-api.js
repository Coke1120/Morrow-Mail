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

function plainDescription(value, limit = 8000) {
  const stripped = String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!stripped) return "";
  return limit > 0 && stripped.length > limit ? stripped.slice(0, limit) : stripped;
}

function normalizeGoogleEvent(item, calendarId) {
  if (!item || !safeId(item.id) || item.status === "cancelled") return null;
  const start = item.start && (item.start.dateTime || item.start.date) || "";
  const end = item.end && (item.end.dateTime || item.end.date) || "";
  if (!start) return null;
  const allDay = !!(item.start && item.start.date && !item.start.dateTime);
  const fullDescription = plainDescription(item.description, 0);
  return {
    id: safeId(item.id),
    calendarId: safeId(calendarId) || "",
    title: cleanName(item.summary) || "(no title)",
    start: allDay ? String(start).slice(0, 10) : start,
    end: end ? (allDay ? String(end).slice(0, 10) : end) : "",
    allDay,
    location: cleanName(item.location) || "",
    description: fullDescription.slice(0, 8000),
    ...(fullDescription.length > 8000 ? { descriptionTruncated: true } : {}),
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
    description: plainDescription((item.body && item.body.content) || item.bodyPreview),
  };
}

function googleEventBody(draft) {
  const allDay = !!(draft && draft.allDay);
  const body = { summary: draft.title };
  if (allDay) {
    body.start = { date: String(draft.start).slice(0, 10) };
    body.end = { date: String(draft.end).slice(0, 10) };
  } else {
    body.start = { dateTime: draft.start, timeZone: "UTC" };
    body.end = { dateTime: draft.end, timeZone: "UTC" };
  }
  const location = cleanName(draft && draft.location);
  if (draft && Object.prototype.hasOwnProperty.call(draft, "location")) body.location = location;
  if (draft && Object.prototype.hasOwnProperty.call(draft, "description")) {
    body.description = String(draft.description || "");
  }
  return body;
}

function graphEventBody(draft) {
  const allDay = !!(draft && draft.allDay);
  const body = { subject: draft.title, isAllDay: allDay };
  if (allDay) {
    body.start = { dateTime: String(draft.start).slice(0, 10) + "T00:00:00", timeZone: "UTC" };
    body.end = { dateTime: String(draft.end).slice(0, 10) + "T00:00:00", timeZone: "UTC" };
  } else {
    body.start = { dateTime: draft.start, timeZone: "UTC" };
    body.end = { dateTime: draft.end, timeZone: "UTC" };
  }
  const location = cleanName(draft && draft.location);
  if (draft && Object.prototype.hasOwnProperty.call(draft, "location")) body.location = { displayName: location };
  if (draft && Object.prototype.hasOwnProperty.call(draft, "description")) {
    body.body = { contentType: "Text", content: String(draft.description || "") };
  }
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
  url.searchParams.set("$select", "id,subject,start,end,isAllDay,location,bodyPreview");
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

// Sequential so a rate limit stops the rest. Each calendar keeps listEvents' MAX_EVENTS cap.
async function listEventsForIds(provider, accessToken, calendarIds, range, fetchImpl) {
  const events = [];
  let truncated = false;
  const fetched = [];
  for (const calendarId of Array.isArray(calendarIds) ? calendarIds : []) {
    const listed = await listEvents(provider, accessToken, calendarId, range, fetchImpl);
    fetched.push(calendarId);
    if (listed.events.length) events.push(...listed.events);
    if (listed.truncated) truncated = true;
  }
  return { events, truncated, calendarIds: fetched };
}

function invalidEvent(message) {
  const error = new Error(message);
  error.code = "invalid";
  return error;
}

function writeEvent(draft) {
  const title = cleanName(draft && draft.title);
  if (!title) throw invalidEvent("Add a title.");
  const location = cleanName(draft && draft.location);
  const optional = {};
  if (draft && Object.prototype.hasOwnProperty.call(draft, "description")) {
    optional.description = plainDescription(draft.description, 0);
    if (optional.description.length > 8000) throw invalidEvent("This description is too long for this editor. Leave it unchanged or edit it with the calendar provider.");
  }
  if (draft && Object.prototype.hasOwnProperty.call(draft, "location")) optional.location = location;
  if (draft && draft.allDay === true) {
    const start = String(draft.start || "").slice(0, 10);
    const end = String(draft.end || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end <= start) {
      throw invalidEvent("Pick a start date and a later end date.");
    }
    return { title, start, end, allDay: true, ...optional };
  }
  const startMs = Date.parse(draft && draft.start);
  const endMs = Date.parse(draft && draft.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw invalidEvent("Pick a start and a later end.");
  }
  const body = {
    title,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    allDay: false,
    ...optional,
  };
  return body;
}

async function sendEvent(provider, accessToken, calendarId, url, body, method, fetchImpl, headers) {
  if (!url) throw invalidEvent("Choose a calendar.");
  if (provider === "google") {
    const json = await apiJson(url, accessToken, { method, fetchImpl, headers, body: googleEventBody(body) });
    const event = normalizeGoogleEvent(json, calendarId);
    if (!event) {
      const error = new Error(method === "POST" ? "Google Calendar did not return the new event." : "Google Calendar did not return the event.");
      error.code = "provider";
      throw error;
    }
    return event;
  }
  if (provider === "microsoft") {
    const json = await apiJson(url, accessToken, { method, fetchImpl, headers, body: graphEventBody(body) });
    const event = normalizeGraphEvent(json, calendarId);
    if (!event) {
      const error = new Error(method === "POST" ? "Outlook did not return the new event." : "Outlook did not return the event.");
      error.code = "provider";
      throw error;
    }
    return event;
  }
  const error = new Error("Calendar needs a Google or Microsoft account.");
  error.code = "imap_only";
  throw error;
}

async function createEvent(provider, accessToken, calendarId, draft, fetchImpl) {
  const body = writeEvent(draft);
  const suffix = "/events";
  const url = provider === "google" || provider === "microsoft" ? calendarPath(provider, calendarId, suffix) : "";
  return sendEvent(provider, accessToken, calendarId, url, body, "POST", fetchImpl);
}

async function updateEvent(provider, accessToken, calendarId, eventId, draft, fetchImpl) {
  const id = safeId(eventId);
  if (!id) throw invalidEvent("Choose an event.");
  const body = writeEvent(draft);
  const suffix = "/events/" + encodeURIComponent(id);
  const url = provider === "google" || provider === "microsoft" ? calendarPath(provider, calendarId, suffix) : "";
  let headers;
  const providerName = provider === "google" ? "Google Calendar" : "Outlook";
  if (["google", "microsoft"].includes(provider) && Object.prototype.hasOwnProperty.call(body, "description")) {
    // A list description can be a preview. Validate the complete baseline and
    // condition the replacement on its revision, for both providers.
    const current = await apiJson(url, accessToken, { fetchImpl });
    const full = provider === "google"
      ? (current.description == null ? "" : typeof current.description === "string" ? plainDescription(current.description, 0) : null)
      : current.body && typeof current.body.content === "string" ? plainDescription(current.body.content, 0) : null;
    if (safeId(current.id) !== id || full == null || full.length > 8000 || provider === "microsoft" && current.isOnlineMeeting === true
        || typeof draft.descriptionBase !== "string" || full !== draft.descriptionBase.trim()) {
      const error = new Error(`The full ${providerName} description cannot be safely replaced from this preview. Edit it with the calendar provider, or leave it unchanged to save other fields.`);
      error.code = "conflict";
      throw error;
    }
    const revision = provider === "google" ? current.etag : current["@odata.etag"];
    if (typeof revision !== "string" || !revision || revision.length > 1024 || /[\r\n]/.test(revision)) {
      const error = new Error(`${providerName} did not confirm the event revision. Refresh the calendar before changing its description.`);
      error.code = "conflict";
      throw error;
    }
    headers = { "if-match": revision };
  }
  try {
    return await sendEvent(provider, accessToken, calendarId, url, body, "PATCH", fetchImpl, headers);
  } catch (error) {
    if (error.status === 412) {
      error.code = "conflict";
      error.message = `This event changed in ${providerName}. Refresh the calendar and review the description before saving again.`;
    }
    throw error;
  }
}

async function deleteEvent(provider, accessToken, calendarId, eventId, fetchImpl) {
  const id = safeId(eventId);
  if (!id) throw invalidEvent("Choose an event.");
  if (provider !== "google" && provider !== "microsoft") {
    const error = new Error("Calendar needs a Google or Microsoft account.");
    error.code = "imap_only";
    throw error;
  }
  const url = calendarPath(provider, calendarId, "/events/" + encodeURIComponent(id));
  if (!url) throw invalidEvent("Choose a calendar.");
  await apiJson(url, accessToken, { method: "DELETE", fetchImpl });
  return { id, calendarId: safeId(calendarId) || "", deleted: true };
}

function preferredCalendarId(calendars) {
  const rows = Array.isArray(calendars) ? calendars : [];
  const primary = rows.find((calendar) => calendar && calendar.primary && calendar.id);
  if (primary) return primary.id;
  const first = rows.find((calendar) => calendar && calendar.id);
  return first ? first.id : "";
}

function selectedCalendarIds(calendars, params) {
  const known = new Set();
  for (const calendar of Array.isArray(calendars) ? calendars : []) {
    if (calendar && calendar.id) known.add(calendar.id);
  }
  const picked = [];
  const raw = params && Array.isArray(params.calendarIds) ? params.calendarIds : [];
  for (const item of raw) {
    const id = String(item || "");
    if (!known.has(id) || picked.includes(id)) continue;
    picked.push(id);
  }
  if (picked.length) return picked;
  const single = params && params.calendarId ? String(params.calendarId) : "";
  if (known.has(single)) return [single];
  const preferred = preferredCalendarId(calendars);
  return preferred ? [preferred] : [];
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
  listEventsForIds,
  createEvent,
  updateEvent,
  deleteEvent,
  plainDescription,
  writeEvent,
  preferredCalendarId,
  selectedCalendarIds,
  pageToken,
};
