"use strict";

// Real grants, cache projection and private state; synthetic clock/transport and
// memory credentials only. No user mailbox, AI service, network or Keychain.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter, once } = require("node:events");
const { Worker } = require("node:worker_threads");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-proactive-"));
const originalEnv = { data: process.env.MORROW_USER_DATA, secrets: process.env.MORROW_MAIL_SECRETS };
process.env.MORROW_USER_DATA = temp;
process.env.MORROW_MAIL_SECRETS = "memory";
const db = require("../host/mail/db");
const auth = require("../host/bot/auth");
const config = require("../host/bot/proactive-config");
const proactive = require("../host/bot/proactive");
const transport = require("../host/bot/proactive-transport");
const secrets = require("../host/mail/secrets");
const audit = require("../host/bot/audit");
const contract = require("../shared/bot-contract-v1.json");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };

function seed() {
  for (const id of ["a", "b"]) {
    db.insertAccount({ id, email: id + "@example.test", username: id, profile: "gmail", authKind: "oauth2",
      imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 465, smtpTls: true, createdAt: Date.now() });
    db.replaceFolders(id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], "/");
  }
  db.insertMessage({ id: "header-a", accountId: "a", folderPath: "INBOX", uid: 1, uidValidity: 1,
    subject: "Synthetic header", from: "Sender <sender@example.test>", snippet: "Ask the bot, not Morrow AI", unread: true,
    bodyComplete: false, date: new Date().toISOString(), listSortTs: 1 });
  db.insertMessage({ id: "html-a", accountId: "a", folderPath: "INBOX", uid: 2, uidValidity: 1,
    subject: "HTML", from: "sender@example.test", snippet: "Snippet", unread: true,
    htmlBody: "<p>Cached text</p><script>script-sentinel</script><style>style-sentinel</style><img src='https://never-fetch.invalid/x'>",
    bodyComplete: true, attachments: [{ filename: "never-push.bin", content: "attachment-byte-sentinel" }],
    date: new Date().toISOString(), listSortTs: 2 });
  db.insertMessage({ id: "other-b", accountId: "b", folderPath: "INBOX", uid: 1, uidValidity: 1,
    subject: "other-account-sentinel", snippet: "other-account-sentinel", bodyComplete: true, textBody: "private-b", date: new Date().toISOString(), listSortTs: 3 });
}

async function transportChecks() {
  for (const url of ["https://public.example/notify", "http://bot.tail.ts.net/n", "https://bot.tail.ts.net.evil/n",
    "https://bot.tail.ts.net/n?token=no", "https://token@bot.tail.ts.net/n", "https://bot.tail.ts.net/n#x", "http://127.0.0.2/n"]) {
    assert.throws(() => config.webhook(url));
  }
  for (const url of ["https://bot.tail.ts.net:8443/notify", "http://localhost:47832/n", "http://127.0.0.1/n", "https://[::1]/n"]) assert.equal(config.webhook(url), url);
  assert.equal(transport.tailnetAddress("100.64.0.1"), true);
  assert.equal(transport.tailnetAddress("100.127.255.254"), true);
  assert.equal(transport.tailnetAddress("fd7a:115c:a1e0::1"), true);
  for (const address of ["100.128.0.1", "192.168.1.1", "127.0.0.1", "8.8.8.8", "::1"]) assert.equal(transport.tailnetAddress(address), false);
  const dns = require("node:dns"), oldLookup = dns.lookup;
  try {
    dns.lookup = (_host, _options, cb) => cb(null, [{ address: "100.64.0.1", family: 4 }, { address: "1.2.3.4", family: 4 }]);
    await assert.rejects(new Promise((resolve, reject) => transport.privateLookup("bot.tail.ts.net", {}, (e, ip) => e ? reject(e) : resolve(ip))), /BLOCKED/);
    dns.lookup = (_host, _options, cb) => cb(null, [{ address: "100.64.0.1", family: 4 }]);
    assert.equal(await new Promise((resolve, reject) => transport.privateLookup("bot.tail.ts.net", {}, (e, ip) => e ? reject(e) : resolve(ip))), "100.64.0.1");
  } finally { dns.lookup = oldLookup; }
  const https = require("node:https"), oldRequest = https.request;
  let status = 200, size = 0, calls = 0, hold = false;
  try {
    https.request = (url, options, callback) => {
      calls++;
      assert.equal(url.hostname, "bot.tail.ts.net");
      assert.equal(options.lookup, transport.privateLookup);
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.agent, false);
      assert.equal(options.headers.authorization, "Bearer fixture-token");
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = body => {
        assert.equal(body.toString("utf8"), "{}");
        assert.equal(options.headers["x-webhook-signature-v2"], undefined, "Bearer mode keeps its original headers");
        assert.equal(options.headers["x-request-id"], undefined);
        if (hold) return;
        queueMicrotask(() => {
          const response = new EventEmitter(); response.statusCode = status;
          response.headers = { location: "https://unapproved.invalid" };
          callback(response);
          response.emit("data", Buffer.alloc(size)); response.emit("end");
        });
      };
      return request;
    };
    const send = options => transport.post("https://bot.tail.ts.net/n", "{}", { token: "fixture-token", deliveryId: "fixture", ...options });
    assert.equal((await send()).code, "OK");
    status = 302; assert.equal((await send()).code, "WEBHOOK_REDIRECT_REJECTED"); assert.equal(calls, 2, "no redirect follow-up");
    status = 503; assert.equal((await send()).retryable, true);
    status = 401; assert.equal((await send()).retryable, false);
    status = 200; size = 8193; assert.equal((await send()).code, "WEBHOOK_RESPONSE_TOO_LARGE");
    size = 0; hold = true; assert.equal((await send({ timeoutMs: 5 })).code, "WEBHOOK_TIMEOUT");
    const abort = new AbortController(), pending = send({ signal: abort.signal }); abort.abort();
    assert.equal((await pending).code, "CANCELLED");
    const before = calls;
    assert.equal((await transport.post("https://bot.tail.ts.net/n", "x".repeat(transport.MAX_BYTES + 1))).code, "PAYLOAD_TOO_LARGE");
    assert.equal(calls, before);
  } finally { https.request = oldRequest; }
}

async function stateChecks(clientId) {
  const grant = auth.load().store.grants.find(row => row.clientId === clientId);
  const file = path.join(temp, "bot-proactive-state.json");
  const original = fs.readFileSync(file, "utf8");
  let now = new Date(), posts = 0, scheduler;
  const codes = [];
  const state = seen => ({ version: 1, bots: { [clientId]: {
    binding: config.binding(grant), revision: grant.revision, seen, nextRunAt: now.toISOString(),
  } } });
  const deps = { now: () => now, listening: () => true, gate: { closed: false, run: work => work() },
    record: row => codes.push(row.code), post: async () => { posts++; return { code: "OK" }; } };
  try {
    for (const seen of [true, false, 1, 0, "cursor", [], null]) {
      fs.writeFileSync(file, JSON.stringify(state(seen)));
      assert.throws(() => proactive.readState(), /STATE_UNAVAILABLE/, `reject malformed seen: ${JSON.stringify(seen)}`);
      scheduler = proactive.createScheduler(deps);
      await scheduler.tick(); now = new Date(+now + 60000); await scheduler.tick();
      assert.equal(posts, 0, "corrupt cursor fails closed before a successful POST can be attempted");
      assert.deepEqual(codes.splice(0), ["STATE_UNAVAILABLE", "STATE_UNAVAILABLE"]);
      scheduler.dispose(); scheduler = null;
    }
    for (const bots of [true, false, 1, "cursor", [], null]) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, bots }));
      assert.throws(() => proactive.readState(), /STATE_UNAVAILABLE/, "cursor bot map must be a plain object");
    }
    for (const fault of ["seen-type", "seen-write", "cursor-write", "acknowledgement-write"]) {
      let persisted = state({}), loaded, failAcknowledgement = true, readable = true;
      posts = 0;
      scheduler = proactive.createScheduler({ ...deps,
        readState() {
          if (!readable) throw Error("synthetic state read failure");
          return (loaded = structuredClone(persisted));
        },
        writeState(next) {
          if (fault === "acknowledgement-write" && posts && failAcknowledgement) throw Error("synthetic acknowledgement write failure");
          persisted = structuredClone(next);
        },
        post: async () => {
          posts++;
          if (fault === "seen-type") loaded.bots[clientId].seen = true;
          if (fault === "seen-write") Object.freeze(loaded.bots[clientId].seen);
          if (fault === "cursor-write") Object.freeze(loaded.bots[clientId]);
          return { code: "OK" };
        },
      });
      await scheduler.tick();
      assert.equal(posts, 1, `${fault}: POST succeeded before the cursor failure`);
      assert.deepEqual(codes.splice(0), ["OK", "STATE_UNAVAILABLE"], `${fault}: cursor failure is audited`);
      assert.deepEqual(persisted.bots[clientId].seen, {}, "delivery acknowledgement was not persisted");
      const status = scheduler.statuses([grant])[clientId];
      assert.equal(status.halted, true, `${fault}: Settings sees the in-memory halt`);
      assert.equal(status.lastCode, "STATE_UNAVAILABLE");
      assert.equal(status.nextRunAt, null, "halted delivery has no runnable next slot");
      assert.equal(scheduler.statuses([{ ...grant, revision: grant.revision + 1 }])[clientId].halted, true, "a new revision cannot hide the halt");
      readable = false;
      assert.equal(scheduler.statuses([grant])[clientId].halted, true, "storage read failure cannot hide the halt");
      readable = true; failAcknowledgement = false;
      assert.deepEqual(scheduler.statuses([]), {}, "deleted grants are not exposed in Settings status");
      scheduler.pause(); scheduler.resume();
      now = new Date(+now + 60000); await scheduler.tick();
      now = new Date(+now + 60000); await scheduler.tick();
      assert.equal(posts, 1, `${fault}: halted bot cannot re-POST the same cached mail`);
      assert.deepEqual(codes.splice(0), [], "halted bots are skipped rather than retried");
      scheduler.dispose(); scheduler = null;
    }
  } finally {
    scheduler?.dispose(); fs.writeFileSync(file, original);
  }
}

async function isolatedSchedulerChecks(root) {
  const assert = require("node:assert/strict"), path = require("node:path"), Module = require("node:module");
  const load = Module.createRequire(path.join(root, "package.json"));
  const forbidden = new Set(["host/agent.js", "host/openai-client.js", "host/bot/drafts.js", "host/bot/send.js",
    "host/mail/engine.js", "host/mail/actions.js"].map(file => path.join(root, file)));
  const blocked = [];
  let probeService = false;
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    const file = Module._resolveFilename(request, parent, isMain);
    if (probeService && file === path.join(root, "host/bot/service.js")) return {};
    if (forbidden.has(file)) { blocked.push(file); throw Error("Scheduler loaded an action/model dependency: " + file); }
    return originalLoad.apply(this, arguments);
  };
  let scheduler, listener, http, createServer;
  try {
    const proactive = load("./host/bot/proactive");
    listener = load("./host/bot/listener-status");
    const grant = { clientId: "isolation-bot", installationId: "synthetic-installation", platform: "hermes_agent", revision: 1,
      accountIds: ["a"], capabilities: ["mail.headers.read"], expiry: { kind: "never" },
      proactive: { enabled: true, consentedAt: "2026-11-01T00:00:00.000Z", accountIds: ["a"], folder: "inbox", includeBody: false,
        webhookUrl: "https://bot.tail.ts.net/notify", schedule: { kind: "interval", everyMinutes: 1 } } };
    let now = new Date("2026-11-01T00:00:00.000Z"), state = { version: 1, bots: {} }, posts = 0;
    const items = [{ messageId: "synthetic-mail" }];
    scheduler = proactive.createScheduler({
      loadAccess: () => ({ ok: true, store: { enabled: true, installationId: grant.installationId, grants: [grant] } }),
      readState: () => structuredClone(state), writeState: next => { state = structuredClone(next); },
      now: () => now, db: { isReady: () => true, accountById: id => ({ id, created_at: 1 }) },
      reads: { listCached: () => ({ items, warnings: [], moreAvailable: false }) },
      onChange: () => () => {}, record() {}, post: async () => { posts++; return { code: "OK" }; },
    });
    await scheduler.tick(); assert.equal(posts, 0, "default listener starts stopped");
    listener.state.listening = true;
    await scheduler.tick(); now = new Date(+now + 60000); await scheduler.tick();
    assert.deepEqual(blocked, [], "transitive CommonJS loads must not reach Agent/model/mail-action modules");
    assert.equal(posts, 1, "default production listener and gate admit a synthetic delivery");
    now = new Date(+now + 60000); await scheduler.tick(); assert.equal(posts, 1, "successful delivery advances its cursor");
    items.push({ messageId: "second-synthetic-mail" }); listener.state.listening = false;
    now = new Date(+now + 60000); await scheduler.tick(); assert.equal(posts, 1, "listener loss blocks delivery");
    listener.state.listening = true;
    await scheduler.tick(); assert.equal(posts, 2, "listener recovery admits newly cached mail");
    assert.deepEqual(blocked, [], "caught load failures must not silently pass the import guard");
    const { EventEmitter } = require("node:events");
    const { HOST, PORT } = load("./host/bot/constants");
    http = load("node:http"); createServer = http.createServer;
    let bind = "ok";
    http.createServer = () => {
      const server = new EventEmitter();
      server.listen = (port, host, ready) => {
        assert.equal(port, PORT); assert.equal(host, HOST);
        queueMicrotask(() => { if (bind === "busy") server.emit("error", { code: "EADDRINUSE" }); else ready(); });
      };
      server.address = () => ({ address: bind === "bad" ? "0.0.0.0" : HOST, port: PORT });
      server.close = callback => callback?.(); server.closeAllConnections = () => {};
      return server;
    };
    probeService = true;
    const server = load("./host/bot/server");
    assert.equal(server.status, listener.status, "server and scheduler share the same status probe");
    listener.state.listening = false;
    const started = server.start();
    assert.equal(listener.status().listening, false, "pending binds do not admit proactive delivery");
    assert.deepEqual(await started, { listening: true, error: "", host: HOST, port: PORT, address: HOST });
    assert.equal(listener.status().listening, true, "successful binds publish listener readiness");
    await server.stop(); assert.equal(listener.status().listening, false, "stop clears shared readiness");
    for (const [mode, error] of [["busy", "port_in_use"], ["bad", "bad_bind"]]) {
      bind = mode;
      const status = await server.start();
      assert.equal(status.listening, false); assert.equal(status.error, error);
      assert.equal(listener.status().listening, false, "failed binds keep delivery closed");
      await server.stop(); assert.equal(listener.status().error, "");
    }
    assert.deepEqual(blocked, [], "listener lifecycle probes need no action/model modules");
  } finally {
    scheduler?.dispose(); if (listener) listener.state.listening = false;
    if (http) http.createServer = createServer;
    Module._load = originalLoad;
  }
}

async function importIsolationChecks() {
  const worker = new Worker(`(${isolatedSchedulerChecks.toString()})(${JSON.stringify(path.join(__dirname, ".."))}).catch(error => { throw error; });`, { eval: true });
  const timeout = setTimeout(() => { worker.terminate(); }, 30000);
  try {
    const [code] = await once(worker, "exit");
    assert.equal(code, 0, "cold scheduler import isolation failed or timed out");
  } finally { clearTimeout(timeout); await worker.terminate(); }
}

async function deletionChecks(settings) {
  const manage = require("../host/bot/manage");
  const file = path.join(temp, "bot-access.json");
  const event = { sender: { getURL: () => "file:///synthetic/renderer/index.html" } };
  for (const channel of ["bot:deleteGrant", "bot:revokeGrant"]) {
    const minted = auth.mint({ label: "Delete failure", platform: "hermes_agent", accountIds: ["a"], capabilities: ["mail.headers.read"] });
    const clientId = minted.grant.clientId;
    config.configure({ ...settings, clientId });
    auth.setEnabledFlag(true);
    const key = auth.load().store.grants.find(row => row.clientId === clientId).proactive.secretKey;
    const before = fs.readFileSync(file, "utf8");
    const rename = fs.renameSync;
    let writes = 0;
    try {
      fs.renameSync = (from, to) => {
        if (to === file) { writes++; throw Error("synthetic access-store write failure"); }
        return rename(from, to);
      };
      const failed = await manage.answer(channel, { clientId }, event);
      assert.equal(writes, 1, "the access-store write is attempted");
      assert.equal(failed.success, false, `${channel}: failed persistence is not reported as success`);
      assert.equal(failed.error.message, "Morrow could not store the grant.");
    } finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(file, "utf8"), before, "failed mutation leaves the grant unchanged");
    assert.ok(auth.authenticate(`Bearer ${minted.secret}`), "the incoming grant remains live");
    assert.equal(manage.snapshot().grants.find(row => row.clientId === clientId).proactive.hasSecret, true);
    assert.equal(await secrets.getPasswordAsync(key), settings.secret, "the referenced webhook credential remains available");
    const succeeded = await manage.answer(channel, { clientId }, event);
    assert.equal(succeeded.success, true, `${channel}: retry succeeds after storage recovers`);
    const remaining = auth.view().grants.find(row => row.clientId === clientId);
    if (channel === "bot:deleteGrant") assert.equal(remaining, undefined);
    else assert.ok(remaining.revokedAt);
    assert.equal(auth.authenticate(`Bearer ${minted.secret}`), null);
    assert.ok(!await secrets.getPasswordAsync(key), "committed removal/revocation retires the webhook credential");
  }
}

async function run() {
  let scheduler;
  try {
    await db.open(path.join(temp, "mail.sqlite")); seed();
    assert.deepEqual(Object.keys(auth.PLATFORMS), contract.platforms);
    assert.ok(db.selectBotHeaders("a", ["INBOX"], 50).every(row => !("html_body" in row) && !("text_body" in row)), "header-only digests do not materialize cached bodies");
    const mint = platform => auth.mint({ label: "Synthetic bot", platform, accountIds: ["a"], capabilities: ["mail.headers.read", "mail.bodies.read"] });
    assert.throws(() => mint("unknown"), /Choose Grok/);
    const legacy = mint(); assert.equal(legacy.grant.platform, "grok_bot");
    const file = path.join(temp, "bot-access.json"), stored = JSON.parse(fs.readFileSync(file));
    delete stored.grants[0].platform; delete stored.grants[0].proactive;
    fs.writeFileSync(file, JSON.stringify(stored));
    assert.equal(auth.view().grants[0].platform, "grok_bot", "missing platform migrates without authorizing push");
    assert.equal(auth.view().grants[0].proactive, null);
    const minted = mint("hermes_agent"), id = minted.grant.clientId;
    const settings = { clientId: id, platform: "hermes_agent", enabled: true, backgroundConfirmed: true,
      schedule: { kind: "interval", everyMinutes: 1 }, accountIds: ["a"], folder: "inbox", includeBody: false,
      webhookUrl: "https://bot.tail.ts.net:8443/notify", secret: "synthetic-push-secret" };
    assert.throws(() => config.configure({ ...settings, backgroundConfirmed: false }), /Tick Allow/);
    assert.throws(() => config.configure({ ...settings, accountIds: ["b"] }), /granted/);
    assert.throws(() => config.configure({ ...settings, schedule: { kind: "interval", everyMinutes: 0 } }), /interval/);
    assert.throws(() => config.configure({ ...settings, schedule: { kind: "cron", cron: "0 0 31 2 *" } }), /next year/);
    const headersOnly = auth.mint({ label: "Headers only", accountIds: ["a"], capabilities: ["mail.headers.read"] });
    assert.throws(() => config.configure({ ...settings, clientId: headersOnly.grant.clientId, includeBody: true }), /permission/);
    config.configure({ ...settings, includeBody: undefined });
    assert.equal(auth.view().grants.find(row => row.clientId === id).proactive.includeBody, false, "omitted body choice defaults to metadata only");
    assert.equal(auth.load().ok, true);
    assert.equal(auth.view().grants.find(row => row.clientId === id).proactive.hasSecret, true);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /synthetic-push-secret/);
    assert.doesNotMatch(JSON.stringify(auth.view()), /secretKey|synthetic-push-secret/);
    let now = new Date(), listening = false, closed = false, result = { code: "OK" };
    const sent = [];
    let secretGate = null, secretStarted = null;
    const deps = { now: () => now, listening: () => listening,
      gate: { get closed() { return closed; }, run: work => work() },
      secrets: { revision: secrets.revision, getPasswordAsync: async (...args) => {
        if (secretGate) { secretStarted.resolve(); await secretGate.promise; }
        return secrets.getPasswordAsync(...args);
      } },
      post: async (url, body, options) => { sent.push({ url, body, options }); return result; } };
    scheduler = proactive.createScheduler(deps);
    await scheduler.tick(); now = new Date(+now + 60000); await scheduler.tick(); assert.equal(sent.length, 0, "listener and access off");
    auth.setEnabledFlag(true); await scheduler.tick(); assert.equal(sent.length, 0, "failed listener cannot push");
    listening = true; await scheduler.tick(); assert.equal(sent.length, 0, "first interval starts at admission");
    now = new Date(+now + 60000); await scheduler.tick(); assert.equal(sent.length, 1);
    const payload = JSON.parse(sent[0].body);
    assert.deepEqual(Object.keys(payload).sort(), contract.proactiveNotify.fields.slice().sort());
    assert.deepEqual(Object.keys(payload.accounts[0]).sort(), contract.proactiveNotify.accountFields.slice().sort());
    assert.equal(transport.MAX_BYTES, contract.proactiveNotify.maxPayloadBytes);
    assert.equal(transport.RESPONSE_BYTES, contract.proactiveNotify.maxResponseBytes);
    assert.equal(transport.TIMEOUT_MS, contract.proactiveNotify.timeoutMs);
    assert.equal(payload.kind, "proactive.mail_digest"); assert.equal(payload.platform, "hermes_agent");
    assert.equal(payload.installationId, auth.installationId()); assert.equal(payload.botId, id);
    assert.equal(payload.contentTrust, "untrusted_mail_data"); assert.equal(payload.accounts[0].folder, "inbox");
    assert.equal(payload.accounts[0].messages.length, 2);
    assert.ok(payload.accounts[0].messages.every(row => !row.body && row.contentTrust === payload.contentTrust));
    assert.doesNotMatch(sent[0].body, /other-account-sentinel|script-sentinel|attachment-byte-sentinel|never-push.bin|synthetic-push-secret/);
    assert.equal(sent[0].options.token, "synthetic-push-secret");
    assert.equal(db.messageById("header-a").unread, 1);
    now = new Date(+now + 60000); await scheduler.tick(); assert.equal(sent.length, 1, "success advances dedup");
    scheduler.dispose(); scheduler = proactive.createScheduler(deps);
    now = new Date(+now + 60000); await scheduler.tick(); assert.equal(sent.length, 1, "dedup survives restart");
    config.configure({ ...settings, includeBody: true, secret: undefined });
    await scheduler.tick(); now = new Date(+now + 60000); await scheduler.tick();
    const withBody = JSON.parse(sent.at(-1).body);
    assert.equal(withBody.accounts[0].messages.find(row => row.messageId === "html-a").body.text, "Cached text");
    assert.ok(withBody.accounts[0].messages.find(row => row.messageId === "header-a").warnings.includes("BODY_NOT_CACHED"));
    assert.doesNotMatch(sent.at(-1).body, /script-sentinel|style-sentinel|never-fetch|attachment-byte-sentinel/);
    // New data scope resets the cursor; retries within a slot use identical bytes.
    config.configure({ ...settings, includeBody: false }); result = { code: "WEBHOOK_HTTP_503", retryable: true };
    await scheduler.tick(); now = new Date(+now + 60000); await scheduler.tick();
    const failures = sent.length;
    now = new Date(+now + 20000); await scheduler.tick(); assert.equal(sent.length, failures + 1);
    assert.equal(sent.at(-1).body, sent.at(-2).body);
    now = new Date(+now + 20000); await scheduler.tick(); assert.equal(sent.length, failures + 1, "only two attempts per slot");
    assert.ok(audit.recent(20).some(row => row.operation === "proactive.mail_digest" && row.code === "WEBHOOK_HTTP_503"));
    assert.doesNotMatch(fs.readFileSync(path.join(temp, "bot-audit.log"), "utf8"), /Synthetic header|bot.tail.ts.net|synthetic-push-secret/);
    const beforeStop = sent.length;
    config.configure({ clientId: id, platform: "hermes_agent", stop: true });
    now = new Date(+now + 60000); await scheduler.tick(); assert.equal(sent.length, beforeStop, "background consent off");
    config.configure(settings); await scheduler.tick();
    scheduler.pause(); now = new Date(+now + 60000); await scheduler.tick(); assert.equal(sent.length, beforeStop, "sleep pauses");
    scheduler.resume(); closed = true; await scheduler.tick(); assert.equal(sent.length, beforeStop, "update pauses"); closed = false;
    // Revocation during the asynchronous secure read must prevent POST.
    secretGate = deferred(); secretStarted = deferred();
    const work = scheduler.tick(); await secretStarted.promise;
    auth.revoke(id); secretGate.resolve(); await work;
    assert.equal(sent.length, beforeStop, "revocation before POST is final");
    scheduler.dispose(); scheduler = null;
    const next = config.nextRun({ kind: "cron", cron: "0 9 * * 1-5" }, new Date(2026, 10, 2, 8, 59));
    assert.equal(next.getHours(), 9); assert.equal(next.getMinutes(), 0);
    // Persistence must succeed before any delivery is admitted.
    config.configure({ ...settings, clientId: legacy.grant.clientId, platform: "grok_bot" });
    scheduler = proactive.createScheduler({ ...deps, writeState() { throw Error("synthetic disk failure"); } });
    await scheduler.tick(); assert.equal(sent.length, beforeStop);
    scheduler.dispose();
    auth.revoke(legacy.grant.clientId);
    // Each queued delivery is revalidated after the asynchronous credential read.
    for (const change of ["disable", "listener", "consent", "rotate", "sleep", "quit", "secret", "account", "expiry", "target"]) {
      const fresh = mint("hermes_agent");
      config.configure({ ...settings, clientId: fresh.grant.clientId });
      auth.setEnabledFlag(true); listening = true;
      let readable = true;
      secretGate = deferred(); secretStarted = deferred();
      scheduler = proactive.createScheduler({ ...deps, db: { isReady: db.isReady, accountById: id => readable ? db.accountById(id) : null } });
      await scheduler.tick(); now = new Date(+now + 60000);
      const before = sent.length, work = scheduler.tick(); await secretStarted.promise;
      if (change === "disable") auth.setEnabledFlag(false);
      if (change === "listener") listening = false;
      if (change === "consent") config.configure({ clientId: fresh.grant.clientId, platform: "hermes_agent", stop: true });
      if (change === "rotate") auth.rotate(fresh.grant.clientId);
      if (change === "sleep") scheduler.pause();
      if (change === "quit") scheduler.stop();
      if (change === "account") readable = false;
      if (change === "expiry") auth.mutate(fresh.grant.clientId, row => { row.expiry = { kind: "finite", expiresAt: "2000-01-01T00:00:00.000Z" }; });
      if (change === "secret") {
        const key = auth.load().store.grants.find(row => row.clientId === fresh.grant.clientId).proactive.secretKey;
        secrets.setPassword(key, "replacement-secret");
      }
      if (change === "target") config.configure({ ...settings, clientId: fresh.grant.clientId, webhookUrl: "https://other.tail.ts.net/notify", secret: undefined });
      secretGate.resolve(); await work; assert.equal(sent.length, before, change + " prevents queued POST");
      if (change === "target") assert.equal(auth.view().grants.find(row => row.clientId === fresh.grant.clientId).proactive.hasSecret, false);
      scheduler.dispose(); auth.revoke(fresh.grant.clientId);
    }
    auth.revoke(legacy.grant.clientId);
    // A cron that missed several slots makes one current run, then advances.
    const cronBot = mint("grok_bot");
    config.configure({ ...settings, clientId: cronBot.grant.clientId, platform: "grok_bot", secret: undefined,
      schedule: { kind: "cron", cron: "* * * * *" } });
    listening = true; auth.setEnabledFlag(true); secretGate = null; result = { code: "OK" };
    scheduler = proactive.createScheduler(deps);
    await scheduler.tick(); const cronBefore = sent.length;
    now = new Date(+now + 185000); await scheduler.tick(); await scheduler.tick();
    assert.equal(sent.length, cronBefore + 1, "cron coalesces missed slots");
    assert.equal(sent.at(-1).options.token, "", "optional bearer remains absent");
    const packedGrant = { ...auth.load().store.grants.find(row => row.clientId === cronBot.grant.clientId) };
    packedGrant.proactive = { ...packedGrant.proactive, accountIds: ["a", "b", "c", "d", "e"], includeBody: true };
    const packed = proactive.buildPayload(packedGrant, {}, now, {
      listCached(accountId, folder, limit) {
        assert.equal(limit, contract.proactiveNotify.candidateWindowPerAccount);
        return { items: Array.from({ length: limit }, (_, i) => ({ messageId: String(i), accountId, snippet: "s".repeat(512) })), warnings: [], moreAvailable: true };
      },
      getCached(_account, id) { return { body: { text: id === "0" ? "\u0001".repeat(8192) : "t".repeat(8192) }, warnings: [] }; },
    });
    assert.ok(Buffer.byteLength(packed.body) <= contract.proactiveNotify.maxPayloadBytes);
    assert.ok(packed.payload.accounts.every(account => account.messages.length > 0 && account.messages.length <= contract.proactiveNotify.maxMessagesPerAccount));
    assert.ok(packed.payload.accounts.every(account => account.messages.every(row => row.messageId !== "0")), "oversized first row cannot starve smaller rows");
    scheduler.dispose(); scheduler = null;
    await deletionChecks(settings);
    await stateChecks(cronBot.grant.clientId);
    await importIsolationChecks();
    await transportChecks();
    console.log("bot-proactive-ok (synthetic cache, consent, lifecycle, cursor failures, import isolation, dedup, retry and transport)");
  } finally {
    scheduler?.dispose(); await db.close(); fs.rmSync(temp, { recursive: true, force: true });
    for (const [key, value] of [["MORROW_USER_DATA", originalEnv.data], ["MORROW_MAIL_SECRETS", originalEnv.secrets]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
