"use strict";

const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { digest, ACTIVE } = require("./folder-recovery");
const GRACE_MS = 30000, REVIEW_MS = 120000;
const conflict = message => Object.assign(new Error(message || "This mailbox or folder changed. Review the action again."), { code: "conflict", operationIssued: false });
const unsupported = message => Object.assign(new Error(message), { code: "unsupported", operationIssued: false });
const flag = (folder, value) => (folder.flags || []).some(item => String(item).toLowerCase() === value.toLowerCase());
const protectedFolder = folder => !folder || !!folder.wellKnown || folder.type === "virtual" || folder.type === "system"
  || String(folder.id).toUpperCase() === "INBOX" || folder.readOnly === true || folder.selectable === false;
const fingerprint = folder => folder ? digest(JSON.stringify([folder.id, folder.name, folder.providerId, folder.wellKnown,
  folder.type, folder.parentId, folder.delimiter, folder.selectable, folder.readOnly, folder.editable, [...(folder.flags || [])].sort()])) : "";

function listing(value) {
  if (!value || !Array.isArray(value.folders) || value.folders.length > 5000
      || value.delimiter !== null && (typeof value.delimiter !== "string" || !value.delimiter || value.delimiter.length > 16)) throw unsupported("A complete bounded folder listing is required before changing folders.");
  const ids = new Set();
  for (const row of value.folders) {
    if (!row || typeof row.id !== "string" || !row.id || row.id.length > 4096 || typeof row.name !== "string" || row.name.length > 4096 || ids.has(row.id)) throw conflict("The server folder listing could not be verified.");
    ids.add(row.id);
  }
  return value;
}

function createManager({ journal, owner, withAccount, notify = () => {}, gate = { run: work => work() }, now = Date.now,
  monotonic = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const reviews = new Map(), pending = new Map();
  let recovered = false;
  function store(write = false) {
    const value = journal(write);
    if (value && !recovered) { value.recover(now()); recovered = true; }
    return value;
  }
  function publish(accountId) { try { notify(accountId); } catch {} }
  function currentOwner(accountId) {
    const value = owner(accountId);
    if (!value) throw conflict("That mailbox is no longer connected.");
    return value;
  }
  function ownedOperation(accountId, id) {
    const operation = store()?.read(id), current = currentOwner(accountId);
    if (!operation || operation.accountId !== accountId || operation.owner !== current.binding) throw conflict("This recovery action belongs to a different mailbox connection.");
    return operation;
  }
  function publicOperation(operation) {
    const runtime = pending.get(operation.id);
    return { id: operation.id, accountId: operation.accountId, intent: operation.intent, sourceId: operation.sourceId,
      name: operation.source?.name || operation.sourceId, phase: operation.phase,
      remainingMs: runtime ? Math.max(0, Math.ceil(runtime.deadline - monotonic())) : 0, reason: operation.reason || "",
      canUndo: operation.mode === "label-grace" && ["pending", "paused"].includes(operation.phase), canReview: false };
  }
  function operations(accountId) {
    const current = currentOwner(accountId);
    const journal = store();
    return (journal?.list(accountId) || []).filter(operation => operation.owner === current.binding).map(operation => {
      // A transient storage failure may have prevented saving the timer's
      // paused outcome. Once storage is readable again, expose cancellation
      // of that orphaned intent; never reconstruct or rearm its timer.
      if (operation.phase === "pending" && !pending.has(operation.id)) operation = journal.update(operation.id, "pending", { phase: "paused", reason: "timer_not_active", updatedAt: now() });
      return publicOperation(operation);
    });
  }
  function requireOwner(ticket, client) {
    client.check();
    if (client.binding !== ticket.binding || client.revision !== ticket.revision || client.generation !== ticket.generation) throw conflict();
  }
  const folderAt = (model, id) => model.folders.find(folder => folder.id === id) || null;
  function canCreate(client, model, parent) {
    const delimiter = parent ? parent.delimiter : model.delimiter;
    return !!delimiter && (!parent || !parent.readOnly && !flag(parent, "\\Noinferiors")
      && (client.backend !== "gmail" || parent.type === "user" && parent.editable === true));
  }
  function policy(client, folder, operationId, savedOperations) {
    if (protectedFolder(folder)) return { enabled: false, reason: "System, virtual, read-only and non-selectable folders are protected." };
    if (client.backend !== "gmail") return { enabled: false, reason: client.gmailImap
      ? "Gmail IMAP uses labels. Recoverable label deletion requires a Gmail API mailbox; no generic folder delete is available."
      : "Folder deletion is unavailable until moving the folder and its mail to Trash and restoring the same folder can be verified for this server. No irreversible delete is available." };
    if (folder.type !== "user" || folder.editable !== true) return { enabled: false, reason: "Only a verified Gmail user label can be deleted." };
    if ((savedOperations || store()?.list(client.accountId) || []).some(operation => operation.id !== operationId && operation.sourceId === folder.id && ACTIVE.has(operation.phase))) {
      return { enabled: false, reason: "This label already has a pending or uncertain folder action. Review its saved status before another deletion." };
    }
    if (client.blocked?.(folder.id)) return { enabled: false, reason: "Finish pending mail writes and draft edits before deleting a label." };
    return { enabled: true, mode: "label-grace", reason: "Only this label is removed; messages and child labels stay. Undo cancels during the 30-second grace period, before any provider write. After removal, original label memberships cannot be restored automatically." };
  }
  function mint(client, data) {
    for (const [id, review] of reviews) if (review.expires <= monotonic()) reviews.delete(id);
    if (reviews.size >= 128) throw unsupported("Close earlier folder reviews before opening another.");
    const id = crypto.randomUUID();
    const ticket = { ...data, id, accountId: client.accountId, binding: client.binding, revision: client.revision,
      generation: client.generation, expires: monotonic() + REVIEW_MS };
    reviews.set(id, ticket);
    return { reviewId: id, accountId: ticket.accountId, mailbox: client.label, intent: ticket.intent, folderId: ticket.source?.id || "",
      name: ticket.source?.name || "", parentName: ticket.parent?.name || "Top level", destination: "", disclosure: ticket.disclosure || "",
      graceMs: ticket.mode === "label-grace" ? GRACE_MS : 0 };
  }
  function take(params, intent) {
    const ticket = reviews.get(params.reviewId); reviews.delete(params.reviewId);
    if (!ticket || ticket.intent !== intent || ticket.accountId !== params.accountId || ticket.expires <= monotonic()) throw conflict("This folder review expired or changed. Open a fresh review.");
    return ticket;
  }
  async function list(accountId) {
    return withAccount(accountId, async client => {
      const model = listing(await client.list()); client.check();
      let savedOperations = [], activeOperations = [], recoveryAvailable = true;
      try { activeOperations = store()?.list(accountId) || []; savedOperations = operations(accountId); } catch { recoveryAvailable = false; }
      const recoveryError = recoveryAvailable ? "" : "Folder recovery storage is unavailable. Folder writes and deletion Undo are disabled; browsing remains available. Keep its files for recovery.";
      return { accountId, backend: client.backend, delimiter: model.delimiter, recoveryAvailable, recoveryError,
        canCreate: recoveryAvailable && canCreate(client, model, null), folders: model.folders.map(folder => ({ ...folder,
          deletion: recoveryAvailable ? policy(client, folder, null, activeOperations) : { enabled: false, reason: recoveryError },
          canCreate: recoveryAvailable && canCreate(client, model, folder) })), operations: savedOperations };
    });
  }
  async function review(params) {
    if (!["create", "delete"].includes(params.intent)) throw unsupported("Choose a supported folder action.");
    return withAccount(params.accountId, async client => {
      const model = listing(await client.list()); client.check();
      store()?.list(); // Fail closed before reviewing any write if recovery is corrupt.
      if (params.intent === "create") {
        const parent = params.folderId ? folderAt(model, params.folderId) : null;
        if (params.folderId && !parent || !canCreate(client, model, parent)) throw unsupported("This folder or namespace cannot accept a new child.");
        return mint(client, { intent: "create", parent, delimiter: parent ? parent.delimiter : model.delimiter });
      }
      const source = folderAt(model, params.folderId);
      if (!source || params.expectedName != null && source.name !== params.expectedName) throw conflict();
      const permission = policy(client, source);
      if (!permission.enabled) throw unsupported(permission.reason);
      return mint(client, { intent: "delete", source, sourceFingerprint: fingerprint(source), mode: permission.mode, disclosure: permission.reason });
    });
  }
  function record(ticket, phase, intent = ticket.intent) {
    return { id: "folder-action:" + crypto.randomUUID(), accountId: ticket.accountId, owner: ticket.binding,
      sourceId: ticket.source?.id || ticket.target, source: ticket.source || { id: ticket.target, name: ticket.name },
      intent, mode: ticket.mode || "create", phase, createdAt: now(), updatedAt: now(), reason: "" };
  }
  async function validateDelete(client, ticket, operationId) {
    requireOwner(ticket, client);
    const model = listing(await client.list()); requireOwner(ticket, client);
    const source = folderAt(model, ticket.source.id);
    if (!source || fingerprint(source) !== ticket.sourceFingerprint) throw conflict();
    const permission = policy(client, source, operationId);
    if (!permission.enabled || permission.mode !== ticket.mode) throw unsupported(permission.reason);
  }
  // Failed outcome storage can never authorize a second provider attempt.
  // An uncommitted 'running' row becomes uncertain on the next startup.
  function settleFailure(operation) {
    try {
      const current = store()?.read(operation.id);
      if (current?.phase === "pending") store().update(operation.id, "pending", { phase: "paused", reason: "connection_or_folder_changed", updatedAt: now() });
      if (current?.phase === "running") store().update(operation.id, "running", { phase: "uncertain", reason: "unconfirmed", updatedAt: now() });
    } catch { /* Preserve durable intent; never replay an uncertain write. */ }
  }
  function storeSafePhase(id) { try { return store()?.read(id)?.phase; } catch { return "unavailable"; } }
  function arm(operation, ticket) {
    const runtime = { deadline: monotonic() + GRACE_MS, timer: null, paused: false };
    const run = async () => {
      try {
        if (runtime.paused || pending.get(operation.id) !== runtime || store()?.read(operation.id)?.phase !== "pending") return;
        const delay = runtime.deadline - monotonic();
        if (delay > 0) { runtime.timer = setTimer(run, delay); runtime.timer?.unref?.(); return; }
        await gate.run(() => withAccount(operation.accountId, async client => {
          await validateDelete(client, ticket, operation.id);
          if (runtime.paused || pending.get(operation.id) !== runtime) throw conflict();
          // Undo races with this compare-and-set, including while LIST awaits.
          store().update(operation.id, "pending", { phase: "running", updatedAt: now() });
          requireOwner(ticket, client);
          await client.deleteLabel(ticket.source.id, ticket.source.name); client.check();
          store().update(operation.id, "running", { phase: "deleted", updatedAt: now() });
          await client.refreshCache(); client.check();
        }, ticket));
      } catch { settleFailure(operation); }
      finally {
        if (monotonic() >= runtime.deadline || runtime.paused || storeSafePhase(operation.id) !== "pending") pending.delete(operation.id);
        publish(operation.accountId);
      }
    };
    pending.set(operation.id, runtime);
    try { runtime.timer = setTimer(run, GRACE_MS); runtime.timer?.unref?.(); }
    catch (error) { runtime.paused = true; pending.delete(operation.id); settleFailure(operation); throw error; }
  }
  async function remove(params) {
    const ticket = take(params, "delete");
    if (params.confirmation !== "confirm") throw unsupported("Type confirm exactly before deleting this folder.");
    return gate.run(() => withAccount(params.accountId, async client => {
      await validateDelete(client, ticket);
      const operation = record(ticket, "pending"); store(true).insert(operation);
      try { requireOwner(ticket, client); arm(operation, ticket); }
      catch (error) { settleFailure(operation); throw error; }
      publish(operation.accountId); return publicOperation(operation);
    }, ticket));
  }
  function undo(params) {
    const operation = ownedOperation(params.accountId, params.operationId);
    if (operation.mode !== "label-grace" || !["pending", "paused"].includes(operation.phase)) throw conflict("The cancellation window ended. No automatic restoration or provider retry is available.");
    const receipt = store().update(operation.id, ["pending", "paused"], { phase: "cancelled", updatedAt: now() });
    const runtime = pending.get(operation.id);
    if (runtime) { runtime.paused = true; clearTimer(runtime.timer); }
    pending.delete(operation.id); publish(operation.accountId);
    return publicOperation(receipt);
  }
  async function create(params) {
    const ticket = take(params, "create");
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name) || !ticket.delimiter || name.includes(ticket.delimiter) || name.toUpperCase() === "INBOX") throw unsupported("Enter one valid folder name without its hierarchy delimiter.");
    return gate.run(() => withAccount(params.accountId, async client => {
      requireOwner(ticket, client); const model = listing(await client.list()); requireOwner(ticket, client);
      const parent = ticket.parent ? folderAt(model, ticket.parent.id) : null;
      if (ticket.parent && (!parent || fingerprint(parent) !== fingerprint(ticket.parent)) || !canCreate(client, model, parent)
          || ticket.delimiter !== (parent ? parent.delimiter : model.delimiter)) throw conflict();
      const target = parent ? (client.backend === "gmail" ? parent.name : parent.id) + ticket.delimiter + name : name;
      if (target.length > 4096 || model.folders.some(folder => String(client.backend === "gmail" ? folder.name : folder.id).toLowerCase() === target.toLowerCase())) throw conflict("A folder with that name already exists. Nothing was overwritten.");
      requireOwner(ticket, client);
      const operation = record({ ...ticket, target, name }, "running", "create"); store(true).insert(operation);
      try {
        requireOwner(ticket, client); await client.create(target); client.check();
        const after = listing(await client.list()); client.check();
        const saved = after.folders.find(folder => (client.backend === "gmail" ? folder.name : folder.id) === target);
        if (!saved) throw conflict();
        const receipt = store().update(operation.id, "running", { phase: "created", updatedAt: now() });
        let cacheWarning = "";
        try { await client.refreshCache(); client.check(); }
        catch { cacheWarning = "The server confirmed folder creation. Refresh to update the sidebar cache; do not create it again."; }
        publish(operation.accountId); return { ...publicOperation(receipt), folderId: saved.id, cacheWarning };
      } catch (error) { settleFailure(operation); publish(operation.accountId); throw Object.assign(new Error("Folder creation could not be confirmed. Its recovery record was kept; refresh and inspect the server before creating it again."), { code: "folder_uncertain", operationId: operation.id }); }
    }, ticket));
  }
  async function answer(params) {
    if (!params || typeof params.accountId !== "string" || !params.accountId || params.accountId.length > 200) throw conflict("Choose a connected mailbox.");
    if (params.action === "list") return list(params.accountId);
    if (params.action === "operations") return { accountId: params.accountId, operations: operations(params.accountId) };
    if (params.action === "review") return review(params);
    if (params.action === "delete") return remove(params);
    if (params.action === "create") return create(params);
    if (params.action === "undo") return undo(params);
    if (params.action === "cancelReview") { const ticket = reviews.get(params.reviewId); if (ticket?.accountId === params.accountId) reviews.delete(params.reviewId); return true; }
    throw unsupported("That folder-management action is not available.");
  }
  function pause() {
    for (const [id, runtime] of pending) {
      runtime.paused = true; clearTimer(runtime.timer);
      try { const operation = store()?.read(id); if (operation?.phase === "pending") store().update(id, "pending", { phase: "paused", reason: "closed", updatedAt: now() }); } catch { /* Startup will pause any remaining durable pending intent. */ }
    }
    pending.clear(); reviews.clear();
  }
  return { answer, pause, operations, assertStorage() { store()?.list(); } };
}

module.exports = { createManager, GRACE_MS, fingerprint, protectedFolder };
