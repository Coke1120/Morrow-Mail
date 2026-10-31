"use strict";

// Temporary SQLite/profile; real identity/send/replay code, intercepted providers.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-provider-metadata-"));
  const keys = ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS"];
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { MORROW_USER_DATA: dir, MORROW_MAIL_DIR: dir, MORROW_AI_CONFIG_DIR: dir, MORROW_MAIL_SECRETS: "memory" });
  const service = require("../host/bot/service"), engine = require("../host/mail/engine"), db = require("../host/mail/db");
  const auth = require("../host/bot/auth"), send = require("../host/bot/send"), sidecar = require("../host/mail/sidecar");
  const provider = require("../host/mail/provider-api"), remote = require("../host/mail/remote");
  const original = { gmailSendAsToken: sidecar.gmailSendAsToken, listSendAs: provider.listSendAs, sendSmtp: remote.sendSmtp, withClient: remote.withClient };
  const describe = capabilities => service.execute({ operation: "bridge.describe", params: {}, requestId: crypto.randomUUID(),
    installationId: "synthetic-installation", grant: { capabilities, expiry: { kind: "finite" } } });
  let release = () => {}, aliasLookups = 0, smtpFixtureCalls = 0;
  try {
    const reader = await describe(["accounts.read", "mail.headers.read"]);
    assert.equal(reader.data.semantics.providerCalls, false);
    assert.equal(reader.data.semantics.cacheOnlyReads, true);
    assert.ok(!reader.data.operations.includes("mail.send"));
    const sender = await describe(["mail.send"]);
    assert.equal(sender.data.semantics.providerCalls, true, "advertised send can contact providers");
    assert.equal(sender.data.semantics.cacheOnlyReads, true);
    assert.ok(sender.data.operations.includes("mail.send"));
    await engine.init();
    db.insertAccount({ id: "sender", email: "sender@example.test", username: "sender", profile: "gmail", authKind: "oauth2", createdAt: 1,
      imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 465, smtpTls: true });
    const aliases = [{ email: "alias@example.test", name: "Synthetic alias" }];
    db.saveSendAs("sender", { email: "sender@example.test", identities: aliases, updatedAt: Date.now() });
    sidecar.gmailSendAsToken = async () => ({ accessToken: "synthetic-provider-token" });
    provider.listSendAs = async () => { aliasLookups++; return aliases; };
    remote.sendSmtp = remote.withClient = async () => { throw new Error("Live provider traffic forbidden in metadata fixture"); };
    const grant = auth.mint({ label: "Synthetic sender", accountIds: ["sender"], capabilities: ["mail.send"] });
    auth.setEnabledFlag(true);
    const principal = auth.authenticate("Bearer " + grant.secret);
    const ctx = { grant: principal, installationId: principal.installationId, operation: "mail.send", requestId: crypto.randomUUID(),
      params: { accountId: "sender", fromAddress: "alias@example.test", to: ["r@example.test"], subject: "Synthetic", bodyText: "Synthetic" } };
    let enter;
    const active = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    engine.setSmtpSenderForTest(async ({ options, messageId }) => {
      smtpFixtureCalls++; enter(); await held;
      return { messageId, accepted: options.to, rejected: [] };
    });
    const first = service.execute(ctx);
    const joined = service.execute(ctx);
    await active;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(aliasLookups, 1, "concurrent sends share one in-flight Gmail send-as discovery");
    release();
    const receipts = await Promise.all([first, joined]);
    assert.equal(smtpFixtureCalls, 1);
    assert.equal(receipts[0].data.auditId, receipts[1].data.auditId);
    assert.ok(receipts.every(receipt => receipt.data.idempotentReplay === false), "the second in-flight request joins the first");
    const replay = await service.execute(ctx);
    assert.equal(replay.data.idempotentReplay, true);
    assert.equal(smtpFixtureCalls, 1, "metadata changes cannot duplicate SMTP submission");
    assert.equal(aliasLookups, 2, "replay forces a fresh Gmail From discovery after the shared join");
    for (const receipt of [...receipts, replay]) assert.ok(!Object.hasOwn(receipt.meta, "providerCalls"), "receipts do not pretend to measure provider traffic");
    const stored = JSON.parse(fs.readFileSync(path.join(dir, "bot-send-receipts.json"), "utf8"));
    assert.equal(stored.receipts.length, 1);
    assert.equal(stored.receipts[0].state, "submitted");
    assert.ok(!Object.hasOwn(stored.receipts[0], "providerCalls"));
    console.log("bot-provider-metadata-ok (reader local, sender may call; 2 intercepted alias lookups, 1 synthetic SMTP for join/replay)");
  } finally {
    release();
    engine.setSmtpSenderForTest(null);
    send.resetForTest();
    sidecar.gmailSendAsToken = original.gmailSendAsToken;
    provider.listSendAs = original.listSendAs;
    remote.sendSmtp = original.sendSmtp;
    remote.withClient = original.withClient;
    await engine.stopIdle();
    await db.close();
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };
if (require.main === module) run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
