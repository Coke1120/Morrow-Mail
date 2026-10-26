"use strict";

// Regenerate the JSON fixture using an unmodified archive of v0.3.0. Only
// temporary local accounts/grants and an intercepted SMTP sender are used.
// node scripts/fixtures/capture-legacy-bot-alias.js <v0.3.0-root> <output.json> [empty-profile-dir]
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const commit = "5f50132ec07d818330e12bd73f8f7b18d823d7d4";
const sourceHashes = {
  "host/bot/send.js": "337de3304ae9176362465ef763864924e606b512e8ca02e28d1939611c0cb63e",
  "host/mail/engine.js": "a1af46d5a085931a84d2fdd1f1871d134466e02f03e5c59dec59dc761b3908bf",
  "host/mail/db.js": "a1a3add57422abd2a838b813523a65d7c38e7159bb86270ebe4aab7d9f1fe345",
};

async function capture(root, output, profile) {
  root = path.resolve(root);
  for (const [file, hash] of Object.entries(sourceHashes)) {
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex"), hash, `Expected original ${commit} ${file}`);
  }
  const directory = profile ? path.resolve(profile) : fs.mkdtempSync(path.join(os.tmpdir(), "morrow-old-bot-alias-"));
  fs.mkdirSync(directory,{recursive:true});
  assert.deepEqual(fs.readdirSync(directory),[],"Fixture capture requires an empty synthetic profile");
  const environment = { ...process.env }, originalFetch = global.fetch;
  Object.assign(process.env, { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_AI_CONFIG_DIR: directory, MORROW_MAIL_SECRETS: "memory" });
  global.fetch = async () => { throw new Error("No live provider calls in fixture capture"); };
  const db = require(path.join(root, "host/mail/db")), engine = require(path.join(root, "host/mail/engine"));
  const remote = require(path.join(root, "host/mail/remote")), auth = require(path.join(root, "host/bot/auth"));
  const send = require(path.join(root, "host/bot/send")), settings = require(path.join(root, "host/settings"));
  const account = { id: "legacy-alias", email: "owner@primary.fixture.invalid", username: "owner", profile: "custom", authKind: "password", createdAt: 1,
    imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true };
  const alias = "author@different.fixture.invalid";
  const folders = [{ path: "Sent", name: "Sent", wellKnown: "sentitems" }, { path: "INBOX", name: "Inbox", wellKnown: "inbox" }];
  const composeSettings = { ccByDomain: {}, bccByDomain: {}, accounts: { [account.id]: { aliases: [{ address: alias }], senderNames: { [alias]: "Historical Alias" } } } };
  const original = { insertMessage: db.insertMessage, withClient: remote.withClient, sendSmtp: remote.sendSmtp };
  const messages = [];
  let captured, failFirstInsert, smtpCalls = 0;
  try {
    await engine.init();
    db.insertAccount(account); db.replaceFolders(account.id, folders);
    settings.answer("emailBrain:saveComposeSettings", [composeSettings]);
    remote.withClient = remote.sendSmtp = async () => { throw new Error("Live transport forbidden in fixture capture"); };
    engine.setSmtpSenderForTest(async ({ options, messageId }) => {
      smtpCalls++;
      assert.equal(options.from.address, alias);
      return { messageId, accepted: options.to, rejected: [] };
    });
    db.insertMessage = input => {
      if (failFirstInsert) { failFirstInsert = false; throw new Error("Synthetic failure before local Sent insert"); }
      captured = JSON.parse(JSON.stringify(input));
      return original.insertMessage(input);
    };
    for (const mode of ["sent-filing", "bot-fallback"]) {
      const minted = auth.mint({ label: `Synthetic historical ${mode}`, accountIds: [account.id], capabilities: ["mail.send"] });
      auth.setEnabledFlag(true);
      const grant = auth.authenticate(`Bearer ${minted.secret}`);
      captured = null; failFirstInsert = mode === "bot-fallback";
      const result = await send.perform({ grant, installationId: grant.installationId, requestId: crypto.randomUUID(), operation: "mail.send",
        params: { accountId: account.id, fromAddress: alias, to: ["customer@fixture.invalid"], cc: [alias, "colleague@fixture.invalid"], bcc: ["hidden@fixture.invalid"],
          subject: `Historical alias ${mode}`, bodyText: "Original bot production path" } });
      const row = db.messageByRfc(account.id, result.data.messageId);
      assert.ok(captured && row);
      assert.equal(row.uid, 0); assert.deepEqual(JSON.parse(row.recipient_headers_json), {});
      assert.match(row.rfc_message_id, /^<[a-f0-9]{24}@different\.fixture\.invalid>$/);
      const receipt = JSON.parse(fs.readFileSync(path.join(directory, "bot-send-receipts.json"), "utf8")).receipts.find(item => item.messageId === row.rfc_message_id);
      assert.equal(receipt.state, "submitted"); assert.equal(receipt.fromAddress, alias);
      messages.push({ mode, input: captured, stored: row, receipt });
    }
    assert.equal(smtpCalls, 2);
    fs.writeFileSync(output, JSON.stringify({ source: { commit, sourceHashes, generator: "scripts/fixtures/capture-legacy-bot-alias.js" }, account, alias, folders, composeSettings, messages }, null, 2) + "\n");
    console.log("legacy-alias-fixture-captured: original bot/send, submitSmtp, Sent filing and noteBotSent; 2 synthetic submissions");
  } finally {
    engine.setSmtpSenderForTest(null); db.insertMessage = original.insertMessage;
    remote.withClient = original.withClient; remote.sendSmtp = original.sendSmtp;
    await db.close(); global.fetch = originalFetch;
    for (const key of ["MORROW_MAIL_DIR", "MORROW_USER_DATA", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS"]) {
      if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key];
    }
    if (!profile) fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) capture(process.argv[2], process.argv[3], process.argv[4]).catch(error => { console.error(error); process.exitCode = 1; });
