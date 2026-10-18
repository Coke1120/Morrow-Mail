const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-account-recovery-"));
  const env = { MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR, MORROW_MAIL_SECRETS: process.env.MORROW_MAIL_SECRETS };
  process.env.MORROW_MAIL_DIR = dir;
  process.env.MORROW_MAIL_SECRETS = "memory";
  const db = require("../host/mail/db");
  const engine = require("../host/mail/engine");
  const oauth = require("../host/mail/oauth");
  const remote = require("../host/mail/remote");
  const secrets = require("../host/mail/secrets");
  const signIn = oauth.signIn;
  const savedRemote = {};
  const accountId = "recovery-test";
  const folders = [
    { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
    { path: "Drafts", name: "Drafts", wellKnown: "drafts" },
  ];
  try {
    await db.open(path.join(dir, "mail.sqlite"));
    db.insertAccount({
      id: accountId, email: "recovery@example.invalid", username: "recovery@example.invalid",
      profile: "outlook", authKind: "oauth2", createdAt: Date.now(),
      imapHost: "imap.example.invalid", imapPort: 993, imapTls: true,
      smtpHost: "smtp.example.invalid", smtpPort: 587, smtpTls: true,
    });
    db.replaceFolders(accountId, folders, "/");
    for (const [id, folderPath, uid, isDraft] of [["cached", "INBOX", 1, false], ["draft", "Drafts", 0, true]]) {
      db.insertMessage({
        id, accountId, folderPath, uid, uidValidity: 1, isDraft,
        subject: "Recovery sentinel", textBody: "Retain local content", bodyComplete: true,
        date: new Date().toISOString(), listSortTs: Date.now(),
      });
    }
    db.saveSignature({ id: "recovery-signature", accountId, name: "Work", bodyText: "Signature", bodyHtml: "", isDefault: true });
    db.saveInboxRule(accountId, { id: "recovery-rule", name: "Rule", enabled: true, match: { from: "news" }, actions: { markRead: true } });
    db.insertScheduled({ id: "recovery-send", accountId, payloadJson: "{}", sendAt: "2099-01-01T00:00:00.000Z", createdAt: Date.now() });
    const retained = () => {
      assert.ok(db.accountById(accountId), "a missing secret must not delete an existing account");
      assert.equal(db.messageById("cached").text_body, "Retain local content");
      assert.equal(db.messageById("draft").is_draft, 1);
      assert.equal(db.searchMessages({ query: "sentinel", accountId }).length, 2);
      assert.equal(db.foldersFor(accountId).length, 2);
      assert.equal(db.listSignatures(accountId).length, 1);
      assert.equal(db.listInboxRules(accountId).length, 1);
      assert.equal(db.listScheduled(accountId).length, 1);
    };
    db.close();
    await engine.init();
    retained();
    assert.equal(engine.answer("mail:listAccounts", []).data[0].needsReauth, true);
    assert.equal(engine.answer("mail:cancelOAuth", []).success, true);
    retained();

    // A purpose-specific grant does not replace the missing mailbox grant.
    secrets.setPassword(`${accountId}:vacation`, "retained-vacation-token");
    db.clearAuthError(accountId);
    db.close();
    await engine.init();
    assert.equal(engine.answer("mail:listAccounts", []).data[0].needsReauth, true);
    assert.equal(secrets.getPassword(`${accountId}:vacation`), "retained-vacation-token");
    retained();

    oauth.signIn = async () => { throw Object.assign(new Error("Canceled"), { code: "oauth_cancelled" }); };
    assert.equal((await engine.answer("mail:addAccount", [{ provider: "microsoft" }])).error.code, "oauth_cancelled");
    assert.equal(db.listAccountRows().length, 1, "canceled sign-in must not add an account");
    retained();

    let completed = false;
    oauth.signIn = async () => ({
      provider: "microsoft", profile: "outlook", purpose: "imap",
      email: "recovery@example.invalid", username: "recovery@example.invalid",
      imap: { host: "imap.example.invalid", port: 993, tls: true },
      smtp: { host: "smtp.example.invalid", port: 587, tls: true },
      refreshToken: "fixture-refresh", accessToken: "fixture-access", expiresAt: Date.now() + 3600000,
      grantedScopes: require("../host/mail/oauth-config").SCOPES.microsoft,
      complete(result) { completed = result.ok; },
    });
    const mocks = {
      withClient: async (_account, _secret, work) => work({}),
      listFolderRecords: async () => ({ folders, delimiter: "/" }),
      verifySmtp: async () => {},
      searchUids: async () => ({ uids: [1], validity: 1, exists: 1, unseen: 0 }),
      fetchMessages: async () => { throw new Error("No new messages in this fixture"); },
    };
    for (const [name, mock] of Object.entries(mocks)) {
      savedRemote[name] = remote[name];
      remote[name] = mock;
    }
    const matchingSignIn = oauth.signIn;
    oauth.signIn = async () => ({ ...(await matchingSignIn()), email: "wrong@example.invalid" });
    const mismatch = await engine.answer("mail:addAccount", [{ provider: "microsoft", expectedAccountId: accountId }]);
    assert.equal(mismatch.error.code, "account_mismatch");
    assert.equal(db.accountByEmail("wrong@example.invalid"), null);
    retained();
    const wrongPassword = await engine.answer("mail:connectImapSmtp", [{ email: "wrong@example.invalid", expectedAccountId: accountId }]);
    assert.equal(wrongPassword.error.code, "account_mismatch");
    oauth.signIn = matchingSignIn;
    const connected = await engine.answer("mail:addAccount", [{ provider: "microsoft", expectedAccountId: accountId }]);
    assert.equal(connected.success, true);
    assert.equal(connected.data.id, accountId, "re-login must reuse the original mailbox identity");
    assert.equal(connected.data.needsReauth, false);
    assert.equal(completed, true);
    // Let the connection's one-shot background refresh finish under the mocks.
    await new Promise((resolve) => setTimeout(resolve, 300));
    retained();
    assert.equal(secrets.getPassword(`${accountId}:vacation`), "retained-vacation-token");
  } finally {
    oauth.signIn = signIn;
    Object.assign(remote, savedRemote);
    secrets.deletePassword(accountId);
    secrets.deletePassword(`${accountId}:vacation`);
    db.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };
