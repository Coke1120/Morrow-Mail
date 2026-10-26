"use strict";

const crypto = require("crypto");
const db = require("./db");
const remote = require("./remote");
const virtuals = require("./virtual-folders");
const { isGmail } = require("./gmail-policy");

// A thrown command that already entered STORE or MOVE may have landed.
// Revert only when issued is still false. Flag sync preserves pending/unknown writes.
const HINTS = {
  star: "The star stays on this device. Click the star again to retry.",
  read: "The read state stays on this device. Set it again to retry.",
  remove: "The message stays where you moved it. Undo is unavailable until the server confirms the move.",
  undo: "Restore outcome is unknown. Refresh before retrying.",
};

let hooks = {
  exclusive(accountId, fn) { return fn(); },
  secretFor() { return Promise.reject(new Error("Mail actions are not installed.")); },
  emitAccounts() {},
};

const drains = new Map();
const scheduled = new Set();
const batchStopped = new Set();
const settledLog = [];
let settledCursor = 0;
let clock = 0;

function install(next) {
  hooks = next;
}

function resetForTests() {
  batchStopped.clear();
  scheduled.clear();
  settledLog.length = 0;
  settledCursor = 0;
}

function fail(code, message) {
  return { success: false, error: { code, message, status: 0, retryable: false } };
}

function ok(data) {
  return { success: true, data };
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function parse(json, fallback) {
  try { return JSON.parse(json); } catch { return fallback; }
}

function priorOf(row) {
  return {
    folderPath: row.folder_path,
    uid: Number(row.uid) || 0,
    uidValidity: Number(row.uid_validity) || 0,
    unread: row.unread ? 1 : 0,
    starred: row.starred ? 1 : 0,
    isDraft: row.is_draft ? 1 : 0,
  };
}

function sourceOf(row) {
  return { folderPath: row.folder_path, uid: Number(row.uid) || 0, uidValidity: Number(row.uid_validity) || 0, confirmed: true };
}

function displayOf(row) {
  if (!row) return null;
  return {
    isStarred: row.starred === 1,
    unread: row.unread === 1,
    isRead: row.unread !== 1,
    folderId: row.folder_path,
  };
}

function outcomeOf(action, status, error, opId) {
  const row = db.messageById(action.message_id);
  const intent = parse(action.intent_json, {});
  return {
    id: action.message_id,
    actionId: action.id,
    generation: action.generation,
    status,
    kind: parse(action.intent_json, {}).kind || "",
    error: error || undefined,
    opId: opId || undefined,
    retryOpId: intent.kind === "undo" && (status === "failed" || status === "not_attempted")
      && db.readOp(intent.opId)?.moves?.length ? intent.opId : undefined,
    projection: displayOf(row),
  };
}

function matches(prior, intent) {
  if (intent.kind === "star") return prior.starred === intent.starred;
  if (intent.kind === "read") return prior.unread === intent.unread;
  if (intent.kind === "remove" && !intent.permanent) return prior.folderPath === intent.destPath;
  return false;
}

function project(messageId, intent, priorRow) {
  if (intent.kind === "star") db.updateMessage(messageId, { starred: intent.starred });
  else if (intent.kind === "read") db.updateMessage(messageId, { unread: intent.unread });
  else if (intent.kind === "remove" && intent.permanent) db.deleteMessage(messageId);
  else if (intent.kind === "remove") {
    db.updateMessage(messageId, {
      folder_path: intent.destPath,
      is_draft: intent.destWell === "drafts" ? 1 : 0,
    });
  }
  return priorRow;
}

function writePrior(action) {
  const prior = parse(action.prior_json, null);
  const intent = parse(action.intent_json, {});
  if (intent.kind === "remove" && intent.permanent) {
    const saved = parse(action.prior_row_json, null);
    if (saved && !db.messageById(action.message_id)) restoreRow(saved);
    return;
  }
  if (!prior || intent.kind === "undo") return;
  if (intent.kind === "read" || intent.kind === "star") {
    const key = intent.kind === "read" ? "unread" : "starred";
    db.updateMessage(action.message_id, { [key]: prior[key] });
    return;
  }
  db.updateMessage(action.message_id, {
    folder_path: prior.folderPath,
    uid: prior.uid,
    uid_validity: prior.uidValidity,
    is_draft: prior.isDraft,
  });
}

function restoreRow(row) {
  db.insertMessage({
    id: row.id,
    accountId: row.account_id,
    folderPath: row.folder_path,
    uid: row.uid,
    uidValidity: row.uid_validity,
    threadId: row.thread_id,
    rfcMessageId: row.rfc_message_id,
    inReplyTo: row.in_reply_to,
    subject: row.subject,
    snippet: row.snippet,
    from: row.from_addr,
    to: parse(row.to_json, []),
    cc: parse(row.cc_json, []),
    bcc: parse(row.bcc_json, []),
    date: row.date_iso,
    listSortTs: row.list_sort_ts,
    unread: row.unread === 1,
    starred: row.starred === 1,
    isDraft: row.is_draft === 1,
    hasAttachments: row.has_attachments === 1,
    htmlBody: row.html_body,
    textBody: row.text_body,
    attachments: parse(row.attachments_json, []),
    bodyComplete: row.body_complete === 1,
    draftPending: row.draft_pending === 1,
    recipientHeaders: parse(row.recipient_headers_json, {}),
  });
}

function rememberMove(action, dest) {
  const prior = parse(action.prior_json, {});
  const source = parse(action.source_json, {});
  const id = newId("op");
  db.saveOp(id, {
    moves: [{
      id: action.message_id,
      accountId: action.account_id,
      folderPath: source.folderPath,
      uid: source.uid,
      uidValidity: source.uidValidity,
      isDraft: prior.isDraft ? 1 : 0,
      destination: { folderPath: dest.folderPath, uid: dest.uid, uidValidity: dest.uidValidity },
    }],
  });
  return id;
}

function newerPending(action) {
  const kind = parse(action.intent_json, {}).kind;
  if (kind !== "read" && kind !== "star") return false;
  return db.mailActionsForMessage(action.message_id).some((row) =>
    row.id !== action.id && row.generation > action.generation && parse(row.intent_json, {}).kind === kind
      && (row.phase === "accepted" || row.phase === "publishing"));
}

function assertIdentityReady(messageId) {
  const pending = db.mailActionsForMessage(messageId).find((row) => {
    const kind = parse(row.intent_json, {}).kind;
    return (kind === "remove" || kind === "undo") &&
      (row.phase === "accepted" || row.phase === "publishing" || row.receipt === "unknown" || row.receipt === "superseded");
  });
  if (!pending) return;
  const error = new Error(pending.phase === "closed"
    ? "The previous move or delete was not confirmed. Refresh the source and destination folders and select a confirmed server copy before acting again."
    : "This message is moving or being deleted. Wait for server confirmation, then try again.");
  error.code = "message_moving";
  error.operationIssued = false;
  throw error;
}

function applyClose(action, receipt, error, dest, skipWrite) {
  const intent = parse(action.intent_json, {});
  // A definitely unissued Undo can be retried; completed/uncertain Undo cannot.
  if (intent.kind === "undo" && (receipt === "completed" || receipt === "unknown")) db.saveOp(intent.opId, { moves: [] });
  let opId = null;
  if (!skipWrite && (receipt === "failed" || receipt === "not_attempted")) {
    if (intent.kind !== "undo") writePrior(action);
  } else if (!skipWrite && receipt === "completed" && intent.kind === "remove" && !intent.permanent && dest) {
    if (dest.uid) {
      const clash = db.messageByUid(action.account_id, dest.folderPath, dest.uid, dest.uidValidity);
      if (clash && clash.id !== action.message_id) db.deleteMessage(clash.id);
      db.updateMessage(action.message_id, {
        folder_path: dest.folderPath,
        uid: dest.uid,
        uid_validity: dest.uidValidity,
      });
    }
    opId = rememberMove(action, dest);
  } else if (!skipWrite && receipt === "completed" && intent.kind === "undo" && dest) {
    db.updateMessage(action.message_id, {
      folder_path: dest.folderPath,
      uid: dest.uid,
      uid_validity: dest.uidValidity,
      is_draft: dest.isDraft ? 1 : 0,
    });
  }
  db.updateMailAction(action.id, {
    phase: "closed",
    receipt,
    error: error || null,
    undo_op_id: opId,
  });
  const stored = db.mailActionById(action.id);
  return outcomeOf(stored, receipt, error, opId);
}

function emit(outcomes) {
  if (!outcomes.length) return;
  settledLog.push(...outcomes);
  const opIds = [...new Set(outcomes.flatMap((row) => row.retryOpId ? [row.retryOpId] : row.status === "completed" && row.opId ? [row.opId] : []))];
  hooks.emitAccounts();
  hooks.broadcast("mail:actionsSettled", { outcomes, opIds });
}

function schedule(accountId) {
  if (!accountId || scheduled.has(accountId)) return;
  scheduled.add(accountId);
  setTimeout(() => {
    scheduled.delete(accountId);
    const run = publishAccount(accountId);
    if (run && run.catch) run.catch(() => {});
  }, 0);
}

function publishAccount(accountId) {
  if (drains.has(accountId)) return drains.get(accountId);
  const run = hooks.exclusive(accountId, async () => {
    const produced = [];
    while (true) {
      const rows = db.acceptedMailActions(accountId);
      if (!rows.length) break;
      for (const row of rows) {
        produced.push(await publishOne(row));
      }
    }
    emit(produced.filter((row) => row && row.status !== "superseded"));
  });
  const tracked = run.catch(() => {});
  drains.set(accountId, tracked);
  tracked.finally(() => {
    if (drains.get(accountId) === tracked) drains.delete(accountId);
    try {
      if (db.acceptedMailActions(accountId).length) schedule(accountId);
    } catch { /* the mailbox file may already be closed */ }
  });
  return tracked;
}

async function publishOne(row) {
  if (batchStopped.has(row.batch_id)) return applyClose(row, "not_attempted", null, null);
  if (newerPending(row)) return applyClose(row, "superseded", null, null, true);
  db.updateMailAction(row.id, { phase: "publishing" });
  const fresh = db.mailActionById(row.id);
  const attempt = await runRemote(fresh);
  if (!db.mailActionById(fresh.id)) return null; // Account removal invalidated this result.
  if (newerPending(fresh)) return applyClose(fresh, "superseded", null, null, true);
  if (attempt.issued && !attempt.error) {
    return applyClose(fresh, "completed", null, attempt.value && attempt.value.dest);
  }
  if (!attempt.issued) {
    batchStopped.add(row.batch_id);
    return applyClose(fresh, "failed", attempt.error, null);
  }
  batchStopped.add(row.batch_id);
  const intent = parse(fresh.intent_json, {});
  const hint = HINTS[intent.kind] || HINTS.remove;
  const error = attempt.error ? `${attempt.error} ${hint}` : hint;
  return applyClose(fresh, "unknown", error, null);
}

async function runRemote(action) {
  const intent = parse(action.intent_json, {});
  const source = parse(action.source_json, {});
  const account = db.accountById(action.account_id);
  if (isGmail(account) && intent.kind === "remove" && intent.permanent) return { issued: false, error: "Permanent Gmail deletion is unavailable. Use Move to Trash; mail already in Trash stays there." };
  if (!source.uid) {
    if (intent.kind === "undo") {
      return { issued: true, value: { dest: { ...intent.restore, uid: intent.restore.uid || 0, uidValidity: intent.restore.uidValidity || 0 } } };
    }
    return { issued: true, value: { dest: intent.kind === "remove" ? { folderPath: intent.destPath, uid: 0, uidValidity: source.uidValidity } : null } };
  }
  if (!account) return { issued: false, error: "That account is no longer connected." };
  let password;
  try {
    password = await hooks.secretFor(account);
  } catch (error) {
    return { issued: false, error: remote.explain(error) };
  }
  let entered = false;
  try {
    const value = await remote.withClient(account, password, async (client) => {
      entered = true;
      if (intent.kind === "star") {
        await remote.changeFlags(client, source.folderPath, source.uid, intent.starred ? ["\\Flagged"] : [], intent.starred ? [] : ["\\Flagged"], source.uidValidity, action.message_id);
        return { dest: null };
      }
      if (intent.kind === "read") {
        await remote.changeFlags(client, source.folderPath, source.uid, intent.unread ? [] : ["\\Seen"], intent.unread ? ["\\Seen"] : [], source.uidValidity, action.message_id);
        return { dest: null };
      }
      if (intent.kind === "remove" && intent.permanent) {
        await remote.removeUid(client, source.folderPath, source.uid, source.uidValidity);
        return { dest: null };
      }
      const destination = intent.kind === "undo" ? intent.restore.folderPath : intent.destPath;
      const next = await remote.moveUid(client, source.folderPath, source.uid, destination, source.uidValidity, action.message_id);
      return {
        dest: {
          folderPath: destination,
          uid: next.uid,
          uidValidity: next.uidValidity,
          isDraft: intent.kind === "undo" ? intent.restore.isDraft : 0,
        },
      };
    });
    return { issued: true, value };
  } catch (error) {
    return { issued: entered && error?.operationIssued !== false, error: remote.explain(error) };
  }
}

function uncertain(messageId) {
  return db.mailActionsForMessage(messageId).some((row) => row.phase === "closed" && row.receipt === "unknown");
}

function closeLocal(action, receipt) {
  const outcome = applyClose(action, receipt, null, localDest(action));
  emit([outcome]);
  return outcome;
}

function localDest(action) {
  const intent = parse(action.intent_json, {});
  const source = parse(action.source_json, {});
  if (intent.kind === "remove" && !intent.permanent) {
    return { folderPath: intent.destPath, uid: 0, uidValidity: source.uidValidity || 0 };
  }
  if (intent.kind === "undo") return { ...intent.restore, uid: intent.restore.uid || 0, uidValidity: intent.restore.uidValidity || 0 };
  return null;
}

function insertAction(spec) {
  clock += 1;
  const row = {
    id: newId("act"),
    batchId: spec.batchId,
    messageId: spec.messageId,
    accountId: spec.accountId,
    generation: spec.generation,
    intentJson: JSON.stringify(spec.intent),
    priorJson: JSON.stringify(spec.prior),
    priorRowJson: spec.priorRow ? JSON.stringify(spec.priorRow) : null,
    sourceJson: JSON.stringify(spec.source),
    phase: "accepted",
    createdAt: clock,
  };
  db.insertMailAction(row);
  return db.mailActionById(row.id);
}

function acceptOne(command, batchId, stopped) {
  if (command.error) {
    return { outcome: { id: command.messageId || command.opId, status: command.error.stop ? "failed" : "failed", error: command.error.message, kind: command.kind || "" } };
  }
  if (stopped.batch) {
    return { outcome: { id: command.messageId, status: "not_attempted", kind: command.intent && command.intent.kind } };
  }
  const row = db.messageById(command.messageId);
  if (!row && command.intent.kind !== "undo") {
    stopped.batch = true;
    return { outcome: { id: command.messageId, status: "failed", error: "Message or account is no longer available.", kind: command.intent.kind } };
  }
  // folder_path is an optimistic display projection while a structural write
  // is unsettled. Do not accept another operation using that predicted UID pair.
  try { assertIdentityReady(command.messageId); }
  catch (error) {
    return { outcome: { id: command.messageId, status: "failed", kind: command.intent.kind, error: error.message,
      projection: displayOf(row), generation: db.maxActionGeneration(command.messageId) } };
  }
  const open = db.openMailAction(command.messageId);
  if (open && open.phase === "accepted") {
    const openIntent = parse(open.intent_json, {});
    if (openIntent.kind === command.intent.kind) {
      const prior = parse(open.prior_json, {});
      const generation = open.generation + 1;
      db.updateMailAction(open.id, { generation, intent_json: JSON.stringify(command.intent) });
      if (matches(prior, command.intent)) {
        writePrior(db.mailActionById(open.id));
        const outcome = closeLocal(db.mailActionById(open.id), "completed");
        return { outcome, terminal: true };
      }
      project(command.messageId, command.intent, row);
      return { pending: pendingOf(db.mailActionById(open.id)), accountId: row.account_id };
    }
  }
  const current = db.messageById(command.messageId);
  const prior = priorOf(current);
  if (matches(prior, command.intent) && !uncertain(command.messageId) && !command.intent.permanent) {
    const action = insertAction({
      batchId, messageId: command.messageId, accountId: current.account_id,
      generation: db.maxActionGeneration(command.messageId) + 1,
      intent: command.intent, prior, source: sourceOf(current),
    });
    const outcome = closeLocal(action, "completed");
    return { outcome, terminal: true };
  }
  const source = command.source || sourceOf(current);
  const action = insertAction({
    batchId,
    messageId: command.messageId,
    accountId: current.account_id,
    generation: db.maxActionGeneration(command.messageId) + 1,
    intent: command.intent,
    prior,
    priorRow: command.intent.permanent ? current : null,
    source,
  });
  if (command.intent.kind !== "undo") project(command.messageId, command.intent, current);
  if (!source.uid || !db.accountById(current.account_id)) {
    const outcome = closeLocal(action, "completed");
    return { outcome, terminal: true };
  }
  return { pending: pendingOf(action), accountId: current.account_id };
}

function pendingOf(action) {
  const row = db.messageById(action.message_id);
  return {
    id: action.message_id,
    actionId: action.id,
    generation: action.generation,
    projection: displayOf(row),
  };
}

function acceptAll(commands) {
  const batchId = newId("batch");
  const pending = [];
  const outcomes = [];
  const accounts = new Set();
  const stopped = { batch: false };
  for (const command of commands) {
    const result = acceptOne(command, batchId, stopped);
    if (result.outcome) outcomes.push(result.outcome);
    if (result.pending) pending.push(result.pending);
    if (result.accountId) accounts.add(result.accountId);
    if (result.outcome && result.outcome.status === "failed" && command.stopBatch) stopped.batch = true;
  }
  for (const accountId of accounts) schedule(accountId);
  const opIds = outcomes.filter((row) => row.status === "completed" && row.opId).map((row) => row.opId);
  if (pending.length || outcomes.some((row) => row.status === "completed")) hooks.emitAccounts();
  return { pending, outcomes, opIds };
}

function idsFrom(params, channel) {
  const ids = [];
  if (params && params.threadId && (channel === "mail:threadArchive" || channel === "mail:threadTrash" || channel === "mail:threadMove")) {
    const rows = db.messagesByThread(params.accountId, params.threadId);
    const source = params.sourceFolderId || params.folderId;
    const list = channel === "mail:threadMove" ? rows.filter((row) => !source || row.folder_path === source) : rows;
    ids.push(...list.map((row) => row.id));
  }
  if (params && Array.isArray(params.items)) {
    for (const item of params.items) ids.push(item.emailId || item.id);
  }
  if (params && params.emailId) ids.push(params.emailId);
  return [...new Set(ids.filter(Boolean))];
}

function removeCommand(messageId, well, targetPath, permanent) {
  const row = db.messageById(messageId);
  if (!row || !db.accountById(row.account_id)) {
    return { messageId, error: { message: "Message or account is no longer available.", stop: true }, intent: { kind: "remove" }, stopBatch: true };
  }
  if (permanent && isGmail(db.accountById(row.account_id))) {
    permanent = false;
    well = "deleteditems";
  }
  if (permanent) {
    const source = db.folderByPath(row.account_id, row.folder_path);
    if (!source || !["deleteditems", "trash"].includes(source.well_known)) {
      return { messageId, error: { message: "This message is no longer in Trash. Refresh before deleting permanently." }, intent: { kind: "remove" }, stopBatch: true };
    }
    return { messageId, accountId: row.account_id, intent: { kind: "remove", permanent: true, destPath: row.folder_path }, stopBatch: true };
  }
  const folder = targetPath ? db.folderByPath(row.account_id, targetPath) : db.folderByWellKnown(row.account_id, well)
    || (well === "archive" && isGmail(db.accountById(row.account_id)) ? db.folderByWellKnown(row.account_id, "all") : null);
  if (!folder) {
    return { messageId, error: { message: "That folder is not on this account." }, intent: { kind: "remove" }, stopBatch: true };
  }
  return {
    messageId,
    accountId: row.account_id,
    intent: { kind: "remove", permanent: false, destPath: folder.path, destWell: folder.well_known, well },
    stopBatch: true,
  };
}

function undoCommands(opIds) {
  const commands = [];
  for (const opId of opIds) {
    const saved = db.readOp(opId);
    if (!saved || !saved.moves || !saved.moves.length) {
      commands.push({ opId, error: { message: "This Undo is no longer available." }, intent: { kind: "undo" } });
      continue;
    }
    for (const snap of saved.moves) {
      const row = db.messageById(snap.id);
      const dest = snap.destination;
      if (!row || !dest || row.account_id !== snap.accountId || row.folder_path !== dest.folderPath
          || row.uid !== dest.uid || row.uid_validity !== dest.uidValidity) {
        commands.push({
          messageId: snap.id,
          error: { message: "Message changed since this operation. Refresh before acting again." },
          intent: { kind: "undo" },
        });
        continue;
      }
      commands.push({
        messageId: row.id,
        accountId: row.account_id,
        source: { folderPath: dest.folderPath, uid: dest.uid, uidValidity: dest.uidValidity, confirmed: true },
        intent: {
          kind: "undo",
          opId,
          restore: { folderPath: snap.folderPath, uid: snap.uid, uidValidity: snap.uidValidity, isDraft: snap.isDraft ? 1 : 0 },
        },
      });
    }
  }
  return commands;
}

function handle(channel, params) {
  const single = !channel.endsWith("Batch") && !channel.startsWith("mail:thread");
  if (channel === "mail:markRead" || channel === "mail:markReadBatch") {
    if (channel === "mail:markRead" && typeof (params && params.isRead) !== "boolean") return ok({ pending: [], outcomes: [], opIds: [] });
    const isRead = channel === "mail:markRead" ? params.isRead : params && params.isRead !== false;
    const ids = channel === "mail:markRead" ? [params && params.emailId] : idsFrom(params, channel);
    if (channel === "mail:markRead" && !db.messageById(params && params.emailId)) {
      return fail("email-gone", "That message is no longer in the mailbox.");
    }
    const commands = ids.map((messageId) => ({
      messageId,
      single,
      intent: { kind: "read", unread: isRead ? 0 : 1 },
      stopBatch: true,
    }));
    const data = acceptAll(commands);
    return ok(data);
  }
  if (channel === "mail:toggleStar" || channel === "mail:toggleStarBatch") {
    if (channel === "mail:toggleStar") {
      if (!db.messageById(params && params.emailId)) return fail("email-gone", "That message is no longer in the mailbox.");
      if (typeof (params && params.isStarred) !== "boolean") return fail("flags", "Star needs a true or false value.");
    }
    const starred = channel === "mail:toggleStar" ? params.isStarred : !!(params && params.isStarred);
    const ids = channel === "mail:toggleStar" ? [params.emailId] : idsFrom(params, channel);
    const data = acceptAll(ids.map((messageId) => ({
      messageId,
      single,
      intent: { kind: "star", starred: starred ? 1 : 0 },
      stopBatch: true,
    })));
    if (channel === "mail:toggleStar") data.isStarred = !!starred;
    return ok(data);
  }
  if (channel === "mail:undoRemoval") {
    const data = acceptAll(undoCommands((params && params.opIds) || []));
    return ok(data);
  }
  const removal = channel === "mail:archive" || channel === "mail:threadArchive" || channel === "mail:delete"
    || channel === "mail:threadTrash" || channel === "mail:markSpam" || channel === "mail:markNotSpam"
    || channel === "mail:archiveBatch" || channel === "mail:deleteBatch"
    || channel === "mail:moveToFolder" || channel === "mail:threadMove" || channel === "mail:moveToFolderBatch";
  if (!removal) return null;
  if (channel === "mail:moveToFolder" || channel === "mail:threadMove" || channel === "mail:moveToFolderBatch") {
    const target = params && (params.targetFolderId || params.destination);
    const blocked = virtuals.get(target);
    if (blocked) return fail("move", blocked.filterCopy);
    if (!target) return fail("move", "Choose a folder.");
  }
  const ids = idsFrom(params, channel);
  if (!ids.length) return ok({ pending: [], outcomes: [], opIds: [] });
  const permanent = channel === "mail:deleteBatch"
    && (params.folderWellKnownName === "deleteditems" || params.folderWellKnownName === "trash");
  let well = null;
  let targetPath = null;
  if (channel === "mail:moveToFolder" || channel === "mail:threadMove" || channel === "mail:moveToFolderBatch") {
    targetPath = params.targetFolderId || params.destination;
  } else if (!permanent) {
    well = "archive";
    if (channel === "mail:delete" || channel === "mail:threadTrash" || channel === "mail:deleteBatch") well = "deleteditems";
    if (channel === "mail:markSpam") well = "junkemail";
    if (channel === "mail:markNotSpam") well = "inbox";
  }
  const data = acceptAll(ids.map((messageId) => removeCommand(messageId, well, targetPath, permanent)));
  return ok(data);
}

function resume() {
  resetForTests();
  const unknown = [];
  for (const row of db.publishingMailActions()) {
    const intent = parse(row.intent_json, {});
    const hint = HINTS[intent.kind] || HINTS.remove;
    unknown.push(applyClose(row, "unknown", `The mailbox did not confirm this change. ${hint}`, null));
  }
  // Older versions could persist a dependent action with a predicted folder/UID
  // pair. Such queued identities cannot be replayed safely after an upgrade.
  for (const accountId of db.acceptedAccountIds()) {
    for (const row of db.acceptedMailActions(accountId)) {
      if (parse(row.source_json, {}).confirmed === true) continue;
      unknown.push(applyClose(row, "unknown", "This saved operation has no confirmed server identity. Refresh the folders and select a confirmed server copy before retrying.", null));
    }
  }
  if (unknown.length) emit(unknown);
  for (const accountId of db.acceptedAccountIds()) schedule(accountId);
}

async function settleAccount(accountId) {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const drain = drains.get(accountId);
    if (!drain && !scheduled.has(accountId)) break;
    if (drain) await drain;
  }
  return takeSettled();
}

async function settleActions() {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = [...drains.values()];
    if (!pending.length && !scheduled.size) break;
    await Promise.all(pending);
  }
  return takeSettled();
}

function takeSettled() {
  const outcomes = settledLog.slice(settledCursor);
  settledCursor = settledLog.length;
  return {
    outcomes,
    opIds: [...new Set(outcomes.flatMap((row) => row.retryOpId ? [row.retryOpId] : row.status === "completed" && row.opId ? [row.opId] : []))],
  };
}

function generationOf(messageId) {
  return db.maxActionGeneration(messageId);
}

module.exports = {
  install,
  handle,
  resume,
  settleActions,
  settleAccount,
  generationOf,
  resetForTests,
  assertIdentityReady,
};
