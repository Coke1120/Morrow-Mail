const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-mail-actions-"));
  const env = { MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR, MORROW_MAIL_SECRETS: process.env.MORROW_MAIL_SECRETS };
  process.env.MORROW_MAIL_DIR = dir;
  process.env.MORROW_MAIL_SECRETS = "memory";
  const engine = require("../host/mail/engine");
  const db = require("../host/mail/db");
  const secrets = require("../host/mail/secrets");
  const remote = require("../host/mail/remote");
  const saved = { withClient: remote.withClient, changeFlags: remote.changeFlags };
  const flagCalls = [];
  try {
    await engine.init();
    db.insertAccount({
      id: "act", email: "act@example.invalid", username: "act", profile: "custom", createdAt: Date.now(),
      imapHost: "imap.example.invalid", imapPort: 993, imapTls: true,
      smtpHost: "smtp.example.invalid", smtpPort: 587, smtpTls: true,
    });
    secrets.setPassword("act", "fixture-only");
    db.replaceFolders("act", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }]);
    db.insertMessage({
      id: "act-1", accountId: "act", folderPath: "INBOX", uid: 4, uidValidity: 1,
      date: new Date().toISOString(), listSortTs: Date.now(), unread: true,
    });
    remote.withClient = async () => { throw new Error("connection refused before STORE"); };
    remote.changeFlags = async () => { flagCalls.push("flags"); };
    const optimistic = await engine.answer("mail:toggleStar", [{ emailId: "act-1", isStarred: true }]);
    assert.equal(optimistic.success, true);
    assert.equal(db.messageById("act-1").starred, 1);
    assert.equal(flagCalls.length, 0);
    const rolled = await engine.settleActions();
    assert.equal(rolled.outcomes.find((row) => row.id === "act-1").status, "failed");
    assert.equal(db.messageById("act-1").starred, 0);
    assert.equal(flagCalls.length, 0);

    remote.withClient = async (_account, _secret, work) => work({});
    remote.changeFlags = async () => { flagCalls.push("flags"); throw new Error("flag rejected"); };
    const kept = await engine.answer("mail:toggleStar", [{ emailId: "act-1", isStarred: true }]);
    assert.equal(kept.success, true);
    assert.equal(db.messageById("act-1").starred, 1);
    const uncertain = await engine.settleActions();
    const outcome = uncertain.outcomes.find((row) => row.id === "act-1");
    assert.equal(outcome.status, "unknown");
    assert.match(outcome.error, /flag rejected/);
    assert.match(outcome.error, /star stays on this device/);
    assert.equal(db.messageById("act-1").starred, 1);
    assert.equal(flagCalls.length, 1);

    db.insertMessage({
      id: "act-local", accountId: "act", folderPath: "INBOX", uid: 0, uidValidity: 0,
      date: new Date().toISOString(), listSortTs: Date.now(), unread: true,
    });
    db.replaceFolders("act", [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Archive", name: "Archive", wellKnown: "archive" },
    ]);
    const moved = await engine.answer("mail:archive", [{ emailId: "act-local", accountId: "act" }]);
    assert.equal(moved.success, true);
    assert.equal(moved.data.opIds.length, 1);
    assert.equal(db.messageById("act-local").folder_path, "Archive");
    assert.equal(flagCalls.length, 1);
    const restored = await engine.answer("mail:undoRemoval", [{ opIds: moved.data.opIds }]);
    assert.equal(restored.success, true);
    assert.equal(db.messageById("act-local").folder_path, "INBOX");
    const replay = await engine.answer("mail:undoRemoval", [{ opIds: moved.data.opIds }]);
    assert.equal(replay.data.outcomes[0].status, "failed");
    assert.equal(db.messageById("act-local").folder_path, "INBOX");
  } finally {
    await engine.settleActions().catch(() => {});
    Object.assign(remote, saved);
    secrets.deletePassword("act");
    db.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("mail-actions-ok");
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
