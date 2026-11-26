"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const { convertSelection } = require("../renderer/reader-local-time.js");

const hongKong = { timeZone: "Asia/Hong_Kong", locale: "en-GB" };

function expected(sourceText, instant, localDate, localTime, dayChanged) {
  return { status: "ok", sourceText, instant, localDate, localTime, timeZone: "Asia/Hong_Kong", utcOffset: "UTC+08:00", dayChanged };
}

test("converts both named-month deadlines", () => {
  const dayFirst = "Entries close Monday, 14 September 2026 at 5:00 p.m. (UTC−07:00).";
  assert.deepEqual(convertSelection(dayFirst, hongKong),
    expected(dayFirst, "2026-09-15T00:00:00.000Z", "15 Sept 2026", "08:00", true));
  const parenthesizedOffset = "14 September 2026 at 17:00 (-07:00)";
  assert.deepEqual(convertSelection(parenthesizedOffset, hongKong),
    expected(parenthesizedOffset, "2026-09-15T00:00:00.000Z", "15 Sept 2026", "08:00", true));

  const monthFirst = "\u00a0Thu. Oct.\u00a01, 2026\nat 14:15 ( GMT +1030 ).\t";
  assert.deepEqual(convertSelection(monthFirst, hongKong),
    expected(monthFirst, "2026-10-01T03:45:00.000Z", "1 Oct 2026", "11:45", false));
});

test("converts both ISO observations using the selected source and destination offset", () => {
  const observation = "2026-02-12T19:42:00Z";
  assert.deepEqual(convertSelection(observation, hongKong),
    expected(observation, "2026-02-12T19:42:00.000Z", "13 Feb 2026", "03:42", true));

  const fractional = "2026-07-01 00:15:30.125678+05:45";
  const instant = "2026-06-30T18:30:30.125678Z";
  assert.deepEqual(convertSelection(fractional, hongKong),
    expected(fractional, instant, "1 Jul 2026", "02:30:30.125678", false));
  assert.deepEqual(convertSelection(fractional, { timeZone: "America/New_York", locale: "en-GB" }), {
    status: "ok", sourceText: fractional, instant, localDate: "30 Jun 2026", localTime: "14:30:30.125678",
    timeZone: "America/New_York", utcOffset: "UTC-04:00", dayChanged: true,
  });
});

test("asks for clarification on missing offsets, ambiguous inputs and unsupported zones", () => {
  for (const source of ["2026-02-12T19:42:00", "14 September 2026 at 5:00 p.m."]) {
    assert.deepEqual(convertSelection(source, hongKong), { status: "clarify", reason: "missing-offset" }, source);
  }
  for (const source of [
    "2026-02-12",
    "09/10/2026 17:00 UTC",
    "14 September 2026 at 09:00-11:00",
    "2026-09-14 09:00-11:00",
    "2026-02-12T19:42:00Z 2026-02-12T19:43:00Z",
    "14 September 2026 at 17:00 UTC or 15 September 2026 at 17:00 UTC",
    "2026-02-12T19:42:00Z Deadline 14 September 2026 at 17:00 UTC",
    "14 September 2026 at 17:00 PST",
    "14 September 2026 at 17:00 America/Los_Angeles",
    "PST Monday 14 September 2026 at 17:00 UTC",
    "5:00 p.m. local time today",
    "Tomorrow or Monday, 14 September 2026 at 17:00 UTC",
    "Around Monday, 14 September 2026 at 17:00 UTC",
    "Pacific Standard Time Monday, 14 September 2026 at 17:00 UTC",
    "The day after Monday, 14 September 2026 at 17:00 UTC",
    "Not Monday, 14 September 2026 at 17:00 UTC",
    "Monday 14 September 2026 at 17:00 UTC or GMT+01:00",
    " ".repeat(257) + "2026-02-12T19:42:00Z",
  ]) {
    assert.deepEqual(convertSelection(source, hongKong), { status: "clarify", reason: "unsupported-format" }, source);
  }
});

test("validates dates, weekday, clock fields and offsets before conversion", () => {
  for (const [source, reason] of [
    ["2026-02-30T19:42Z", "invalid-date-time"],
    ["February 29, 2026 at 7:42 p.m. UTC", "invalid-date-time"],
    ["2026-13-01T19:42Z", "invalid-date-time"],
    ["Entries close Tuesday 14 September 2026 at 17:00 UTC", "weekday-mismatch"],
    ["Weds 14 September 2026 at 17:00 UTC", "weekday-mismatch"],
    ["2026-02-12T24:00Z", "invalid-date-time"],
    ["2026-02-12T19:60Z", "invalid-date-time"],
    ["2026-02-12T19:42:60Z", "invalid-date-time"],
    ["14 September 2026 at 13:00 PM UTC", "invalid-date-time"],
    ["2026-02-12T19:42+05:60", "invalid-offset"],
    ["2026-02-12T19:42+2400", "invalid-offset"],
    ["2026-02-12T19:42-00:00", "unknown-offset"],
    ["14 September 2026 at 17:00 (UTC−00:00)", "unknown-offset"],
  ]) {
    assert.deepEqual(convertSelection(source, hongKong), { status: "clarify", reason }, source);
  }
});

test("accepts explicit correction through the classic script and defaults to device Intl options", () => {
  const original = "February 29, 2024 at 12:15 a.m. ET";
  const edited = "Thursday, February 29, 2024 at 12:15 a.m. UTC";
  const browser = { window: {} };
  runInNewContext(readFileSync(require.resolve("../renderer/reader-local-time.js"), "utf8"), browser);
  const { convertSelection: browserConvert } = browser.window.morrowReaderLocalTime;
  assert.deepEqual({ ...browserConvert(original, hongKong) }, { status: "clarify", reason: "unsupported-format" });
  assert.deepEqual({ ...browserConvert(edited, hongKong) },
    expected(edited, "2024-02-29T00:15:00.000Z", "29 Feb 2024", "08:15", false));

  const { timeZone, locale } = new Intl.DateTimeFormat().resolvedOptions();
  assert.deepEqual(convertSelection(edited), convertSelection(edited, { timeZone, locale }));
  assert.equal(convertSelection(edited).timeZone, timeZone);
});
