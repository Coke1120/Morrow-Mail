// One elapsed-time policy for automatic profile refresh, including page opens.
const INTERVALS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };

function cadence(value, loose = false) {
  if (typeof value === "string" && (value === "manual" || Object.hasOwn(INTERVALS, value))) return value;
  if (loose) return value === undefined ? "daily" : "manual";
  throw new Error("Brain refresh must be daily, weekly, or manual");
}

function nextDueAt(store, value) {
  const interval = INTERVALS[cadence(value, true)];
  if (!interval) return null;
  const times = [store.generated && store.generated.updatedAt, store.refreshAttemptAt]
    .map(value => typeof value === "string" ? Date.parse(value) : NaN)
    .filter(Number.isFinite);
  // No profile yet: the next automatic check may build one, with consent.
  return times.length ? Math.max(...times) + interval : 0;
}

module.exports = { cadence, nextDueAt };
