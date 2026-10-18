"use strict";

// In-memory notes from ordinary host sync. A bridge read must not refresh tokens
// to fill this in. Restart leaves unknown until Morrow syncs again.
const byAccount = new Map();

function note(accountId, patch) {
  if (!accountId || !patch || typeof patch !== "object") return;
  const prev = byAccount.get(accountId) || {};
  const next = {
    syncState: prev.syncState || "unknown",
    lastObservedAt: prev.lastObservedAt || null,
    lastSuccessfulSyncAt: prev.lastSuccessfulSyncAt || null,
    pausedUntil: prev.pausedUntil || null,
    providerConnection: "unknown",
  };
  if (typeof patch.syncState === "string") next.syncState = patch.syncState;
  if (typeof patch.lastObservedAt === "string") next.lastObservedAt = patch.lastObservedAt;
  if (typeof patch.lastSuccessfulSyncAt === "string") next.lastSuccessfulSyncAt = patch.lastSuccessfulSyncAt;
  if (Object.prototype.hasOwnProperty.call(patch, "pausedUntil")) {
    next.pausedUntil = patch.pausedUntil || null;
  }
  byAccount.set(accountId, next);
}

function get(accountId) {
  return byAccount.get(accountId) || null;
}

function reset() {
  byAccount.clear();
}

module.exports = { note, get, reset };
