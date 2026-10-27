const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const db = require("../host/mail/db");
const { Persistence } = require("../host/mail/persistence");

const account = { id: "index-fixture", email: "index@example.invalid", username: "index", profile: "custom", createdAt: 1,
  imapHost: "imap.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.invalid", smtpPort: 465, smtpTls: true };
const COUNT = 160;
const queries = ["cafe", "東京", "alpha beta", "htmlneedle", "lastneedle"];
function sql(file, work, readonly = false) {
  const raw = new Database(file, { readonly, fileMustExist: true });
  try { return work(raw); } finally { raw.close(); }
}
function digest(file) {
  return sql(file, raw => crypto.createHash("sha256").update(JSON.stringify({
    docs: raw.prepare("SELECT * FROM message_fts_doc ORDER BY message_id").all(),
    terms: raw.prepare("SELECT * FROM message_fts ORDER BY term, message_id, field").all(),
  })).digest("hex"), true);
}
function meta(file) {
  return sql(file, raw => Object.fromEntries(raw.prepare("SELECT * FROM message_fts_meta").all().map(row => [row.meta_key, row.meta_value])), true);
}
function search() {
  return queries.map(query => db.searchMessages({ query, accountId: account.id }).map(row => row.id));
}
function damage(file, marker) {
  sql(file, raw => {
    raw.prepare("UPDATE message_fts_meta SET meta_value = 'old-index' WHERE meta_key = 'version'").run();
    raw.prepare("DELETE FROM message_fts_doc WHERE message_id = 'm0030'").run();
    raw.prepare("INSERT INTO message_fts_doc VALUES ('orphan-doc','old','old','old')").run();
    raw.prepare("INSERT INTO message_fts VALUES ('obsolete','orphan-doc','body')").run();
    raw.prepare("INSERT INTO message_fts VALUES ('obsolete','orphan-term','body')").run();
    if (marker !== undefined) raw.prepare("INSERT OR REPLACE INTO message_fts_meta VALUES ('rebuild',?)").run(marker);
  });
}
function copy(base, dir, name, marker) {
  const file = path.join(dir, name + ".sqlite");
  fs.copyFileSync(base, file); damage(file, marker); return file;
}

async function seed(file) {
  await db.open(file);
  db.insertAccount(account);
  db.replaceFolders(account.id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }]);
  db.transaction(() => {
    for (let i = 0; i < COUNT; i++) db.insertMessage({ id: "m" + String(i).padStart(4, "0"), uid: i + 1, uidValidity: 1,
      accountId: account.id, folderPath: "INBOX", subject: `Café 東京 ${i}`, from: "sender@example.invalid",
      textBody: i === COUNT - 1 ? "lastneedle " + "large unicode café 東京 ".repeat(10000) : i % 2 ? "alpha beta needle" : "",
      htmlBody: i % 2 ? "" : "<p>htmlneedle &amp; café</p>", snippet: "fallback", bodyComplete: true,
      date: "2026-10-27T00:00:00Z", listSortTs: i + 1 });
  });
  const expected = search();
  await db.checkpoint(); await db.close();
  return { expected, hash: digest(file) };
}

async function rebuilt(file, expected, hash, extra = {}) {
  const events = [], pending = [];
  const observerErrors = [];
  let heartbeats = 0, first = true;
  let opening;
  const unsubscribe = db.subscribeIndexProgress(event => {
    try {
    if (event.phase === "idle") return;
    assert.equal(db.isReady(), false, "readiness is published only after the open promise completes");
    assert.deepEqual(Object.keys(event).sort(), ["completed", "phase", "resumed", "total"]);
    assert.ok(event.completed <= event.total);
    if (events.length) {
      assert.ok(event.completed >= events.at(-1).completed);
      assert.ok(event.completed - events.at(-1).completed <= 64);
    }
    events.push(event);
    if (event.phase === "building") {
      setImmediate(() => { heartbeats++; });
      if (first) {
        first = false;
        assert.equal(db.open(file), opening, "same-file opens share initialization");
        pending.push(assert.rejects(db.open(file + ".other"), { code: "mail_open_busy" }));
        assert.throws(() => db.searchMessages({ query: "cafe" }), { code: "mail_not_ready" });
        assert.throws(() => db.updateMessage("m0000", { subject: "must-not-change" }), { code: "mail_not_ready" });
        assert.throws(() => db.removeAccount(account.id), { code: "mail_not_ready" });
        assert.throws(() => db.insertAccount({ ...account, id: "must-not-exist" }), { code: "mail_not_ready" });
      }
    }
    } catch (error) { observerErrors.push(error); }
  });
  const noisy = db.subscribeIndexProgress(event => { if (event.phase === "building") throw new Error("Synthetic observer failure"); });
  try {
    opening = db.open(file);
    assert.equal(db.isReady(), false);
    await opening; await Promise.all(pending);
  } finally { unsubscribe(); noisy(); }
  if (observerErrors.length) throw observerErrors[0];
  assert.equal(db.isReady(), true);
  assert.ok(events.length >= 2); assert.ok(heartbeats >= 1, "rebuild yields before processing resumed work");
  if (COUNT - events[0].completed > 64) assert.ok(heartbeats > 1, "rebuild yields between durable batches");
  assert.equal(events.at(-1).phase, "ready"); assert.equal(events.at(-1).completed, COUNT);
  if (extra.resumed !== undefined) assert.equal(events[0].resumed, extra.resumed);
  if (extra.minimum !== undefined) assert.ok(events[0].completed >= extra.minimum);
  assert.deepEqual(search(), expected);
  assert.equal(digest(file + ".live"), hash, "rebuilt documents and terms match the incremental index exactly");
  assert.deepEqual(meta(file + ".live"), { version: "1" });
  assert.equal(db.accountById("must-not-exist"), null);
  assert.equal(sql(file + ".live", raw => raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('message_fts','message_fts_doc','message_fts_meta')").get().n, true), 3);
  return events;
}

async function interruptions(base, dir, expected, hash) {
  for (const kind of ["abort", "close"]) {
    const file = copy(base, dir, kind), controller = new AbortController();
    let completed = 0, closing;
    const unsubscribe = db.subscribeIndexProgress(event => {
      if (event.phase === "building" && event.completed > 0 && event.completed < COUNT && !completed) {
        completed = event.completed;
        if (kind === "abort") controller.abort(); else closing = db.close();
      }
    });
    try { await assert.rejects(db.open(file, { signal: controller.signal }), { code: "mail_open_cancelled" }); }
    finally { unsubscribe(); }
    if (closing) await closing;
    assert.ok(completed > 0); assert.equal(db.isReady(), false);
    assert.ok(fs.statSync(file + ".journal").size > 0, "interrupted durable progress is retained");
    await rebuilt(file, expected, hash, { resumed: true, minimum: completed });
    await db.close();
  }
}

async function failures(base, dir, expected, hash) {
  for (const phase of ["batch", "final"]) {
    const file = copy(base, dir, "failure-" + phase);
    const original = Persistence.prototype.append;
    let armed = false, prefix = 0, failed = false;
    const unsubscribe = db.subscribeIndexProgress(event => {
      if (event.phase === "building" && event.completed > 0) { armed = true; prefix = event.completed; }
    });
    Persistence.prototype.append = function (commands) {
      const final = commands.some(command => command.sql === "DELETE FROM message_fts_meta WHERE meta_key = 'rebuild'");
      if (!failed && ((phase === "batch" && armed) || (phase === "final" && final))) {
        failed = true; throw new Error("Synthetic index journal failure");
      }
      return original.call(this, commands);
    };
    try { await assert.rejects(db.open(file), /Synthetic index journal failure/); }
    finally { Persistence.prototype.append = original; unsubscribe(); }
    assert.equal(failed, true); assert.equal(db.isReady(), false);
    await rebuilt(file, expected, hash, { resumed: true, minimum: prefix });
    await db.close();
  }
}

async function crashes(base, dir, expected, hash) {
  for (const boundary of ["partial", "ready"]) {
    const file = copy(base, dir, "crash-" + boundary);
    const child = spawnSync(process.execPath, [__filename, "--crash", file, boundary], {
      encoding: "utf8", timeout: 60000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    assert.equal(child.status, 0, child.stderr || String(child.error));
    const stopped = JSON.parse(child.stdout.trim());
    if (boundary === "partial") await rebuilt(file, expected, hash, { resumed: true, minimum: stopped.completed });
    else {
      const events = [], unsubscribe = db.subscribeIndexProgress(event => events.push(event));
      try { await db.open(file); } finally { unsubscribe(); }
      assert.equal(events.some(event => event.phase === "building"), false, "final durable publication survives exit before admission");
      assert.deepEqual(search(), expected); assert.equal(digest(file + ".live"), hash);
    }
    await db.close();
  }
}

async function ui() {
  const { JSDOM } = require("jsdom");
  const { startupStatusHtml, startupIndexProgressScript } = require("../host/startup-error");
  const dom = new JSDOM(startupStatusHtml(), { runScripts: "outside-only" });
  const node = dom.window.document.getElementById("startup-index-progress");
  assert.equal(node.hidden, false);
  assert.match(node.textContent, /Your mail stays on this computer/);
  dom.window.eval(startupIndexProgressScript({ phase: "building", total: 160, completed: 64, resumed: true }));
  assert.equal(node.hidden, false); assert.match(node.textContent, /Resuming local search: 64 of 160 saved messages/);
  dom.window.eval(startupIndexProgressScript({ phase: "building", total: 160, completed: 160 }));
  assert.match(node.textContent, /Finishing local search checks/);
  dom.window.eval(startupIndexProgressScript({ phase: "ready", total: 160, completed: 160 }));
  assert.equal(node.textContent, "Local search is ready.");
  assert.equal(startupIndexProgressScript({ phase: "<private>" }), "");
  assert.ok(!startupIndexProgressScript({ phase: "building", completed: "<private>", total: NaN }).includes("private"));
  const features = new JSDOM('<div id="features-catalog"></div><p id="features-empty"></p>');
  const featureUi = require("./check-ux-workflows").renderer({ document: features.window.document });
  featureUi.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  featureUi.run("paintFeatureCatalog()");
  assert.match(features.window.document.body.textContent, /Quitting keeps committed progress for the next open/);
  assert.match(features.window.document.body.textContent, /A large individual message or disk call can still cause a pause/);
  const help = new JSDOM(fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8"));
  assert.match(help.window.document.getElementById("search-rebuild-help").textContent, /Mail and search wait for verification/);
  assert.match(help.window.document.getElementById("search-rebuild-help").textContent, /does not fetch mail/);
  features.window.close(); help.window.close();
  dom.window.close();
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-index-rebuild-"));
  try {
    await ui();
    const base = path.join(dir, "base.sqlite"), { expected, hash } = await seed(base);
    await rebuilt(copy(base, dir, "normal"), expected, hash, { resumed: false });
    const preabort = new AbortController(); preabort.abort();
    await assert.rejects(db.open(path.join(dir, "never-opened"), { signal: preabort.signal }), { code: "mail_open_cancelled" });
    assert.equal(db.isReady(), true); assert.equal(fs.existsSync(path.join(dir, "never-opened")), false);
    db.updateMessage("m0000", { text_body: "incrementalneedle" });
    assert.ok(db.searchMessages({ query: "incrementalneedle" }).some(row => row.id === "m0000"));
    db.deleteMessage("m0001");
    await db.checkpoint(); const warmFile = db.file(); await db.close();
    const warmEvents = [], stop = db.subscribeIndexProgress(event => warmEvents.push(event));
    try { await db.open(warmFile); } finally { stop(); }
    assert.equal(warmEvents.some(event => event.phase === "building"), false);
    assert.ok(db.searchMessages({ query: "incrementalneedle" }).some(row => row.id === "m0000"));
    assert.equal(db.messageById("m0001"), null); await db.close();
    for (const [name, marker] of [["bad-json", "{"], ["empty-marker", ""], ["wrong-state", JSON.stringify({ target: "1", completed: COUNT + 1 })]]) {
      const file = copy(base, dir, name, marker);
      if (name === "empty-marker") sql(file, raw => raw.prepare("UPDATE message_fts_meta SET meta_value='1' WHERE meta_key='version'").run());
      await rebuilt(file, expected, hash, { resumed: false }); await db.close();
    }
    await interruptions(base, dir, expected, hash);
    await failures(base, dir, expected, hash);
    await crashes(base, dir, expected, hash);
    console.log("search-index-rebuild-ok: yield/progress/admission/parity/markers/abort/close/journal-failure/process-restart/incremental/warm; synthetic SQLite only");
  } finally { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[2] === "--crash") {
  const file = process.argv[3], boundary = process.argv[4];
  db.subscribeIndexProgress(event => {
    if ((boundary === "partial" && event.completed > 0 && event.completed < COUNT)
        || (boundary === "ready" && event.phase === "ready")) {
      process.stdout.write(JSON.stringify(event)); process.exit(0);
    }
  });
  db.open(file).then(() => { throw new Error("Expected durable crash boundary was not reached"); }).catch(error => { console.error(error); process.exitCode = 1; });
} else if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { run };
