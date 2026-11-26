"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isPromise } = require("node:util").types;

const SCHEME = "morrow-message";
const PREFIX = SCHEME + "://open/v1/";
const KEY_FILE = "local-message-link.key";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_IDENTIFIER_BYTES = 200;
const MAX_ENVELOPE_BYTES = 600;
const STORAGE_ERROR = "local-message-link-storage";

function identifier(value) {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_BYTES && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

function parseLocalMessageLink(link) {
  if (typeof link !== "string" || link.length > PREFIX.length + MAX_ENVELOPE_BYTES * 2 ||
      !link.startsWith(PREFIX)) return null;
  const token = link.slice(PREFIX.length);
  if (!/^[a-zA-Z0-9_-]+$/.test(token) || token.length > Math.ceil(MAX_ENVELOPE_BYTES * 4 / 3)) return null;
  const envelope = Buffer.from(token, "base64url");
  if (envelope.length <= IV_BYTES + TAG_BYTES || envelope.length > MAX_ENVELOPE_BYTES ||
      envelope.toString("base64url") !== token) return null;
  return envelope;
}

function readKey(filename) {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  const fd = fs.openSync(filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== KEY_BYTES || (process.platform !== "win32" && (stat.mode & 0o077))) {
      throw new Error("Invalid local message link key");
    }
    const key = Buffer.alloc(KEY_BYTES);
    if (fs.readSync(fd, key, 0, KEY_BYTES, 0) !== KEY_BYTES) throw new Error("Incomplete local message link key");
    return key;
  } finally {
    fs.closeSync(fd);
  }
}

function publishKey(filename) {
  // Publish only a complete key. A concurrent mint may install the winner first.
  const candidate = filename + "." + crypto.randomUUID() + ".tmp";
  const fd = fs.openSync(candidate, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, crypto.randomBytes(KEY_BYTES));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.linkSync(candidate, filename); }
    catch (error) {
      if (error.code === "EEXIST") return;
      if (["ENOTSUP", "EOPNOTSUPP", "EPERM", "EACCES", "EXDEV", "ENOSYS"].includes(error.code)) {
        throw Object.assign(new Error("This profile location cannot safely create local message links."), { code: STORAGE_ERROR });
      }
      throw error;
    }
  } finally {
    fs.unlinkSync(candidate);
  }
}

function mintKey(filename) {
  let key;
  try { key = readKey(filename); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    publishKey(filename);
    key = readKey(filename);
  }
  // A concurrent mint may already see the key before its writer flushes the
  // directory entry. Every caller must finish that flush before sealing a link.
  // Node cannot obtain a directory handle for FlushFileBuffers on Windows.
  if (process.platform !== "win32") {
    const dir = fs.openSync(path.dirname(filename), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  return key;
}

function createLocalMessageLinks({ profileDir, readProof }) {
  // A copied key and database at another profile path do not authorize a link.
  const profile = fs.realpathSync.native(profileDir);
  const filename = path.join(profile, KEY_FILE);
  const context = Buffer.from(PREFIX + profile, "utf8");
  const proofPattern = /^[a-f0-9]{64}$/;

  function currentProof(accountId, messageId) {
    const proof = readProof({ accountId, messageId });
    if (isPromise(proof)) {
      // Resolution must stay synchronous through the final identity check.
      proof.catch(() => {});
      return null;
    }
    return typeof proof === "string" && proofPattern.test(proof) ? proof : null;
  }

  function mint(target) {
    try {
      const { accountId, messageId } = target ?? {};
      if (!identifier(accountId) || !identifier(messageId)) return null;
      const proof = currentProof(accountId, messageId);
      if (!proof) return null;
      const plaintext = Buffer.from(JSON.stringify([accountId, messageId, proof]), "utf8");
      if (plaintext.length + IV_BYTES + TAG_BYTES > MAX_ENVELOPE_BYTES) return null;
      const nonce = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv("aes-256-gcm", mintKey(filename), nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(context);
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
    } catch (error) {
      if (error?.code === STORAGE_ERROR) throw error;
      return null;
    }
  }

  function resolve(link) {
    const envelope = parseLocalMessageLink(link);
    if (!envelope) return null;
    try {
      const nonce = envelope.subarray(0, IV_BYTES);
      const tag = envelope.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const encrypted = envelope.subarray(IV_BYTES + TAG_BYTES);
      const cipher = crypto.createDecipheriv("aes-256-gcm", readKey(filename), nonce, { authTagLength: TAG_BYTES });
      cipher.setAAD(context);
      cipher.setAuthTag(tag);
      const decoded = JSON.parse(Buffer.concat([cipher.update(encrypted), cipher.final()]).toString("utf8"));
      if (!Array.isArray(decoded) || decoded.length !== 3) return null;
      const [accountId, messageId, proof] = decoded;
      if (!identifier(accountId) || !identifier(messageId) || typeof proof !== "string" || !proofPattern.test(proof)) return null;
      return currentProof(accountId, messageId) === proof ? { accountId, messageId } : null;
    } catch {
      return null;
    }
  }

  return { mint, resolve };
}

module.exports = { SCHEME, parseLocalMessageLink, createLocalMessageLinks };
