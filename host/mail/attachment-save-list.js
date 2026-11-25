"use strict";

const { lstatSync, promises: fs, unlinkSync } = require("node:fs");
const path = require("node:path");
const { isPromise } = require("node:util").types;
const { LIMITS } = require("./attachment-cache");

const NAME_BYTES = 120;
const MAX_FILES = 65535; // Also the existing ZIP file-count limit.
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i;
const issue = (code, message) => Object.assign(new Error(message), { code });
const nameKey = name => name.normalize("NFC").toUpperCase();

function trimToBytes(text, available) {
  let output = "", remaining = available;
  for (const char of text) {
    remaining -= Buffer.byteLength(char);
    if (remaining < 0) break;
    output += char;
  }
  return output;
}

function outputName(rawName, taken, cursors) {
  let name = path.win32.basename(String(rawName || "").replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ""))
    .replace(/[<>:"|?*]/g, "_").trim().replace(/[. ]+$/g, "").normalize("NFC");
  if (!name) name = "attachment";
  if (DEVICE_NAME.test(name)) name = "_" + name;
  const extension = path.extname(name);
  const ext = Buffer.byteLength(extension) <= 16 ? extension : "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  function fit(suffix) {
    const room = NAME_BYTES - Buffer.byteLength(suffix + ext);
    const clipped = limit => trimToBytes(stem, limit).replace(/[. ]+$/g, "");
    const candidate = clipped(room) + suffix + ext;
    // Clipping followed by trimming can expose a device name that was not
    // reserved when it still had its full suffix.
    return DEVICE_NAME.test(candidate) ? "_" + clipped(room - 1) + suffix + ext : candidate;
  }
  const base = fit("") || "attachment";
  const key = nameKey(base);
  let candidate = base;
  let next = cursors.get(key) || 2;
  while (taken.has(nameKey(candidate))) candidate = fit("-" + next++);
  taken.add(nameKey(candidate));
  cursors.set(key, next);
  return candidate;
}

async function directoryIdentity(directory) {
  const real = await fs.realpath(directory);
  const stat = await fs.stat(real, { bigint: true });
  if (!stat.isDirectory()) throw issue("destination-changed", "Choose an available folder.");
  return { real, dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

function sameEntry(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

async function checkDirectory(destination) {
  let current;
  try { current = await directoryIdentity(destination.real); } catch { /* unavailable */ }
  if (!current || current.real !== destination.real || !sameEntry(current, destination)) {
    throw issue("destination-changed", "The reviewed folder is no longer available.");
  }
}

async function checkTarget(target, created) {
  const current = await fs.lstat(target, { bigint: true }).catch(() => null);
  if (!current?.isFile() || !sameEntry(current, created)) {
    throw issue("destination-changed", "The reviewed file path changed.");
  }
}

async function writeReviewed(destination, filename, data, check) {
  const target = path.join(destination.real, filename);
  let file, created;
  try {
    await checkDirectory(destination);
    check();
    // Exclusive creation claims the reviewed name on every supported volume.
    // All bytes are written through that handle, never through a reopened path.
    file = await fs.open(target, "wx", 0o600);
    created = await file.stat({ bigint: true });
    await checkTarget(target, created);
    await checkDirectory(destination);
    check();
    await file.writeFile(data);
    await file.close();
  } catch (error) {
    let cleanupFailed = !!file;
    if (created && (created.ino !== 0n || created.birthtimeNs !== 0n)) {
      try {
        const current = lstatSync(target, { bigint: true });
        if (current.isFile() && sameEntry(current, created)) {
          unlinkSync(target);
          cleanupFailed = false;
        }
      } catch { /* the output may already have moved or been replaced */ }
    }
    if (file) await file.close().catch(() => {});
    return { failure: error || issue("write-failed", "The reviewed file could not be saved."), cleanupFailed };
  }
  // A completed write still counts if the source changes or the user cancels
  // while the write finishes. Preserve the result and report the failed check.
  try {
    await checkDirectory(destination);
    await checkTarget(target, created);
    check();
    return { cleanupFailed: false };
  } catch (verificationFailure) {
    return { cleanupFailed: false, verificationFailure };
  }
}

function failureStatus(error, stage, signal) {
  const code = error?.code;
  if (code === "EEXIST" && stage === "write") return "collision";
  if (["destination-changed", "too-large", "source-unavailable"].includes(code)) return code;
  if ((signal?.aborted && error === signal.reason) || code === "cancelled" || error?.name === "AbortError") return "cancelled";
  return stage === "source" ? "source-unavailable" : "write-failed";
}

function checkCancellation(signal) {
  if (signal?.aborted) throw issue("cancelled", "Cancelled.");
}

function createAttachmentSaveList({ readBytes }) {
  if (typeof readBytes !== "function") throw new TypeError("An attachment reader is required.");
  const prepared = new WeakMap();

  // The engine supplies one synchronous live check per captured attachment.
  // Keep those closures private; confirmation must use the reviewed object.
  async function prepare(directory, sources) {
    if (typeof directory !== "string" || !path.isAbsolute(directory) || !Array.isArray(sources) ||
        !sources.length || sources.length > MAX_FILES) throw issue("invalid-review", "Choose a folder and at least one attachment.");
    const seen = new Set();
    const selections = sources.map(source => {
      const { accountId, emailId, attachmentId, filename, size, assertCurrent } = source || {};
      if ([accountId, emailId, attachmentId].some(id => typeof id !== "string" || !id || id.length > 512) ||
          typeof assertCurrent !== "function") throw issue("invalid-review", "An attachment selection is no longer valid.");
      const key = JSON.stringify([accountId, emailId, attachmentId]);
      if (seen.has(key)) throw issue("invalid-review", "Review the duplicate attachment selection.");
      seen.add(key);
      return { accountId, emailId, attachmentId, filename, size, assertCurrent };
    });
    const destination = await directoryIdentity(directory);
    const taken = new Set((await fs.readdir(destination.real)).map(nameKey));
    await checkDirectory(destination);
    const cursors = new Map();
    const rows = selections.map(({ accountId, emailId, attachmentId, filename }) =>
      Object.freeze({ accountId, emailId, attachmentId, filename: outputName(filename, taken, cursors) }));
    const review = Object.freeze({ directory: destination.real, files: Object.freeze(rows) });
    prepared.set(review, { destination, selections });
    return review;
  }

  async function save(review, { signal } = {}) {
    const plan = prepared.get(review);
    if (!plan) throw issue("invalid-review", "Review the selected attachments and folder again.");
    prepared.delete(review);
    const outcomes = [];
    let transferred = 0;
    for (const [index, source] of plan.selections.entries()) {
      const row = review.files[index];
      let stage = "destination", failure, cleanupFailed = false, data, verificationFailure;
      const checkSource = () => {
        checkCancellation(signal);
        try {
          const current = source.assertCurrent();
          if (isPromise(current)) {
            current.catch(() => {});
            throw new Error("The attachment check must be synchronous.");
          }
          if (current === false) throw new Error("Attachment changed.");
        }
        catch { throw issue("source-unavailable", "The source attachment changed or is unavailable."); }
      };
      try {
        checkCancellation(signal);
        await checkDirectory(plan.destination);
        stage = "source";
        checkSource();
        const maxBytes = Math.min(LIMITS.fileBytes, LIMITS.zipBytes - transferred);
        if ((maxBytes === 0 && source.size !== 0) || (Number.isSafeInteger(source.size) && source.size > maxBytes)) {
          throw issue("too-large", "This file exceeds the remaining download limit.");
        }
        data = await readBytes({ accountId: source.accountId, emailId: source.emailId, attachmentId: source.attachmentId },
          { signal, maxBytes });
        if (!Buffer.isBuffer(data)) throw issue("source-unavailable", "No complete attachment was returned.");
        transferred = Math.min(LIMITS.zipBytes, transferred + data.length);
        if (data.length > maxBytes) throw issue("too-large", "This file exceeds the remaining download limit.");
        checkSource();
        stage = "write";
        ({ failure, cleanupFailed, verificationFailure } = await writeReviewed(plan.destination, row.filename, data, checkSource));
      } catch (error) {
        failure = error || (signal?.aborted && error === signal.reason
          ? issue("cancelled", "Cancelled.") : issue("source-unavailable", "The attachment could not be read."));
      }
      if (failure) outcomes.push({ ...row, status: failureStatus(failure, stage, signal), cleanupFailed });
      else {
        const result = { ...row, status: "saved", bytes: data.length, cleanupFailed };
        if (verificationFailure) result.verification = failureStatus(verificationFailure, "write", signal);
        outcomes.push(result);
      }
    }
    return outcomes;
  }

  return { prepare, save };
}

module.exports = { createAttachmentSaveList };
