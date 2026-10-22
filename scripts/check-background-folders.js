// Background sync selects every listed folder and takes turns.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { planBackgroundFolders } = require("../host/mail/background-jobs");

const root = path.join(__dirname, "..");

function pathsOf(plan) {
  return plan.jobs.map((folder) => folder.path);
}

function checkPlanner() {
  const folders = [
    { path: "Drafts", well_known: "drafts" },
    { path: "INBOX", well_known: "inbox" },
    { path: "Projects/Alpha", well_known: null },
    { path: "Sent", well_known: "sentitems" },
    { path: "[Gmail]/All Mail", well_known: "all" },
  ];
  const first = planBackgroundFolders(folders, "", 0);
  assert.deepEqual(pathsOf(first), folders.map((folder) => folder.path));
  assert.equal(first.nextCursor(new Set(pathsOf(first))), 1);
  assert.equal(first.nextCursor(new Set(["Drafts"])), 1);
  assert.equal(first.cursorFor("Sent"), 3);

  const active = planBackgroundFolders(folders, "Sent", 0);
  assert.deepEqual(pathsOf(active), [
    "Drafts",
    "Sent",
    "INBOX",
    "Projects/Alpha",
    "[Gmail]/All Mail",
  ]);
  assert.equal(active.nextCursor(new Set(["Drafts", "Sent"])), 1);

  const turned = planBackgroundFolders(folders, "Sent", 3);
  assert.deepEqual(pathsOf(turned), [
    "Sent",
    "[Gmail]/All Mail",
    "Drafts",
    "INBOX",
    "Projects/Alpha",
  ]);
  assert.equal(pathsOf(turned).filter((folder) => folder === "Sent").length, 1);
  assert.equal(turned.nextCursor(new Set(pathsOf(turned))), 4);

  const wrapped = planBackgroundFolders(folders, null, -1);
  assert.equal(pathsOf(wrapped)[0], "[Gmail]/All Mail");

  const empty = planBackgroundFolders([{ path: "" }, null, { path: "INBOX" }], "Missing", 4);
  assert.deepEqual(pathsOf(empty), ["INBOX"]);
  assert.equal(planBackgroundFolders(null, "INBOX", 1).nextCursor(new Set()), 0);
  assert.equal(planBackgroundFolders([], "", 2).cursorFor("INBOX"), 0);
}

function checkCopy() {
  const independent = fs.readFileSync(path.join(root, "docs/INDEPENDENT_UI.md"), "utf8");
  const parity = fs.readFileSync(path.join(root, "docs/PARITY_SHELL.md"), "utf8");
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  for (const text of [independent, parity, html]) {
    assert.equal(text.includes("inbox plus the active folder"), false);
    assert.equal(text.includes("inbox and the active folder"), false);
    assert.equal(text.includes("Open other folders to download their history"), false);
    assert.equal(text.includes("does not start syncing every folder at once"), false);
    assert.equal(text.includes("for Inbox and the open folder"), false);
  }
  assert.ok(independent.includes("every listed folder"));
  assert.ok(parity.includes("every listed folder"));
  assert.ok(independent.includes("All removes the date bound"));
  assert.ok(independent.includes("more disk"));
  assert.ok(parity.includes("more disk"));
  assert.ok(html.includes("do not need to open a folder first"));
  assert.ok(html.includes("more disk"));
  assert.ok(parity.includes("every listed folder, not only Inbox"));
}

function accountRow(id, email, profile) {
  return {
    id,
    email,
    username: email,
    profile,
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

function header(uid) {
  return {
    uid,
    threadId: `t-${uid}`,
    rfcMessageId: `<${uid}@example.test>`,
    subject: `S${uid}`,
    snippet: "body",
    from: "Ada <ada@example.com>",
    to: [],
    cc: [],
    bcc: [],
    date: new Date().toISOString(),
    listSortTs: Date.now(),
    unread: false,
    bodyComplete: true,
  };
}

async function checkEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-bg-folders-"));
  const env = Object.fromEntries(
    ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_MAIL_SECRETS", "MORROW_PAGE_DELAY_MS", "MORROW_SYNC_TICK_MS"]
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    MORROW_USER_DATA: dir,
    MORROW_MAIL_DIR: dir,
    MORROW_MAIL_SECRETS: "memory",
    MORROW_PAGE_DELAY_MS: "0",
  });
  delete process.env.MORROW_SYNC_TICK_MS;
  const engine = require("../host/mail/engine");
  const db = require("../host/mail/db");
  const remote = require("../host/mail/remote");
  const secrets = require("../host/mail/secrets");
  const saved = {
    withClient: remote.withClient,
    listFolderRecords: remote.listFolderRecords,
    searchUids: remote.searchUids,
    fetchMessages: remote.fetchMessages,
    fetchSource: remote.fetchSource,
    changeFlags: remote.changeFlags,
  };
  const listed = [
    { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
    { path: "Sent", name: "Sent", wellKnown: "sentitems" },
    { path: "Drafts", name: "Drafts", wellKnown: "drafts" },
    { path: "[Gmail]/All Mail", name: "All Mail", wellKnown: "all" },
    { path: "Projects/Alpha", name: "Alpha", wellKnown: null },
    { path: "Empty", name: "Empty", wellKnown: null },
  ];
  const pathOrder = ["Drafts", "Empty", "INBOX", "Projects/Alpha", "Sent", "[Gmail]/All Mail"];
  const big = pathOrder.filter((folder) => folder !== "Empty");
  try {
    await engine.init();
    remote.withClient = async (_account, _secret, work) => work({});
    remote.listFolderRecords = async () => ({ folders: listed, delimiter: "/" });
    const range = Array.from({ length: 250 }, (_item, index) => index + 1);
    const searches = [];
    const fetched = [];
    remote.searchUids = async (_client, folder) => {
      searches.push(folder);
      if (folder === "Empty") return { uids: [], validity: 1, exists: 0, unseen: 0 };
      return { uids: range.slice(), validity: 1, exists: 250, unseen: 0 };
    };
    remote.fetchMessages = async (_client, folder, page) => {
      fetched.push({ folder, uids: page.slice() });
      return { validity: 1, messages: page.map(header) };
    };
    db.insertAccount(accountRow("bg-all", "all@example.test", "gmail"));
    secrets.setPassword("bg-all", "pw");
    await engine.syncAccountById("bg-all", { background: true });
    assert.deepEqual(searches, pathOrder, "background sync visits every listed folder without opening it");
    assert.deepEqual(fetched.map((row) => row.folder), big);
    assert.ok(fetched.every((row) => row.uids.length === engine.syncPolicy.headerBatch));
    assert.equal(fetched[0].uids[0], 250);
    assert.equal(db.folderByPath("bg-all", "Projects/Alpha").window_done, 0);
    assert.equal(db.folderByPath("bg-all", "Empty").window_done, 1);
    searches.length = 0;
    fetched.length = 0;
    await engine.syncAccountById("bg-all", { background: true });
    assert.deepEqual(fetched.map((row) => row.folder), [
      "INBOX",
      "Projects/Alpha",
      "Sent",
      "[Gmail]/All Mail",
      "Drafts",
    ]);
    assert.ok(fetched.every((row) => row.uids.length === engine.syncPolicy.headerBatch));
    assert.ok(searches.includes("Empty"));
    for (let pass = 0; pass < 2; pass += 1) await engine.syncAccountById("bg-all", { background: true });
    for (const folder of big) {
      const row = db.folderByPath("bg-all", folder);
      assert.equal(row.window_done, 1, folder);
      assert.equal(row.sync_horizon_days, 0, folder);
      assert.equal(db.countInFolder("bg-all", folder), 250, folder);
    }

    db.insertAccount(accountRow("bg-active", "active@example.test", "gmail"));
    secrets.setPassword("bg-active", "pw");
    engine.noteActive("bg-active", "Sent");
    searches.length = 0;
    fetched.length = 0;
    await engine.syncAccountById("bg-active", { background: true });
    assert.deepEqual(searches, ["Drafts", "Sent", "Empty", "INBOX", "Projects/Alpha", "[Gmail]/All Mail"]);
    assert.equal(fetched[0].folder, "Drafts");
    assert.equal(fetched[1].folder, "Sent");

    const budgetFolders = [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Notes", name: "Notes", wellKnown: null },
      { path: "Sent", name: "Sent", wellKnown: "sentitems" },
    ];
    remote.listFolderRecords = async () => ({ folders: budgetFolders, delimiter: "/" });
    remote.searchUids = async (_client, folder) => {
      searches.push(folder);
      return { uids: range.slice(), validity: 2, exists: 250, unseen: 0 };
    };
    remote.fetchMessages = async (_client, folder, page) => {
      fetched.push({ folder, uids: page.slice() });
      return { validity: 2, messages: page.map(header) };
    };
    db.insertAccount(accountRow("bg-budget", "budget@example.test", "custom"));
    secrets.setPassword("bg-budget", "pw");
    engine.noteActive("bg-budget", "Sent");
    process.env.MORROW_SYNC_TICK_MS = "0";
    searches.length = 0;
    fetched.length = 0;
    await engine.syncAccountById("bg-budget", { background: true });
    assert.deepEqual(fetched.map((row) => row.folder), ["INBOX"]);
    fetched.length = 0;
    await engine.syncAccountById("bg-budget", { background: true });
    assert.deepEqual(fetched.map((row) => row.folder), ["Notes"]);
    fetched.length = 0;
    await engine.syncAccountById("bg-budget", { background: true });
    assert.deepEqual(fetched.map((row) => row.folder), ["Sent"]);
    fetched.length = 0;
    await engine.syncAccountById("bg-budget", { background: true });
    assert.deepEqual(fetched.map((row) => row.folder), ["INBOX"]);
    delete process.env.MORROW_SYNC_TICK_MS;

    const removed = await engine.answer("mail:removeAccount", [{ accountId: "bg-budget" }]);
    assert.equal(removed.success, true);
    db.insertAccount(accountRow("bg-budget", "budget@example.test", "custom"));
    secrets.setPassword("bg-budget", "pw");
    process.env.MORROW_SYNC_TICK_MS = "0";
    fetched.length = 0;
    await engine.syncAccountById("bg-budget", { background: true });
    assert.deepEqual(fetched.map((row) => row.folder), ["INBOX"], "removing an account forgets its turn");
    delete process.env.MORROW_SYNC_TICK_MS;

    remote.listFolderRecords = async () => ({
      folders: [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }],
      delimiter: "/",
    });
    remote.searchUids = async () => ({ uids: range.slice(0, 150), validity: 3, exists: 150, unseen: 0 });
    const manual = [];
    remote.fetchMessages = async (_client, _folder, page) => {
      manual.push(page.length);
      return { validity: 3, messages: page.map(header) };
    };
    db.insertAccount(accountRow("bg-manual", "manual@example.test", "custom"));
    secrets.setPassword("bg-manual", "pw");
    await engine.syncAccountById("bg-manual", { onlyPath: "INBOX" });
    assert.deepEqual(manual, [100, 50], "opening Sync still finishes the folder batch window");

    db.insertAccount(accountRow("bg-ol", "ol@example.test", "outlook"));
    secrets.setPassword("bg-ol", "pw");
    const outlook = [];
    remote.searchUids = async () => ({
      uids: Array.from({ length: 60 }, (_item, index) => index + 1),
      validity: 4,
      exists: 60,
      unseen: 0,
    });
    remote.fetchMessages = async (_client, _folder, page) => {
      outlook.push(page.length);
      return { validity: 4, messages: page.map(header) };
    };
    await engine.syncAccountById("bg-ol", { background: true });
    assert.deepEqual(outlook, [engine.syncPolicy.outlookBatch]);
    await engine.syncAccountById("bg-ol", { background: true });
    assert.deepEqual(outlook, [50, 10]);
    assert.equal(db.folderByPath("bg-ol", "INBOX").window_done, 1);

    const rateFolders = [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Notes", name: "Notes", wellKnown: null },
      { path: "Sent", name: "Sent", wellKnown: "sentitems" },
    ];
    remote.listFolderRecords = async () => ({ folders: rateFolders, delimiter: "/" });
    const rateSearches = [];
    let failNotes = true;
    remote.searchUids = async (_client, folder) => {
      rateSearches.push(folder);
      if (failNotes && folder === "Notes") {
        throw Object.assign(new Error("slow down"), { status: 429, retryAfterMs: 60000 });
      }
      return { uids: [1], validity: 5, exists: 1, unseen: 0 };
    };
    remote.fetchMessages = async (_client, _folder, page) => ({ validity: 5, messages: page.map(header) });
    db.insertAccount(accountRow("bg-rate", "rate@example.test", "custom"));
    secrets.setPassword("bg-rate", "pw");
    await engine.syncAccountById("bg-rate", { background: true });
    assert.deepEqual(rateSearches, ["INBOX", "Notes"]);
    assert.ok(engine.syncGates.get("bg-rate").until > Date.now());
    engine.syncGates.delete("bg-rate");
    failNotes = false;
    rateSearches.length = 0;
    await engine.syncAccountById("bg-rate", { background: true });
    assert.deepEqual(rateSearches, ["Notes", "Sent", "INBOX", "INBOX"]);
    await checkOpenPriority(engine, db, remote, secrets);
    console.log("background-folders-ok");
  } finally {
    Object.assign(remote, saved);
    for (const id of ["bg-all", "bg-active", "bg-budget", "bg-manual", "bg-ol", "bg-rate", "bg-yield", "bg-resume", "bg-queue", "bg-manual-open", "bg-throw", "bg-paint", "bg-prefetch", "bg-page"]) {
      try { secrets.deletePassword(id); } catch { /* already gone */ }
      engine.syncGates.delete(id);
    }
    try { await db.close(); } catch { /* the store may already be closed */ }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sourceBody(uid, html) {
  return {
    uid,
    htmlBody: html,
    textBody: "Opened",
    snippet: "Opened",
    subject: "Need body",
    attachments: [],
    hasAttachments: false,
    bodyComplete: true,
    recipientHeaders: {},
  };
}

function insertIncomplete(db, id, accountId, folderPath, uid) {
  db.insertMessage({
    id,
    accountId,
    folderPath,
    uid,
    uidValidity: 1,
    threadId: id,
    subject: "Need body",
    snippet: "snippet",
    from: "Ada <ada@example.com>",
    date: new Date().toISOString(),
    listSortTs: Date.now(),
    unread: true,
    bodyComplete: false,
  });
}

async function checkOpenPriority(engine, db, remote, secrets) {
  const opens = { active: 0, max: 0 };
  remote.withClient = async (_account, _secret, work) => {
    opens.active += 1;
    opens.max = Math.max(opens.max, opens.active);
    try {
      return await work({});
    } finally {
      opens.active -= 1;
    }
  };
  const three = [
    { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
    { path: "Notes", name: "Notes", wellKnown: null },
    { path: "Sent", name: "Sent", wellKnown: "sentitems" },
  ];
  remote.listFolderRecords = async () => ({ folders: three, delimiter: "/" });

  process.env.MORROW_SYNC_TICK_MS = "0";
  const yieldEvents = [];
  let releaseYield = () => {};
  let markYieldStarted = () => {};
  const yieldStarted = new Promise((resolve) => { markYieldStarted = resolve; });
  const yieldGate = new Promise((resolve) => { releaseYield = resolve; });
  remote.searchUids = async (_client, folder) => {
    yieldEvents.push(`search:${folder}`);
    if (folder === "Sent") return { uids: [7], validity: 1, exists: 1, unseen: 0 };
    return { uids: [1], validity: 1, exists: 1, unseen: 0 };
  };
  remote.fetchMessages = async (_client, folder, page) => {
    yieldEvents.push(`fetch:${folder}`);
    if (folder === "INBOX" && !yieldEvents.includes("source")) {
      markYieldStarted();
      await yieldGate;
    }
    return { validity: 1, messages: page.map(header) };
  };
  remote.fetchSource = async (_client, _folder, uid) => {
    yieldEvents.push("source");
    return sourceBody(uid, "<p>Opened</p>");
  };
  db.insertAccount(accountRow("bg-yield", "yield@example.test", "custom"));
  secrets.setPassword("bg-yield", "pw");
  insertIncomplete(db, "bg-yield-body", "bg-yield", "Sent", 7);
  let yieldSync = Promise.resolve();
  let yieldOpen = Promise.resolve();
  try {
    yieldSync = engine.syncAccountById("bg-yield", { background: true });
    await yieldStarted;
    yieldOpen = engine.answer("mail:openEmail", [{ emailId: "bg-yield-body" }]);
    releaseYield();
    const opened = await yieldOpen;
    await yieldSync;
    assert.equal(opened.success, true);
    assert.equal(opened.data.email.htmlBody, "<p>Opened</p>");
    assert.deepEqual(yieldEvents, ["search:INBOX", "fetch:INBOX", "source"], "an open runs after the in-flight folder and before the next one");
    assert.equal(db.messageById("bg-yield-body").body_complete, 1);
    assert.equal(db.folderByPath("bg-yield", "INBOX").uid_cursor, 1);
    assert.equal(db.folderByPath("bg-yield", "INBOX").window_done, 1);
    assert.equal(db.folderByPath("bg-yield", "Notes").uid_cursor, 0);
    assert.equal(db.folderByPath("bg-yield", "Notes").window_done, 0);
    yieldEvents.length = 0;
    await engine.syncAccountById("bg-yield", { background: true });
    assert.deepEqual(yieldEvents, ["search:Notes", "fetch:Notes"], "the next poll resumes at the folder that yielded");
    yieldEvents.length = 0;
    await engine.syncAccountById("bg-yield", { background: true });
    assert.deepEqual(yieldEvents, ["search:Sent"], "a later poll still reaches the remaining folder");
    assert.equal(db.messageById("bg-yield-body").html_body, "<p>Opened</p>");
    assert.equal(db.messageById("bg-yield-body").uid, 7);
    assert.equal(db.countInFolder("bg-yield", "Sent"), 1);
    assert.equal(db.folderByPath("bg-yield", "Sent").window_done, 1);
    assert.equal(db.folderByPath("bg-yield", "Sent").uid_cursor, 7);
  } finally {
    releaseYield();
    delete process.env.MORROW_SYNC_TICK_MS;
    await Promise.allSettled([yieldSync, yieldOpen]);
  }

  process.env.MORROW_SYNC_TICK_MS = "60000";
  const resumeEvents = [];
  let releaseResume = () => {};
  let markResumeStarted = () => {};
  const resumeStarted = new Promise((resolve) => { markResumeStarted = resolve; });
  const resumeGate = new Promise((resolve) => { releaseResume = resolve; });
  remote.searchUids = async (_client, folder) => {
    resumeEvents.push(`search:${folder}`);
    if (folder === "Sent") return { uids: [7], validity: 1, exists: 1, unseen: 0 };
    return { uids: [1], validity: 1, exists: 1, unseen: 0 };
  };
  remote.fetchMessages = async (_client, folder, page) => {
    resumeEvents.push(`fetch:${folder}`);
    if (folder === "INBOX") {
      markResumeStarted();
      await resumeGate;
    }
    return { validity: 1, messages: page.map(header) };
  };
  remote.fetchSource = async (_client, _folder, uid) => {
    resumeEvents.push("source");
    return sourceBody(uid, "<p>Resumed</p>");
  };
  db.insertAccount(accountRow("bg-resume", "resume@example.test", "custom"));
  secrets.setPassword("bg-resume", "pw");
  insertIncomplete(db, "bg-resume-body", "bg-resume", "Sent", 7);
  let resumeSync = Promise.resolve();
  let resumeOpen = Promise.resolve();
  try {
    resumeSync = engine.syncAccountById("bg-resume", { background: true });
    await resumeStarted;
    resumeOpen = engine.answer("mail:openEmail", [{ emailId: "bg-resume-body" }]);
    releaseResume();
    const opened = await resumeOpen;
    await resumeSync;
    assert.equal(opened.success, true);
    assert.equal(opened.data.email.htmlBody, "<p>Resumed</p>");
    assert.deepEqual(resumeEvents, [
      "search:INBOX",
      "fetch:INBOX",
      "source",
      "search:Notes",
      "fetch:Notes",
      "search:Sent",
    ], "the same tick continues the pass after the body fetch");
    assert.equal(db.messageById("bg-resume-body").html_body, "<p>Resumed</p>");
    assert.equal(db.folderByPath("bg-resume", "Sent").uid_cursor, 7);
    assert.equal(db.countInFolder("bg-resume", "INBOX"), 1);
  } finally {
    releaseResume();
    delete process.env.MORROW_SYNC_TICK_MS;
    await Promise.allSettled([resumeSync, resumeOpen]);
  }

  const queueEvents = [];
  let releaseRead = () => {};
  let markReadStarted = () => {};
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  remote.listFolderRecords = async () => ({
    folders: [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Notes", name: "Notes", wellKnown: null },
    ],
    delimiter: "/",
  });
  remote.searchUids = async (_client, folder) => {
    queueEvents.push(`search:${folder}`);
    if (folder === "Notes") return { uids: [7], validity: 1, exists: 1, unseen: 0 };
    return { uids: [1], validity: 1, exists: 1, unseen: 0 };
  };
  remote.fetchMessages = async (_client, folder, page) => {
    queueEvents.push(`fetch:${folder}`);
    return { validity: 1, messages: page.map(header) };
  };
  remote.fetchSource = async (_client, _folder, uid) => {
    queueEvents.push("source");
    return sourceBody(uid, "<p>Queued</p>");
  };
  remote.changeFlags = async () => {
    markReadStarted();
    await readGate;
  };
  db.insertAccount(accountRow("bg-queue", "queue@example.test", "custom"));
  secrets.setPassword("bg-queue", "pw");
  db.insertMessage({
    id: "bg-queue-flag",
    accountId: "bg-queue",
    folderPath: "INBOX",
    uid: 1,
    uidValidity: 1,
    subject: "Flag",
    from: "Ada <ada@example.com>",
    date: new Date().toISOString(),
    listSortTs: Date.now(),
    unread: true,
    bodyComplete: true,
    htmlBody: "<p>Flag</p>",
    textBody: "Flag",
  });
  insertIncomplete(db, "bg-queue-body", "bg-queue", "Notes", 7);
  let queueSync = Promise.resolve();
  let queueOpen = Promise.resolve();
  let reading = Promise.resolve();
  try {
    reading = engine.answer("mail:markRead", [{ emailId: "bg-queue-flag", isRead: true }]);
    await readStarted;
    queueSync = engine.syncAccountById("bg-queue", { background: true });
    for (let i = 0; i < 30 && engine.mailQueueForTest("bg-queue").background !== 1; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(engine.mailQueueForTest("bg-queue"), { user: 0, background: 1, active: true });
    queueOpen = engine.answer("mail:openEmail", [{ emailId: "bg-queue-body" }]);
    assert.deepEqual(engine.mailQueueForTest("bg-queue"), { user: 1, background: 1, active: true });
    releaseRead();
    const opened = await queueOpen;
    const during = queueEvents.slice();
    await queueSync;
    assert.equal(opened.success, true);
    assert.equal(opened.data.email.htmlBody, "<p>Queued</p>");
    assert.deepEqual(during, ["source"], "a queued open runs before a background walk that is already queued");
    assert.deepEqual(queueEvents, ["source", "search:INBOX", "search:Notes"]);
  } finally {
    releaseRead();
    await Promise.allSettled([reading, queueSync, queueOpen]);
  }

  const manualEvents = [];
  let releaseManual = () => {};
  let markManualStarted = () => {};
  const manualStarted = new Promise((resolve) => { markManualStarted = resolve; });
  const manualGate = new Promise((resolve) => { releaseManual = resolve; });
  remote.listFolderRecords = async () => ({
    folders: [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }],
    delimiter: "/",
  });
  remote.searchUids = async () => ({
    uids: Array.from({ length: 150 }, (_item, index) => index + 1),
    validity: 9,
    exists: 150,
    unseen: 0,
  });
  remote.fetchMessages = async (_client, _folder, page) => {
    manualEvents.push(`page:${page.length}`);
    if (page.length === 100) {
      markManualStarted();
      await manualGate;
    }
    return { validity: 9, messages: page.map(header) };
  };
  remote.fetchSource = async (_client, _folder, uid) => {
    manualEvents.push("source");
    return sourceBody(uid, "<p>After sync</p>");
  };
  db.insertAccount(accountRow("bg-manual-open", "manual-open@example.test", "custom"));
  secrets.setPassword("bg-manual-open", "pw");
  insertIncomplete(db, "bg-manual-body", "bg-manual-open", "Sent", 9);
  let manualSync = Promise.resolve();
  let manualOpen = Promise.resolve();
  try {
    manualSync = engine.answer("mail:listFromNetwork", [{ accountId: "bg-manual-open", folderId: "INBOX" }]);
    await manualStarted;
    manualOpen = engine.answer("mail:openEmail", [{ emailId: "bg-manual-body" }]);
    releaseManual();
    const opened = await manualOpen;
    await manualSync;
    assert.equal(opened.success, true);
    assert.equal(opened.data.email.htmlBody, "<p>After sync</p>");
    assert.deepEqual(manualEvents, ["page:100", "page:50", "source"], "manual Sync still finishes the open folder before a body fetch");
  } finally {
    releaseManual();
    await Promise.allSettled([manualSync, manualOpen]);
  }

  const throwEvents = [];
  let releaseThrow = () => {};
  let markThrowStarted = () => {};
  const throwStarted = new Promise((resolve) => { markThrowStarted = resolve; });
  const throwGate = new Promise((resolve) => { releaseThrow = resolve; });
  remote.listFolderRecords = async () => ({ folders: three, delimiter: "/" });
  remote.searchUids = async (_client, folder) => {
    throwEvents.push(`search:${folder}`);
    if (folder === "Sent") return { uids: [7], validity: 1, exists: 1, unseen: 0 };
    return { uids: [1], validity: 1, exists: 1, unseen: 0 };
  };
  remote.fetchMessages = async () => {
    markThrowStarted();
    await throwGate;
    throw new Error("folder failed");
  };
  remote.fetchSource = async (_client, _folder, uid) => {
    throwEvents.push("source");
    return sourceBody(uid, "<p>After failure</p>");
  };
  db.insertAccount(accountRow("bg-throw", "throw@example.test", "custom"));
  secrets.setPassword("bg-throw", "pw");
  insertIncomplete(db, "bg-throw-body", "bg-throw", "Sent", 7);
  let throwSync = Promise.resolve();
  let throwOpen = Promise.resolve();
  try {
    throwSync = engine.syncAccountById("bg-throw", { background: true });
    await throwStarted;
    throwOpen = engine.answer("mail:openEmail", [{ emailId: "bg-throw-body" }]);
    releaseThrow();
    const failure = assert.rejects(throwSync);
    const opened = await throwOpen;
    await failure;
    assert.equal(opened.success, true);
    assert.equal(opened.data.email.htmlBody, "<p>After failure</p>");
    assert.deepEqual(throwEvents, ["search:INBOX", "source"]);
    assert.equal(db.messageById("bg-throw-body").uid, 7);
  } finally {
    releaseThrow();
    await Promise.allSettled([throwSync, throwOpen]);
  }

  await checkPaintAndPrefetch(engine, db, remote, secrets);
  assert.equal(opens.max, 1, "a body fetch waits for the in-flight mailbox connection to close");
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
    date: new Date().toISOString(),
    listSortTs: fields.listSortTs,
    unread: true,
    bodyComplete: fields.bodyComplete === true,
    htmlBody: fields.htmlBody || null,
    textBody: fields.textBody || null,
  });
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function checkPaintAndPrefetch(engine, db, remote, secrets) {
  const events = [];
  let releaseFetch = () => {};
  let markStarted = () => {};
  let started = new Promise((resolve) => { markStarted = resolve; });
  const arm = () => {
    started = new Promise((resolve) => { markStarted = resolve; });
    releaseFetch = () => {};
  };
  remote.fetchSource = async (_client, _folder, uid) => {
    events.push(Number(uid));
    markStarted();
    await new Promise((resolve) => { releaseFetch = resolve; });
    return sourceBody(uid, `<p>Full ${uid}</p>`);
  };
  db.insertAccount(accountRow("bg-paint", "paint@example.test", "custom"));
  secrets.setPassword("bg-paint", "pw");
  db.replaceFolders("bg-paint", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], "/");
  insertBody(db, "bg-paint-cached", "bg-paint", "INBOX", 4, {
    listSortTs: 40,
    htmlBody: "<p>Cached newsletter</p>",
    textBody: "Cached newsletter",
  });
  arm();
  const painted = await engine.answer("mail:openEmail", [{ emailId: "bg-paint-cached" }]);
  assert.equal(painted.success, true);
  assert.equal(painted.data.email.htmlBody, "<p>Cached newsletter</p>");
  assert.equal(painted.data.email.bodyComplete, false);
  assert.equal(painted.data.email.hasBody, true);
  await started;
  assert.equal(db.messageById("bg-paint-cached").body_complete, 0, "paint-first returns before the full fetch finishes");
  let fullDone = false;
  const fullOpen = engine.answer("mail:openEmail", [{ emailId: "bg-paint-cached", full: true }]);
  fullOpen.then(() => { fullDone = true; });
  await tick();
  assert.equal(fullDone, false, "a reply that asks for the full body still waits");
  releaseFetch();
  const full = await fullOpen;
  assert.equal(full.success, true);
  assert.equal(full.data.email.bodyComplete, true);
  assert.match(full.data.email.htmlBody, /Full 4/);
  assert.deepEqual(events, [4], "the background fill and the waiting open share one fetch");
  assert.equal(db.messageById("bg-paint-cached").body_complete, 1);

  remote.fetchSource = async (_client, _folder, uid) => {
    events.push(Number(uid));
    return sourceBody(uid, `<p>Full ${uid}</p>`);
  };
  events.length = 0;
  db.insertAccount(accountRow("bg-prefetch", "prefetch@example.test", "custom"));
  secrets.setPassword("bg-prefetch", "pw");
  db.replaceFolders("bg-prefetch", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], "/");
  insertBody(db, "bg-pre-3", "bg-prefetch", "INBOX", 3, { listSortTs: 300 });
  insertBody(db, "bg-pre-2", "bg-prefetch", "INBOX", 2, { listSortTs: 200 });
  insertBody(db, "bg-pre-1", "bg-prefetch", "INBOX", 1, { listSortTs: 100 });
  insertBody(db, "bg-pre-open", "bg-prefetch", "INBOX", 9, { listSortTs: 50 });
  const listed = engine.answer("mail:listFromCache", [{ accountId: "bg-prefetch", folderId: "INBOX", limit: 3 }]);
  assert.deepEqual(listed.data.emails.map((row) => row.id), ["bg-pre-3", "bg-pre-2", "bg-pre-1"]);
  const openResult = await engine.answer("mail:openEmail", [{ emailId: "bg-pre-open" }]);
  assert.equal(openResult.success, true);
  assert.match(openResult.data.email.htmlBody, /Full 9/);
  for (let i = 0; i < 40 && events.length < 4; i += 1) await tick();
  assert.equal(events[0], 9, "an open runs before a visible-page prefetch");
  assert.deepEqual(events, [9, 3, 2, 1]);
  assert.equal(db.messageById("bg-pre-1").body_complete, 1);
  assert.equal(db.messageById("bg-pre-open").body_complete, 1);

  events.length = 0;
  db.insertAccount(accountRow("bg-page", "page@example.test", "custom"));
  secrets.setPassword("bg-page", "pw");
  db.replaceFolders("bg-page", [
    { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
    { path: "Notes", name: "Notes", wellKnown: null },
  ], "/");
  insertBody(db, "bg-page-a1", "bg-page", "INBOX", 31, { listSortTs: 310 });
  insertBody(db, "bg-page-a2", "bg-page", "INBOX", 32, { listSortTs: 300 });
  insertBody(db, "bg-page-a3", "bg-page", "INBOX", 33, { listSortTs: 290 });
  insertBody(db, "bg-page-old", "bg-page", "INBOX", 34, { listSortTs: 10 });
  insertBody(db, "bg-page-b1", "bg-page", "Notes", 41, { listSortTs: 280 });
  engine.answer("mail:listFromCache", [{ accountId: "bg-page", folderId: "INBOX", limit: 2 }]);
  engine.answer("mail:listFromCache", [{ accountId: "bg-page", folderId: "Notes", limit: 50 }]);
  for (let i = 0; i < 40 && events.length < 2; i += 1) await tick();
  assert.equal(events.includes(32), false, "changing the page drops the rest of the previous prefetch");
  assert.equal(events.includes(33), false, "changing the page drops the rest of the previous prefetch");
  assert.equal(events.includes(34), false, "prefetch stays on the loaded page");
  assert.ok(events.includes(41), "the new page prefetches its own incomplete row");
  assert.equal(db.messageById("bg-page-a3").body_complete, 0);
  assert.equal(db.messageById("bg-page-b1").body_complete, 1);
}

async function run() {
  checkPlanner();
  checkCopy();
  await checkEngine();
}

module.exports = { run };
if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
