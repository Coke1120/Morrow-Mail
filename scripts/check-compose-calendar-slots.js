const assert = require("node:assert/strict");
const { test } = require("node:test");
const { listEventsForIds } = require("../host/mail/calendar-api");
const {
  availableCalendarSlots,
  calendarDayBounds,
  formatCalendarSlotPair,
} = require("../renderer/compose-calendar-slots");

process.env.TZ = "Asia/Hong_Kong";

const accountId = "sending-account";
const checkedCalendarIds = ["work", "personal"];
const halfHour = 30 * 60 * 1000;

function payload(firstDay, events, lastDay = firstDay) {
  return {
    api: true,
    accountId,
    truncated: false,
    calendarIds: [...checkedCalendarIds].reverse(),
    calendars: [{ id: "work" }, { id: "personal" }, { id: "unchecked" }],
    timeMin: calendarDayBounds(firstDay).timeMin,
    timeMax: calendarDayBounds(lastDay).timeMax,
    events,
  };
}

function daySlots(day, response, checkedIds = checkedCalendarIds) {
  return availableCalendarSlots({ day, accountId, checkedCalendarIds: checkedIds, payload: response });
}

function timed(calendarId, start, end) {
  return { calendarId, start, end, allDay: false };
}

function halfHourAt(value) {
  const startMs = Date.parse(value);
  return { startMs, endMs: startMs + halfHour };
}

test("12 January 2027 in Hong Kong leaves 16:00 and 17:00 of three cross-zone options", () => {
  const day = "2027-01-12";
  assert.deepEqual(calendarDayBounds(day), {
    timeMin: "2027-01-11T16:00:00.000Z",
    timeMax: "2027-01-12T16:00:00.000Z",
  });
  const response = payload(day, [
    {
      ...timed("work", day + "T00:30:00-08:00", day + "T01:00:00-08:00"),
      title: "Private provider title",
      attendees: ["private@example.invalid"],
    },
    timed("personal", day + "T14:00:00+08:00", day + "T14:30:00+08:00"),
  ]);
  const result = daySlots(day, response);
  const options = ["16:00", "16:30", "17:00"].map(time => halfHourAt(day + "T" + time + ":00+08:00"));
  const selected = result.slots.filter(slot => options.some(option => option.startMs === slot.startMs));
  assert.deepEqual(selected, [options[0], options[2]]);
  assert.deepEqual(Object.keys(result), ["slots", "unavailableCalendarIds"]);
  assert.deepEqual(result.unavailableCalendarIds, []);
  assert.equal(result.slots.length, 46);
  for (const slot of result.slots) assert.deepEqual(Object.keys(slot), ["startMs", "endMs"]);

  const text = formatCalendarSlotPair(result.slots, selected);
  assert.equal(text, "2027-01-12 16:00–16:30 UTC+08:00\n2027-01-12 17:00–17:30 UTC+08:00");
  assert.doesNotMatch(JSON.stringify({ result, text }), /Private provider title|private@example\.invalid|title|attendees/);
  assert.equal(formatCalendarSlotPair(result.slots, options.slice(0, 2)), null);
});

test("a repair visit can use Thursday 18:00 and Saturday 10:00 when work blocks Wednesday 18:00", () => {
  const days = ["2027-01-13", "2027-01-14", "2027-01-16"];
  const response = payload(days[0], [
    timed("work", "2027-01-13T10:00:00Z", "2027-01-13T10:30:00Z"),
    timed("personal", "2027-01-16T09:30:00+08:00", "2027-01-16T10:00:00+08:00"),
  ], days[2]);
  const options = [
    halfHourAt("2027-01-13T18:00:00+08:00"),
    halfHourAt("2027-01-14T18:00:00+08:00"),
    halfHourAt("2027-01-16T10:00:00+08:00"),
  ];
  const candidates = days.flatMap((day, index) => {
    const result = daySlots(day, response);
    assert.deepEqual(result.unavailableCalendarIds, []);
    return result.slots.filter(slot => slot.startMs === options[index].startMs);
  });
  assert.deepEqual(candidates, options.slice(1));
  assert.equal(formatCalendarSlotPair(candidates, options.slice(1)),
    "2027-01-14 18:00–18:30 UTC+08:00\n2027-01-16 10:00–10:30 UTC+08:00");
});

test("unverified or invalid responses yield no slots and identify affected checked calendars", async () => {
  const day = "2027-01-12";
  const event = timed("work", day + "T08:30:00Z", day + "T09:00:00Z");
  const response = payload(day, [event]);
  for (const [label, overrides, unavailableCalendarIds = checkedCalendarIds] of [
    ["fallback", { calendarIds: ["unchecked"], calendarId: "unchecked" }],
    ["legacy fallback only", { calendarIds: undefined, calendarId: "work" }],
    ["partial selection", { calendarIds: ["work"] }, ["personal"]],
    ["unexpected calendar", { calendarIds: ["work", "personal", "unchecked"] }],
    ["duplicate returned ID", { calendarIds: ["work", "work", "personal"] }, ["work"]],
    ["missing directory entry", { calendars: [{ id: "work" }] }, ["personal"]],
    ["unavailable API", { api: false }],
    ["truncated", { truncated: true }],
    ["unknown truncation", { truncated: undefined }],
    ["wrong sending account", { accountId: "another-account" }],
    ["incomplete calendar", { incompleteCalendarIds: ["personal"] }, ["personal"]],
    ["malformed incomplete list", { incompleteCalendarIds: null }],
    ["missing events", { events: undefined }],
    ["event from unexpected calendar", { events: [{ ...event, calendarId: "unchecked" }] }],
    ["timed event without an offset", { events: [{ ...event, end: day + "T17:00:00" }] }, ["work"]],
    ["impossible date with an offset", { events: [{ ...event, end: "2027-02-30T17:00:00+08:00" }] }, ["work"]],
    ["late lower bound", { timeMin: "2027-01-11T16:00:00.0000001Z" }],
    ["early upper bound", { timeMax: "2027-01-12T15:59:59Z" }],
  ]) {
    assert.deepEqual(daySlots(day, { ...response, ...overrides }), { slots: [], unavailableCalendarIds }, label);
  }
  const emptyDay = daySlots(day, { ...response, events: [] });
  assert.deepEqual(emptyDay.unavailableCalendarIds, []);
  assert.equal(emptyDay.slots.length, 48);
  assert.deepEqual(daySlots(day, response, []), { slots: [], unavailableCalendarIds: [] });
  assert.deepEqual(daySlots(day, response, ["work", "work"]), { slots: [], unavailableCalendarIds: ["work"] });
  assert.equal(calendarDayBounds("2027-02-30"), null);

  const range = calendarDayBounds(day);
  const busy = { id: "busy", start: { dateTime: event.start }, end: { dateTime: event.end } };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
  for (const [provider, rowsKey, cursorKey, invalid, next] of [
    ["google", "items", "nextPageToken", "../invalid", "page2"],
    ["microsoft", "value", "@odata.nextLink", "https://example.invalid/page2", "https://graph.microsoft.com/v1.0/me/calendars/personal/calendarView?$skiptoken=page2"],
  ]) {
    const ids = response.calendarIds;
    const list = fetchImpl => listEventsForIds(provider, "synthetic", ids, range, fetchImpl);
    const isPersonal = url => url.includes("/calendars/personal/");
    for (const [cursor, requests] of [[invalid, 1], [[next], 1], [false, 1], [next, 2]]) {
      let personalRequests = 0;
      const grouped = await list(async url => {
        if (!isPersonal(url)) return json({ [rowsKey]: [] });
        personalRequests++;
        return json({ [rowsKey]: [], [cursorKey]: cursor });
      });
      assert.deepEqual(daySlots(day, { ...response, ...grouped }), { slots: [], unavailableCalendarIds: checkedCalendarIds }, provider);
      assert.deepEqual(grouped, { events: [], truncated: true, calendarIds: ids, incompleteCalendarIds: ["personal"] });
      assert.equal(personalRequests, requests);
    }
    for (const cursor of [undefined, null, ""]) {
      const grouped = await list(async () => json({ [rowsKey]: [], [cursorKey]: cursor }));
      assert.deepEqual(grouped, { events: [], truncated: false, calendarIds: ids });
      assert.equal(daySlots(day, { ...response, ...grouped }).slots.length, 48);
    }
    const fetchPages = status => async url => {
      if (!isPersonal(url)) return json({ [rowsKey]: [] });
      if (!url.includes("page2")) return json({ [rowsKey]: [], [cursorKey]: next });
      return status === 200 ? json({ [rowsKey]: [busy] }) : json({}, status);
    };
    const complete = await list(fetchPages(200));
    assert.deepEqual(complete.events.map(event => [event.calendarId, event.id]), [["personal", "busy"]]);
    assert.equal(complete.truncated, false);
    assert.equal(Object.hasOwn(complete, "incompleteCalendarIds"), false);
    assert.equal(daySlots(day, { ...response, ...complete }).slots.length, 47);
    await assert.rejects(list(fetchPages(400)), { code: "provider", status: 400 });
  }

  const mixedIds = ["unchecked", "work", "personal"];
  let pageRequests = 0;
  const mixed = await listEventsForIds("google", "synthetic", mixedIds, range, async url => {
    if (url.includes("/calendars/unchecked/")) {
      return json({ items: [busy], nextPageToken: "page" + ++pageRequests });
    }
    if (url.includes("/calendars/personal/")) return json({ items: Array(500).fill(busy) });
    return json({ items: [busy] });
  });
  assert.equal(pageRequests, 5);
  assert.deepEqual(mixed.events.map(event => event.calendarId),
    [...Array(5).fill("unchecked"), "work", ...Array(500).fill("personal")]);
  assert.deepEqual(mixed.calendarIds, mixedIds);
  assert.equal(mixed.truncated, true);
  assert.deepEqual(mixed.incompleteCalendarIds, ["unchecked", "personal"]);
  assert.deepEqual(daySlots(day, { ...response, ...mixed }, mixedIds), { slots: [], unavailableCalendarIds: mixedIds });
  assert.deepEqual(await listEventsForIds("google", "synthetic", [], range, assert.fail),
    { events: [], truncated: false, calendarIds: [] });
});

test("adjacent timed events and all-day exclusive civil dates preserve boundary slots", () => {
  const day = "2027-01-12";
  const response = payload("2027-01-11", [
    { calendarId: "work", allDay: true, start: "2027-01-11T00:00:00-08:00", end: day + "T00:00:00-08:00" },
    { calendarId: "work", allDay: true, start: "2027-01-13", end: "2027-01-14" },
    timed("personal", day + "T00:30:00+08:00", day + "T01:00:00+08:00"),
  ], "2027-01-13");
  const { slots, unavailableCalendarIds } = daySlots(day, response);
  const first = halfHourAt(day + "T00:00:00+08:00");
  const last = halfHourAt(day + "T23:30:00+08:00");
  assert.deepEqual(unavailableCalendarIds, []);
  assert.equal(slots.length, 47);
  assert.deepEqual([slots[0], slots[1], slots.at(-1)], [first, halfHourAt(day + "T01:00:00+08:00"), last]);
  assert.equal(formatCalendarSlotPair(slots, [first, last]),
    "2027-01-12 00:00–00:30 UTC+08:00\n2027-01-12 23:30–2027-01-13 00:00 UTC+08:00");
  assert.equal(formatCalendarSlotPair(slots, [first, { ...first }]), null);
  const overlapping = halfHourAt(day + "T00:15:00+08:00");
  assert.equal(formatCalendarSlotPair([first, overlapping], [first, overlapping]), null);
  const short = { startMs: first.startMs, endMs: first.endMs - 1 };
  assert.equal(formatCalendarSlotPair([short, last], [short, last]), null);
  assert.equal(formatCalendarSlotPair(slots, [first]), null);
  assert.equal(formatCalendarSlotPair(slots, [first, slots[1], last]), null);

  assert.deepEqual(daySlots("2027-01-13", response), { slots: [], unavailableCalendarIds: [] });
  const missingEnd = { ...response.events[1], end: "" };
  assert.deepEqual(daySlots(day, { ...response, events: [missingEnd] }),
    { slots: [], unavailableCalendarIds: ["work"] });
  const extendsPastMidnight = timed("work", "2027-01-11T23:30:00+08:00", day + "T00:00:00.0000001+08:00");
  const fractional = daySlots(day, { ...response, events: [...response.events, extendsPastMidnight] });
  assert.deepEqual(fractional.unavailableCalendarIds, []);
  assert.deepEqual(fractional.slots[0], slots[1]);
});

test("IANA time changes use elapsed half hours and explicit offsets", t => {
  process.env.TZ = "America/New_York";
  t.after(() => { process.env.TZ = "Asia/Hong_Kong"; });
  const fall = "2027-11-07";
  const spring = "2027-03-14";
  assert.deepEqual(calendarDayBounds(fall), {
    timeMin: "2027-11-07T04:00:00.000Z",
    timeMax: "2027-11-08T05:00:00.000Z",
  });
  assert.deepEqual(calendarDayBounds(spring), {
    timeMin: "2027-03-14T05:00:00.000Z",
    timeMax: "2027-03-15T04:00:00.000Z",
  });
  const fallResult = daySlots(fall, payload("2027-11-06", [
    timed("work", "2027-11-06T14:00:00Z", "2027-11-06T14:30:00Z"),
  ], fall));
  const springResult = daySlots(spring, payload("2027-03-13", [
    timed("work", "2027-03-13T14:00:00Z", "2027-03-13T14:30:00Z"),
  ], spring));
  assert.deepEqual(fallResult.unavailableCalendarIds, []);
  assert.deepEqual(springResult.unavailableCalendarIds, []);
  assert.equal(fallResult.slots.length, 50);
  assert.equal(springResult.slots.length, 46);
  assert.ok(springResult.slots.every(slot => new Date(slot.startMs).getHours() !== 2));
  const earlier = halfHourAt(fall + "T01:00:00-04:00");
  const later = halfHourAt(fall + "T01:00:00-05:00");
  assert.equal(formatCalendarSlotPair(fallResult.slots, [earlier, later]),
    "2027-11-07 01:00–01:30 UTC-04:00\n2027-11-07 01:00–01:30 UTC-05:00");
  const crossesFallBack = halfHourAt(fall + "T01:30:00-04:00");
  assert.equal(formatCalendarSlotPair(fallResult.slots, [crossesFallBack, later]),
    "2027-11-07 01:30 UTC-04:00–01:00 UTC-05:00\n2027-11-07 01:00–01:30 UTC-05:00");

  process.env.TZ = "Pacific/Apia";
  assert.equal(calendarDayBounds("2011-12-30"), null);
  assert.equal(calendarDayBounds("2011-12-29").timeMax, "2011-12-30T10:00:00.000Z");
});
