"use strict";

const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const bytes = require("./copy-message");
const { digest } = require("./copy-recovery");
const LIMITS = Object.freeze({ messages: 50, rawBytes: bytes.MAX_BYTES, batchBytes: 256 * 1024 * 1024, reviews: 32, reviewMs: 120000 });
const problem = (code, message) => Object.assign(new Error(message), { code, operationIssued: false });
const UNKNOWN = "The destination copy could not be fully verified. The source was retained. Check the destination before retrying; this upload will not be repeated automatically.";
const receiptProof = receipt => digest(JSON.stringify([receipt.id, receipt.key, receipt.sourceKey, receipt.destinationKey, receipt.rawSha,
  receipt.sourceBinding, receipt.destinationBinding, receipt.folderProof, receipt.expected,
  receipt.destination && [receipt.destination.accountId, receipt.destination.folderId, receipt.destination.providerId, receipt.destination.uid, receipt.destination.uidValidity]]));

function createService({ access, journal, gate, now = Date.now, clock = () => performance.now() } = {}) {
  const reviews = new Map();
  let pendingReviews = 0, privateVerifications = 0;
  function store() { return typeof journal === "function" ? journal() : journal; }
  function prune() { for (const [id, review] of reviews) if (!review.running && (review.cancelled || review.expires <= clock())) reviews.delete(id); }
  function validateItems(params) {
    if (!Array.isArray(params?.items) || !params.items.length || params.items.length > LIMITS.messages) throw problem("copy_limit", "Choose 1–50 saved messages for mailbox Copy. Local Folders keeps its separate limits.");
    const ids = new Set();
    for (const item of params.items) {
      if (!item || typeof item.emailId !== "string" || !item.emailId || typeof item.accountId !== "string" || !item.accountId || ids.has(item.emailId)) throw problem("copy_review", "Review each exact source message once.");
      ids.add(item.emailId);
    }
    if (params.mode && params.mode !== "copy") throw problem("unsupported", "Move into a connected mailbox is unavailable until verified Copy and recoverable source Trash have been reviewed separately.");
  }
  async function destinations(params) {
    validateItems(params);
    const ticket = access.capture(params);
    const result = await access.destinations(ticket);
    return { ...result, maxBytes: LIMITS.rawBytes, maxMessages: LIMITS.messages, maxTotalBytes: LIMITS.batchBytes,
      moveEnabled: false, moveReason: "Remote Move is not enabled in the Copy phase. Your source messages stay in place." };
  }
  async function review(params) {
    validateItems(params); prune();
    if (reviews.size + pendingReviews >= LIMITS.reviews) throw problem("copy_limit", "Close an earlier copy review before opening another.");
    pendingReviews++;
    try {
      const ticket = access.capture(params);
      const destination = await access.review(ticket, params.folderId);
      const id = "copy-review:" + crypto.randomUUID();
      reviews.set(id, { id, ticket, destination, expires: clock() + LIMITS.reviewMs, used: new Set(), running: false, cancelled: false, bytes: 0 });
      return { reviewId: id, accountId: ticket.destination.accountId, folderId: destination.id,
      sourceCount: ticket.sources.length, sourceLabels: [...new Set(ticket.sources.map(source => source.label))],
      destinationLabel: destination.label, notices: destination.notices || [], expiresAt: now() + LIMITS.reviewMs,
      maxBytes: LIMITS.rawBytes, maxMessages: LIMITS.messages, maxTotalBytes: LIMITS.batchBytes };
    } finally { pendingReviews--; }
  }
  function result(receipt, status, detail) {
    return { status, receiptId: receipt.id, detail, destination: receipt.destination
      || { accountId: receipt.destinationAccountId, folderId: receipt.destinationFolderId },
      sourceRetained: true, ...(status === "unknown" ? { destinationMayContainCopy: true } : {}) };
  }
  async function copy(params) {
    const reviewed = reviews.get(params?.reviewId);
    if (!reviewed || reviewed.cancelled || reviewed.expires <= clock() || reviewed.running) throw problem("copy_review", "This copy review expired or is already running. Review the destination again.");
    const source = reviewed.ticket.sources.find(value => value.id === params.emailId && value.accountId === params.accountId);
    if (!source || reviewed.used.has(source.id)) throw problem("copy_review", "This reviewed source was already attempted. Open a fresh review to verify its saved receipt; no upload was repeated.");
    reviewed.used.add(source.id); reviewed.running = true;
    try {
      const run = () => access.withCopy(reviewed.ticket, source, reviewed.destination, async session => {
        session.check();
        const snapshot = await session.readSource(); session.check();
        const proof = bytes.inspect(snapshot.raw);
        if (reviewed.bytes + proof.size > LIMITS.batchBytes) throw problem("copy_limit", "This copy review reached its 256 MiB transfer limit. Remaining messages were retained; open a new explicit review.");
        reviewed.bytes += proof.size;
        const expected = session.expected(snapshot);
        const sourceKey = session.sourceKey(snapshot), destinationKey = session.destinationKey();
        const key = digest(JSON.stringify([sourceKey, destinationKey]));
        const ledger = store();
        let receipt = ledger.find(key), submitted = false;
        if (receipt && receipt.phase !== "not_uploaded") {
          if (!receipt.destination || receipt.rawSha !== proof.rawSha || receipt.sourceBinding !== session.sourceBinding
            || receipt.destinationBinding !== session.destinationBinding || receipt.folderProof !== session.folderProof) return result(receipt, "unknown", UNKNOWN);
          try {
            const saved = await session.readDestination(receipt.destination); session.check();
            bytes.verify(snapshot.raw, saved.raw, { gmail: session.backend === "gmail" });
            session.verifyState(saved, expected);
            receipt = ledger.update(receipt.id, receipt.phase, { phase: "verified", expected, updatedAt: now(), detail: "Destination content and state freshly verified." });
            return result(receipt, "reused", "A previous complete copy was freshly verified. No message was uploaded again; the source stayed in place.");
          } catch {
            receipt = ledger.update(receipt.id, receipt.phase, { phase: "unknown", updatedAt: now(), detail: UNKNOWN });
            return result(receipt, "unknown", UNKNOWN);
          }
        }
        const intent = { rawSha: proof.rawSha, size: proof.size, expected,
          sourceBinding: session.sourceBinding, destinationBinding: session.destinationBinding, folderProof: session.folderProof,
          destinationAccountId: reviewed.ticket.destination.accountId, destinationFolderId: reviewed.destination.id,
          updatedAt: now(), phase: "prepared", detail: "Prepared; no upload has started." };
        receipt = receipt ? ledger.update(receipt.id, "not_uploaded", intent)
          : ledger.insert({ id: "mailbox-copy:" + crypto.randomUUID(), key, sourceKey, destinationKey, createdAt: now(), ...intent });
        try {
          if (reviewed.cancelled) throw problem("copy_cancelled", "Copy was cancelled before upload. The source was retained.");
          session.check();
          const destination = await session.upload(snapshot, expected, () => {
            if (reviewed.cancelled) throw problem("copy_cancelled", "Copy was cancelled before upload. The source was retained.");
            session.check();
            receipt = ledger.update(receipt.id, "prepared", { phase: "unknown", updatedAt: now(), detail: UNKNOWN });
            session.check(); submitted = true;
          });
          if (!submitted) throw problem("copy_protocol", "The destination did not prove a submitted upload. The source was retained.");
          receipt = ledger.update(receipt.id, "unknown", { phase: "unverified", destination, updatedAt: now(), detail: "Upload acknowledged; checking complete destination readback." });
          session.check();
          const saved = await session.readDestination(destination); session.check();
          bytes.verify(snapshot.raw, saved.raw, { gmail: session.backend === "gmail" });
          session.verifyState(saved, expected);
          receipt = ledger.update(receipt.id, "unverified", { phase: "verified", updatedAt: now(), detail: "Complete destination content and read/star/date state verified." });
          return result(receipt, "copied", "A complete destination copy was verified. The source message stayed in place.");
        } catch (error) {
          if (!submitted && error.operationIssued !== true) {
            ledger.update(receipt.id, receipt.phase, { phase: "not_uploaded", updatedAt: now(), detail: "No upload was submitted. A new explicit review is required." });
            throw error;
          }
          receipt = ledger.update(receipt.id, receipt.phase, { phase: "unknown", updatedAt: now(), detail: UNKNOWN });
          return result(receipt, "unknown", UNKNOWN);
        }
      });
      return gate ? await gate.run(run) : await run();
    } finally {
      reviewed.running = false;
      if (reviewed.cancelled || reviewed.used.size === reviewed.ticket.sources.length) reviews.delete(reviewed.id);
    }
  }
  async function answer(params = {}) {
    if (params.action === "destinations") return destinations(params);
    if (params.action === "review") return review(params);
    if (params.action === "copy") return copy(params);
    if (params.action === "cancelReview") {
      const reviewed = reviews.get(params.reviewId);
      if (reviewed) { reviewed.cancelled = true; if (!reviewed.running) reviews.delete(reviewed.id); }
      return { cancelled: true };
    }
    throw problem("copy_review", "Choose a supported mailbox Copy action.");
  }
  // Private host-only extension: neither a receipt ID nor a Copy review grants
  // source-removal authority. This path never calls upload or changes a receipt.
  async function verifyExistingOnly(ticket, source, destination, work, authority = {}) {
    privateVerifications++;
    try {
      const run = () => access.withCopy(ticket, source, destination, async session => {
        authority.check?.(); session.check();
        const snapshot = await session.readSource(); session.check();
        const proof = bytes.inspect(snapshot.raw), expected = session.expected(snapshot);
        const sourceKey = session.sourceKey(snapshot), destinationKey = session.destinationKey();
        const key = digest(JSON.stringify([sourceKey, destinationKey])), ledger = store(), receipt = ledger.find(key);
        if (!receipt || receipt.phase !== "verified" || !receipt.destination || receipt.sourceKey !== sourceKey || receipt.destinationKey !== destinationKey
          || receipt.rawSha !== proof.rawSha || receipt.sourceBinding !== session.sourceBinding || receipt.destinationBinding !== session.destinationBinding
          || receipt.folderProof !== session.folderProof || JSON.stringify(receipt.expected) !== JSON.stringify(expected)) {
          throw problem("copy_unverified", "Complete and verify Copy for this exact source and destination before reviewing source removal. No source was removed.");
        }
        const fingerprint = receiptProof(receipt);
        const assertReceipt = () => {
          session.check(); const current = ledger.read(receipt.id);
          if (!current || current.phase !== "verified" || receiptProof(current) !== fingerprint) throw problem("copy_unverified", "The verified Copy receipt changed. The source was retained.");
        };
        assertReceipt();
        const saved = await session.readDestination(receipt.destination); assertReceipt();
        bytes.verify(snapshot.raw, saved.raw, { gmail: session.backend === "gmail" }); session.verifyState(saved, expected);
        if (session.backend === "gmail" && saved.labelIds?.some(label => ["TRASH", "SPAM", "DRAFT"].includes(label))) {
          throw problem("copy_unverified", "The receiving copy is in a protected or auto-purged Gmail view. The source was retained.");
        }
        assertReceipt();
        authority.check?.();
        return work({ session, snapshot, receipt, expected, proof, assertReceipt, receiptProof: fingerprint, verifiedAt: clock() });
      }, authority);
      return gate ? await gate.run(run) : await run();
    } finally { privateVerifications--; }
  }
  return { answer, verifyExistingOnly, limits: LIMITS, get active() { return privateVerifications > 0 || [...reviews.values()].some(value => value.running); } };
}

module.exports = { createService, LIMITS, UNKNOWN, receiptProof };
