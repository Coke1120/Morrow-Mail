// Spaces Gmail API reads for one local mailbox. No network and no shared
// Google-user meter: two Morrow accounts, or two machines, still count
// separately against the same person at Google.
const USER_UNITS_PER_MIN = 6000;
const READ_UNITS_PER_MIN = 4500;
const WINDOW_MS = 60 * 1000;
const SYNC_PAGE = 20;

function readUnits(operation, query) {
  const format = query && query.format;
  const heavy = format === "full" || format === "raw" || format === "html" || format == null;
  switch (operation) {
    case "messages.get":
    case "drafts.get":
      return heavy ? 60 : 20;
    case "attachments.get":
      return 20;
    case "messages.list":
    case "drafts.list":
      return 5;
    case "history.list":
      return 2;
    case "threads.get":
      return format === "full" ? 120 : 40;
    case "threads.list":
      return 10;
    case "profile.get":
    case "labels.get":
    case "labels.list":
      return 1;
    default:
      return 5;
  }
}

function gapMs(units, unitsPerMin = READ_UNITS_PER_MIN) {
  const cost = Math.max(0, Number(units) || 0);
  const rate = Number(unitsPerMin) > 0 ? Number(unitsPerMin) : READ_UNITS_PER_MIN;
  if (!cost) return 0;
  return Math.ceil(cost * WINDOW_MS / rate);
}

function createReadPacer({ now = () => Date.now(), unitsPerMin = READ_UNITS_PER_MIN } = {}) {
  let nextAt = 0;
  return function reserve(units) {
    const gap = gapMs(units, unitsPerMin);
    const t = now();
    const start = Math.max(t, nextAt);
    nextAt = start + gap;
    return start - t;
  };
}

const pacers = new Map();

function reserve(accountKey, units) {
  if (!accountKey || process.env.MORROW_GMAIL_PACE === "0") return 0;
  const key = String(accountKey);
  let pacer = pacers.get(key);
  if (!pacer) {
    pacer = createReadPacer();
    pacers.set(key, pacer);
  }
  return pacer(units);
}

function reset(accountKey) {
  if (accountKey == null) pacers.clear();
  else pacers.delete(String(accountKey));
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
}

module.exports = {
  USER_UNITS_PER_MIN,
  READ_UNITS_PER_MIN,
  WINDOW_MS,
  SYNC_PAGE,
  readUnits,
  gapMs,
  createReadPacer,
  reserve,
  reset,
  sleep,
};
