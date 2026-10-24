"use strict";

// Temporary profiles and intercepted identity/OAuth/SMTP only. No live account,
// Keychain, listener, Tailscale process, or provider request is used.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function reached(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Synthetic send did not reach the held boundary")), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-bot-send-auth-"));
  const keys = ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS"];
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const configure = name => {
    const home = path.join(dir, name);
    fs.mkdirSync(home, { recursive: true });
    Object.assign(process.env, { MORROW_USER_DATA: home, MORROW_MAIL_DIR: home,
      MORROW_AI_CONFIG_DIR: home, MORROW_MAIL_SECRETS: "memory" });
    return home;
  };
  configure("initial");
  const engine = require("../host/mail/engine");
  const db = require("../host/mail/db");
  const identity = require("../host/mail/compose-identity");
  const oauth = require("../host/mail/oauth");
  const remote = require("../host/mail/remote");
  const secrets = require("../host/mail/secrets");
  const auth = require("../host/bot/auth");
  const send = require("../host/bot/send");
  const service = require("../host/bot/service");
  const original = { sendingFrom: identity.sendingFrom, accessTokenFor: oauth.accessTokenFor,
    submitSmtp: engine.submitSmtp, sendSmtp: remote.sendSmtp };
  const params = { accountId: "sender", to: ["recipient@example.test"], subject: "Synthetic bot send", bodyText: "Synthetic body" };
  let home;
  let grant;
  let ctx;
  let smtpCalls;
  const reset = async (name, credentialWait = false) => {
    db.close();
    home = configure(name);
    await engine.init();
    for (const id of ["sender", "other"]) {
      db.insertAccount({ id, email: `${id}@example.test`, username: id, profile: "custom", createdAt: Date.now(),
        authKind: credentialWait ? "oauth2" : "password", imapHost: "imap.example.test", imapPort: 993,
        imapTls: true, smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true });
    }
    grant = auth.mint({ label: "Synthetic sender", accountIds: ["sender"], capabilities: ["mail.send"] });
    auth.setEnabledFlag(true);
    const principal = auth.authenticate(`Bearer ${grant.secret}`);
    assert.ok(principal);
    ctx = { grant: principal, installationId: principal.installationId,
      requestId: crypto.randomUUID(), operation: "mail.send", params: { ...params } };
    send.resetForTest();
    smtpCalls = 0;
    identity.sendingFrom = original.sendingFrom;
    oauth.accessTokenFor = original.accessTokenFor;
    engine.submitSmtp = original.submitSmtp;
    remote.sendSmtp = async () => { throw new Error("Unexpected synthetic SMTP path"); };
    engine.setSmtpSenderForTest(async ({ options, messageId }) => {
      if (options.subject === params.subject) smtpCalls++;
      return { messageId, accepted: options.to, rejected: [] };
    });
  };
  const receipts = () => {
    const file = path.join(home, "bot-send-receipts.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).receipts : [];
  };
  const mutate = change => {
    const store = auth.load().store;
    change(store, store.grants.find(row => row.clientId === grant.grant.clientId));
    fs.writeFileSync(path.join(home, "bot-access.json"), JSON.stringify(store), { mode: 0o600 });
  };
  const invalidations = {
    revoke: () => auth.revoke(grant.grant.clientId),
    disable: () => auth.setEnabledFlag(false),
    rotate: () => auth.rotate(grant.grant.clientId),
    expire: () => mutate((_store, row) => { row.expiry = { kind: "finite", expiresAt: "2000-01-01T00:00:00Z" }; }),
    "account-scope": () => mutate((_store, row) => { row.accountIds = ["other"]; }),
    "send-scope": () => mutate((_store, row) => { row.capabilities = ["accounts.read"]; }),
    "removed-account": () => db.removeAccount("sender"),
    installation: () => mutate(store => {
      store.installationId = crypto.randomUUID();
      for (const row of store.grants) row.installationId = store.installationId;
    }),
  };
  try {
    for (const phase of ["identity", "mailbox-queue", "credentials"]) {
      for (const [name, invalidate] of Object.entries(invalidations)) {
        await reset(`${phase}-${name}`, phase === "credentials");
        const originalAccess = fs.readFileSync(path.join(home, "bot-access.json"), "utf8");
        const held = deferred();
        const entered = deferred();
        let blocker;
        let pending;
        try {
          if (phase === "identity") {
            identity.sendingFrom = async account => { entered.resolve(); await held.promise; return account.email; };
          } else if (phase === "mailbox-queue") {
            engine.setSmtpSenderForTest(async ({ options, messageId }) => {
              if (options.subject === "Hold mailbox lane") { entered.resolve(); await held.promise; }
              else smtpCalls++;
              return { messageId, accepted: options.to, rejected: [] };
            });
            blocker = engine.submitSmtp({ account: db.accountById("sender"), options: { subject: "Hold mailbox lane", to: params.to },
              messageId: "<synthetic-blocker@example.test>" });
            await reached(entered.promise);
            const queued = deferred();
            engine.submitSmtp = input => {
              const result = original.submitSmtp(input);
              queued.resolve();
              return result;
            };
            entered.promise = queued.promise;
          } else {
            engine.setSmtpSenderForTest(null);
            secrets.setPassword("sender", "synthetic-oauth-store");
            oauth.accessTokenFor = async () => { entered.resolve(); await held.promise; return "synthetic-access-token"; };
            remote.sendSmtp = async (_account, _password, options) => {
              smtpCalls++;
              return { messageId: options.messageId, accepted: options.to, rejected: [] };
            };
          }
          // Attach rejection handling immediately, so a pre-submit rejection
          // cannot become an unhandled rejection while the boundary is held.
          pending = service.execute(ctx).then(value => ({ value }), error => ({ error }));
          await reached(entered.promise);
          if (phase !== "identity") assert.equal(receipts()[0].state, "claimed");
          invalidate();
          held.resolve();
          const result = await pending;
          assert.equal(smtpCalls, 0, `${phase}/${name}: invalidated access must not enter SMTP`);
          assert.equal(result.error?.code, "UNAUTHENTICATED", `${phase}/${name}: fail closed`);
          if (phase === "identity") assert.equal(receipts().length, 0, "do not claim after identity invalidation");
          else {
            assert.equal(receipts()[0].state, "rejected", "a proven pre-submit stop is terminal");
            if (name === "removed-account") {
              // Restore only the synthetic identity for the replay check.
              db.insertAccount({ id: "sender", email: "sender@example.test", username: "sender", profile: "custom", createdAt: Date.now(),
                imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true });
            }
            fs.writeFileSync(path.join(home, "bot-access.json"), originalAccess, { mode: 0o600 });
            const replay = await service.execute(ctx).then(value => ({ value }), error => ({ error }));
            assert.equal(replay.error?.code, "SEND_REJECTED");
            assert.equal(smtpCalls, 0, "restoring access must not replay a stopped claim");
          }
        } finally {
          held.resolve();
          await Promise.allSettled([pending, blocker]);
        }
      }
    }
    // Once the SMTP transport has been invoked it cannot be recalled. An
    // accepted receipt must survive revocation and retain replay protection.
    await reset("already-submitted");
    const originalAccess = fs.readFileSync(path.join(home, "bot-access.json"), "utf8");
    const held = deferred();
    const entered = deferred();
    engine.setSmtpSenderForTest(async ({ options, messageId }) => {
      smtpCalls++;
      entered.resolve();
      await held.promise;
      return { messageId, accepted: options.to, rejected: [] };
    });
    const first = service.execute(ctx);
    const joined = service.execute(ctx);
    try {
      await reached(entered.promise);
      auth.revoke(grant.grant.clientId);
      held.resolve();
      const results = await Promise.all([first, joined]);
      assert.equal(smtpCalls, 1);
      assert.equal(receipts()[0].state, "submitted");
      assert.equal(results[0].data.auditId, results[1].data.auditId);
      fs.writeFileSync(path.join(home, "bot-access.json"), originalAccess, { mode: 0o600 });
      send.resetForTest();
      const replay = await service.execute(ctx);
      assert.equal(replay.data.idempotentReplay, true);
      assert.equal(smtpCalls, 1, "an already submitted send cannot be repeated");
    } finally {
      held.resolve();
      await Promise.allSettled([first, joined]);
    }
    console.log("bot-send-authorization-ok: 24 invalidation races; submitted/join/replay preserved");
  } finally {
    identity.sendingFrom = original.sendingFrom;
    oauth.accessTokenFor = original.accessTokenFor;
    engine.submitSmtp = original.submitSmtp;
    remote.sendSmtp = original.sendSmtp;
    engine.setSmtpSenderForTest(null);
    send.resetForTest();
    secrets.deletePassword("sender");
    secrets.deletePassword("other");
    db.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
