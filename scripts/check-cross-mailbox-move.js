"use strict";
// Native temporary journals and real Gmail HTTP/Move adapters, synthetic mail.
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { createJournal: copyJournal, digest } = require("../host/mail/copy-recovery");
const { createJournal: moveJournal } = require("../host/mail/move-recovery");
const { createService: copies } = require("../host/mail/cross-mailbox-copy");
const { createService: moves, LIMITS } = require("../host/mail/cross-mailbox-move");
const { createSource } = require("../host/mail/gmail-source-move");
const { createGmailMailApi } = require("../host/mail/gmail-mail-api");
const RAW = Buffer.from("From: sender@fixture.invalid\r\nTo: owner@fixture.invalid\r\nDate: Mon, 02 Nov 2026 03:04:05 +0000\r\nMessage-ID: <duplicate@fixture.invalid>\r\nSubject: Synthetic Move\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic original");
const DATE = Date.parse("2026-11-02T03:04:05Z"), tick = () => new Promise(resolve => setImmediate(resolve));
const wait = () => { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; };
const conflict = () => Object.assign(new Error("Synthetic owner changed"), { code: "copy_conflict", operationIssued: false });

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-source-move-"));
  const copyFile = path.join(dir, "copies.sqlite"), moveFile = path.join(dir, "moves.sqlite");
  let cl = copyJournal(copyFile), ml = moveJournal(moveFile), mono = 0, hook = async () => {};
  const state = { valid: true, alive: true, labels: ["INBOX", "UNREAD", "STARRED"], uploads: 0, trashes: 0,
    raw: RAW, destinationRaw: RAW, sourceFolder: "v1", destinationFolder: "v1", destinationLabels: ["Archive"],
    sourceBackend: options.unsupported ? "imap" : "gmail", loseAck: false, rejectTrash: false, wrongTrash: false, destination: null, requests: [] };
  const owner = { check() { if (!state.alive) throw Object.assign(new Error("Synthetic window destroyed or navigated"), { code: "move_review", operationIssued: false }); } };
  const accounts = { source: { profile: options.unsupported ? "custom" : "gmail", auth_kind: "oauth2", mail_transport: options.unsupported ? "imap" : "gmail_api" } };
  const access = {
    capture(params) { if (!state.valid) throw conflict(); return { destination: { accountId: "destination" }, sources: params.items.map(item => ({ id: item.emailId,
      accountId: item.accountId, owner: { account: accounts.source }, label: "source@fixture.invalid" })) }; },
    async review() { await hook("destination-review"); if (!state.valid) throw conflict(); return { id: "Archive", label: "Destination / Archive", proof: digest(state.destinationFolder) }; },
    async withCopy(ticket, source, destination, work, authority = {}) {
      const checked = () => { authority.check?.(); if (!state.valid || destination.proof !== digest(state.destinationFolder)) throw conflict(); };
      checked(); await hook("lane"); checked(); await hook("credential"); checked(); await hook("connection"); checked();
      const sourceSnapshot = () => ({ raw: state.raw, providerId: "canonical-source", labelIds: [...state.labels], date: DATE,
        unread: state.labels.includes("UNREAD"), starred: state.labels.includes("STARRED") });
      const api = createGmailMailApi({ accessToken: async () => { await hook("token"); checked(); return "synthetic-only"; }, check: checked,
        fetchImpl: async (url, request) => {
          const method = request.method || "GET", pathname = new URL(url).pathname; state.requests.push({ method, pathname });
          assert.equal(method === "DELETE" || /send|drafts|batchDelete/.test(pathname), false, "no permanent/send/draft API");
          if (method === "POST") {
            assert.ok(pathname.endsWith("/canonical-source/trash"));
            assert.equal(ml.list().at(-1).phase, "source_unknown", "durable uncertainty precedes every source POST");
            state.trashes++;
            if (state.rejectTrash) return new Response(JSON.stringify({ error: { errors: [{ reason: "domainPolicy" }] } }), { status: 403 });
            state.labels = [...state.labels, "TRASH"];
            await hook("submitted"); if (state.loseAck) throw new Error("synthetic lost acknowledgement");
          } else { assert.equal(method, "GET"); await hook("source-metadata"); }
          return new Response(JSON.stringify({ id: state.wrongTrash ? "wrong-source" : "canonical-source", labelIds: state.labels, internalDate: String(DATE) }), { status: 200 });
        } });
      const mover = createSource({ api, check: checked, accountId: source.accountId,
        async folder() { checked(); await hook("source-folder"); checked(); return { id: "INBOX", proof: digest(state.sourceFolder) }; },
        async readRaw() { await hook("trash-readback"); checked(); return sourceSnapshot(); } });
      return work({ check: checked, backend: options.destinationGmail ? "gmail" : "imap", sourceBackend: state.sourceBackend,
        sourceBinding: digest("source-owner"), destinationBinding: digest("destination-owner"), folderProof: destination.proof,
        async readSource() { await hook("source-read"); checked(); return sourceSnapshot(); },
        expected(snapshot) { return { date: DATE, unread: snapshot.unread, starred: snapshot.starred }; },
        sourceKey() { return digest("canonical-source"); }, destinationKey() { return digest("destination/Archive"); },
        async upload(snapshot, expected, beforeSubmit) { checked(); beforeSubmit(); state.uploads++;
          state.destination = { accountId: "destination", folderId: "Archive", uid: 10, uidValidity: 1 };
          return state.destination; },
        async readDestination(locator) { await hook("destination-read"); checked(); if (!state.destination || locator.uid !== 10) throw new Error("synthetic missing copy");
          return { raw: state.destinationRaw, date: DATE, unread: true, starred: true, labelIds: state.destinationLabels }; },
        verifyState(saved, expected) { if (saved.date !== expected.date || saved.unread !== expected.unread || saved.starred !== expected.starred) throw new Error("synthetic state mismatch"); },
        reviewSourceMove: snapshot => mover.review(snapshot), trashSource: (snapshot, proof, beforeSubmit) => mover.trash(snapshot, proof, beforeSubmit),
      });
    },
  };
  let cs = copies({ access, journal: () => cl, clock: () => mono }), ms = moves({ access, copies: () => cs, journal: () => ml, enabled: options.enabled !== false, clock: () => mono });
  t.after(() => { ms.pause(); ml.close(); cl.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const params = (mode = "move", ids = ["message"]) => ({ mode, items: ids.map(emailId => ({ emailId, accountId: "source" })), destinationAccountId: "destination", folderId: "Archive" });
  return { state, owner, access, copyFile, moveFile, params, get cl() { return cl; }, get ml() { return ml; }, get cs() { return cs; }, get ms() { return ms; },
    hook(fn) { hook = fn; }, time(value) { mono = value; },
    async copy(ids = ["message"]) { const review = await cs.answer({ ...params("copy", ids), action: "review" });
      for (const id of ids) await cs.answer({ action: "copy", reviewId: review.reviewId, emailId: id, accountId: "source" }); return review; },
    review(ids) { return ms.answer({ ...params("move", ids), action: "review" }, owner); },
    move(review, id = "message") { return ms.answer({ action: "move", reviewId: review.reviewId, emailId: id, accountId: "source", confirmed: true }, owner); },
    restart() { ms.pause(); ml.close(); cl.close(); cl = copyJournal(copyFile); cl.recover(); ml = moveJournal(moveFile); ml.recover();
      cs = copies({ access, journal: () => cl, clock: () => mono }); ms = moves({ access, copies: () => cs, journal: () => ml, enabled: true, clock: () => mono }); },
  };
}

test("compiled gate rejects source removal before source reads or journal writes", async t => {
  const f = fixture(t, { enabled: false }); let calls = 0; f.hook(() => { calls++; });
  assert.equal((await f.ms.answer({ action: "capabilities", ...f.params() }, f.owner)).moveEnabled, false);
  await assert.rejects(f.review(), /disabled/); assert.equal(calls, 0); assert.equal(f.state.trashes, 0);
});
test("Move never uploads and cannot accept a Copy review or a missing verified receipt", async t => {
  const f = fixture(t); await assert.rejects(f.review(), /verify Copy/); assert.equal(f.state.uploads, 0);
  const copy = await f.copy(); await assert.rejects(f.move(copy), /separate Gmail Move review/); assert.equal(f.state.trashes, 0);
});
test("verified Copy plus distinct Move confirmation commits exact Gmail Trash once", async t => {
  const f = fixture(t); await f.copy(); const review = await f.review(), result = await f.move(review);
  assert.equal(result.status, "moved"); assert.equal(result.sourceTrashed, true); assert.equal(f.state.uploads, 1); assert.equal(f.state.trashes, 1);
  const record = f.ml.list()[0]; assert.equal(record.phase, "source_trashed"); assert.equal(record.trash.providerId, "canonical-source");
  assert.equal(record.copy.id, f.cl.list()[0].id); assert.equal(f.cl.list()[0].phase, "verified"); assert.ok(f.state.destination);
  assert.equal((await f.move(review)).status, "already_moved"); assert.equal(f.state.trashes, 1);
});
test("Gmail label aliases and concurrent duplicate requests share one source removal", async t => {
  const f = fixture(t); await f.copy(["message", "alias"]); const review = await f.review(["message", "alias"]);
  assert.equal(review.uniqueSourceCount, 1);
  const results = await Promise.all([f.move(review), f.move(review, "alias")]);
  assert.deepEqual(results.map(row => row.status), ["moved", "already_moved"]); assert.equal(f.state.uploads, 1); assert.equal(f.state.trashes, 1);
});
for (const phase of ["unknown", "unverified", "not_uploaded"]) test(`Copy receipt ${phase} cannot authorize source removal`, async t => {
  const f = fixture(t); await f.copy(); const receipt = f.cl.list()[0]; f.cl.update(receipt.id, "verified", { phase });
  await assert.rejects(f.review(), /verify Copy/); assert.equal(f.state.trashes, 0); assert.equal(f.state.uploads, 1);
});
for (const label of ["TRASH", "DRAFT"]) test(`fresh source ${label} blocks review and execution`, async t => {
  const f = fixture(t); await f.copy(); const review = await f.review(); f.state.labels.push(label);
  await assert.rejects(f.move(review), /Trash|draft|state changed/); assert.equal(f.state.trashes, 0); assert.ok(f.state.destination);
});
test("legacy Gmail IMAP and other sources remain unsupported even with a verified copy", async t => {
  const f = fixture(t, { unsupported: true }); await f.copy();
  assert.equal((await f.ms.answer({ action: "capabilities", ...f.params() }, f.owner)).moveEnabled, false);
  await assert.rejects(f.review(), /Gmail API sources/); assert.equal(f.state.trashes, 0);
});
for (const changed of ["body", "missing", "folder", "Gmail Trash"]) test(`destination ${changed} after Copy prevents Gmail source POST`, async t => {
  const f = fixture(t, { destinationGmail: changed === "Gmail Trash" }); await f.copy(); const review = await f.review();
  if (changed === "body") f.state.destinationRaw = Buffer.from(RAW.toString().replace("Synthetic original", "Changed original"));
  if (changed === "missing") f.state.destination = null;
  if (changed === "folder") f.state.destinationFolder = "recreated";
  if (changed === "Gmail Trash") f.state.destinationLabels.push("TRASH");
  await assert.rejects(f.move(review), /Destination|destination|changed|copy|protected/i); assert.equal(f.state.trashes, 0); assert.equal(f.state.uploads, 1);
});
for (const stage of ["lane", "credential", "connection", "source-read", "destination-read", "source-folder", "source-metadata", "token"]) {
  test(`owner/credential cancellation during ${stage} prevents source removal`, async t => {
    const f = fixture(t); await f.copy(); const review = await f.review();
    f.hook(at => { if (at === stage) f.state.valid = false; });
    await assert.rejects(f.move(review), /changed|retained/i); assert.equal(f.state.trashes, 0);
  });
}
test("Stop, owner destruction, expired review and aged destination proof never submit Trash", async t => {
  for (const kind of ["stop", "owner", "expiry", "freshness"]) {
    const f = fixture(t); await f.copy(); const review = await f.review(); let hit = false;
    f.hook(async stage => {
      if (hit || stage !== "source-folder") return; hit = true;
      if (kind === "stop") await f.ms.answer({ action: "cancelReview", reviewId: review.reviewId }, f.owner);
      if (kind === "owner") f.state.alive = false;
      if (kind === "expiry") f.time(LIMITS.reviewMs + 1);
      if (kind === "freshness") f.time(LIMITS.freshMs + 1);
    });
    const result = await f.move(review).catch(error => error);
    assert.equal(f.state.trashes, 0); assert.ok(f.state.destination);
    assert.ok(result instanceof Error || result.status === "source_retained");
  }
});
test("lost source acknowledgement persists unknown across restart and never re-Trashes", async t => {
  const f = fixture(t); await f.copy(); const review = await f.review(); f.state.loseAck = true;
  const result = await f.move(review); assert.equal(result.status, "unknown"); assert.equal(result.sourceRetained, null); assert.equal(result.sourceTrashed, null);
  assert.equal(f.ml.list()[0].phase, "source_unknown"); assert.equal(f.state.trashes, 1);
  f.restart(); await assert.rejects(f.move(review), /separate Gmail Move review/); await assert.rejects(f.review(), /Trash|unconfirmed|could not/);
  assert.equal(f.state.trashes, 1); assert.equal(f.state.uploads, 1); assert.ok(f.state.destination);
});
test("a cancellation after submission stays unknown rather than authorizing safe retry", async t => {
  const f = fixture(t); await f.copy(); const review = await f.review(), held = wait();
  f.hook(async stage => { if (stage === "submitted") await held.promise; });
  const moving = f.move(review); while (!f.state.trashes) await tick();
  await f.ms.answer({ action: "cancelReview", reviewId: review.reviewId }, f.owner); held.release();
  assert.equal((await moving).status, "unknown"); assert.equal(f.ml.list()[0].phase, "source_unknown"); assert.equal(f.state.trashes, 1);
});
test("definitive rejected Trash retains the verified copy and requires a fresh review", async t => {
  const f = fixture(t); await f.copy(); const review = await f.review(); f.state.rejectTrash = true;
  assert.equal((await f.move(review)).status, "source_retained"); assert.equal(f.ml.list()[0].phase, "not_trashed");
  assert.equal((await f.move(review)).status, "source_retained"); assert.equal(f.state.trashes, 1);
  assert.ok(!f.state.labels.includes("TRASH")); assert.equal(f.state.uploads, 1);
});
for (const phase of ["prepared", "source_unknown", "source_trashed"]) test(`storage failure at ${phase} preserves the receiving copy and blocks replay`, async t => {
  const f = fixture(t); await f.copy(); const review = await f.review(), insert = f.ml.insert, update = f.ml.update;
  if (phase === "prepared") f.ml.insert = () => { throw new Error("synthetic disk full"); };
  else f.ml.update = (id, before, patch) => { if (patch.phase === phase) throw Object.assign(new Error("synthetic commit failure"), { code: "move_recovery" }); return update(id, before, patch); };
  const result = await f.move(review).catch(error => error);
  assert.equal(f.state.trashes, phase === "source_trashed" ? 1 : 0); assert.equal(f.state.uploads, 1); assert.ok(f.state.destination);
  if (phase === "source_trashed") { assert.equal(result.status, "unknown"); assert.equal(f.ml.list()[0].phase, "source_unknown"); }
  f.ml.insert = insert; f.ml.update = update;
});
test("corrupt Copy receipt and Move journal fail closed on the same cached handles", async t => {
  for (const which of ["copy", "move"]) {
    const f = fixture(t); await f.copy(); const review = await f.review();
    const file = which === "copy" ? f.copyFile : f.moveFile, table = which === "copy" ? "mailbox_copies" : "mailbox_moves";
    if (which === "move") {
      f.state.rejectTrash = true; await f.move(review); f.state.rejectTrash = false;
    }
    const sql = new Database(file); sql.prepare(`UPDATE ${table} SET sha=?`).run("bad-digest"); sql.close();
    const count = f.state.trashes;
    await assert.rejects(f.review(), /storage could not be verified/); assert.equal(f.state.trashes, count); assert.equal(f.state.uploads, 1);
  }
});
test("Move review capacity includes in-flight destination reviews before credential use", async t => {
  const f = fixture(t), held = wait(); f.hook(async stage => { if (stage === "destination-review") await held.promise; });
  const pending = Array.from({ length: LIMITS.reviews }, () => f.review().catch(error => error));
  await assert.rejects(f.review(), /Close an earlier/); held.release(); await Promise.all(pending); assert.equal(f.state.trashes, 0);
});

test("process exit preserves pre-submit uncertainty and expires unsubmitted authority without replay", async t => {
  const f = fixture(t); await f.copy(); f.state.rejectTrash = true; await f.move(await f.review());
  const record = f.ml.list()[0], before = f.state.trashes;
  for (const phase of ["prepared", "source_unknown"]) {
    const file = f.moveFile + ".crash-" + phase;
    const child = spawnSync(process.execPath, ["-e", "const j=require('./host/mail/move-recovery').createJournal(process.argv[1]);j.insert(JSON.parse(process.argv[2]));process.exit(23);",
      file, JSON.stringify({ ...record, phase })], { cwd: path.resolve(__dirname, ".."), timeout: 10000 });
    assert.equal(child.status, 23, child.stderr?.toString());
    const journal = moveJournal(file);
    try {
      journal.recover(); assert.equal(journal.list()[0].phase, phase === "prepared" ? "not_trashed" : "source_unknown");
      const restarted = moves({ journal, enabled: true, copies: () => assert.fail("restart cannot invoke provider work without a new review") });
      await assert.rejects(restarted.answer({ action: "move", reviewId: "old-review", confirmed: true, emailId: "message", accountId: "source" }, f.owner), /separate Gmail Move review/);
    } finally { journal.close(); }
  }
  assert.equal(f.state.trashes, before); assert.equal(f.state.uploads, 1);
});

test("native SQLITE_FULL rolls back intent and poisons the same recovery handle", async t => {
  const f = fixture(t); await f.copy(); f.state.rejectTrash = true; await f.move(await f.review());
  const record = f.ml.list()[0], file = f.moveFile + ".full"; let native;
  function TinyDatabase(path) { native = new Database(path); return native; }
  const journal = moveJournal(file, { database: TinyDatabase });
  try {
    native.pragma("max_page_count = " + native.pragma("page_count", { simple: true }));
    assert.throws(() => journal.insert({ ...record, detail: "x".repeat(12000) }), /storage could not be verified/);
    assert.throws(() => journal.find(record.sourceKey), /storage could not be verified/, "failed native write cannot be cached as healthy");
  } finally { journal.close(); }
  const reopened = moveJournal(file);
  try { assert.equal(reopened.list().length, 0, "failed SQLite transaction left no misleading prepared intent"); } finally { reopened.close(); }
  assert.equal(f.state.trashes, 1); assert.equal(f.state.uploads, 1);
});

test("Move receipt quota retains every source-removal record instead of allowing replay", async t => {
  const f = fixture(t); await f.copy(); f.state.rejectTrash = true; await f.move(await f.review());
  const sample = f.ml.list()[0], file = f.moveFile + ".quota", journal = moveJournal(file);
  try {
    const sql = new Database(file), insert = sql.prepare("INSERT INTO mailbox_moves VALUES(?,?,?,?,?,?)");
    try {
      sql.transaction(() => { for (let index = 0; index < 1000; index++) {
        const row = { ...sample, id: "fixture-" + index, sourceKey: digest("source-" + index) }, body = JSON.stringify(row);
        insert.run(row.id, row.sourceKey, row.phase, row.updatedAt, body, digest(body));
      } })();
    } finally { sql.close(); }
    assert.throws(() => journal.insert({ ...sample, id: "overflow", sourceKey: digest("overflow") }), /storage is full/);
    assert.equal(journal.list().length, 1000); assert.equal(f.state.trashes, 1);
  } finally { journal.close(); }
});

test("constructor pragma/schema failures close the native SQLite handle before cleanup", t => {
  const f = fixture(t);
  for (const failure of ["pragma", "schema"]) {
    let native;
    function BrokenDatabase(file) {
      native = new Database(file);
      if (failure === "pragma") {
        const pragma = native.pragma.bind(native);
        native.pragma = (...args) => { if (args[0] === "synchronous = EXTRA") throw new Error("synthetic fsync configuration failure"); return pragma(...args); };
      } else native.exec = () => { throw new Error("synthetic schema failure"); };
      return native;
    }
    assert.throws(() => moveJournal(f.moveFile + ".constructor-" + failure, { database: BrokenDatabase }), /storage could not be verified/);
    assert.equal(native.open, false); assert.equal(f.state.trashes, 0);
  }
});
