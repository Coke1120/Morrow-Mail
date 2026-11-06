"use strict";

// Folder management uses the mailbox transport, not a second provider grant.
// All dependencies are injected so ownership and protocol races can be tested
// without reading a keychain or connecting to a server.
const { digest } = require("./folder-recovery");
const conflict = () => Object.assign(new Error("This mailbox connection changed. Review the folder action again."), { code: "conflict", operationIssued: false });
const identity = account => [account.id, account.created_at, account.profile, account.auth_kind, account.mail_transport,
  account.gmail_generation, account.username, account.email, account.imap_host, account.imap_port, account.imap_tls];
const has = (flags, flag) => flags.some(value => value.toLowerCase() === flag.toLowerCase());
const SYSTEM = { "\\inbox": "inbox", "\\sent": "sentitems", "\\drafts": "drafts", "\\trash": "deleteditems",
  "\\junk": "junkemail", "\\archive": "archive", "\\all": "all", "\\flagged": "starred", "\\important": "important" };

function imapListing(boxes) {
  if (!Array.isArray(boxes) || boxes.length > 5000) throw conflict();
  // A NIL delimiter is a flat namespace, not an invitation to invent '/'.
  const delimiters = [...new Set(boxes.map(box => box.delimiter).filter(value => typeof value === "string" && value))];
  const delimiter = delimiters.length === 1 ? delimiters[0] : null;
  const folders = boxes.map(box => {
    if (typeof box.path !== "string" || !box.path) throw conflict();
    const flags = Array.from(box.flags || [], value => String(value));
    const special = String(box.specialUse || "").toLowerCase();
    const wellKnown = box.path.toUpperCase() === "INBOX" ? "inbox" : SYSTEM[special]
      || flags.map(value => SYSTEM[value.toLowerCase()]).find(Boolean) || null;
    const separator = typeof box.delimiter === "string" && box.delimiter ? box.delimiter : null;
    const cut = separator ? box.path.lastIndexOf(separator) : -1;
    return { id: box.path, name: box.name || box.path, type: wellKnown ? "system" : "user", wellKnown,
      delimiter: separator, parentId: cut > 0 ? box.path.slice(0, cut) : null, flags, specialUse: box.specialUse || null,
      selectable: !has(flags, "\\Noselect") && !has(flags, "\\NonExistent"),
      readOnly: box.readOnly === true || has(flags, "\\ReadOnly") || has(flags, "\\NonExistent"),
      canCreate: !!separator && !has(flags, "\\Noinferiors") && box.readOnly !== true };
  });
  const ids = new Set(folders.map(folder => folder.id));
  for (const folder of folders) if (!ids.has(folder.parentId)) folder.parentId = null;
  return { delimiter, folders };
}

function gmailListing(labels) {
  if (!Array.isArray(labels) || labels.length > 5000) throw conflict();
  const byName = new Map(labels.map(label => [label.name, label.id]));
  return { delimiter: "/", folders: labels.map(label => {
    const cut = label.name.lastIndexOf("/");
    return { ...label, providerId: label.id, parentId: cut > 0 ? byName.get(label.name.slice(0, cut)) || null : null,
      flags: [], selectable: true, readOnly: label.type !== "user" || label.editable !== true,
      wellKnown: label.type === "user" ? null : label.id, delimiter: "/" };
  }) };
}

function createAccess({ accountById, bindAccount, assertAccountCurrent, generation, revision, googleClient,
  secretFor, withMailClient, exclusive, refreshCache, blocked = () => false } = {}) {
  function describe(account) {
    const clientId = account.mail_transport === "gmail_api" || (account.profile === "gmail" && account.auth_kind === "oauth2") ? googleClient() : null;
    return { binding: digest(JSON.stringify([...identity(account), clientId])), generation: generation(account.id), revision: revision(account.id) };
  }
  function owner(accountId) {
    const account = accountById(accountId);
    return account ? describe(account) : null;
  }
  async function withAccount(accountId, work, ticket) {
    const account = bindAccount(accountById(accountId));
    const captured = describe(account);
    let pinned = captured.revision;
    function check() {
      assertAccountCurrent(account);
      const current = owner(accountId);
      if (!current || current.binding !== captured.binding || current.generation !== captured.generation || current.revision !== pinned) throw conflict();
    }
    function ticketCurrent() {
      check();
      if (ticket && (ticket.binding !== captured.binding || ticket.generation !== captured.generation || ticket.revision !== pinned)) throw conflict();
    }
    // Capture before the mailbox lane. A reconnect while queued cannot cause
    // either a credential read or an operation on its replacement connection.
    ticketCurrent();
    return exclusive(accountId, async () => {
      ticketCurrent();
      const value = await secretFor(account, { snapshot: true });
      assertAccountCurrent(account);
      // secretFor proves any revision it produces itself. All other revision
      // changes retire this operation, including after a connection wait.
      if (value && typeof value === "object" && value.revision === revision(accountId)) pinned = value.revision;
      ticketCurrent();
      const secret = typeof value === "string" ? value : value?.token;
      return withMailClient(account, secret, async transport => {
        ticketCurrent();
        const gmail = transport.gmail;
        const client = { accountId, transport, label: account.email || account.username || account.name || accountId,
          backend: gmail ? "gmail" : "imap", gmailImap: !gmail && account.profile === "gmail", recoverableRename: false,
          binding: captured.binding, generation: captured.generation, get revision() { check(); return pinned; }, check,
          blocked: () => blocked(accountId),
          async list() {
            check();
            const result = gmail ? gmailListing(await gmail.api.labels()) : imapListing(await transport.list());
            check(); return result;
          },
          async create(name) { check(); await (gmail ? gmail.api.createLabel(name) : transport.mailboxCreate(name)); check(); },
          async deleteLabel(id, expectedName) {
            check();
            if (!gmail) throw Object.assign(new Error("Safe folder deletion is unavailable for this transport."), { code: "unsupported", operationIssued: false });
            await gmail.api.deleteLabel(id, { expectedName }); check();
          },
          async refreshCache() { check(); await refreshCache(account, transport, check); check(); },
        };
        return work(client);
      }, { check });
    });
  }
  return { owner, withAccount };
}

module.exports = { createAccess, imapListing, gmailListing };
