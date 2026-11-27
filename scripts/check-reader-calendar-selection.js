"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parse } = require("../renderer/reader-calendar-selection");

test("converts explicit named-month ranges using the source UTC offset", () => {
  const expected = { title: "Tool induction", location: "North Workshop",
    start: "2027-01-12T03:15:00.000Z", end: "2027-01-12T03:35:00.000Z" };
  assert.deepEqual(parse("Title: Tool induction\nWhen: 12 January 2027, 11:15–11:35 UTC+08:00\nLocation: North Workshop"), expected);
  assert.deepEqual(parse("Tool induction is on Jan 12, 2027, 11:15 to 11:35 GMT+08:00"),
    { ...expected, location: "" });
  assert.deepEqual(parse("2027-01-12, 11:15 – 11:35 UTC+08:00"), { ...expected, title: "", location: "" });
});

test("retains exact overnight instants from explicit ISO endpoints", () => {
  const input = "Rehearsal: 2027-01-19T23:30+01:00 to 2027-01-20T00:20+01:00";
  assert.deepEqual(parse(input), { title: "Rehearsal", location: "",
    start: "2027-01-19T22:30:00.000Z", end: "2027-01-19T23:20:00.000Z" });
});

test("determines neither time from incomplete, ambiguous or non-appointment text", () => {
  for (const text of [
    "12 January 2027, 11:15–11:35",
    "12 January, 11:15–11:35 UTC+08:00",
    "12 January 2027, 11:15–11:35 JST",
    "2027-01-12T11:15+08:00 to 2027-01-12T11:35",
    "02/03/2027, 11:15–11:35 UTC",
    "2027-01-12, 11:15–11:35 UTC-00:00",
    "2027-01-12, 11:15–11:35 UTC+14:30",
    "2027-02-29, 11:15–11:35 UTC",
    "2027-01-12, 11:45–11:35 UTC",
    "2027-01-12, 24:00–24:30 UTC",
    "Deadline: 12 January 2027, 11:15–11:35 UTC+08:00",
    "Check-in is on 12 January 2027, 11:15–11:35 UTC+08:00",
    "Tool induction: 12 January 2027, 11:15–11:35 UTC+08:00\nArrive ten minutes early.",
    "2027-01-12, 11:15–11:35 UTC or 12:15–12:35 UTC",
    "2027-01-12, 11:15–11:35 UTC\n2027-01-13, 11:15–11:35 UTC",
    "2027-01-12, 11:15–11:35 UTC\nLocation: Hall at 11:00",
    "2027-01-12, 11:15–11:35 UTC\nLocation: https://example.test",
    "2027-01-12, 11:15–11:35 UTC\nTitle: Hello user@example.test",
    "X".repeat(513), "2027-01-12, 11:15–11:35 UTC\x00",
  ]) assert.equal(parse(text), null, text);
});
