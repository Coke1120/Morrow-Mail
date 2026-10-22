// Local-time night window for the slow body fill. 07:00 is outside.
const NIGHT_START_HOUR = 0;
const NIGHT_END_HOUR = 7;

function hourInTimeZone(at, timeZone) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: timeZone || undefined,
    }).formatToParts(date);
    const raw = parts.find((part) => part.type === "hour");
    const value = Number(raw && raw.value);
    if (!Number.isFinite(value)) return date.getHours();
    return value === 24 ? 0 : value;
  } catch {
    return date.getHours();
  }
}

function inOvernightWindow(at, timeZone) {
  const hour = hourInTimeZone(at, timeZone);
  return hour != null && hour >= NIGHT_START_HOUR && hour < NIGHT_END_HOUR;
}

module.exports = {
  NIGHT_START_HOUR,
  NIGHT_END_HOUR,
  hourInTimeZone,
  inOvernightWindow,
};
