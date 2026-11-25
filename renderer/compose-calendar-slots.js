(function () {
  "use strict";

  const HALF_HOUR_MS = 30 * 60 * 1000;
  const HOUR_MS = 2 * HALF_HOUR_MS;
  const DAY_MS = 24 * HOUR_MS;
  const MAX_CALENDARS = 500;
  const MAX_EVENTS = 10000;
  const MAX_CANDIDATES = 4096;
  const MAX_FORMAT_MS = 8640000000000000 - DAY_MS;
  const ISO_TIME = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.(\d{1,9}))?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;

  function boundedArray(value, limit) {
    return Array.isArray(value) && value.length <= limit;
  }

  function validId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 512 &&
      value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
  }

  function validCheckedCalendarIds(value) {
    if (!boundedArray(value, MAX_CALENDARS) || !value.length) return false;
    const ids = new Set(value);
    return ids.size === value.length && [...ids].every(validId);
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function localDateKey(date) {
    return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function civilDateUtc(day) {
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
    const utc = Date.parse(day + "T00:00:00Z");
    return Number.isFinite(utc) && new Date(utc).toISOString().slice(0, 10) === day ? utc : NaN;
  }

  function localOffsetMs(time) {
    const local = new Date(time);
    const utc = new Date(0);
    utc.setUTCFullYear(local.getFullYear(), local.getMonth(), local.getDate());
    utc.setUTCHours(local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds());
    return utc.getTime() - time;
  }

  function dayRanges(day) {
    const wallStart = civilDateUtc(day);
    if (!Number.isFinite(wallStart)) return [];
    const wallEnd = wallStart + DAY_MS;
    const searchEnd = wallEnd + DAY_MS;
    const ranges = [];
    let segmentStart = wallStart - DAY_MS;
    let offset = localOffsetMs(segmentStart);

    function appendRange(segmentEnd) {
      const start = Math.max(segmentStart, wallStart - offset);
      const end = Math.min(segmentEnd, wallEnd - offset);
      if (start >= end) return;
      const last = ranges.at(-1);
      if (last?.end === start) last.end = end;
      else ranges.push({ start, end });
    }

    // The surrounding UTC days cover IANA offsets. Locate any offset change
    // within its hour so shifts at midnight and across dates use real instants.
    for (let probe = segmentStart + HOUR_MS; probe <= searchEnd; probe += HOUR_MS) {
      const nextOffset = localOffsetMs(probe);
      if (nextOffset === offset) continue;
      let before = probe - HOUR_MS;
      let after = probe;
      while (after - before > 1) {
        const mid = before + Math.floor((after - before) / 2);
        if (localOffsetMs(mid) === offset) before = mid;
        else after = mid;
      }
      appendRange(after);
      segmentStart = after;
      offset = nextOffset;
    }
    appendRange(searchEnd);
    return ranges;
  }

  function calendarDayBounds(day) {
    const ranges = dayRanges(day);
    if (!ranges.length) return null;
    return {
      timeMin: new Date(ranges[0].start).toISOString(),
      timeMax: new Date(ranges.at(-1).end).toISOString(),
    };
  }

  function isoTimeParts(value) {
    return typeof value === "string" && value.length <= 35 ? ISO_TIME.exec(value) : null;
  }

  function parseInstant(value) {
    const parts = isoTimeParts(value);
    if (!parts?.[3] || !Number.isFinite(civilDateUtc(parts[1]))) return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return null;
    // Keep the fractional remainder for ordering and overlap at slot boundaries.
    const subMsNanos = Number((parts[2] || "").slice(3).padEnd(6, "0"));
    return { ms, subMsNanos };
  }

  function allDayKey(value) {
    const day = typeof value === "string" && value.length === 10 ? value : isoTimeParts(value)?.[1];
    return Number.isFinite(civilDateUtc(day)) ? day : "";
  }

  function availableCalendarSlots(request) {
    const { day, accountId, checkedCalendarIds, payload } = request || {};
    const ids = Array.isArray(checkedCalendarIds) ? checkedCalendarIds.slice(0, MAX_CALENDARS) : [];
    const checked = new Set(ids.filter(validId));
    const unavailable = (affected = checked) => ({
      slots: [],
      unavailableCalendarIds: [...checked].filter(id => affected.has(id)),
    });
    if (!validCheckedCalendarIds(checkedCalendarIds) || !validId(accountId) ||
        payload?.accountId !== accountId || payload.api !== true || typeof payload.truncated !== "boolean" ||
        !boundedArray(payload.calendarIds, MAX_CALENDARS) || !boundedArray(payload.calendars, MAX_CALENDARS)) return unavailable();

    const ranges = dayRanges(day);
    if (!ranges.length) return unavailable();
    const dayStart = ranges[0].start;
    const dayEnd = ranges.at(-1).end;
    const timeMin = parseInstant(payload.timeMin);
    const timeMax = parseInstant(payload.timeMax);
    if (!timeMin || !timeMax ||
        timeMin.ms + Number(timeMin.subMsNanos > 0) > dayStart || timeMax.ms < dayEnd) return unavailable();

    const affected = new Set();
    const returned = new Set();
    for (const id of payload.calendarIds) {
      if (!checked.has(id)) return unavailable();
      if (returned.has(id)) affected.add(id);
      returned.add(id);
    }
    // The calendar directory can include unchecked calendars.
    const known = new Set();
    for (const calendar of payload.calendars) {
      const id = calendar?.id;
      if (!validId(id)) return unavailable();
      if (!checked.has(id)) continue;
      if (known.has(id)) affected.add(id);
      known.add(id);
    }
    for (const id of checked) {
      if (!returned.has(id) || !known.has(id)) affected.add(id);
    }
    if (payload.truncated || Object.hasOwn(payload, "incompleteCalendarIds")) {
      const incomplete = payload.incompleteCalendarIds;
      if (!boundedArray(incomplete, MAX_CALENDARS) || (payload.truncated && !incomplete.length) ||
          new Set(incomplete).size !== incomplete.length) return unavailable();
      for (const id of incomplete) {
        if (!checked.has(id)) return unavailable();
        affected.add(id);
      }
    }
    if (affected.size) return unavailable(affected);
    if (!boundedArray(payload.events, MAX_EVENTS)) return unavailable();

    const busy = [];
    for (const event of payload.events) {
      const id = event?.calendarId;
      if (!checked.has(id)) return unavailable();
      if (event.allDay === true) {
        const start = allDayKey(event.start);
        const end = allDayKey(event.end);
        if (!start || !end || end <= start) affected.add(id);
        else if (start <= day && day < end) busy.push([dayStart, dayEnd]);
      } else if (event.allDay === false) {
        const start = parseInstant(event.start);
        const end = parseInstant(event.end);
        if (!start || !end || end.ms < start.ms || (end.ms === start.ms && end.subMsNanos <= start.subMsNanos)) {
          affected.add(id);
        } else {
          // Slot endpoints are whole milliseconds. Round the busy interval outward.
          const endMs = end.ms + Number(end.subMsNanos > 0);
          if (start.ms < dayEnd && endMs > dayStart) busy.push([start.ms, endMs]);
        }
      } else {
        affected.add(id);
      }
    }
    if (affected.size) return unavailable(affected);

    const slots = [];
    for (const range of ranges) {
      const firstSlot = dayStart + Math.ceil((range.start - dayStart) / HALF_HOUR_MS) * HALF_HOUR_MS;
      for (let startMs = firstSlot; startMs + HALF_HOUR_MS <= range.end; startMs += HALF_HOUR_MS) {
        const endMs = startMs + HALF_HOUR_MS;
        if (!busy.some(([start, end]) => start < endMs && end > startMs)) slots.push({ startMs, endMs });
      }
    }
    return { slots, unavailableCalendarIds: [] };
  }

  function validHalfHour(slot) {
    const { startMs, endMs } = slot || {};
    return Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs) &&
      startMs >= -MAX_FORMAT_MS && endMs <= MAX_FORMAT_MS && endMs - startMs === HALF_HOUR_MS;
  }

  function offsetLabel(date) {
    const offsetSeconds = localOffsetMs(date.getTime()) / 1000;
    const magnitude = Math.abs(offsetSeconds);
    const hours = pad(Math.floor(magnitude / 3600));
    const minutes = pad(Math.floor(magnitude / 60) % 60);
    const seconds = magnitude % 60;
    return `UTC${offsetSeconds < 0 ? "-" : "+"}${hours}:${minutes}${seconds ? ":" + pad(seconds) : ""}`;
  }

  function clockTime(date) {
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const seconds = date.getSeconds();
    const ms = date.getMilliseconds();
    if (!seconds && !ms) return time;
    return `${time}:${pad(seconds)}${ms ? "." + String(ms).padStart(3, "0") : ""}`;
  }

  function slotLine({ startMs, endMs }) {
    const start = new Date(startMs);
    const end = new Date(endMs);
    const startDay = localDateKey(start);
    const endDay = localDateKey(end);
    const startTime = clockTime(start);
    const endTime = clockTime(end);
    const startOffset = offsetLabel(start);
    const endOffset = offsetLabel(end);
    const endLabel = endDay === startDay ? endTime : `${endDay} ${endTime}`;
    const startLabel = startOffset === endOffset ? startTime : `${startTime} ${startOffset}`;
    return `${startDay} ${startLabel}–${endLabel} ${endOffset}`;
  }

  function formatCalendarSlotPair(candidates, selected) {
    if (!boundedArray(candidates, MAX_CANDIDATES) || !Array.isArray(selected) || selected.length !== 2) return null;
    const [first, second] = selected;
    if (!validHalfHour(first) || !validHalfHour(second) ||
        (first.startMs < second.endMs && first.endMs > second.startMs)) return null;
    for (const slot of selected) {
      if (!candidates.some(candidate => candidate?.startMs === slot.startMs && candidate.endMs === slot.endMs)) return null;
    }
    return `${slotLine(first)}\n${slotLine(second)}`;
  }

  function formatCalendarSlot(slot) {
    return validHalfHour(slot) ? slotLine(slot) : "";
  }

  const api = { calendarDayBounds, availableCalendarSlots, formatCalendarSlot, formatCalendarSlotPair, validCheckedCalendarIds };
  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.morrowComposeCalendarSlots = api;
})();
