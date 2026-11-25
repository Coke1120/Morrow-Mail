const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const calendar = require("../host/mail/calendar-api");
const { listEventsForIds } = calendar;
const { renderer } = require("./check-ux-workflows");
const slotsApi = require("../renderer/compose-calendar-slots");
const {
  availableCalendarSlots,
  calendarDayBounds,
  formatCalendarSlotPair,
} = slotsApi;

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
    calendars: [{ id: "work", name: "Work" }, { id: "personal", name: "Personal" }, { id: "unchecked" }],
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

function composePickerFixture() {
  const palette = new Map();
  const calls = [];
  const inserted = [];
  let checks = { [accountId]: checkedCalendarIds, other: ["unchecked"] };
  function node(id) {
    const listeners = new Map();
    return {
      id, dataset: {}, value: "", disabled: false, open: false, textContent: "", classList: { toggle() {} },
      addEventListener(type, fn) { listeners.set(type, fn); },
      dispatch(type, extra) { return listeners.get(type)?.({ preventDefault() {}, ...extra }); },
      focus() { document.activeElement = this; },
      replaceChildren(...options) { this.options = options; this.value = ""; },
      showModal() { this.open = true; },
      close() { this.open = false; this.dispatch("close"); },
    };
  }
  const get = id => {
    if (!palette.has(id)) palette.set(id, node(id));
    return palette.get(id);
  };
  const control = suffix => get(`compose-calendar-slots-${suffix}`);
  const dialog = get("compose-calendar-slots");
  const document = {
    getElementById: get,
    createElement: node,
    querySelectorAll: () => [get("compose"), dialog].filter(row => row.open),
  };
  get("compose").open = true;
  get("compose-from").value = "sender@example.invalid";
  Object.assign(get("compose-editor"), { nodeType: 1, appendChild() {}, isConnected: true, contentEditable: "true" });
  const window = { ...node("window"), morrowComposeCalendarSlots: slotsApi };
  const ui = renderer({ window, document, localStorage: { getItem: () => JSON.stringify(checks) },
    senderAccountId: accountId, inserted, closePending: null,
    list: (channel, params) => new Promise(resolve => calls.push({ channel, params: JSON.parse(JSON.stringify(params)), resolve })),
  });
  ui.run(`
    state.accountId = 'other';
    state.accounts = [{ id: senderAccountId, platform: 'imap', bodyEpoch: 1 }];
    state.composeSession = 1;
    state.composeMeta = { kind: 'all', accountId: senderAccountId, fromAddress: 'sender@example.invalid' };
    state.composeIdentity = { accountId: senderAccountId, accountEpoch: 1, sendAs: [{ email: state.composeMeta.fromAddress }] };
    call = list;
    const closeCalendarDialog = closeDialog;
    closeDialog = id => closePending ? closePending.then(() => closeCalendarDialog(id)) : closeCalendarDialog(id);
    insertComposeCalendarText = (_editor, _range, text) => { inserted.push(text); return true; };
    wireComposeCalendarSlots();
    syncComposeCalendarSlots();
  `);
  return {
    dialog, control, calls, inserted, ui,
    open: () => control("open").dispatch("click"),
    date(day) {
      control("date").value = day;
      return control("date").dispatch("input");
    },
    pick(slot) {
      assert.ok(control("time").options.some(row => row.value === String(slot.startMs)));
      control("time").value = String(slot.startMs);
      control("time").dispatch("change");
      assert.equal(control("add").disabled, false);
      control("add").dispatch("click");
    },
    checks(ids) {
      checks = { ...checks, [accountId]: ids };
      window.dispatch("storage", { key: "morrow.calendarChecks", newValue: JSON.stringify(checks) });
    },
  };
}

function calendarListFixture(fetchImpl) {
  const account = { id: accountId, profile: "gmail", email: "sender@example.invalid" };
  const grant = JSON.stringify({ accessToken: "synthetic", refreshToken: "synthetic", grantedScopes: "calendar" });
  const modules = {
    "./db": { accountById: id => id === account.id ? account : null },
    "./secrets": { revision: () => 0, getPasswordAsync: async key => key === `${accountId}:calendar` ? grant : null },
    "./oauth": { oauthReady: () => ({ google: true }), accessTokenFor: async () => "synthetic" },
    "./oauth-config": { providerKey: () => "google", hasPurposeScopes: scopes => scopes === "calendar",
      loadGoogleClient: () => ({ clientId: "synthetic" }), googleGrantMatches: () => true, requireGoogleGrantClient() {} },
    "./calendar-api": {
      ...calendar,
      listCalendars: (...args) => calendar.listCalendars(...args, fetchImpl),
      listEventsForIds: (...args) => calendar.listEventsForIds(...args, fetchImpl),
    },
    "./provider-http": require("../host/mail/provider-http"),
    "./provider-api": {}, "./inbox-rules": {}, "./vacation-api": {}, "./sieve-vacation": {},
  };
  const module = { exports: {} };
  const file = require.resolve("../host/mail/sidecar");
  runInNewContext(readFileSync(file, "utf8"), {
    module, Error, require: name => name.startsWith("node:") ? require(name) : modules[name],
  }, { filename: file });
  return async params => JSON.parse(JSON.stringify(await module.exports.answer("calendar:list", [params])));
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

test("a repair visit can use Thursday 18:00 and Saturday 10:00 when work blocks Wednesday 18:00", async () => {
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

  const f = composePickerFixture();
  f.open();
  assert.equal(f.dialog.open, true);
  assert.equal(f.calls.length, 0);
  const wed = f.date(days[0]);
  const thu = f.date(days[1]);
  assert.deepEqual(f.calls.map(({ channel, params }) => [channel, params]), days.slice(0, 2).map(day => ["calendar:list",
    { accountId, calendarIds: checkedCalendarIds, ...calendarDayBounds(day), availabilityOnly: true }]));
  f.calls[1].resolve(response);
  await thu;
  f.calls[0].resolve(payload(days[0], []));
  await wed;
  f.pick(options[1]);
  assert.equal(f.control("insert").disabled, true);
  const sat = f.date(days[2]);
  assert.equal(f.control("insert").disabled, true);
  f.calls[2].resolve(response);
  await sat;
  f.pick(options[2]);
  const preview = "2027-01-14 18:00–18:30 UTC+08:00\n2027-01-16 10:00–10:30 UTC+08:00";
  assert.equal(f.control("preview").textContent, preview);
  assert.equal(f.control("insert").disabled, false);
  await f.control("insert").dispatch("click");
  assert.deepEqual(f.inserted, [preview]);

  f.open();
  assert.equal(f.control("preview").textContent, "");
  const abandoned = f.date(days[0]);
  f.dialog.dispatch("cancel");
  f.open();
  f.calls.at(-1).resolve(response);
  await abandoned;
  assert.equal(f.control("time").options.length, 1);
  assert.equal(f.control("insert").disabled, true);

  const readSaturday = f.date(days[2]);
  f.calls.at(-1).resolve(response);
  await readSaturday;
  f.pick(options[2]);
  f.pick(halfHourAt("2027-01-16T10:30:00+08:00"));
  const readTruncated = f.date(days[0]);
  assert.equal(f.control("insert").disabled, true);
  f.calls.at(-1).resolve({ ...response, truncated: true, incompleteCalendarIds: ["work"] });
  await readTruncated;
  assert.equal(f.control("status").textContent, "Could not verify availability for Work.");
  assert.equal(f.control("preview").textContent, "");
  assert.equal(f.control("time").options.length, 1);

  for (const [reason, invalidate] of [
    ["changed checked set", () => { f.checks(["personal"]); f.checks(checkedCalendarIds); }],
    ["date change", () => { f.date(days[0]); f.control("date").value = days[2]; }],
    ["sender context replacement", () => f.ui.run("state.composeIdentity = { ...state.composeIdentity }")],
    ["draft save", () => f.ui.run("state.composePending = true; syncComposeCalendarSlots(); state.composePending = false;")],
  ]) {
    if (!f.dialog.open) f.open();
    const readAgain = f.date(days[2]);
    f.calls.at(-1).resolve(response);
    await readAgain;
    f.pick(options[2]);
    f.pick(halfHourAt("2027-01-16T10:30:00+08:00"));
    let finishClose;
    f.ui.context.closePending = new Promise(resolve => { finishClose = resolve; });
    const pendingInsert = f.control("insert").dispatch("click");
    invalidate();
    finishClose();
    await pendingInsert;
    f.ui.context.closePending = null;
    assert.deepEqual(f.inserted, [preview], `${reason} revokes approval during close`);
  }

  f.open();
  const readMissing = f.date(days[0]);
  f.calls.at(-1).resolve({ ...response, calendars: [{ id: "personal", name: "Personal" }], events: [], incompleteCalendarIds: ["work"] });
  await readMissing;
  assert.equal(f.control("status").textContent, "Could not verify availability for work.");
  assert.equal(f.control("time").options.length, 1);
  f.control("cancel").dispatch("click");

  f.checks([]);
  f.open();
  assert.equal(f.control("date").disabled, true);
  assert.equal(f.control("status").textContent, "Select calendars for this mailbox in Calendar.");
  assert.equal(f.control("insert").disabled, true);
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
    ["precisely truncated", { truncated: true, incompleteCalendarIds: ["work"] }, ["work"]],
    ["large truncated response", { truncated: true, incompleteCalendarIds: ["work"], events: Array(10001).fill(event) }, ["work"]],
    ["empty truncation metadata", { truncated: true, incompleteCalendarIds: [] }],
    ["duplicate truncation metadata", { truncated: true, incompleteCalendarIds: ["work", "work"] }],
    ["unexpected truncation metadata", { truncated: true, incompleteCalendarIds: ["unchecked"] }],
    ["unknown truncation", { truncated: undefined }],
    ["wrong sending account", { accountId: "another-account" }],
    ["incomplete calendar", { incompleteCalendarIds: ["personal"] }, ["personal"]],
    ["malformed incomplete list", { incompleteCalendarIds: null }],
    ["missing events", { events: undefined }],
    ["event from unexpected calendar", { events: [{ ...event, calendarId: "unchecked" }] }],
    ["free event from unexpected calendar", { events: [{ ...event, calendarId: "unchecked", blocksAvailability: false }] }],
    ["timed event without an offset", { events: [{ ...event, end: day + "T17:00:00" }] }, ["work"]],
    ["free timed event without an offset", { events: [{ ...event, end: day + "T17:00:00", blocksAvailability: false }] }, ["work"]],
    ["free all-day event without an end", { events: [{ ...event, start: day, end: "", allDay: true, blocksAvailability: false }] }, ["work"]],
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
  const fourPm = halfHourAt(day + "T16:00:00+08:00");
  const google = await listEventsForIds("google", "synthetic", ["work"], range, async () => json({ items: [
    { ...busy, transparency: "Transparent" },
    { id: "transparent", summary: "Available appointment", transparency: "transparent",
      start: { date: day }, end: { date: "2027-01-13" } },
    { id: "transparent-timed", transparency: "transparent",
      start: { dateTime: day + "T08:00:00Z" }, end: { dateTime: event.start } },
  ] }));
  assert.deepEqual(google.events.map(row => [row.id, row.blocksAvailability]), [
    ["busy", undefined], ["transparent", false], ["transparent-timed", false],
  ]);
  assert.equal(google.events[1].title, "Available appointment");
  const googleSlots = daySlots(day, { ...response, ...google }, ["work"]);
  assert.equal(googleSlots.slots.length, 47);
  assert.ok(googleSlots.slots.some(slot => slot.startMs === fourPm.startMs));
  assert.ok(!googleSlots.slots.some(slot => slot.startMs === Date.parse(event.start)));

  const graph = await listEventsForIds("microsoft", "synthetic", ["work"], range, async url => {
    assert.ok(new URL(url).searchParams.get("$select").split(",").includes("showAs"));
    return json({ value: [
      { id: "fractional", showAs: "tentative",
        start: { dateTime: day + "T07:30:00.0000000", timeZone: "UTC" },
        end: { dateTime: day + "T08:00:00.5000000", timeZone: "UTC" } },
      { ...busy, id: "free", subject: "Free appointment", showAs: "free" },
    ] });
  });
  assert.equal(graph.events[0].start, day + "T07:30:00Z");
  assert.equal(graph.events[0].end, day + "T08:00:00.5000000Z");
  assert.equal(Object.hasOwn(graph.events[0], "blocksAvailability"), false);
  assert.equal(graph.events[1].blocksAvailability, false);
  assert.equal(graph.events[1].title, "Free appointment");
  const graphSlots = daySlots(day, { ...response, ...graph }, ["work"]);
  assert.equal(graphSlots.slots.length, 46);
  assert.ok(!graphSlots.slots.some(slot => slot.startMs === fourPm.startMs));
  assert.ok(graphSlots.slots.some(slot => slot.startMs === Date.parse(event.start)));

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
      assert.deepEqual(daySlots(day, { ...response, ...grouped }), { slots: [], unavailableCalendarIds: ["personal"] }, provider);
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
  assert.deepEqual(daySlots(day, { ...response, ...mixed }, mixedIds), { slots: [], unavailableCalendarIds: ["unchecked", "personal"] });
  assert.deepEqual(await listEventsForIds("google", "synthetic", [], range, assert.fail),
    { events: [], truncated: false, calendarIds: [] });

  const paths = [];
  let workState = "complete";
  const list = calendarListFixture(async (url, init) => {
    assert.equal(init.method, "GET");
    const path = new URL(url).pathname;
    paths.push(path);
    if (path === "/calendar/v3/users/me/calendarList") {
      return json({ items: [{ id: "unchecked", primary: true }, { id: "personal", summary: "Personal" },
        ...(workState === "missing" ? [] : [{ id: "work", summary: "Work" }])] });
    }
    if (path.includes("/calendars/work/")) {
      if (workState === "error") return json({}, 400);
      const items = [
        { id: "cancelled", status: "cancelled", end: busy.end },
        { end: busy.end },
        ...(workState === "missing-start" ? [{ id: "missing-start", end: busy.end }] : []),
        busy,
      ];
      return json({ items, ...(workState === "truncated" ? { nextPageToken: false } : {}) });
    }
    if (path.includes("/calendars/unchecked/")) {
      return json({ items: [{ ...busy, start: { dateTime: day + "T16:00:00+08:00" }, end: { dateTime: day + "T17:30:00+08:00" } }] });
    }
    return json({ items: [] });
  });
  const strict = { accountId, ...range, calendarIds: checkedCalendarIds, calendarId: "unchecked", availabilityOnly: true };
  for (const calendarIds of [undefined, [], ["work", "work"], [" work"], [0], [""], ["x".repeat(513)],
    Array(1), Array.from({ length: 501 }, (_, i) => String(i))]) {
    assert.equal((await list({ ...strict, calendarIds })).error.code, "invalid");
  }
  assert.equal((await list({ ...strict, accountId: undefined, id: accountId })).error.code, "invalid");
  assert.deepEqual(paths, []);

  const complete = (await list(strict)).data;
  assert.deepEqual(complete.calendarIds, checkedCalendarIds);
  assert.deepEqual(complete.events.map(row => row.calendarId), ["work"]);
  assert.ok(paths.every(path => !path.includes("/calendars/unchecked/")));
  assert.deepEqual(daySlots(day, complete).slots.filter(slot =>
    ["16:00", "16:30", "17:00"].some(time => slot.startMs === Date.parse(`${day}T${time}:00+08:00`))),
  [halfHourAt(day + "T16:00:00+08:00"), halfHourAt(day + "T17:00:00+08:00")]);

  paths.length = 0;
  workState = "missing";
  const missing = (await list(strict)).data;
  assert.deepEqual(paths, ["/calendar/v3/users/me/calendarList"]);
  assert.deepEqual(missing.events, []);
  assert.deepEqual(missing.incompleteCalendarIds, ["work"]);
  assert.equal(missing.truncated, false);
  assert.deepEqual(daySlots(day, missing), { slots: [], unavailableCalendarIds: ["work"] });
  const fallback = (await list({ ...strict, calendarIds: ["work"], availabilityOnly: false })).data;
  assert.deepEqual(fallback.calendarIds, ["unchecked"]);
  assert.deepEqual(fallback.events.map(row => row.calendarId), ["unchecked"]);
  assert.equal(Object.hasOwn(fallback, "incompleteCalendarIds"), false);

  workState = "truncated";
  const truncated = (await list(strict)).data;
  assert.equal(truncated.truncated, true);
  assert.deepEqual(truncated.incompleteCalendarIds, ["work"]);
  assert.deepEqual(daySlots(day, truncated), { slots: [], unavailableCalendarIds: ["work"] });
  const legacy = (await list({ ...strict, availabilityOnly: undefined })).data;
  assert.equal(legacy.truncated, true);
  assert.equal(Object.hasOwn(legacy, "incompleteCalendarIds"), false);

  workState = "missing-start";
  const missingStart = (await list(strict)).data;
  assert.equal(missingStart.truncated, false);
  assert.deepEqual(missingStart.incompleteCalendarIds, ["work"]);
  assert.deepEqual(missingStart.events, complete.events);
  assert.deepEqual(daySlots(day, missingStart), { slots: [], unavailableCalendarIds: ["work"] });
  const legacyMissingStart = (await list({ ...strict, availabilityOnly: false })).data;
  assert.equal(legacyMissingStart.truncated, false);
  assert.equal(Object.hasOwn(legacyMissingStart, "incompleteCalendarIds"), false);
  assert.deepEqual(legacyMissingStart.events, complete.events);

  const picker = composePickerFixture();
  picker.open();
  const readComplete = picker.date(day);
  picker.calls.at(-1).resolve(complete);
  await readComplete;
  picker.pick(fourPm);
  picker.pick(halfHourAt(day + "T17:00:00+08:00"));
  assert.equal(picker.control("insert").disabled, false);
  const nextDay = "2027-01-13";
  const readMissingStart = picker.date(nextDay);
  picker.calls.at(-1).resolve((await list({ ...strict, ...calendarDayBounds(nextDay) })).data);
  await readMissingStart;
  assert.equal(picker.control("status").textContent, "Could not verify availability for Work.");
  assert.equal(picker.control("preview").textContent, "");
  assert.equal(picker.control("time").options.length, 1);
  assert.equal(picker.control("insert").disabled, true);

  workState = "error";
  const rejected = await list(strict);
  assert.equal(rejected.success, false);
  assert.equal(rejected.error.code, "provider");
  assert.deepEqual(await list({ ...strict, availabilityOnly: false }), rejected);
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
