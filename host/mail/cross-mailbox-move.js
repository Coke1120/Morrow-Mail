"use strict";

const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { LIMITS: COPY_LIMITS } = require("./cross-mailbox-copy");
const POLICY = require("./cross-mailbox-move-policy");
const LIMITS = Object.freeze({ messages: COPY_LIMITS.messages, batchBytes: COPY_LIMITS.batchBytes, reviews: 32,
  reviewMs: 120000, freshMs: 15000 });
const fail = (code, message) => Object.assign(new Error(message), { code, operationIssued: false });
const UNKNOWN = "The destination copy remains verified, but Gmail source Trash could not be confirmed. Check Gmail before any further move; no upload or source removal will replay automatically.";

function createService({ access, copies, journal, enabled = POLICY.enabled, reason = POLICY.reason, gate,
  now = Date.now, clock = () => performance.now(), onConfirmed = () => {} } = {}) {
  const reviews = new Map(); let pendingReviews = 0, active = 0, retired = false;
  const store = () => typeof journal === "function" ? journal() : journal;
  const copyService = () => typeof copies === "function" ? copies() : copies;
  function available() { if (enabled !== true || retired) throw fail("move_gated", retired ? "Source Move reviews were retired for shutdown. Open a fresh application session before continuing." : reason); }
  function principal(owner) { if (!owner || typeof owner.check !== "function") throw fail("move_review", "Open a fresh Move review in this window."); owner.check(); }
  function validate(params) {
    if (!Array.isArray(params?.items) || !params.items.length || params.items.length > LIMITS.messages) throw fail("move_limit", "Choose 1–50 saved Gmail API messages for this Move review.");
    const ids = new Set();
    for (const item of params.items) {
      if (typeof item?.emailId !== "string" || !item.emailId || item.emailId.length > 200 || typeof item.accountId !== "string" || !item.accountId || ids.has(item.emailId)) throw fail("move_review", "Review each exact Gmail source once.");
      ids.add(item.emailId);
    }
    if (params.mode && params.mode !== "move") throw fail("move_review", "Copy reviews do not authorize Gmail source removal.");
  }
  function capture(params) {
    validate(params);
    const ticket = access.capture(params);
    if (ticket.sources.some(source => source.local || source.owner?.account?.profile !== "gmail"
      || source.owner.account.auth_kind !== "oauth2" || source.owner.account.mail_transport !== "gmail_api")) {
      throw fail("move_unsupported", "Remote source removal is available only for reviewed Gmail API sources. Legacy Gmail IMAP and other source providers remain Copy-only.");
    }
    return ticket;
  }
  function guard(review, owner) {
    available(); principal(owner);
    if (review.owner !== owner || review.cancelled || review.expires <= clock()) throw fail("move_review", "The Move review expired or was cancelled. Verified copies remain; no later source removal is authorized.");
  }
  function prune() { for (const [id, value] of reviews) if (!value.running && (value.cancelled || value.expires <= clock())) reviews.delete(id); }
  async function capabilities(params, owner) {
    if (enabled !== true || retired) return { moveEnabled: false, sourceGmailOnly: true, moveReason: reason };
    try { principal(owner); capture(params); store().assertIntegrity(); copyService(); return { moveEnabled: true, sourceGmailOnly: true,
      moveReason: "Copy first, then explicitly review Gmail source Trash. The receiving copy stays on every outcome; no atomic transfer or automatic Undo is promised." }; }
    catch (error) { return { moveEnabled: false, sourceGmailOnly: true, moveReason: error.message }; }
  }
  async function review(params, owner) {
    available(); principal(owner); validate(params); prune();
    if (reviews.size + pendingReviews >= LIMITS.reviews) throw fail("move_limit", "Close an earlier Move review before opening another.");
    pendingReviews++;
    const starting = { owner, expires: clock() + LIMITS.reviewMs, cancelled: false };
    try {
      const ticket = capture(params), destination = await access.review(ticket, params.folderId); guard(starting, owner);
      const entries = new Map(); let total = 0;
      for (const source of ticket.sources) {
        const entry = await copyService().verifyExistingOnly(ticket, source, destination, async verified => {
          guard(starting, owner);
          if (verified.session.sourceBackend !== "gmail" || !verified.session.reviewSourceMove) throw fail("move_unsupported", "A Gmail API source proof is required.");
          const sourceProof = await verified.session.reviewSourceMove(verified.snapshot); guard(starting, owner); verified.assertReceipt();
          const prior = store().find(verified.receipt.sourceKey);
          if (prior?.phase === "source_unknown") throw fail("move_unknown", UNKNOWN);
          return { source, sourceProof, sourceKey: verified.receipt.sourceKey, copyReceiptId: verified.receipt.id,
            copyProof: verified.receiptProof, size: verified.proof.size };
        }, { check: () => guard(starting, owner) });
        total += entry.size;
        if (total > LIMITS.batchBytes) throw fail("move_limit", "This Move review exceeds the 256 MiB verified-copy limit. Review fewer messages.");
        entries.set(source.id, entry);
      }
      guard(starting, owner);
      const id = "move-review:" + crypto.randomUUID(), value = { ...starting, id, ticket, destination, entries, running: 0, attempts: new Map() };
      reviews.set(id, value);
      return { reviewId: id, accountId: ticket.destination.accountId, folderId: destination.id, sourceCount: entries.size,
        uniqueSourceCount: new Set([...entries.values()].map(entry => entry.sourceKey)).size,
        sourceLabels: [...new Set(ticket.sources.map(source => source.label))], destinationLabel: destination.label,
        notices: ["Only freshly verified existing copies are used; this Move review cannot upload mail.",
          "Gmail source messages move to Gmail Trash. Gmail retention and other clients can later remove them.",
          "The destination copy stays if removal fails or is cancelled. This is not a cross-provider atomic transaction, and Morrow does not offer an automatic Undo for this transfer."],
        expiresAt: now() + Math.max(0, value.expires - clock()),
        entries: [...entries.values()].map(entry => ({ emailId: entry.source.id, accountId: entry.source.accountId, copyReceiptId: entry.copyReceiptId })) };
    } finally { pendingReviews--; }
  }
  function result(receipt, status, detail) {
    return { status, moveReceiptId: receipt.id, copyReceiptId: receipt.copy.id, destination: receipt.destination,
      sourceRetained: status === "unknown" ? null : !["moved", "already_moved"].includes(status),
      sourceTrashed: status === "unknown" ? null : ["moved", "already_moved"].includes(status), detail };
  }
  async function execute(review, entry, owner) {
    const run = () => copyService().verifyExistingOnly(review.ticket, entry.source, review.destination, async verified => {
      guard(review, owner);
      if (verified.receipt.id !== entry.copyReceiptId || verified.receiptProof !== entry.copyProof || verified.receipt.sourceKey !== entry.sourceKey) throw fail("copy_unverified", "The reviewed Copy receipt changed. The Gmail source was retained.");
      const proof = await verified.session.reviewSourceMove(verified.snapshot); guard(review, owner); verified.assertReceipt();
      if (proof.proof !== entry.sourceProof.proof) throw fail("move_source", "The reviewed Gmail source changed. The destination copy remains; review source removal again.");
      const ledger = store(); let receipt = ledger.find(entry.sourceKey);
      if (receipt?.phase === "source_unknown") return result(receipt, "unknown", UNKNOWN);
      // A known earlier completed removal can only be rearmed by this new,
      // explicit review after fresh Gmail data proves restoration outside Trash.
      const data = { sourceKey: entry.sourceKey, copy: { id: verified.receipt.id, proof: verified.receiptProof },
        source: { ...proof, binding: verified.session.sourceBinding }, destination: verified.receipt.destination,
        destinationBinding: verified.session.destinationBinding, phase: "prepared", updatedAt: now(),
        detail: "Copy and source freshly verified; no Gmail Trash request has started.", attempt: (receipt?.attempt || 0) + 1 };
      receipt = receipt ? ledger.update(receipt.id, ["not_trashed", "source_trashed"], data)
        : ledger.insert({ id: "mailbox-move:" + crypto.randomUUID(), createdAt: now(), ...data });
      let submitted = false, acknowledged = false;
      try {
        const trash = await verified.session.trashSource(verified.snapshot, proof, () => {
          guard(review, owner); verified.assertReceipt();
          if (clock() - verified.verifiedAt > LIMITS.freshMs) throw fail("move_review", "Destination verification aged while waiting. The copy remains; review source removal again.");
          const current = ledger.read(receipt.id);
          if (!current || current.phase !== "prepared" || current.attempt !== receipt.attempt || current.copy.proof !== entry.copyProof) throw fail("move_conflict", "This source Move attempt changed before submission.");
          receipt = ledger.update(receipt.id, "prepared", { phase: "source_unknown", updatedAt: now(), detail: UNKNOWN });
          guard(review, owner); verified.assertReceipt(); submitted = true;
        });
        acknowledged = true;
        receipt = ledger.update(receipt.id, "source_unknown", { phase: "source_trashed", trash, updatedAt: now(),
          detail: "The exact Gmail source was confirmed in Gmail Trash. The destination copy remains." });
        try { onConfirmed(entry.source.accountId, trash); } catch { /* durable receipt survives cache/event failure */ }
        return result(receipt, "moved", receipt.detail);
      } catch (error) {
        if (!acknowledged && error.operationIssued === false) {
          receipt = ledger.update(receipt.id, ["prepared", "source_unknown"], { phase: "not_trashed", updatedAt: now(),
            detail: "No source removal was completed by this attempt. The destination copy remains; a new explicit review is required." });
          return result(receipt, "source_retained", receipt.detail);
        }
        // Once submitted or acknowledged, later read/owner/storage failure can
        // never authorize re-Trash or turn uncertainty into a safe retry.
        if (!submitted && !acknowledged) throw error;
        try { receipt = ledger.update(receipt.id, ["prepared", "source_unknown"], { phase: "source_unknown", updatedAt: now(), detail: UNKNOWN }); } catch { /* keep original durable unknown intent */ }
        return result(receipt, "unknown", UNKNOWN);
      }
    }, { check: () => guard(review, owner) });
    return gate ? gate.run(run) : run();
  }
  async function move(params, owner) {
    available(); const reviewed = reviews.get(params.reviewId);
    if (!reviewed || params.confirmed !== true) throw fail("move_review", "Confirm the separate Gmail Move review before source removal.");
    guard(reviewed, owner);
    const entry = reviewed.entries.get(params.emailId);
    if (!entry || entry.source.accountId !== params.accountId) throw fail("move_review", "This exact source is outside the Move review.");
    if (reviewed.attempts.has(entry.sourceKey)) {
      const prior = await reviewed.attempts.get(entry.sourceKey);
      return prior.status === "moved" ? { ...prior, status: "already_moved", detail: "This reviewed operation already confirmed Gmail Trash. No source removal was repeated." } : prior;
    }
    reviewed.running++; active++;
    const work = Promise.resolve().then(() => execute(reviewed, entry, owner));
    reviewed.attempts.set(entry.sourceKey, work);
    try { return await work; } finally { reviewed.running--; active--; }
  }
  function cancelOwner(owner) { for (const value of reviews.values()) if (value.owner === owner) value.cancelled = true; }
  function pause() { retired = true; for (const value of reviews.values()) value.cancelled = true; }
  async function answer(params = {}, owner) {
    if (params.action === "capabilities") return capabilities(params, owner);
    available(); principal(owner);
    if (params.action === "review") return review(params, owner);
    if (params.action === "move") return move(params, owner);
    if (params.action === "cancelReview") {
      const value = reviews.get(params.reviewId);
      if (value?.owner === owner) { value.cancelled = true; if (!value.running) reviews.delete(value.id); }
      return { cancelled: true };
    }
    throw fail("move_review", "Choose a supported Gmail source Move action.");
  }
  return { answer, cancelOwner, pause, limits: LIMITS, get active() { return active > 0 || pendingReviews > 0; } };
}

module.exports = { createService, LIMITS, UNKNOWN };
