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
    console.log("background-folders-ok");
  } finally {
    Object.assign(remote, saved);
    for (const id of ["bg-all", "bg-active", "bg-budget", "bg-manual", "bg-ol", "bg-rate"]) {
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
