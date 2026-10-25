"use strict";

// Real SQLite, renderer functions and calendar request builders. Every account,
// credential and provider is synthetic; sockets and global fetch are forbidden.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = process.argv[2] === "--reopen" ? process.argv[3]
  : fs.mkdtempSync(path.join(os.tmpdir(), "morrow-reconnect-calendar-"));
Object.assign(process.env, { MORROW_USER_DATA: root, MORROW_MAIL_DIR: root,
  MORROW_AI_CONFIG_DIR: root, MORROW_MAIL_SECRETS: "memory", ELECTRON_OVERRIDE_DIST_PATH: "/nonexistent" });
delete process.env.MORROW_ASAR;
globalThis.fetch = async () => { throw new Error("Network forbidden in fixture"); };
require("node:net").Socket.prototype.connect = function () { throw new Error("Socket forbidden in fixture"); };
const db = require("../host/mail/db");
const engine = require("../host/mail/engine");
const remote = require("../host/mail/remote");
const oauth = require("../host/mail/oauth");
const memory = require("../host/mail/memory-secrets");
const { Persistence } = require("../host/mail/persistence");
const folders = [{ path: "Drafts", name: "Drafts", wellKnown: "drafts" }];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const expected = new Map();
const sends = [];
const connections = [];
let accountCases = 0, calendarCases = 0;

remote.withClient = async (account, secret, work) => {
  connections.push({ id: account.id, kind: account.auth_kind, secret });
  return work({});
};
remote.listFolderRecords = async () => ({ folders, delimiter: "/" });
remote.verifySmtp = async () => {};
remote.openIdleClient = async () => { throw new Error("Synthetic IDLE disabled"); };
remote.searchUids = async () => ({ uids: [], validity: 1, exists: 0, unseen: 0 });
remote.fetchMessages = async () => ({ messages: [], validity: 1 });
remote.sendSmtp = async (account, secret, options) => {
  sends.push({ id: account.id, kind: account.auth_kind, secret });
  return { messageId: options.messageId, accepted: options.to, rejected: [] };
};

function seed(id, kind = "password", profile = "custom") {
  const email = id + "@example.test";
  db.insertAccount({ id, email, username: email, profile, authKind: kind, createdAt: 1,
    imapHost: "old-imap.example.test", imapPort: 993, imapTls: true,
    smtpHost: "old-smtp.example.test", smtpPort: 465, smtpTls: true });
  db.replaceFolders(id, [...folders, { path: "Archive", name: "Archive", wellKnown: "archive" }], "/");
  db.insertMessage({ id: id + "-cached", accountId: id, folderPath: "Archive", uid: 1, uidValidity: 1,
    subject: "Synthetic cached mail", textBody: "Synthetic retained content", bodyComplete: true,
    date: "2026-10-25T08:00:00Z", listSortTs: 1 });
  const secret = kind === "oauth2" ? JSON.stringify({ provider: "google", refreshToken: "synthetic-refresh",
    accessToken: "synthetic-access", expiresAt: Date.now() + 3600000, grantedScopes: "https://mail.google.com/" })
    : "synthetic-old-password";
  memory.setPassword(id, secret);
  return secret;
}
function snapshot(id) {
  // Successful reconnects schedule a synthetic refresh; compare persisted
  // folder identity, not its independently advancing sync timestamps/cursors.
  return { account: db.accountById(id), folders: db.foldersFor(id).map(({ path, name, well_known }) => ({ path, name, well_known })),
    message: db.messageById(id + "-cached") };
}
function reconnect(id, profile = "custom", existing = true) {
  return engine.answer("mail:connectImapSmtp", [{ expectedAccountId: existing ? id : undefined,
    email: id + "@example.test", username: "new-user@example.test", password: "synthetic-new-password",
    profile, custom: { imap: { host: "new-imap.example.test", port: 993, tls: true },
      smtp: { host: "new-smtp.example.test", port: 465, tls: true } } }]);
}
const submit = account => engine.submitSmtp({ account, messageId: "<synthetic@example.test>",
  options: { from: account.email, to: ["recipient@example.test"], subject: "Synthetic", text: "No real mail" } });
function gate() {
  let started, release;
  const active = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  return { active, release, async wait() { started(); await held; } };
}
async function patch(object, name, replacement, work) {
  const original = object[name];
  object[name] = replacement(original);
  try { return await work(); } finally { object[name] = original; }
}

async function accountChecks() {
  for (const kind of ["password", "oauth2"]) {
    const id = "success-" + kind;
    seed(id, kind, kind === "oauth2" ? "gmail" : "custom");
    const connected = await reconnect(id, kind === "oauth2" ? "gmail" : "custom");
    assert.equal(connected.success, true);
    assert.equal(db.accountById(id).auth_kind, "password");
    assert.equal(memory.getPassword(id), "synthetic-new-password");
    await engine.syncAccountById(id, { background: false });
    assert(connections.some(row => row.id === id && row.kind === "password" && row.secret === "synthetic-new-password"));
    assert.equal((await submit(db.accountById(id))).kind, "accepted");
    assert.deepEqual(sends.at(-1), { id, kind: "password", secret: "synthetic-new-password" });
    expected.set(id, snapshot(id));
    accountCases++;
  }

  for (const kind of ["password", "oauth2"]) {
    for (const phase of ["read", "write-before", "write-after", "login", "folders", "journal", "probe"]) {
      const id = kind + "-failure-" + phase, secret = seed(id, kind), before = snapshot(id);
      const sensitive = "SYNTHETIC_SECRET_MUST_NOT_ESCAPE";
      const failure = () => { throw new Error(sensitive); };
      const attempt = () => reconnect(id);
      let result;
      if (phase === "read") result = await patch(memory, "getPassword", original => key => key === id ? failure() : original(key), attempt);
      if (phase.startsWith("write")) result = await patch(memory, "setPassword", original => (key, value) => {
        if (key === id && value === "synthetic-new-password") {
          if (phase === "write-after") original(key, value);
          failure();
        }
        return original(key, value);
      }, attempt);
      if (phase === "login" || phase === "folders") {
        result = await patch(db, phase === "login" ? "updateAccountLogin" : "replaceFolders", original => (...args) => {
          original(...args); // Throw after changes, including folder/cache deletion.
          if (args[0] === id) failure();
        }, attempt);
      }
      if (phase === "journal") result = await patch(Persistence.prototype, "append", () => failure, attempt);
      if (phase === "probe") result = await patch(remote, "withClient", () => failure, attempt);
      assert.equal(result.success, false, id);
      assert.equal(result.error.code, phase === "probe" ? "auth" : ["login", "folders", "journal"].includes(phase) ? "storage" : "keychain");
      if (phase !== "probe") assert.doesNotMatch(result.error.message, /SYNTHETIC_SECRET_MUST_NOT_ESCAPE/);
      assert.deepEqual(snapshot(id), before, "account, folders and cached mail must roll back: " + id);
      assert.equal(memory.getPassword(id), secret);
      expected.set(id, before);
      accountCases++;
    }
  }

  for (const phase of ["write-after", "insert", "folders"]) {
    const id = "new-failure-" + phase;
    let credentialId;
    const originalWrite = memory.setPassword;
    memory.setPassword = (key, value) => {
      credentialId = key;
      originalWrite(key, value);
      if (phase === "write-after") throw new Error("Synthetic write completed before failure");
    };
    let result;
    try {
      const attempt = () => reconnect(id, "custom", false);
      result = phase === "write-after" ? await attempt()
        : await patch(db, phase === "insert" ? "insertAccount" : "replaceFolders", original => (...args) => {
          original(...args); throw new Error("Synthetic storage failure after write");
        }, attempt);
    } finally { memory.setPassword = originalWrite; }
    assert.equal(result.success, false);
    assert.equal(db.accountByEmail(id + "@example.test"), null);
    assert.equal(memory.getPassword(credentialId), null);
    accountCases++;
  }
  const fresh = await reconnect("fresh-success", "custom", false);
  assert.equal(fresh.success, true);
  const added = db.accountByEmail("fresh-success@example.test");
  assert.equal(added.auth_kind, "password");
  expected.set(added.id, snapshot(added.id));
  accountCases++;

  const broken = "compensation-fails";
  seed(broken);
  const unchanged = snapshot(broken);
  const failedRestore = await patch(memory, "setPassword", original => (key, value) => {
    if (key === broken) {
      if (value === "synthetic-new-password") original(key, value);
      throw new Error("SYNTHETIC_SECRET_MUST_NOT_ESCAPE");
    }
    return original(key, value);
  }, () => reconnect(broken));
  assert.equal(failedRestore.success, false);
  assert.match(failedRestore.error.message, /Could not restore credentials.*Reconnect/);
  assert.doesNotMatch(failedRestore.error.message, /SYNTHETIC_SECRET/);
  assert.deepEqual(snapshot(broken), unchanged);
  db.removeAccount(broken); memory.deletePassword(broken);
  accountCases++;

  // An old refresh cannot overwrite the successful password transition. If the
  // transition failed and restored its exact prior secret, the refresh may finish.
  for (const failSave of [false, true]) {
    const id = "refresh-race-" + failSave, previous = seed(id, "oauth2"), held = gate();
    const originalRefresh = oauth.accessTokenFor;
    oauth.accessTokenFor = async (account, raw) => {
      assert.equal(account.id, id); assert.equal(raw, previous);
      await held.wait(); return { token: "synthetic-refreshed-token", store: "synthetic-refreshed-store" };
    };
    try {
      const beforeSends = sends.length, pending = submit(db.accountById(id));
      await held.active;
      const result = failSave ? await patch(memory, "setPassword", original => (key, value) => {
        original(key, value);
        if (key === id && value === "synthetic-new-password") throw new Error("Synthetic write failed");
      }, () => reconnect(id)) : await reconnect(id);
      assert.equal(result.success, !failSave);
      held.release();
      const receipt = await pending;
      assert.equal(receipt.kind === "accepted", failSave);
      assert.equal(sends.length - beforeSends, failSave ? 1 : 0);
      assert.equal(memory.getPassword(id), failSave ? "synthetic-refreshed-store" : "synthetic-new-password");
      assert.equal(db.accountById(id).auth_kind, failSave ? "oauth2" : "password");
      expected.set(id, snapshot(id));
      accountCases++;
    } finally { held.release(); oauth.accessTokenFor = originalRefresh; }
  }
}

function calendarUi() {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", checked: false, hidden: false, textContent: "",
      options: [{ value: "primary" }], classList: { remove() {}, add() {} }, focus() {} });
    return nodes.get(id);
  };
  const ui = require("./check-ux-workflows").renderer({ document: { getElementById: get, querySelector: () => null } });
  ui.run(`calendarAccount=()=>({id:'a'});state.calendarPayload={accountId:'a'};state.calendarId='primary';state.calendarIds=['primary'];
    openDialog=()=>{};closeDialog=()=>{};showStatus=()=>{};loadCalendar=async()=>{};
    globalThis.calls=[];call=async(channel,payload)=>{calls.push({channel,payload});return {};};`);
  return { ui, get };
}
async function calendarChecks() {
  const api = require("../host/mail/calendar-api");
  const { ui, get } = calendarUi();
  for (const provider of ["google", "microsoft"]) {
    for (const title of ["", "T".repeat(200), "T".repeat(201), "T".repeat(220)]) {
      for (const allDay of [false, true]) {
        const start = allDay ? "2026-10-25" : "2026-10-25T09:00:00Z";
        const end = allDay ? "2026-10-26" : "2026-10-25T10:00:00Z";
        let stored = provider === "google" ? { id: "evt", summary: title,
          start: allDay ? { date: start } : { dateTime: start }, end: allDay ? { date: end } : { dateTime: end } }
          : { id: "evt", subject: title, isAllDay: allDay, start: { dateTime: start, timeZone: "UTC" }, end: { dateTime: end, timeZone: "UTC" } };
        const normalize = provider === "google" ? api.normalizeGoogleEvent : api.normalizeGraphEvent;
        const requests = [];
        const fetchImpl = async (_url, options) => {
          assert.equal(options.method, "PATCH");
          const body = JSON.parse(options.body); requests.push(body); stored = { ...stored, ...body };
          return { ok: true, status: 200, text: async () => JSON.stringify(stored) };
        };
        ui.context.event = normalize(stored, "primary");
        assert.equal(ui.context.event.title, title.slice(0, 200));
        assert.equal(!!ui.context.event.titleTruncated, title.length > 200);
        ui.run("openCalendarEditor(event)");
        assert.equal(get("calendar-event-title").readOnly, title.length > 200);
        assert.equal(get("calendar-title-note").hidden, title.length <= 200);
        if (title.length > 200) {
          const before = ui.run("calls.length");
          get("calendar-event-title").value = "Incomplete replacement";
          await assert.rejects(ui.run("submitCalendarEvent({preventDefault(){}})"), /title is incomplete/);
          assert.equal(ui.run("calls.length"), before);
          get("calendar-event-title").value = title.slice(0, 200);
        }
        get("calendar-end").value = allDay ? "2026-10-27" : ui.run("toDateTimeLocal('2026-10-25T11:00:00Z')");
        await ui.run("submitCalendarEvent({preventDefault(){}})");
        const draft = JSON.parse(ui.run("JSON.stringify(calls.at(-1).payload)"));
        assert.equal(Object.hasOwn(draft, "title"), false);
        await api.updateEvent(provider, "synthetic-token", "primary", "evt", draft, fetchImpl);
        assert.equal(Object.hasOwn(requests[0], provider === "google" ? "summary" : "subject"), false);
        assert.equal(stored[provider === "google" ? "summary" : "subject"], title);
        assert.equal(normalize(stored, "primary").end, allDay ? "2026-10-27" : "2026-10-25T11:00:00.000Z");
        // A deliberate short replacement is supported by the provider boundary.
        await api.updateEvent(provider, "synthetic-token", "primary", "evt", { ...draft, title: "Renamed" }, fetchImpl);
        assert.equal(stored[provider === "google" ? "summary" : "subject"], "Renamed");
        const before = requests.length;
        for (const invalid of ["", "X".repeat(201)]) {
          await assert.rejects(api.updateEvent(provider, "synthetic-token", "primary", "evt", { ...draft, title: invalid }, fetchImpl), e => e.code === "invalid");
        }
        await assert.rejects(api.createEvent(provider, "synthetic-token", "primary", draft, fetchImpl), e => e.code === "invalid");
        assert.equal(requests.length, before);
        calendarCases++;
      }
    }
  }
  ui.run("openCalendarEditor(null)");
  assert.equal(get("calendar-event-title").readOnly, false);
  assert.equal(get("calendar-title-note").hidden, true);
  await assert.rejects(ui.run("submitCalendarEvent({preventDefault(){}})"), /Add a title/);
  get("calendar-event-title").value = "New title";
  await ui.run("submitCalendarEvent({preventDefault(){}})");
  assert.equal(ui.run("calls.at(-1).channel"), "calendar:createEvent");
  assert.equal(ui.run("calls.at(-1).payload.title"), "New title");
}

async function run() {
  if (process.argv[2] === "--reopen") {
    const saved = JSON.parse(fs.readFileSync(path.join(root, "expected.json")));
    await db.open(saved.file);
    try { for (const [id, state] of saved.rows) assert.deepEqual(snapshot(id), state, "restart: " + id); }
    finally { await db.close(); }
    console.log("reconnect-restart-ok");
    return;
  }
  try {
    await engine.init();
    await accountChecks();
    await calendarChecks();
    await delay(350); // Settle connectAccount's synthetic follow-up before closing.
    await engine.stopIdle();
    const file = db.file();
    for (const [id, state] of expected) assert.deepEqual(snapshot(id), state);
    await db.close();
    await db.open(file);
    for (const [id, state] of expected) assert.deepEqual(snapshot(id), state, "reopen: " + id);
    await db.close();
    fs.writeFileSync(path.join(root, "expected.json"), JSON.stringify({ file, rows: [...expected] }));
    const child = spawnSync(process.execPath, [__filename, "--reopen", root], { encoding: "utf8", timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /reconnect-restart-ok/);
    console.log(`reconnect-calendar-preservation-ok (${accountCases} account cases; ${calendarCases} calendar cases; reopen + process restart; no live I/O)`);
  } finally {
    await delay(250);
    await engine.stopIdle();
    await db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
