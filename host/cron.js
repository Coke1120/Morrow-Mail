"use strict";

// Local-time five-field cron shared by independent schedulers.
function fieldValid(field, min, max) {
  if (field === "*") return true;
  const bits = String(field || "").split(",");
  if (!bits.length || bits.some((bit) => bit === "")) return false;
  return bits.every((bit) => {
    const step = bit.match(/^\*\/(\d+)$/);
    if (step) return Number(step[1]) >= 1;
    const range = bit.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const stride = range[3] ? Number(range[3]) : 1;
      return stride >= 1 && start >= min && end <= max && start <= end;
    }
    if (!/^\d+$/.test(bit)) return false;
    const value = Number(bit);
    return value >= min && value <= max;
  });
}

function fieldMatch(field, value, min = 0) {
  if (field === "*") return true;
  return String(field || "").split(",").some((bit) => {
    const step = bit.match(/^\*\/(\d+)$/);
    if (step) return (value - min) % Number(step[1]) === 0;
    const range = bit.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const stride = range[3] ? Number(range[3]) : 1;
      return value >= start && value <= end && (value - start) % stride === 0;
    }
    return Number(bit) === value;
  });
}

function parseCron(expr) {
  const parts = String(expr || "").trim().replace(/\s+/g, " ").split(" ");
  if (parts.length !== 5) return null;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  for (let i = 0; i < ranges.length; i += 1) {
    if (!fieldValid(parts[i], ranges[i][0], ranges[i][1])) return null;
  }
  return { minute: parts[0], hour: parts[1], dom: parts[2], month: parts[3], dow: parts[4] };
}

function dowMatch(field, date) {
  const dow = date.getDay();
  if (fieldMatch(field, dow)) return true;
  return dow === 0 && fieldMatch(field, 7);
}

function cronMatches(expr, date) {
  const fields = typeof expr === "string" || expr == null ? parseCron(expr) : expr;
  if (!fields || !(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  if (!fieldMatch(fields.minute, date.getMinutes())) return false;
  if (!fieldMatch(fields.hour, date.getHours())) return false;
  if (!fieldMatch(fields.month, date.getMonth() + 1, 1)) return false;
  const domRestricted = !fields.dom.startsWith("*");
  const dowRestricted = !fields.dow.startsWith("*");
  const domOk = fieldMatch(fields.dom, date.getDate(), 1);
  const dowOk = dowMatch(fields.dow, date);
  if (domRestricted && dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

function nextCron(expr, from) {
  const fields = parseCron(expr);
  if (!fields) return null;
  const cursor = new Date(from instanceof Date ? from.getTime() : Date.now());
  if (Number.isNaN(cursor.getTime())) return null;
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const end = cursor.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= end) {
    if (cronMatches(fields, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

module.exports = { parseCron, cronMatches, nextCron };
