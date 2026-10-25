// Off-hours body fill stays on the background poll, one message at a time.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const overnight = require("../host/mail/overnight");

const DAY_MS = 24 * 60 * 60 * 1000;
const NIGHT = "2026-06-15T03:30:00.000Z";
const DAY = "2026-06-15T15:00:00.000Z";

function checkWindow() {
  assert.equal(overnight.NIGHT_START_HOUR, 0);
  assert.equal(overnight.NIGHT_END_HOUR, 7);
  assert.equal(overnight.inOvernightWindow("2026-06-15T00:00:00.000Z", "UTC"), true);
  assert.equal(overnight.inOvernightWindow("2026-06-15T03:30:00.000Z", "UTC"), true);
  assert.equal(overnight.inOvernightWindow("2026-06-15T06:59:00.000Z", "UTC"), true);
  assert.equal(overnight.inOvernightWindow("2026-06-15T07:00:00.000Z", "UTC"), false);
  assert.equal(overnight.inOvernightWindow("2026-06-15T23:30:00.000Z", "UTC"), false);
  assert.equal(overnight.inOvernightWindow("2026-06-15T07:30:00.000Z", "America/Los_Angeles"), true);
  assert.equal(overnight.inOvernightWindow("2026-06-15T14:00:00.000Z", "America/Los_Angeles"), false);
  assert.equal(overnight.hourInTimeZone("2026-06-15T00:00:00.000Z", "UTC"), 0);
}

function accountRow(id, email) {
  return {
    id,
    email,
    username: email,
    profile: "custom",
    imapHost: "imap.example.test",
    imapPort: 993,
    imapTls: true,
    smtpHost: "smtp.example.test",
    smtpPort: 465,
    smtpTls: true,
    delimiter: "/",
    createdAt: Date.now(),
  };
}

function sourceBody(uid) {
  return {
    uid,
    htmlBody: `<p>Full ${uid}</p>`,
    textBody: "Opened",
    snippet: "Opened",
    subject: "Need body",
    attachments: [{ filename: "note.txt", size: 12 }],
    hasAttachments: true,
    bodyComplete: true,
    recipientHeaders: {},
  };
}

function insertBody(db, id, accountId, folderPath, uid, extra) {
  const fields = extra || {};
  db.insertMessage({
    id,
    accountId,
    folderPath,
    uid,
    uidValidity: 1,
    threadId: id,
    subject: fields.subject || "Need body",
    snippet: "snippet",
    from: "Ada <ada@example.com>",
    date: new Date(fields.listSortTs || Date.now()).toISOString(),
    listSortTs: fields.listSortTs,
    unread: true,
    bodyComplete: fields.bodyComplete === true,
    htmlBody: fields.htmlBody || null,
    textBody: fields.textBody || null,
    isDraft: fields.isDraft === true,
  });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function checkEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-overnight-"));
  const env = Object.fromEntries(
    ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_MAIL_SECRETS", "MORROW_PAGE_DELAY_MS", "MORROW_SYNC_TICK_MS", "MORROW_OVERNIGHT_AT", "MORROW_OVERNIGHT_TZ"]
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    MORROW_USER_DATA: dir,
    MORROW_MAIL_DIR: dir,
    MORROW_MAIL_SECRETS: "memory",
    MORROW_PAGE_DELAY_MS: "0",
    MORROW_OVERNIGHT_AT: DAY,
    MORROW_OVERNIGHT_TZ: "UTC",
  });
  delete process.env.MORROW_SYNC_TICK_MS;
  const engine = require("../host/mail/engine");
  const db = require("../host/mail/db");
  const remote = require("../host/mail/remote");
  const secrets = require("../host/mail/secrets");
  const settings = require("../host/settings");
  const saved = {
    withClient: remote.withClient,
    listFolderRecords: remote.listFolderRecords,
    searchUids: remote.searchUids,
    fetchMessages: remote.fetchMessages,
    fetchSource: remote.fetchSource,
    readPart: remote.readPart,
  };
  const events = [];
  let active = 0;
  let maxActive = 0;
  let readParts = 0;
  let hold = false;
  let release = () => {};
  let markStarted = () => {};
  let started = Promise.resolve();
  const arm = () => {
    started = new Promise((resolve) => { markStarted = resolve; });
    release = () => {};
  };
  const ids = [];
  try {
    await engine.init();
    if (typeof engine.resetOvernightForTest === "function") engine.resetOvernightForTest();
    remote.withClient = async (_account, _secret, work) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await work({});
      } finally {
        active -= 1;
      }
    };
    remote.readPart = async () => {
      readParts += 1;
      throw new Error("overnight must not download attachment bytes");
    };
    remote.fetchSource = async (_client, _folder, uid) => {
      events.push(Number(uid));
      if (hold) {
        markStarted();
        await new Promise((resolve) => { release = resolve; });
      }
      return sourceBody(uid);
    };
    remote.listFolderRecords = async () => ({
      folders: [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }],
      delimiter: "/",
    });
    remote.searchUids = async (_client, _folder, criteria) => {
      if (criteria && typeof criteria.uid === "string") return { uids: [], validity: 1, exists: 2, unseen: 0 };
      return { uids: [4, 5], validity: 1, exists: 2, unseen: 0 };
    };
    remote.fetchMessages = async () => {
      throw new Error("pre-indexed mail should not be fetched again as headers");
    };

    const now = Date.parse(NIGHT);
    db.insertAccount(accountRow("night-poll", "poll@example.test"));
    secrets.setPassword("night-poll", "pw");
    ids.push("night-poll");
    db.replaceFolders("night-poll", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], "/");
    insertBody(db, "night-poll-new", "night-poll", "INBOX", 5, { listSortTs: now - DAY_MS });
    insertBody(db, "night-poll-old", "night-poll", "INBOX", 4, { listSortTs: now - 2 * DAY_MS });

    const day = await engine.fillOvernightBodies();
    assert.equal(day.window, false);
    assert.equal(day.fetched, 0);
    assert.deepEqual(events, [], "daytime does not download bodies");
    await engine.syncAllForTest({ background: true });
    assert.deepEqual(events, [], "the daytime background poll does not download bodies");

    process.env.MORROW_OVERNIGHT_AT = NIGHT;
    await engine.syncAllForTest({ background: true });
    assert.deepEqual(events, [5], "one night poll downloads only the newest incomplete body");
    assert.equal(db.messageById("night-poll-new").body_complete, 1);
    assert.equal(db.messageById("night-poll-old").body_complete, 0);
    assert.equal(maxActive, 1, "overnight body download stays at one IMAP client");
    await engine.answer("mail:removeAccount", [{ accountId: "night-poll" }]);

    db.insertAccount(accountRow("night-open", "open@example.test"));
    secrets.setPassword("night-open", "pw");
    ids.push("night-open");
    db.replaceFolders("night-open", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], "/");
    insertBody(db, "night-open-target", "night-open", "INBOX", 9, { listSortTs: now - 10 * DAY_MS });
    insertBody(db, "night-open-new", "night-open", "INBOX", 8, {
      listSortTs: now - 1000,
      htmlBody: "<p>Cached</p>",
      textBody: "Cached",
    });
    insertBody(db, "night-open-next", "night-open", "INBOX", 7, { listSortTs: now - 2000 });
    events.length = 0;
    maxActive = 0;
    hold = true;
    arm();
    const openPromise = engine.answer("mail:openEmail", [{ emailId: "night-open-target" }]);
    await started;
    const opening = engine.answer("mail:getBodySyncStatus", [{}]).data;
    assert.equal(opening.accounts.find(a => a.accountId === "night-open").state, "running");
    assert.equal(opening.accounts.find(a => a.accountId === "night-open").source, "open");
    const nightPromise = engine.fillOvernightBodies();
    await tick();
    assert.deepEqual(events, [9], "overnight does not fetch while an open holds the connection");
    assert.equal(maxActive, 1);
    const busy = await engine.fillOvernightBodies();
    assert.equal(busy.busy, true);
    assert.equal(maxActive, 1, "a second overnight pass does not open another IMAP client");
    assert.deepEqual(events, [9]);
    hold = false;
    release();
    const opened = await openPromise;
    const night = await nightPromise;
    const completed = engine.answer("mail:getBodySyncStatus", [{}]).data;
    assert.equal(completed.accounts.find(a => a.accountId === "night-open").state, "idle");
    assert.equal(completed.accounts.find(a => a.accountId === "night-open").lastResult, "done");
    assert.doesNotMatch(JSON.stringify(completed), /open@example|Full 9|Need body|htmlBody|subject/);
    assert.equal(opened.success, true);
    assert.match(opened.data.email.htmlBody, /Full 9/);
    assert.equal(night.fetched, 1);
    assert.deepEqual(events, [9, 8], "after the open, overnight fills the newest incomplete body");
    assert.equal(db.messageById("night-open-next").body_complete, 0);
    hold = false;
    const follow = await engine.fillOvernightBodies();
    assert.equal(follow.fetched, 1);
    assert.deepEqual(events, [9, 8, 7]);
    assert.equal(maxActive, 1);

    settings.answer("morrow:configSetSyncHorizonDays", [180]);
    db.insertAccount(accountRow("night-horizon", "horizon@example.test"));
    secrets.setPassword("night-horizon", "pw");
    ids.push("night-horizon");
    db.replaceFolders("night-horizon", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], "/");
    insertBody(db, "night-horizon-old", "night-horizon", "INBOX", 15, { listSortTs: now - 200 * DAY_MS });
    insertBody(db, "night-horizon-new", "night-horizon", "INBOX", 16, { listSortTs: now - DAY_MS });
    events.length = 0;
    const horizon = await engine.fillOvernightBodies();
    assert.equal(horizon.fetched, 1);
    assert.deepEqual(events, [16], "overnight stays inside the sync horizon");
    assert.equal(db.messageById("night-horizon-old").body_complete, 0);
    settings.answer("morrow:configSetSyncHorizonDays", [0]);
    await engine.answer("mail:removeAccount", [{ accountId: "night-horizon" }]);

    db.insertAccount(accountRow("night-skip", "skip@example.test"));
    secrets.setPassword("night-skip", "pw");
    ids.push("night-skip");
    db.replaceFolders("night-skip", [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Trash", name: "Trash", wellKnown: "deleteditems" },
      { path: "Junk", name: "Junk", wellKnown: "junkemail" },
    ], "/");
    insertBody(db, "night-skip-trash", "night-skip", "Trash", 21, { listSortTs: now - 10 });
    insertBody(db, "night-skip-junk", "night-skip", "Junk", 22, { listSortTs: now - 20 });
    insertBody(db, "night-skip-draft", "night-skip", "INBOX", 23, { listSortTs: now - 30, isDraft: true });
    insertBody(db, "night-skip-inbox", "night-skip", "INBOX", 24, { listSortTs: now - 40 });
    events.length = 0;
    const skipped = await engine.fillOvernightBodies();
    assert.equal(skipped.fetched, 1);
    assert.deepEqual(events, [24], "trash, spam, and drafts are not bulk-downloaded");
    assert.equal(readParts, 0, "attachment bytes stay on demand");

    db.insertAccount(accountRow("night-rate", "rate@example.test"));
    secrets.setPassword("night-rate", "pw");
    ids.push("night-rate");
    db.replaceFolders("night-rate", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], "/");
    insertBody(db, "night-rate-body", "night-rate", "INBOX", 30, { listSortTs: now - 5 });
    remote.fetchSource = async (_client, _folder, uid) => {
      events.push(Number(uid));
      throw Object.assign(new Error("slow down"), { status: 429, retryAfterMs: 60000 });
    };
    events.length = 0;
    const limited = await engine.fillOvernightBodies();
    assert.equal(limited.fetched, 0);
    assert.deepEqual(events, [30]);
    assert.ok(engine.syncGates.get("night-rate").until > Date.now(), "a 429 pauses that account");
    const activity = engine.answer("mail:getBodySyncStatus", [{}]).data;
    assert.equal(activity.accounts.find(a => a.accountId === "night-rate").reason, "rate-limit");
    assert.doesNotMatch(JSON.stringify(activity), /slow down/);
    const paused = await engine.fillOvernightBodies();
    assert.equal(paused.fetched, 0);
    assert.deepEqual(events, [30], "a paused account is not fetched again on the next pass");
    engine.syncGates.delete("night-rate");

    remote.fetchSource = async (_client, _folder, uid) => {
      events.push(Number(uid));
      if (hold) {
        markStarted();
        await new Promise((resolve) => { release = resolve; });
      }
      return sourceBody(uid);
    };
    db.insertAccount(accountRow("night-prefetch", "prefetch@example.test"));
    secrets.setPassword("night-prefetch", "pw");
    ids.push("night-prefetch");
    db.replaceFolders("night-prefetch", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], "/");
    insertBody(db, "night-prefetch-row", "night-prefetch", "INBOX", 41, { listSortTs: now - 1 });
    insertBody(db, "night-prefetch-other", "night-prefetch", "INBOX", 42, { listSortTs: now - 2 });
    events.length = 0;
    maxActive = 0;
    hold = true;
    arm();
    engine.answer("mail:listFromCache", [{ accountId: "night-prefetch", folderId: "INBOX", limit: 50 }]);
    await started;
    const yielded = await engine.fillOvernightBodies();
    assert.equal(yielded.yielded, "prefetch");
    assert.deepEqual(events, [41], "overnight waits while the visible page is prefetching");
    assert.equal(maxActive, 1);
    hold = false;
    release();
    for (let i = 0; i < 20 && events.length < 2; i += 1) await tick();
    assert.deepEqual(events, [41, 42], "the visible page still finishes after overnight yields");
    console.log("overnight-bodies-ok");
  } finally {
    release();
    for (const id of ids) {
      try { secrets.deletePassword(id); } catch { /* already gone */ }
      engine.syncGates.delete(id);
    }
    try { settings.answer("morrow:configSetSyncHorizonDays", [0]); } catch { /* the temp dir may already be gone */ }
    try { await db.close(); } catch { /* the store may already be closed */ }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    Object.assign(remote, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function run() {
  checkWindow();
  await checkEngine();
}

module.exports = { run };
if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
