"use strict";

const MIB = 1024 * 1024;

function checkpointDelay({ databaseBytes = 0, journalBytes = 0, transactions = 0, pending = false,
  startup = false, ageMs = 0, sinceCheckpointMs = 0, checkpointMs = 0 } = {}) {
  if (!journalBytes && !transactions && !pending) return null;
  const byteLimit = Math.max(8 * MIB, Math.min(64 * MIB, Math.ceil(databaseBytes / 64))) * (startup ? 4 : 1);
  const transactionLimit = Math.max(256, Math.min(4096, Math.ceil(databaseBytes / (2 * MIB))));
  const ageDelay = Math.max(0, (startup ? 120000 : 60000) - ageMs);
  const threshold = journalBytes >= byteLimit || (!startup && (transactions >= transactionLimit || pending));
  if (!threshold) return ageDelay;
  const cooldown = Math.max(1000, Math.min(60000, checkpointMs * 4));
  return Math.min(ageDelay, Math.max(0, cooldown - sinceCheckpointMs));
}

function checkpointHeadroom(databaseBytes, availableBytes) {
  if (!Number.isFinite(availableBytes) || availableBytes < 0) return true;
  const reserve = Math.max(64 * MIB, Math.min(512 * MIB, Math.ceil(databaseBytes / 20)));
  return availableBytes >= databaseBytes + reserve;
}

function checkpointRetry(failures, lowSpace = false) {
  return Math.min(300000, (lowSpace ? 60000 : 30000) * 2 ** Math.min(4, Math.max(0, failures - 1)));
}

module.exports = { checkpointDelay, checkpointHeadroom, checkpointRetry };
