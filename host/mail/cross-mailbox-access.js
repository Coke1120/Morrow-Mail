"use strict";

const fs = require("node:fs");
const { digest } = require("./copy-recovery");
const messageBytes = require("./copy-message");
const publicOwner = require("../../shared/mail-context-owner");
const { ACCOUNT_ID: LOCAL_ID } = require("./local-folders");
const { imapListing, gmailListing } = require("./folder-adapter");
const { persistentSelection } = require("./copy-imap-selection");
const { createSource: createGmailMoveSource } = require("./gmail-source-move");
const conflict = () => Object.assign(new Error("The reviewed message, folder or mailbox connection changed. Review Copy again; no source was removed."), { code: "copy_conflict", operationIssued: false });
const unsupported = reason => Object.assign(new Error(reason), { code: "copy_unsupported", operationIssued: false });
const positive = value => (typeof value === "number" || typeof value === "bigint" || typeof value === "string" && /^[1-9]\d{0,9}$/.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 0xffffffff;
const sourceFields = ["id", "account_id", "folder_path", "uid", "uid_validity", "gmail_id", "rfc_message_id", "draft_pending", "is_draft", "unread", "starred", "date_iso", "date_source"];
const same = (left, right, fields) => !!left && !!right && fields.every(key => left[key] === right[key]);
const localIdentity = value => JSON.stringify([value.id, value.folderId, value.unread, value.isStarred, value.date, value.dateSource, value.attachments]);

function folderIdentity(model, folder) {
  const pick = value => value && [value.id, value.name, value.parentId, value.delimiter, [...(value.flags || [])].map(String).sort(),
    value.specialUse, value.wellKnown, value.type, value.selectable, value.readOnly];
  const parents = [], visited = new Set([folder.id]); let next = folder.parentId;
  while (next) {
    if (parents.length >= 20 || visited.has(next)) throw conflict();
    visited.add(next);
    const parent = model.folders.find(value => value.id === next);
    if (!parent) throw conflict();
    parents.push(pick(parent)); next = parent.parentId;
  }
  return digest(JSON.stringify([pick(folder), parents]));
}
function permission(folder, backend) {
  if (!folder.selectable) return "This is a folder container, not a selectable destination.";
  if (folder.readOnly && !(backend === "gmail" && folder.id === "INBOX")) return "This destination is read-only or protected by the provider.";
  const well = String(folder.wellKnown || "").toLowerCase();
  if (["drafts", "deleteditems", "trash", "junkemail", "spam", "starred", "unread", "all", "important"].includes(well)) return "Choose an ordinary destination folder instead of Drafts, Trash, Junk or a virtual view.";
  if (backend === "gmail" && folder.type !== "user" && folder.id !== "INBOX") return "Choose a Gmail user label or Inbox. Other system labels are unavailable for imported Copy.";
  return "";
}
const folderGeneration = folder => folder && JSON.stringify([folder.path, folder.provider_id, folder.uid_validity, folder.well_known]);

function createAccess({ db, bindAccount, assertAccountCurrent, owner, publicAccount, secretFor, withMailClient, exclusive, localArchive, identityReady, googleClient = () => null } = {}) {
  function owned(accountId) {
    const current = owner(accountId), account = db.accountById(accountId);
    if (!current || !account) return null;
    const client = account.profile === "gmail" && account.auth_kind === "oauth2" ? googleClient() : null;
    return { ...current, binding: digest(JSON.stringify([current.binding, client])) };
  }
  function accountSnapshot(accountId, hint) {
    const account = bindAccount(db.accountById(accountId));
    const current = owned(accountId);
    if (!current || !hint || hint.accountId !== accountId || hint.bodyEpoch !== publicAccount(account).bodyEpoch
      || hint.connection !== publicOwner.connection(publicAccount(account))) throw conflict();
    return { accountId, account, ...current, pinned: current.revision };
  }
  function checkAccount(snapshot, allowOwnRevision = false) {
    assertAccountCurrent(snapshot.account);
    const current = owned(snapshot.accountId);
    if (!current || current.binding !== snapshot.binding || current.generation !== snapshot.generation
      || !allowOwnRevision && current.revision !== snapshot.pinned) throw conflict();
    return current;
  }
  function localBinding(store) {
    const stat = fs.statSync(store.file);
    if (!stat.isFile() || !Number.isFinite(stat.birthtimeMs)) throw conflict();
    return digest(JSON.stringify([store.file, stat.dev, stat.ino, stat.birthtimeMs]));
  }
  function checkSource(source) {
    if (source.local) {
      const store = localArchive();
      if (localBinding(store) !== source.binding || localIdentity(store.message(source.id, false)) !== source.identity) throw conflict();
      return;
    }
    checkAccount(source.owner);
    const row = db.messageById(source.id);
    if (!same(row, source.row, sourceFields) || folderGeneration(db.folderByPath(source.accountId, row.folder_path)) !== source.folderGeneration) throw conflict();
    identityReady(source.id);
  }
  function check(ticket, source) {
    checkAccount(ticket.destination);
    if (source) checkSource(source);
    else for (const value of ticket.sources) checkSource(value);
  }
  function capture(params) {
    if (params.destinationAccountId === LOCAL_ID) throw unsupported("Use the existing Local Folders transfer for this destination.");
    const destination = accountSnapshot(params.destinationAccountId, params.destinationOwner);
    const hints = Array.isArray(params.contextOwners) ? params.contextOwners : [];
    const remoteItems = params.items.filter(item => item.accountId !== LOCAL_ID);
    if (hints.length !== remoteItems.length || new Set(hints.map(value => value?.emailId)).size !== hints.length) throw conflict();
    const sources = params.items.map(item => {
      if (item.accountId === params.destinationAccountId) throw unsupported("Copy to another mailbox requires a different receiving account. Use this mailbox's existing folder actions for its own messages.");
      if (item.accountId === LOCAL_ID) {
        const store = localArchive(), message = store.verify(item.emailId);
        if (message.accountId !== LOCAL_ID || message.isDraft) throw conflict();
        return { id: item.emailId, accountId: LOCAL_ID, local: true, label: "Local Folders", binding: localBinding(store),
          identity: localIdentity(message), folderId: message.folderId };
      }
      const hint = hints.find(value => value?.emailId === item.emailId);
      const snapshot = accountSnapshot(item.accountId, hint);
      const row = db.messageById(item.emailId);
      if (!row || row.account_id !== item.accountId || hint.folderId !== row.folder_path) throw conflict();
      if (row.is_draft || row.draft_pending || !positive(row.uid) || !positive(row.uid_validity)) throw unsupported("Choose fully synchronized saved messages with confirmed server identities. Drafts and unconfirmed copies cannot be transferred.");
      const folder = db.folderByPath(item.accountId, row.folder_path);
      if (!folder) throw conflict();
      identityReady(item.emailId);
      if (snapshot.account.mail_transport !== "gmail_api" && destination.account.mail_transport !== "gmail_api"
        && ["username", "imap_host", "imap_port", "imap_tls"].every(key => snapshot.account[key] === destination.account[key])) {
        throw unsupported("These accounts use the same server mailbox. Use its existing folder actions instead.");
      }
      return { id: row.id, accountId: row.account_id, owner: snapshot, row: { ...row }, folderGeneration: folderGeneration(folder),
        label: snapshot.account.email || snapshot.account.username || snapshot.accountId };
    });
    const ticket = { destination, sources };
    check(ticket); return ticket;
  }
  async function lock(ids, work, at = 0) {
    return at === ids.length ? work() : exclusive(ids[at], () => lock(ids, work, at + 1));
  }
  async function connect(snapshot, checkBoth, work) {
    checkBoth(); checkAccount(snapshot);
    const value = await secretFor(snapshot.account, { snapshot: true });
    let token;
    if (typeof value === "string") { checkAccount(snapshot); token = value; }
    else {
      const current = checkAccount(snapshot, true);
      if (!value || typeof value.token !== "string" || value.revision !== current.revision) throw conflict();
      snapshot.pinned = value.revision; token = value.token;
    }
    checkBoth();
    return withMailClient(snapshot.account, token, async transport => {
      checkBoth(); return work(transport);
    }, { check: checkBoth });
  }
  async function listing(transport, checked) {
    checked();
    const value = transport.gmail ? gmailListing(await transport.gmail.api.labels()) : imapListing(await transport.list());
    checked(); return value;
  }
  function capability(transport) {
    if (transport.gmail) return "";
    const capabilities = [...(transport.capabilities?.keys?.() || [])].map(value => String(value).toUpperCase());
    return capabilities.includes("UIDPLUS") || capabilities.includes("IMAP4REV2") ? "" : "This server does not advertise UIDPLUS or IMAP4rev2, so a verified APPEND destination identity is unavailable.";
  }
  const notices = backend => backend === "gmail" ? ["Gmail Copy imports mail; it never sends it. Gmail may classify or group it and add system labels.",
    "Gmail uses the original valid Date header for sorting; its receiving time may differ. Original headers, complete MIME, all attachments and read/star state must pass readback."]
    : ["Copy requires persistent UIDVALIDITY, APPENDUID and complete destination readback. Original internal date and read/star state must match.",
      "Provider labels, categories, replied/forwarded markers and other flags are not portable. Copy leaves the source unchanged."];
  async function destinations(ticket) {
    return lock([ticket.destination.accountId], () => connect(ticket.destination, () => check(ticket), async transport => {
      const model = await listing(transport, () => check(ticket));
      const backend = transport.gmail ? "gmail" : "imap", reason = capability(transport);
      return { accountId: ticket.destination.accountId, copyEnabled: !reason, copyReason: reason, notices: notices(backend),
        folders: model.folders.map(folder => { const disabled = reason || permission(folder, backend);
          return { id: folder.id, name: folder.name, path: folder.name || folder.id, enabled: !disabled, reason: disabled }; }) };
    }));
  }
  async function selected(transport, checked, id, expected) {
    const model = await listing(transport, checked), folder = model.folders.find(value => value.id === id);
    if (!folder) throw conflict();
    const backend = transport.gmail ? "gmail" : "imap", reason = capability(transport) || permission(folder, backend);
    if (reason) throw unsupported(reason);
    const fingerprint = folderIdentity(model, folder);
    let uidValidity = null, permanentFlags = null;
    if (!transport.gmail) {
      checked(); const mailbox = await persistentSelection(transport, () => transport.mailboxOpen(id, { readOnly: false }), checked); checked();
      const opened = transport.mailbox || mailbox;
      if (!opened || opened.readOnly !== false || !positive(opened.uidValidity) || opened.uidNotSticky) throw unsupported("This destination cannot prove writable persistent message identities.");
      uidValidity = Number(opened.uidValidity);
      permanentFlags = opened.permanentFlags instanceof Set ? [...opened.permanentFlags] : null;
    }
    const proof = digest(JSON.stringify([fingerprint, uidValidity]));
    if (expected && (expected.proof !== proof || expected.uidValidity !== uidValidity)) throw conflict();
    return { id, label: folder.name || id, backend, proof, uidValidity, permanentFlags, notices: notices(backend) };
  }
  async function review(ticket, id) {
    if (typeof id !== "string" || !id) throw unsupported("Choose a receiving folder or label.");
    return lock([ticket.destination.accountId], () => connect(ticket.destination, () => check(ticket), transport => selected(transport, () => check(ticket), id)));
  }
  async function imapSnapshot(transport, locator, checked) {
    checked();
    const held = await persistentSelection(transport, () => transport.getMailboxLock(locator.folderId, { readOnly: true }), checked);
    let content;
    try {
      checked();
      if (!positive(transport.mailbox?.uidValidity) || Number(transport.mailbox.uidValidity) !== locator.uidValidity) throw conflict();
      const rows = [];
      for await (const row of transport.fetch(String(locator.uid), { uid: true, size: true, flags: true, internalDate: true }, { uid: true })) {
        checked(); if (Number(row.uid) === locator.uid) rows.push(row);
      }
      if (rows.length !== 1 || !Number.isSafeInteger(rows[0].size) || rows[0].size <= 0 || rows[0].size > messageBytes.MAX_BYTES) throw unsupported("The server did not prove a complete message within the 32 MiB mailbox-copy limit.");
      const metadata = rows[0], date = metadata.internalDate instanceof Date ? metadata.internalDate.getTime() : NaN;
      if (!Number.isSafeInteger(date) || date < 0 || !(metadata.flags instanceof Set)) throw unsupported("The server did not confirm this message's original date and flags.");
      checked(); const download = await transport.download(String(locator.uid), undefined, { uid: true, maxBytes: messageBytes.MAX_BYTES + 1 }); checked();
      content = download?.content;
      if (!content) throw unsupported("The full original MIME could not be read. The source was retained.");
      const chunks = []; let size = 0;
      for await (const chunk of content) {
        checked(); size += chunk.length;
        if (size > metadata.size || size > messageBytes.MAX_BYTES) throw unsupported("The MIME download exceeded its confirmed size.");
        chunks.push(Buffer.from(chunk));
      }
      checked();
      if (size !== metadata.size || Number(transport.mailbox?.uidValidity) !== locator.uidValidity) throw unsupported("The MIME download was incomplete or its folder identity changed. The source was retained.");
      const flags = new Set([...metadata.flags].map(flag => String(flag).toLowerCase()));
      return { raw: Buffer.concat(chunks), date, unread: !flags.has("\\seen"), starred: flags.has("\\flagged") };
    } finally { content?.destroy?.(); held.release(); }
  }
  async function gmailSnapshot(transport, providerId, checked, validateParts) {
    checked(); const value = await transport.gmail.api.raw(providerId); checked(); transport.gmail.alive();
    if (value.id !== providerId || !Buffer.isBuffer(value.source) || !value.source.length || value.source.length > messageBytes.MAX_BYTES
      || !Array.isArray(value.labelIds) || !Number.isSafeInteger(Number(value.internalDate)) || Number(value.internalDate) < 0) throw unsupported("Gmail did not return a complete original message and its state.");
    if (validateParts) {
      checked(); const full = await transport.gmail.api.getMessage(providerId); checked();
      if (full.id !== providerId || !Array.isArray(full.labelIds)
        || JSON.stringify([...full.labelIds].sort()) !== JSON.stringify([...value.labelIds].sort())) throw conflict();
      await messageBytes.verifyGmailSource(value.source, full.payload, attachmentId => transport.gmail.api.attachment(providerId, attachmentId), checked); checked();
    }
    return { raw: value.source, date: Number(value.internalDate), unread: value.labelIds.includes("UNREAD"), starred: value.labelIds.includes("STARRED"), labelIds: value.labelIds, providerId };
  }
  async function withCopy(ticket, source, destination, work, authority = {}) {
    const ids = [...new Set([ticket.destination.accountId, ...(source.local ? [] : [source.accountId])])].sort();
    const checked = () => { authority.check?.(); check(ticket, source); };
    return lock(ids, async () => {
      checked();
      return connect(ticket.destination, checked, destinationTransport => {
        const useSource = source.local ? fn => fn(null) : fn => connect(source.owner, checked, fn);
        return useSource(async sourceTransport => {
          const live = await selected(destinationTransport, checked, destination.id, destination);
          let sourceProviderId;
          const sourceLocator = source.local ? { localId: source.id } : { folderId: source.row.folder_path, uid: Number(source.row.uid), uidValidity: Number(source.row.uid_validity) };
          const sourceBinding = source.local ? source.binding : source.owner.binding;
          const destinationBinding = ticket.destination.binding;
          const session = { backend: live.backend, sourceBackend: sourceTransport?.gmail && source.owner?.account.mail_transport === "gmail_api" ? "gmail" : "unsupported",
            sourceBinding, destinationBinding, folderProof: live.proof, check: checked,
            async readSource() {
              checked(); let snapshot;
              if (source.local) {
                const store = localArchive(), message = store.verify(source.id);
                snapshot = { raw: store.raw(source.id), unread: message.unread, starred: message.isStarred, date: Date.parse(message.date) };
              } else if (sourceTransport.gmail) {
                const mapped = await sourceTransport.gmail.resolve(source.row.folder_path, source.row.uid, source.row.uid_validity, source.id, { readOnly: true }); checked();
                sourceProviderId = mapped.provider_id;
                snapshot = await gmailSnapshot(sourceTransport, sourceProviderId, checked, true);
              } else snapshot = await imapSnapshot(sourceTransport, sourceLocator, checked);
              checked();
              if (!source.local && (snapshot.unread !== !!source.row.unread || snapshot.starred !== !!source.row.starred)) throw conflict();
              messageBytes.inspect(snapshot.raw); return snapshot;
            },
            expected(snapshot) {
              const date = live.backend === "gmail" ? messageBytes.dateHeader(snapshot.raw) : snapshot.date;
              if (!Number.isSafeInteger(date) || date < 0) throw unsupported("The original message date could not be preserved at this destination.");
              if (live.backend === "imap") {
                const flags = live.permanentFlags?.map(flag => String(flag).toLowerCase());
                if (flags && ((!snapshot.unread && !flags.includes("\\seen")) || (snapshot.starred && !flags.includes("\\flagged")))) throw unsupported("This destination cannot preserve the original read/star flags.");
                const appendLimit = destinationTransport.capabilities?.get?.("APPENDLIMIT");
                if (typeof appendLimit === "number" && snapshot.raw.length > appendLimit) throw unsupported("The complete original exceeds this server's APPENDLIMIT.");
              }
              return { date, unread: !!snapshot.unread, starred: !!snapshot.starred };
            },
            sourceKey() {
              return digest(JSON.stringify([source.accountId, source.local ? source.binding : source.owner.account.created_at,
                source.local ? [source.id] : sourceProviderId ? ["gmail", sourceProviderId] : [source.row.folder_path, source.row.uid_validity, source.row.uid]]));
            },
            destinationKey() { return digest(JSON.stringify([ticket.destination.accountId, ticket.destination.account.created_at, live.id])); },
            async upload(snapshot, expected, beforeSubmit) {
              checked(); await selected(destinationTransport, checked, live.id, live); checked();
              let locator;
              if (destinationTransport.gmail) {
                const labels = [live.id, ...(expected.unread ? ["UNREAD"] : []), ...(expected.starred ? ["STARRED"] : [])];
                const result = await destinationTransport.gmail.api.importMessage(snapshot.raw, labels, { beforeSubmit });
                checked();
                if (typeof result?.id !== "string" || !result.id) throw Object.assign(new Error("Gmail import identity was not confirmed."), { operationIssued: true });
                locator = { accountId: ticket.destination.accountId, folderId: live.id, providerId: result.id };
              } else {
                const flags = [...(!expected.unread ? ["\\Seen"] : []), ...(expected.starred ? ["\\Flagged"] : [])];
                checked(); beforeSubmit(); checked();
                const appended = await destinationTransport.append(live.id, snapshot.raw, flags, new Date(expected.date));
                checked();
                if (!positive(appended?.uid) || !positive(appended?.uidValidity) || Number(appended.uidValidity) !== live.uidValidity) throw Object.assign(new Error("APPENDUID was not confirmed. The destination may contain the message."), { operationIssued: true });
                locator = { accountId: ticket.destination.accountId, folderId: live.id, uid: Number(appended.uid), uidValidity: Number(appended.uidValidity) };
              }
              return locator;
            },
            async readDestination(locator) {
              checked();
              if (locator.accountId !== ticket.destination.accountId || locator.folderId !== live.id) throw conflict();
              await selected(destinationTransport, checked, live.id, live); checked();
              return destinationTransport.gmail ? gmailSnapshot(destinationTransport, locator.providerId, checked, false)
                : imapSnapshot(destinationTransport, locator, checked);
            },
            verifyState(saved, expected) {
              if (saved.unread !== expected.unread || saved.starred !== expected.starred
                || Math.floor(saved.date / 1000) !== Math.floor(expected.date / 1000)
                || live.backend === "gmail" && !saved.labelIds?.includes(live.id)) throw unsupported("Destination readback did not preserve the reviewed folder, date and read/star state. The source was retained.");
            },
          };
          if (session.sourceBackend === "gmail") {
            const mover = createGmailMoveSource({ api: sourceTransport.gmail.api, accountId: source.accountId, check: checked,
              readRaw: providerId => gmailSnapshot(sourceTransport, providerId, checked, true),
              async folder() {
                checked(); const cached = db.folderByPath(source.accountId, source.row.folder_path);
                if (!cached?.provider_id) throw conflict();
                if (cached.provider_id === "__gmail_all__" && cached.well_known === "all") return {
                  id: cached.provider_id, all: true, proof: digest(JSON.stringify(["gmail-all", cached.path, sourceBinding])) };
                const model = await listing(sourceTransport, checked), folder = model.folders.find(row => row.id === cached.provider_id); checked();
                if (!folder || ["TRASH", "DRAFT"].includes(folder.id) || folder.type === "user" && ![cached.path, cached.name].includes(folder.name)) throw conflict();
                return { id: folder.id, all: false, proof: folderIdentity(model, folder) };
              } });
            session.reviewSourceMove = snapshot => mover.review(snapshot);
            session.trashSource = (snapshot, sourceProof, beforeSubmit) => mover.trash(snapshot, sourceProof, beforeSubmit);
          }
          return work(session);
        });
      });
    });
  }
  return { capture, destinations, review, withCopy };
}

module.exports = { createAccess, folderIdentity, permission };
