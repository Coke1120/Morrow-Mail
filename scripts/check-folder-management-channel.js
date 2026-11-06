"use strict";

// Exercise the real engine/channel, memory-secret facade and Gmail supplier.
// A subprocess owns the temporary profile so SQLite locks also close on Windows.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

async function fixture() {
  const engine = require("../host/mail/engine"), db = require("../host/mail/db"), remote = require("../host/mail/remote");
  const secrets = require("../host/mail/secrets"), oauth = require("../host/mail/oauth"), config = require("../host/mail/oauth-config");
  const Database = require("better-sqlite3");
  oauth.accessTokenFor = async () => "synthetic-access-token";
  await engine.init();
  function seed(id, profile, authKind = "password") {
    db.insertAccount({ id, email: id + "@fixture.invalid", username: id + "@fixture.invalid", profile, authKind, createdAt: 10,
      imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true });
    secrets.setPassword(id, authKind === "oauth2" ? JSON.stringify({ accessToken: "synthetic-access-token", refreshToken: "synthetic-refresh-token",
      googleClientId: config.loadGoogleClient().clientId, grantedScopes: config.BUNDLE_SCOPES.google, expiresAt: Date.now() + 3600000 }) : "synthetic-password");
    if (profile === "gmail" && authKind === "oauth2") db.setMailTransport(id, "gmail_api");
  }
  seed("gmail", "gmail", "oauth2");
  for (const profile of ["outlook", "yahoo", "custom"]) seed(profile, profile);
  seed("legacy", "gmail");
  let labels = [{ id: "INBOX", name: "Inbox", type: "system" }, { id: "Label_1", name: "User", type: "user" }];
  const requests = []; let failCreate = false, held = null;
  global.fetch = async (input, options) => {
    const url = new URL(input), method = options.method || "GET";
    assert.equal(url.origin, "https://gmail.googleapis.com"); assert.ok(url.pathname.startsWith("/gmail/v1/users/me/labels"));
    assert.equal(options.headers.authorization, "Bearer synthetic-access-token"); requests.push({ path: url.pathname, method });
    if (held && method === "GET") await held;
    if (method === "POST") {
      if (failCreate) return new Response("{}", { status: 503 });
      const value = { id: "Label_" + labels.length, name: JSON.parse(options.body).name, type: "user" }; labels.push(value);
      return new Response(JSON.stringify(value), { status: 200 });
    }
    assert.equal(method, "GET", "no real removal is allowed in this channel fixture");
    return new Response(JSON.stringify({ labels }), { status: 200 });
  };
  const originalClient = remote.withClient;
  remote.withClient = (account, secret, work, options) => account.mail_transport === "gmail_api" ? originalClient(account, secret, work, options)
    : work({ list: async () => [{ path: "INBOX", delimiter: ".", flags: new Set(["\\Inbox"]) },
      { path: "Parent", name: "Parent", delimiter: ".", flags: new Set(["\\Noselect"]) },
      { path: "Parent.Child", name: "Child", delimiter: ".", flags: new Set(["\\Noinferiors"]) }],
      mailboxCreate: async () => { throw new Error("not requested in this protocol fixture"); } });
  const invoke = (accountId, action, extra = {}) => engine.answer("mail:folderManagement", [{ accountId, action, expectedEpoch: 0, ...extra }]);
  try {
    assert.equal((await invoke("gmail", "list", { expectedEpoch: undefined })).success, false);
    assert.equal(requests.length, 0);
    for (const accountId of ["outlook", "yahoo", "custom", "legacy"]) {
      const result = await invoke(accountId, "list"); assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.data.backend, "imap"); assert.equal(result.data.delimiter, ".");
      assert.equal(result.data.folders[1].selectable, false); assert.equal(result.data.folders[1].canCreate, true);
      assert.equal(result.data.folders[2].parentId, "Parent"); assert.equal(result.data.folders[2].canCreate, false);
      assert.ok(result.data.folders.every(folder => !folder.deletion.enabled));
    }
    const common = await invoke("gmail", "list"); assert.equal(common.success, true);
    assert.equal(common.data.folders.find(folder => folder.id === "INBOX").deletion.enabled, false);
    assert.equal(common.data.folders.find(folder => folder.id === "Label_1").deletion.enabled, true);
    assert.equal(secrets.getPassword("gmail:organize"), null, "common transport requires no new organize grant");
    const review = await invoke("gmail", "review", { intent: "create", folderId: "Label_1" }); assert.equal(review.success, true);
    const created = await invoke("gmail", "create", { reviewId: review.data.reviewId, name: "Child" }); assert.equal(created.success, true, JSON.stringify(created));
    assert.ok(labels.some(label => label.name === "User/Child")); assert.ok(db.foldersFor("gmail").some(folder => folder.path === "User/Child"));
    const removal = await invoke("gmail", "review", { intent: "delete", folderId: "Label_1", expectedName: "User" });
    const pending = await invoke("gmail", "delete", { reviewId: removal.data.reviewId, confirmation: "confirm" });
    assert.equal(pending.success, true); assert.equal(pending.data.phase, "pending"); assert.equal(pending.data.canUndo, true);
    const count = requests.length;
    const undo = await invoke("gmail", "undo", { operationId: pending.data.id }); assert.equal(undo.data.phase, "cancelled"); assert.equal(requests.length, count);
    const legacyDelete = await engine.answer("mail:deleteProviderFolder", [{ accountId: "gmail", folderId: "Label_1" }]);
    assert.equal(legacyDelete.success, false); assert.equal(requests.length, count);
    failCreate = true;
    const failureReview = await invoke("gmail", "review", { intent: "create" });
    const failed = await invoke("gmail", "create", { reviewId: failureReview.data.reviewId, name: "Uncertain" });
    assert.equal(failed.success, false); assert.equal(failed.error.code, "folder_uncertain");
    assert.equal(requests.filter(request => request.method === "POST").length, 2, "each write submits once");
    const journal = new Database(path.join(process.env.MORROW_MAIL_DIR, "folder-recovery.sqlite"), { readonly: true });
    const records = journal.prepare("SELECT body FROM folder_operations").all().map(row => JSON.parse(row.body)); journal.close();
    assert.equal(records.find(record => record.sourceId === "Uncertain").phase, "uncertain");
    const stored = JSON.stringify(records); assert.ok(!stored.includes("synthetic-access-token")); assert.ok(!stored.includes("synthetic-password")); assert.ok(!stored.includes("fixture.invalid"));
    const originalGrant = secrets.getPassword("gmail");
    let release; held = new Promise(resolve => { release = resolve; });
    const reading = invoke("gmail", "list"); await new Promise(resolve => setImmediate(resolve));
    secrets.setPassword("gmail", "replacement synthetic secret"); held = null; release();
    assert.equal((await reading).success, false, "credential replacement retires awaited Gmail listing");
    const beforeStale = requests.length;
    assert.equal((await invoke("gmail", "list", { expectedEpoch: 999 })).success, false); assert.equal(requests.length, beforeStale);
    secrets.setPassword("gmail", originalGrant);
    const broken = new Database(path.join(process.env.MORROW_MAIL_DIR, "folder-recovery.sqlite"));
    broken.prepare("UPDATE folder_operations SET body=?").run('{"invalid":"synthetic corruption"}'); broken.close();
    const readable = await invoke("gmail", "list"); assert.equal(readable.success, true); assert.equal(readable.data.recoveryAvailable, false);
    assert.equal(readable.data.folders.length, labels.length); assert.ok(readable.data.folders.every(folder => !folder.canCreate && !folder.deletion.enabled));
    let credentialReads = 0; const read = secrets.getPasswordAsync;
    secrets.getPasswordAsync = (...args) => { credentialReads++; return read(...args); };
    const beforeGuard = requests.length;
    for (const channel of ["mail:createProviderFolder", "mail:renameProviderFolder", "mail:moveProviderFolder", "mail:moveFolder", "mail:createFolder"]) {
      const result = await engine.answer(channel, [{ accountId: "gmail", folderId: "Label_1", name: "Must not write" }]);
      assert.equal(result.success, false); assert.equal(result.error.code, "folder_recovery");
    }
    assert.equal(credentialReads, 0); assert.equal(requests.length, beforeGuard);
    console.log("folder-management-channel-ok (Gmail/Outlook/Yahoo/IMAP/legacy, real channel and supplier, durable intent, create/Undo, no replay, no extra grant)");
  } finally { await engine.stopLocalImports(); await engine.stopIdle(); await db.close(); }
}

if (process.argv.includes("--fixture")) fixture().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-folder-channel-"));
  try {
    const result = spawnSync(process.execPath, [__filename, "--fixture"], { stdio: "inherit", timeout: 30000, env: { ...process.env,
      MORROW_MAIL_DIR: dir, MORROW_USER_DATA: dir, MORROW_AI_CONFIG_DIR: dir, MORROW_MAIL_SECRETS: "memory", MORROW_GOOGLE_OAUTH_FILE: "",
      MORROW_GOOGLE_OAUTH_JSON: JSON.stringify({ installed: { client_id: "folder-fixture.apps.googleusercontent.com", client_secret: "fixture-only" } }) } });
    assert.ifError(result.error); assert.equal(result.status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
