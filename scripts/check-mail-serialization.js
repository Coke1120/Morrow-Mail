const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-mail-queue-"));
  const env = { MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR, MORROW_MAIL_SECRETS: process.env.MORROW_MAIL_SECRETS };
  process.env.MORROW_MAIL_DIR = dir;
  process.env.MORROW_MAIL_SECRETS = "memory";
  const engine = require("../host/mail/engine");
  const db = require("../host/mail/db");
  const secrets = require("../host/mail/secrets");
  const remote = require("../host/mail/remote");
  const saved = { withClient: remote.withClient, changeFlags: remote.changeFlags };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const pending = [];
  try {
    await engine.init();
    for (const id of ["queue-a", "queue-b"]) {
      db.insertAccount({
        id, email: `${id}@example.invalid`, username: id, profile: "custom", createdAt: Date.now(),
        imapHost: "imap.example.invalid", imapPort: 993, imapTls: true,
        smtpHost: "smtp.example.invalid", smtpPort: 587, smtpTls: true,
      });
      secrets.setPassword(id, "fixture-password");
      db.insertMessage({ id: `${id}-message`, accountId: id, folderPath: "INBOX", uid: 1, uidValidity: 1,
        date: new Date().toISOString(), listSortTs: Date.now(), unread: true });
    }
    let entered;
    const firstEntered = new Promise((resolve) => { entered = resolve; });
    const calls = [];
    remote.withClient = async (account, _secret, work) => work({ accountId: account.id });
    remote.changeFlags = async (client, _folder, _uid, add) => {
      const key = `${client.accountId}:${add[0]}`;
      calls.push(key);
      if (key === "queue-a:\\Seen") {
        entered();
        await held;
        throw new Error("Fixture first operation failed");
      }
    };
    const first = engine.answer("mail:markRead", [{ emailId: "queue-a-message", isRead: true }]);
    pending.push(first);
    await firstEntered;
    assert.equal(db.messageById("queue-a-message").unread, 0);
    const second = engine.answer("mail:toggleStar", [{ emailId: "queue-a-message", isStarred: true }]);
    const unrelated = engine.answer("mail:markRead", [{ emailId: "queue-b-message", isRead: true }]);
    pending.push(second, unrelated);
    assert.equal((await unrelated).success, true, "another account must remain independent");
    assert.equal(db.messageById("queue-a-message").starred, 1);
    await engine.settleAccount("queue-b");
    assert.deepEqual(calls, ["queue-a:\\Seen", "queue-b:\\Seen"], "a second request must wait for its mailbox queue");
    release();
    await engine.settleAccount("queue-a");
    assert.equal((await first).success, true);
    assert.equal((await second).success, true, "a failed operation must release its mailbox queue");
    assert.equal(db.messageById("queue-a-message").unread, 0);
    assert.equal(db.messageById("queue-a-message").starred, 1);
    assert.equal(db.messageById("queue-b-message").unread, 0);
  } finally {
    release();
    await Promise.allSettled(pending);
    Object.assign(remote, saved);
    for (const id of ["queue-a", "queue-b"]) secrets.deletePassword(id);
    db.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };
