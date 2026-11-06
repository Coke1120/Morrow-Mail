"use strict";
// Actual engine, Gmail session/token supplier/HTTP adapter and native journals.
// Every mailbox, credential, window and network response below is synthetic.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events"), { spawnSync } = require("node:child_process"), { Readable } = require("node:stream");
const RAW = Buffer.from("From: sender@fixture.invalid\r\nTo: owner@fixture.invalid\r\nDate: Mon, 02 Nov 2026 03:04:05 +0000\r\nMessage-ID: <duplicate@fixture.invalid>\r\nSubject: Synthetic engine Move\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nComplete body");
const DATE = Date.parse("2026-11-02T03:04:05Z"), tick = () => new Promise(resolve => setImmediate(resolve));
const held = () => { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; };

async function scenario(kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-move-engine-"));
  Object.assign(process.env, { MORROW_MAIL_DIR: dir, MORROW_USER_DATA: dir, MORROW_AI_CONFIG_DIR: dir, MORROW_MAIL_SECRETS: "memory", MORROW_GMAIL_PACE: "0",
    MORROW_GOOGLE_OAUTH_JSON: JSON.stringify({ installed: { client_id: "move-fixture.apps.googleusercontent.com", client_secret: "synthetic-only" } }) });
  delete process.env.MORROW_GOOGLE_OAUTH_FILE;
  if (kind !== "gate") {
    const policy = require.resolve("../host/mail/cross-mailbox-move-policy");
    require.cache[policy] = { id: policy, filename: policy, loaded: true, exports: Object.freeze({ enabled: true, reason: "Synthetic fixture only" }) };
  }
  const engine = require("../host/mail/engine"), db = require("../host/mail/db"), secrets = require("../host/mail/secrets"), remote = require("../host/mail/remote");
  const oauth = require("../host/mail/oauth"), config = require("../host/mail/oauth-config"), owners = require("../shared/mail-context-owner");
  const originalClient = remote.withClient, originalRead = secrets.getPasswordAsync;
  oauth.accessTokenFor = async (_account, raw) => JSON.parse(raw).accessToken;
  const messages = new Map(), imports = new Map(), imapCopies = new Map(), wire = []; let trashes = 0, uploads = 0, hook = async () => {};
  const gmail = kind !== "gmail-imap";
  const sender = new EventEmitter(); sender.mainFrame = {}; sender.destroyed = false; sender.isDestroyed = () => sender.destroyed;
  const event = () => ({ sender, senderFrame: sender.mainFrame });
  const call = (channel, params, owner = event()) => engine.answer(channel, [params], owner);
  function resource(id, saved) {
    return { id, threadId: "thread-" + id, labelIds: saved.labels, internalDate: String(DATE), raw: saved.raw.toString("base64url"),
      payload: { mimeType: "text/plain", headers: [{ name: "Message-ID", value: "<duplicate@fixture.invalid>" }],
        body: { size: 13, data: Buffer.from("Complete body").toString("base64url") } } };
  }
  global.fetch = async (input, options) => {
    const url = new URL(input), method = options.method || "GET", token = options.headers.authorization;
    assert.equal(url.origin, "https://gmail.googleapis.com");
    const accountId = token === "Bearer a-token" ? "a" : token === "Bearer b-token" ? "b" : null; assert.ok(accountId, "only memory fixture grants");
    const route = url.pathname.replace("/gmail/v1/users/me", ""); wire.push({ accountId, method, route });
    assert.ok(method !== "DELETE" && !/send|drafts|batchDelete/.test(route), "no permanent-delete, SMTP/draft/send path");
    await hook("http:" + accountId + ":" + method + ":" + route);
    if (route === "/labels") return new Response(JSON.stringify({ labels: [
      { id: "INBOX", name: "INBOX", type: "system" }, { id: "TRASH", name: "TRASH", type: "system" },
      { id: "DRAFT", name: "DRAFT", type: "system" }, { id: "Label_archive", name: "Archive", type: "user" }] }));
    if (route === "/messages/import") {
      uploads++; const body = JSON.parse(options.body), id = "imported-" + uploads;
      imports.set(accountId + ":" + id, { raw: Buffer.from(body.raw, "base64url"), labels: body.labelIds });
      return new Response(JSON.stringify({ id }));
    }
    const match = /^\/messages\/([^/]+)(\/trash)?$/.exec(route); assert.ok(match, "unexpected fixture URL " + route);
    const id = decodeURIComponent(match[1]), saved = messages.get(accountId + ":" + id) || imports.get(accountId + ":" + id); assert.ok(saved);
    if (method === "POST") {
      assert.equal(match[2], "/trash"); trashes++;
      const Database = require("better-sqlite3"), journal = new Database(path.join(dir, "mailbox-move-recovery.sqlite"), { readonly: true });
      assert.equal(journal.prepare("SELECT phase FROM mailbox_moves WHERE json_extract(body,'$.source.providerId')=?").get(id).phase, "source_unknown"); journal.close();
      saved.labels = [...saved.labels, "TRASH"]; await hook("after-post");
      if (kind === "lost-ack") throw new Error("synthetic source acknowledgement lost");
    } else assert.equal(method, "GET");
    return new Response(JSON.stringify(resource(id, saved)));
  };
  function seed(id, gmailAccount = true) {
    db.insertAccount({ id, email: id + "@fixture.invalid", username: id + "@fixture.invalid", profile: gmailAccount ? "gmail" : "custom",
      authKind: gmailAccount ? "oauth2" : "password", createdAt: 1, imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true,
      smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true });
    secrets.setPassword(id, gmailAccount ? JSON.stringify({ accessToken: id + "-token", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600000,
      googleClientId: config.loadGoogleClient().clientId, grantedScopes: config.BUNDLE_SCOPES.google }) : "synthetic-only");
    if (gmailAccount) db.enableGmail(id);
    db.replaceFolders(id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox", providerId: gmailAccount ? "INBOX" : null },
      { path: "Archive", name: "Archive", wellKnown: null, providerId: gmailAccount ? "Label_archive" : null },
      { path: "Trash", name: "Trash", wellKnown: "deleteditems", providerId: gmailAccount ? "TRASH" : null }], "/");
    if (gmailAccount) {
      const providerId = id + "-source", mapped = db.rememberGmail(id, { providerId, labelIds: ["INBOX", "UNREAD"] });
      messages.set(id + ":" + providerId, { raw: RAW, labels: ["INBOX", "UNREAD"] });
      db.insertMessage({ id: id + "-message", accountId: id, folderPath: "INBOX", uid: mapped.local_uid, uidValidity: db.accountById(id).gmail_generation,
        rfcMessageId: "<duplicate@fixture.invalid>", date: new Date(DATE).toISOString(), listSortTs: DATE, unread: true, bodyComplete: true, textBody: "Complete body" });
      db.updateMessage(id + "-message", { gmail_id: providerId });
    }
  }
  remote.withClient = async (account, token, work, options) => {
    await hook("connect:" + account.id);
    if (account.mail_transport === "gmail_api") return originalClient(account, token, work, options);
    const client = { capabilities: new Map([["UIDPLUS", true]]), mailbox: null,
      async list() { return [{ path: "Archive", name: "Archive", delimiter: "/", flags: new Set() }]; },
      async exec(_command, _attrs, handlers) { await handlers.untagged?.OK?.({ attributes: [{ section: [{ type: "ATOM", value: "UIDVALIDITY" }, { type: "ATOM", value: "22" }] }] }); return { response: { attributes: [{ section: [{ type: "ATOM", value: "READ-WRITE" }] }] }, next() {} }; },
      async mailboxOpen(folder, settings) { await this.exec("SELECT", [], { untagged: {} }); this.mailbox = { path: folder, uidValidity: 22, readOnly: !!settings.readOnly, permanentFlags: new Set(["\\Seen", "\\Flagged"]) }; return this.mailbox; },
      async getMailboxLock(folder, settings) { await this.mailboxOpen(folder, settings); return { release() {} }; },
      async append(folder, raw, flags, date) { uploads++; const uid = 100 + uploads; imapCopies.set(uid, { raw: Buffer.from(raw), flags, date }); return { uid, uidValidity: 22 }; },
      async *fetch(uid) { const saved = imapCopies.get(Number(uid)); if (saved) yield { uid: Number(uid), size: saved.raw.length, flags: new Set(saved.flags), internalDate: saved.date }; },
      async download(uid) { return { content: Readable.from([imapCopies.get(Number(uid)).raw]) }; },
      messageMove() { assert.fail("Gmail-source Move must never call IMAP MOVE"); }, messageDelete() { assert.fail("no IMAP delete/expunge"); },
    };
    return work(client);
  };
  const params = (source = "a", target = "b", mode = "move") => {
    const views = engine.accountViews(), from = views.find(row => row.id === source), to = views.find(row => row.id === target);
    return { mode, items: [{ emailId: source + "-message", accountId: source }],
      contextOwners: [owners.capture(from, { id: source + "-message", accountId: source, folderId: "INBOX" })], destinationAccountId: target,
      destinationOwner: { accountId: target, bodyEpoch: to.bodyEpoch, connection: owners.connection(to) }, folderId: gmail || target === "a" ? "Label_archive" : "Archive" };
  };
  const copy = async (source = "a", target = "b") => {
    const review = await call("mail:crossMailboxCopy", { action: "review", ...params(source, target, "copy") }); assert.equal(review.success, true, JSON.stringify(review.error));
    const result = await call("mail:crossMailboxCopy", { action: "copy", reviewId: review.data.reviewId, emailId: source + "-message", accountId: source });
    assert.equal(result.success, true, JSON.stringify(result.error)); assert.equal(result.data.status, "copied"); return review.data;
  };
  const reviewMove = async (source = "a", target = "b") => {
    const reply = await call("mail:crossMailboxMove", { action: "review", ...params(source, target) }); assert.equal(reply.success, true, JSON.stringify(reply.error)); return reply.data;
  };
  const move = (review, source = "a", owner) => call("mail:crossMailboxMove", { action: "move", confirmed: true, reviewId: review.reviewId, emailId: source + "-message", accountId: source }, owner);
  try {
    await engine.init();
    if (kind === "gate") {
      assert.equal((await call("mail:crossMailboxMove", { action: "capabilities" })).data.moveEnabled, false);
      assert.equal((await call("mail:crossMailboxMove", { action: "review" })).error.code, "move_gated");
      assert.equal(wire.length, 0); assert.equal(fs.existsSync(path.join(dir, "mailbox-move-recovery.sqlite")), false); return;
    }
    seed("a"); seed("b", gmail); await copy();
    if (kind === "both-directions") {
      await copy("b", "a"); const [a, b] = await Promise.all([reviewMove(), reviewMove("b", "a")]);
      const results = await Promise.all([move(a), move(b, "b")]); assert.ok(results.every(reply => reply.success && reply.data.status === "moved"));
      assert.equal(trashes, 2); assert.equal(uploads, 2); assert.equal(imports.size, 2); return;
    }
    const review = await reviewMove();
    if (kind === "window" || kind === "navigation") {
      if (kind === "window") { sender.destroyed = true; sender.emit("destroyed"); }
      else { sender.emit("did-start-navigation", {}, "fixture://other", false, true); sender.mainFrame = {}; }
      assert.equal((await move(review)).success, false); assert.equal(trashes, 0); return;
    }
    if (kind === "other-window") {
      const other = new EventEmitter(); other.mainFrame = {}; other.isDestroyed = () => false;
      assert.equal((await move(review, "a", { sender: other, senderFrame: other.mainFrame })).success, false); assert.equal(trashes, 0); return;
    }
    if (kind.startsWith("credential-")) {
      const side = kind.slice("credential-".length), blocked = held(); let entered = false;
      secrets.getPasswordAsync = async (...args) => { if (args[0] === side && !entered) { entered = true; await blocked.promise; } return originalRead(...args); };
      const moving = move(review); while (!entered) await tick(); secrets.setPassword(side, "synthetic replacement grant"); blocked.release();
      assert.equal((await moving).success, false); assert.equal(trashes, 0); return;
    }
    if (kind.startsWith("remove-")) {
      const side = kind.slice("remove-".length), blocked = held(); let entered = false;
      hook = async stage => { if (stage === "connect:" + side && !entered) { entered = true; await blocked.promise; } };
      const moving = move(review); while (!entered) await tick();
      assert.equal((await call("mail:removeAccount", { accountId: side })).success, true); seed(side, side === "a" || gmail); blocked.release();
      assert.equal((await moving).success, false); assert.equal(trashes, 0); return;
    }
    if (kind === "destroy-during-read" || kind === "cancel-after-post") {
      const blocked = held(); let entered = false;
      hook = async stage => { if (!entered && (kind === "cancel-after-post" ? stage === "after-post" : stage.includes("http:a:GET:/messages/a-source"))) { entered = true; await blocked.promise; } };
      const moving = move(review); while (!entered) await tick(); sender.destroyed = true; sender.emit("destroyed"); blocked.release();
      const result = await moving;
      if (kind === "cancel-after-post") { assert.equal(result.data.status, "unknown"); assert.equal(trashes, 1); }
      else { assert.equal(result.success, false); assert.equal(trashes, 0); } return;
    }
    const result = await move(review); assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.data.status, kind === "lost-ack" ? "unknown" : "moved"); assert.equal(trashes, 1); assert.equal(uploads, 1);
    assert.equal((await move(review)).data.status, kind === "lost-ack" ? "unknown" : "already_moved"); assert.equal(trashes, 1);
    assert.ok(imports.size || imapCopies.size); assert.ok(wire.every(row => row.method !== "DELETE"));
  } finally {
    secrets.getPasswordAsync = originalRead; remote.withClient = originalClient;
    await engine.stopLocalImports(); engine.closeMailboxMoveForTest(); engine.closeMailboxCopyForTest(); engine.closeLocalArchiveForTest(); await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (process.argv[2] === "fixture") scenario(process.argv[3]).then(() => process.exit(0), error => { console.error(error); process.exit(1); });
else {
  const { test } = require("node:test");
  for (const kind of ["gate", "gmail-gmail", "gmail-imap", "both-directions", "window", "navigation", "other-window", "credential-a", "credential-b", "remove-a", "remove-b", "destroy-during-read", "cancel-after-post", "lost-ack"]) {
    test("actual engine Gmail source Move " + kind, () => {
      const child = spawnSync(process.execPath, [__filename, "fixture", kind], { encoding: "utf8", timeout: 25000 });
      assert.equal(child.status, 0, child.stderr || child.stdout);
    });
  }
}
