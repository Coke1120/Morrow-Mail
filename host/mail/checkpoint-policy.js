"use strict";

const MIB = 1024 * 1024;

function checkpointDelay({ databaseBytes = 0, journalBytes = 0, transactions = 0, pending = false,
  startup = false, ageMs = 0, sinceCheckpointMs = 0, checkpointMs = 0 } = {}) {
  if (!journalBytes && !transactions && !pending) return null;
  const byteLimit = Math.max(8 * MIB, Math.min(64 * MIB, Math.ceil(databaseBytes / 64))) * (startup ? 4 : 1);
  const transactionLimit = Math.max(256, Math.min(4096, Math.ceil(databaseBytes / (2 * MIB))));
  const hardDelay = Math.max(0, 3600000 - ageMs);
  if (journalBytes >= Math.max(256 * MIB, byteLimit * 4)) return 0;
  const baseAge = startup ? 120000 : 60000;
  const softAge = Math.min(3600000, Math.max(baseAge,
    Math.min(startup ? 1800000 : 900000, Math.ceil(databaseBytes / (64 * MIB)) * baseAge), checkpointMs * 8));
  const threshold = journalBytes >= byteLimit || (!startup && (transactions >= transactionLimit || pending));
  const cooldown = Math.max(1000, Math.min(300000, checkpointMs * 4));
  return Math.min(hardDelay, Math.max(threshold ? 0 : softAge - ageMs, cooldown - sinceCheckpointMs, 0));
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
