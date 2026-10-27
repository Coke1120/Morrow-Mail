// Synthetic HTTP, temporary production SQLite, memory-only grants and DOM/IPC.
// No real credentials, sockets, Google calls or native-window claims.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { inspect } = require("node:util");
const { createRequire } = require("node:module");
const { gmailError, diagnosticMessage, MAX_ERROR_BYTES, ERROR_READ_MS } = require("../host/mail/gmail-error");
const { createGmailMailApi } = require("../host/mail/gmail-mail-api");
const privateText = "PRIVATE_BODY owner@private.invalid https://private.invalid/message/PRIVATE_ID ya29.PRIVATE_TOKEN";
const reply = (body, status = 403, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const legacy = reason => ({ error: { code: 403, message: privateText, errors: [{ reason, message: privateText, location: privateText }] } });
const rpc = (reason, status = "PERMISSION_DENIED") => ({ error: { code: 403, status, message: privateText,
  details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", domain: "googleapis.com", reason,
    metadata: { consumer: privateText, service: privateText, method: privateText, email: privateText } },
  { "@type": "type.googleapis.com/google.rpc.Help", links: [{ url: privateText, description: privateText }] }] } });
function privateAbsent(value) { assert.doesNotMatch(typeof value === "string" ? value : inspect(value, { depth: 10 }), /PRIVATE_|owner@private|https:\/\/private/); }
async function rejected(work) { try { await work; } catch (error) { return error; } assert.fail("Expected Gmail rejection"); }

test("legacy and RPC reasons distinguish quota, permission, disabled API and domain policy", async () => {
  const cases = [
    ...["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded"].map(reason => [legacy(reason), "quota", "rate_limit", reason]),
    [legacy("insufficientPermissions"), "permission", "scope_missing", "insufficientPermissions"],
    [legacy("accessNotConfigured"), "api_disabled", "gmail_api_disabled", "accessNotConfigured"],
    [legacy("domainPolicy"), "domain_policy", "gmail_domain_policy", "domainPolicy"],
    ...["RATE_LIMIT_EXCEEDED", "RESOURCE_QUOTA_EXCEEDED"].map(reason => [rpc(reason), "quota", "rate_limit", reason]),
    [rpc("ACCESS_TOKEN_SCOPE_INSUFFICIENT"), "permission", "scope_missing", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"],
    [rpc("SERVICE_DISABLED"), "api_disabled", "gmail_api_disabled", "SERVICE_DISABLED"],
  ];
  for (const [body, category, code, reason] of cases) {
    const error = await gmailError(reply(body), "messages.list");
    assert.equal(error.code, code); assert.equal(error.status, 403); assert.equal(error.operationIssued, false);
    assert.equal(error.gmailDiagnostic.category, category); assert.equal(error.gmailDiagnostic.reason, reason);
    assert.equal(error.gmailDiagnostic.operation, "messages.list"); assert.match(error.message, /HTTP 403/);
    assert.ok(error.message.includes(reason)); assert.ok(error.message.length <= 280);
    privateAbsent(error); privateAbsent(JSON.stringify(error));
    assert.equal(Object.hasOwn(error, "cause"), false); assert.equal(Object.hasOwn(error, "providerDetail"), false);
  }
});

test("HTTP evidence survives absent/unsupported/conflicting details without a false missing-scope claim", async () => {
  const conflict = legacy("domainPolicy"); conflict.error.errors.push({ reason: "rateLimitExceeded" });
  const wrongType = rpc("SERVICE_DISABLED"); wrongType.error.details[0]["@type"] = "private.ErrorInfo";
  const wrongDomain = rpc("SERVICE_DISABLED"); wrongDomain.error.details[0].domain = privateText;
  for (const body of [{}, null, [], { error: privateText }, legacy("forbidden"), legacy(privateText),
    { error: { status: "PERMISSION_DENIED" } }, rpc(privateText), conflict, wrongType, wrongDomain]) {
    const error = await gmailError(reply(body), privateText);
    assert.equal(error.code, "provider"); assert.equal(error.gmailDiagnostic.category, "unknown");
    assert.equal(error.gmailDiagnostic.operation, "unknown"); assert.match(error.message, /cause unknown/); privateAbsent(error);
  }
  const resource = await gmailError(reply({ error: { status: "RESOURCE_EXHAUSTED" } }), "messages.list");
  assert.equal(resource.code, "rate_limit"); assert.equal(resource.gmailDiagnostic.providerStatus, "RESOURCE_EXHAUSTED");
  const badStatus = await gmailError(reply({ error: { status: privateText } }), "messages.get");
  assert.equal(badStatus.gmailDiagnostic.providerStatus, "unknown"); privateAbsent(badStatus);
  for (const [status, code, issued] of [[401, "auth", false], [429, "rate_limit", false], [408, "provider", true], [500, "provider", true]]) {
    const error = await gmailError(reply(legacy("insufficientPermissions"), status, { "retry-after": "999999" }), "messages.send", { method: "POST" });
    assert.equal(error.status, status); assert.equal(error.code, code); assert.equal(error.operationIssued, issued);
    assert.equal(error.retryAfterMs, 15 * 60 * 1000);
  }
});

test("malformed, oversized and unreadable error bodies have bounded safe fallbacks", async () => {
  for (const text of ["", "{", "<html>" + privateText, JSON.stringify({ error: { errors: {} } }),
    JSON.stringify({ error: { message: "界".repeat(MAX_ERROR_BYTES), errors: [{ reason: "domainPolicy" }] } })]) {
    const error = await gmailError(new Response(text, { status: 403 }), "messages.list");
    assert.equal(error.code, "provider"); assert.match(error.message, /cause unknown/); privateAbsent(error);
  }
  for (const headers of [{}, { "content-length": "1" }, { "content-length": String(MAX_ERROR_BYTES + 1) }]) {
    let cancelled = false, pulls = 0;
    const response = new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(MAX_ERROR_BYTES + 1)); },
      cancel() { cancelled = true; },
    }), { status: 403, headers });
    const error = await gmailError(response, "messages.list");
    assert.equal(error.code, "provider"); assert.equal(cancelled, true); assert.ok(pulls <= 2);
  }
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateText)); } }), { status: 403 });
  const error = await gmailError(broken, "messages.list"); assert.equal(error.code, "provider"); privateAbsent(error);
  let emptyCancelled = false;
  const empty = await gmailError(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); },
    cancel() { emptyCancelled = true; } }), { status: 403 }), "messages.list");
  assert.equal(empty.code, "provider"); assert.equal(emptyCancelled, true, "empty chunks cannot starve the read deadline");
  const noStream = await gmailError({ status: 403, text() { assert.fail("Unbounded text fallback is forbidden"); } }, "messages.list");
  assert.equal(noStream.code, "provider");
  const exact = JSON.stringify(legacy("domainPolicy"));
  const boundary = await gmailError(new Response(exact + " ".repeat(MAX_ERROR_BYTES - Buffer.byteLength(exact)), { status: 403 }), "messages.list");
  assert.equal(boundary.code, "gmail_domain_policy", "the exact byte budget is accepted");
  const chunks = Buffer.from(JSON.stringify(rpc("SERVICE_DISABLED")));
  const split = await gmailError(new Response(new ReadableStream({ start(controller) {
    for (const byte of chunks) controller.enqueue(Uint8Array.of(byte)); controller.close();
  } }), { status: 403 }), "messages.list");
  assert.equal(split.code, "gmail_api_disabled", "chunk boundaries do not change parsing");
});

test("stalled, aborted and cancellation-resistant streams cannot hide a known HTTP result", async () => {
  let cancelled = false;
  const stalled = new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), { status: 403 });
  const error = await gmailError(stalled, "messages.send", { method: "POST" });
  assert.equal(error.code, "provider"); assert.equal(error.operationIssued, false); assert.equal(cancelled, true);
  assert.equal(ERROR_READ_MS, 1500);
  const controller = new AbortController(); let abortedCancel = false;
  const response = new Response(new ReadableStream({ cancel() { abortedCancel = true; } }), { status: 429 });
  const pending = gmailError(response, "messages.send", { method: "POST", signal: controller.signal });
  controller.abort(new Error(privateText));
  const aborted = await pending;
  assert.equal(aborted.status, 429); assert.equal(aborted.code, "rate_limit"); assert.equal(aborted.operationIssued, false);
  assert.equal(abortedCancel, true); privateAbsent(aborted);
});

test("transport diagnostics use static operations and never resubmit writes", async () => {
  const steps = [
    [api => api.profile(), "profile.get"], [api => api.listMessages({ query: privateText }), "messages.list"],
    [api => api.getMessage("PRIVATE_ID"), "messages.get"], [api => api.attachment("PRIVATE_ID", "PRIVATE_PART"), "attachments.get"],
    [api => api.history({ startHistoryId: "12345" }), "history.list"], [api => api.listDrafts(), "drafts.list"],
    [api => api.getDraft("PRIVATE_ID"), "drafts.get"], [api => api.saveDraft({ raw: Buffer.from(privateText) }), "drafts.create"],
    [api => api.saveDraft({ draftId: "PRIVATE_ID", raw: Buffer.from(privateText) }), "drafts.update"],
    [api => api.modifyLabels("PRIVATE_ID", ["PRIVATE_LABEL"]), "messages.modify"],
    [api => api.send({ raw: Buffer.from(privateText), confirmed: true }), "messages.send"],
    [api => api.getLabel("PRIVATE_LABEL"), "labels.get"], [api => api.labels(), "labels.list"],
    [api => api.createLabel("PRIVATE_LABEL"), "labels.create"], [api => api.renameLabel("PRIVATE_ID", "PRIVATE_LABEL"), "labels.update"],
    [api => api.deleteLabel("PRIVATE_ID"), "labels.delete"],
  ];
  for (const [work, operation] of steps) {
    let calls = 0;
    const api = createGmailMailApi({ accessToken: async () => "PRIVATE_TOKEN", fetchImpl: async () => { calls++; return reply(rpc("SERVICE_DISABLED")); } });
    const error = await rejected(work(api));
    assert.equal(error.gmailDiagnostic.operation, operation); assert.equal(error.code, "gmail_api_disabled");
    assert.equal(calls, 1); assert.equal(error.operationIssued, false); privateAbsent(error);
  }
  // Trash has an intentional metadata read before its single submitted write.
  for (const [work, operation] of [[api => api.trash("PRIVATE_ID"), "messages.trash"], [api => api.restoreTrash({ messageId: "PRIVATE_ID" }), "messages.untrash"]]) {
    const calls = [];
    const api = createGmailMailApi({ accessToken: async () => "PRIVATE_TOKEN", fetchImpl: async (_url, options) => {
      calls.push(options.method); return options.method === "GET" ? reply({ id: "PRIVATE_ID" }, 200) : reply(legacy("rateLimitExceeded"));
    } });
    const error = await rejected(work(api)); assert.equal(error.gmailDiagnostic.operation, operation); privateAbsent(error);
    assert.equal(calls.filter(method => method === "POST").length, 1);
  }
  // A subtree move keeps its partial-result receipt and existing request count.
  let calls = 0;
  const api = createGmailMailApi({ accessToken: async () => "PRIVATE_TOKEN", fetchImpl: async (_url, options) => {
    calls++;
    return options.method === "GET" ? reply({ labels: [{ id: "source", name: "Source", type: "user" }, { id: "dest", name: "Dest", type: "user" }] }, 200)
      : reply(legacy("domainPolicy"));
  } });
  const partial = await rejected(api.moveLabel("source", "dest"));
  assert.equal(partial.code, "partial"); assert.equal(partial.failed.length, 1); assert.equal(partial.moved.length, 0);
  assert.match(partial.message, /domainPolicy/); privateAbsent(partial); assert.equal(calls, 2);
});

test("engine sync activity, IPC, Debug log and actual DOM keep safe details without a false auth gate", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-gmail-diagnostics-"));
  const names = ["MORROW_MAIL_DIR", "MORROW_USER_DATA", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS", "MORROW_GOOGLE_OAUTH_FILE", "MORROW_GOOGLE_OAUTH_JSON"];
  const originalEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_AI_CONFIG_DIR: directory, MORROW_MAIL_SECRETS: "memory",
    MORROW_GOOGLE_OAUTH_JSON: JSON.stringify({ installed: { client_id: "diagnostics.apps.googleusercontent.com", client_secret: "synthetic-only" } }) });
  delete process.env.MORROW_GOOGLE_OAUTH_FILE;
  const priorFetch = global.fetch, net = require("node:net"), priorConnect = net.Socket.prototype.connect;
  let sockets = 0, signins = 0;
  net.Socket.prototype.connect = function () { sockets++; throw new Error("Socket forbidden in synthetic diagnostics test"); };
  const db = require("../host/mail/db"), secrets = require("../host/mail/secrets"), oauth = require("../host/mail/oauth"), config = require("../host/mail/oauth-config");
  const priorSignIn = oauth.signIn; oauth.signIn = async () => { signins++; throw new Error("Unexpected sign-in"); };
  const debug = require("../host/debug-log"), syncRetry = require("../shared/sync-retry"), events = [], timers = [];
  const filename = require.resolve("../host/mail/engine"), load = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, exports: module.exports, __dirname: path.dirname(filename), process, console,
    Buffer, URL, TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
    require(name) {
      if (name === "electron") return { BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send(channel, payload) { events.push({ channel, payload: structuredClone(payload) }); } } }] } };
      if (name === "../../shared/sync-retry") return { ...syncRetry, createRetryScheduler(options) {
        return syncRetry.createRetryScheduler({ ...options, setTimer(fn, ms) { timers.push(ms); return 1; }, clearTimer() {} });
      } };
      return load(name);
    },
  });
  const engine = module.exports, answer = (channel, params) => engine.answer(channel, [params]);
  const { JSDOM } = require("jsdom"), { renderer } = require("./check-ux-workflows");
  const dom = new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8"));
  const ui = renderer({ document: dom.window.document, setTimeout: () => 1, clearTimeout() {} });
  try {
    await engine.init();
    const bodies = [legacy("rateLimitExceeded"), legacy("insufficientPermissions"), rpc("SERVICE_DISABLED"), legacy("domainPolicy"), legacy(privateText)];
    for (const listing of [true, false]) for (const [index, body] of bodies.entries()) {
      const accountId = "fixture-" + Number(listing) + "-" + index;
      db.insertAccount({ id: accountId, email: "Synthetic mailbox", username: "Synthetic mailbox", profile: "gmail", authKind: "oauth2", createdAt: 1,
        imapHost: "imap.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.invalid", smtpPort: 465, smtpTls: true });
      db.enableGmail(accountId); db.replaceFolders(accountId, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox", providerId: "INBOX" }]);
      const credential = JSON.stringify({ provider: "google", purpose: "imap", googleClientId: config.credentials("google").clientId,
        accessToken: "PRIVATE_TOKEN", refreshToken: "PRIVATE_REFRESH", expiresAt: Date.now() + 3600000, grantedScopes: config.SCOPES.google });
      secrets.setPassword(accountId, credential);
      let calls = 0;
      global.fetch = async url => { calls++; return String(url).endsWith("/profile") ? reply({ historyId: "1" }, 200) : reply(body, 403, { "retry-after": "2" }); };
      const scope = { accountId, ...(listing ? {} : { folderId: "INBOX" }) };
      await answer("mail:listFromNetwork", scope);
      const activity = answer("mail:getSyncStatus", scope).data;
      const operation = listing ? "labels.list" : "messages.list";
      assert.ok(activity.message.includes(operation), JSON.stringify(activity)); privateAbsent(activity);
      assert.equal(activity.state, index === 0 ? "paused" : "error");
      assert.equal(!!db.accountById(accountId).auth_error, index === 1, "only permission evidence sets the 403 sign-in gate");
      assert.equal(calls, listing ? 1 : 2); assert.equal(secrets.getPassword(accountId), credential);
      assert.ok(events.some(event => event.channel === "mail:syncStatus" && event.payload.message === activity.message));
      assert.ok(debug.recent().some(line => line.text.includes(activity.message))); privateAbsent(debug.recent());
      ui.context.activity = activity; ui.context.accountId = accountId;
      ui.run(`state.view='mail'; state.accountId=accountId; state.folderId='INBOX'; state.accounts=[{id:accountId}]; rememberSyncStatus(activity); paintSyncControl();`);
      for (const value of [dom.window.document.getElementById("refresh").title, dom.window.document.getElementById("refresh").getAttribute("aria-label"),
        dom.window.document.getElementById("sync-detail").title, ui.run("syncDetail(activity)")]) {
        assert.ok(value.includes(operation)); assert.ok(value.includes("HTTP 403")); privateAbsent(value);
      }
      if (index === 0) {
        await answer("mail:listFromNetwork", scope);
        assert.equal(calls, listing ? 1 : 2, "the existing rate gate prevents another read");
        assert.ok(answer("mail:getSyncStatus", scope).data.message.includes(operation), "paused diagnostics survive later status reads");
      }
    }
    assert.deepEqual(timers, [5000, 5000, 5000, 5000, 5000, 5000], "non-credential 403s use only existing read retries");
    assert.equal(sockets, 0); assert.equal(signins, 0);
    const remote = require("../host/mail/remote");
    const auth = await gmailError(reply(legacy("authError"), 401), "messages.get");
    assert.equal(remote.explain(auth), diagnosticMessage(auth), "generic IMAP auth text cannot replace Gmail diagnostics");
    auth.message = privateText; assert.equal(remote.explain(auth), diagnosticMessage(auth)); privateAbsent(remote.explain(auth));
    ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog"); ui.run("paintFeatureCatalog()");
    for (const id of ["features-catalog", "settings-gmail-error-help", "gmail-error-diagnostics-note"]) {
      const text = dom.window.document.getElementById(id).textContent;
      for (const pattern of [/403/, /permission/i, /domain policy/i, /unknown/i]) assert.match(text, pattern);
    }
  } finally {
    await engine.stopIdle(); require("../host/mail/actions").resetForTests(); await db.close(); dom.window.close();
    global.fetch = priorFetch; net.Socket.prototype.connect = priorConnect; oauth.signIn = priorSignIn;
    for (const [name, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
