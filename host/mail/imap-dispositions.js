const { createHash } = require("node:crypto");

// No RFC Message-ID matching: IMAP identities belong to one account, mailbox
// and UIDVALIDITY. A reconnect to a different endpoint/login retires the proof.
function accountKey(account) {
  if (!account || account.mail_transport === "gmail_api") return null;
  return createHash("sha256").update(JSON.stringify([account.id, account.created_at,
    account.email, account.username, account.auth_kind, account.profile, account.mail_transport,
    account.imap_host, account.imap_port, account.imap_tls,
    account.smtp_host, account.smtp_port, account.smtp_tls])).digest("hex");
}

const identityWhere = "account_id = ? AND account_key = ? AND folder_path = ? AND uid_validity = ? AND uid = ?";
const values = proof => [proof.accountId, proof.accountKey, proof.folderPath, proof.uidValidity, proof.uid];
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff;

function createStore({ run, get, all, transaction, accountById, messageById, folderByPath, updateChanged }) {
  function schema() {
    run(`CREATE TABLE IF NOT EXISTS imap_dispositions (
      account_id TEXT NOT NULL, account_key TEXT NOT NULL, folder_path TEXT NOT NULL,
      uid_validity INTEGER NOT NULL, uid INTEGER NOT NULL, kind TEXT NOT NULL,
      server_state TEXT NOT NULL DEFAULT 'pending', retry_after INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account_id, account_key, folder_path, uid_validity, uid, kind))`);
  }

  function target(proof) {
    if (proof?.transport !== "imap" || !["replied", "forwarded"].includes(proof.kind)
        || !positive(proof.uid) || !positive(proof.uidValidity)
        || !proof.accountKey || accountKey(accountById(proof.accountId)) !== proof.accountKey
        || folderByPath(proof.accountId, proof.folderPath)?.uid_validity !== proof.uidValidity) return null;
    return get(`SELECT id, account_id, folder_path, uid_validity, uid, is_draft, replied, forwarded,
      disposition_provider_replied, disposition_provider_forwarded FROM messages
      WHERE account_id = ? AND folder_path = ? AND uid_validity = ? AND uid = ? AND is_draft = 0`,
      [proof.accountId, proof.folderPath, proof.uidValidity, proof.uid]);
  }

  function capture(accountId, input) {
    const kind = input?.kind === "forward" ? "forwarded" : ["reply", "all"].includes(input?.kind) ? "replied" : null;
    const row = kind && messageById(input.sourceMessageId, { headersOnly: true });
    const key = accountKey(accountById(accountId));
    if (!key || !row || row.account_id !== accountId || row.is_draft
        || kind === "replied" && (input.inReplyTo || "") !== (row.rfc_message_id || "")) return null;
    const proof = { transport: "imap", accountId, accountKey: key,
      folderPath: row.folder_path, uidValidity: row.uid_validity, uid: row.uid, kind };
    return target(proof) ? proof : null;
  }

  function refresh(id, provider) {
    const row = messageById(id, { headersOnly: true });
    const key = row && accountKey(accountById(row.account_id));
    if (!key) return false;
    const evidence = !row.is_draft && positive(row.uid) && positive(row.uid_validity)
      ? all(`SELECT kind FROM imap_dispositions WHERE ${identityWhere}`,
        [row.account_id, key, row.folder_path, row.uid_validity, row.uid]) : [];
    const patch = {};
    for (const kind of ["replied", "forwarded"]) {
      const column = `disposition_provider_${kind}`;
      if (provider && (provider[kind] === null || typeof provider[kind] === "boolean")) {
        patch[column] = provider[kind] === null ? null : Number(provider[kind]);
      }
      const observed = column in patch ? patch[column] : row[column];
      // Absence of a keyword is not proof that this device did not send. Keep
      // confirmed local evidence even when a server cannot persist $Forwarded.
      patch[kind] = evidence.some(item => item.kind === kind) ? 1 : observed;
    }
    return updateChanged("messages", patch, "id = ?", [id]);
  }

  function confirm(accountId, proof) {
    if (proof?.accountId !== accountId || !target(proof)) return false;
    return transaction(() => {
      const row = target(proof);
      if (!row) return false;
      // Older IMAP caches predate the separate raw-provider columns.
      if (!get(`SELECT 1 FROM imap_dispositions WHERE ${identityWhere}`, values(proof))) {
        updateChanged("messages", { disposition_provider_replied: row.replied,
          disposition_provider_forwarded: row.forwarded }, "id = ?", [row.id]);
      }
      run(`INSERT INTO imap_dispositions(account_id, account_key, folder_path, uid_validity, uid, kind)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, account_key, folder_path, uid_validity, uid, kind)
        DO UPDATE SET server_state = 'pending', retry_after = 0`, [...values(proof), proof.kind]);
      refresh(row.id);
      return true;
    });
  }

  function pending(accountId, folderPath, now = Date.now()) {
    const key = accountKey(accountById(accountId));
    const validity = folderByPath(accountId, folderPath)?.uid_validity;
    if (!key || !positive(validity)) return [];
    return all(`SELECT uid, kind FROM imap_dispositions d WHERE account_id = ? AND account_key = ?
      AND folder_path = ? AND uid_validity = ? AND server_state = 'pending' AND retry_after <= ?
      AND EXISTS (SELECT 1 FROM messages m WHERE m.account_id = d.account_id AND m.folder_path = d.folder_path
        AND m.uid_validity = d.uid_validity AND m.uid = d.uid AND m.is_draft = 0)
      ORDER BY retry_after, uid LIMIT 2`, [accountId, key, folderPath, validity, now])
      .map(row => ({ transport: "imap", accountId, accountKey: key, folderPath, uidValidity: validity, ...row }));
  }

  function settle(proof, state) {
    if (!target(proof)) return;
    const serverState = ["stored", "unsupported", "missing"].includes(state) ? state : "pending";
    transaction(() => run(`UPDATE imap_dispositions SET server_state = ?, retry_after = ? WHERE ${identityWhere} AND kind = ?`,
      [serverState, serverState === "pending" ? Date.now() + 5 * 60000 : 0, ...values(proof), proof.kind]));
  }

  function resetAccount(accountId) {
    run("DELETE FROM imap_dispositions WHERE account_id = ?", [accountId]);
    run(`UPDATE messages SET replied = disposition_provider_replied, forwarded = disposition_provider_forwarded
      WHERE account_id = ?`, [accountId]);
  }

  return { schema, capture, confirm, refresh, pending, settle, target, resetAccount };
}

module.exports = { createStore, accountKey };
