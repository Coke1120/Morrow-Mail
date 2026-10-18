// Offline end-to-end preference, sync, and cache paging checks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { renderer } = require("./check-ux-workflows");

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-horizon-"));
  const env = Object.fromEntries(["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_MAIL_SECRETS", "MORROW_PAGE_DELAY_MS"]
    .map(key => [key, process.env[key]]));
  Object.assign(process.env, { MORROW_USER_DATA: dir, MORROW_MAIL_DIR: dir, MORROW_MAIL_SECRETS: "memory", MORROW_PAGE_DELAY_MS: "0" });
  const settings = require("../host/settings");
  const engine = require("../host/mail/engine");
  const db = require("../host/mail/db");
  const remote = require("../host/mail/remote");
  const secrets = require("../host/mail/secrets");
  const saved = { withClient: remote.withClient, searchUids: remote.searchUids, fetchMessages: remote.fetchMessages };
  try {
    assert.equal(settings.syncHorizonDays(), 180);
    assert.equal(settings.answer("morrow:configGetCompactMessageList", []), false);
    assert.throws(() => settings.answer("morrow:configSetCompactMessageList", ["true"]), /on or off/);
    for (const bad of [null, "0", "365", -1, 1, 360, Infinity, NaN, {}, true]) {
      assert.throws(() => settings.answer("morrow:configSetSyncHorizonDays", [bad]), /Sync history/);
    }
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ syncHorizonDays: -1 }));
    assert.equal(settings.syncHorizonDays(), 180, "invalid stored values use the default");
    await engine.init();
    db.insertAccount({ id: "horizon", email: "horizon@example.test", username: "horizon", profile: "custom",
      imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 465,
      smtpTls: true, createdAt: Date.now() });
    db.replaceFolders("horizon", [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Notes", name: "Notes", wellKnown: null },
      { path: "Empty", name: "Empty", wellKnown: null },
    ], "/");
    secrets.setPassword("horizon", "fixture");
    const count = 2105, now = Date.now(), day = 86400000;
    const age = uid => uid <= 500 ? 600 : uid <= 1100 ? 250 : 10;
    const header = uid => ({ uid, subject: `Message ${uid}`, from: "sender@example.test", to: [], cc: [], bcc: [],
      date: new Date(now - age(uid) * day + uid).toISOString(), listSortTs: now - age(uid) * day + uid,
      threadId: `horizon-${uid}`, snippet: "Downloaded text", textBody: "Downloaded text", unread: false });
    const searches = [], fetched = [];
    let changeDuringFetch = false, deletedOldest = false, validity = 1;
    remote.withClient = async (_account, _secret, work) => work({});
    remote.searchUids = async (_client, folder, query) => {
      searches.push({ folder, query });
      const all = folder === "Empty" ? [] : folder === "Notes" ? [1, 501, 1101]
        : Array.from({ length: count }, (_, i) => i + 1).filter(uid => !deletedOldest || uid !== 1);
      const uids = all.filter(uid => (!query.since || header(uid).listSortTs >= query.since.getTime())
        && (!query.uid || uid >= Number(query.uid.split(":")[0])));
      return { uids, validity, exists: all.length, unseen: 0 };
    };
    remote.fetchMessages = async (_client, folder, uids) => {
      fetched.push({ folder, uids });
      if (changeDuringFetch) {
        changeDuringFetch = false;
        settings.answer("morrow:configSetSyncHorizonDays", [0]);
      }
      return { validity, messages: uids.map(header) };
    };
    const list = (extra = {}) => engine.answer("mail:listFromCache", [{ accountId: "horizon", folderId: "INBOX", ...extra }]).data;
    const sync = async (folderId = "INBOX") => {
      const result = await engine.answer("mail:listFromNetwork", [{ accountId: "horizon", folderId }]);
      assert.equal(result.success, true);
      return result.data;
    };
    const ui = renderer({ hostCall: async (channel, params) => {
      const result = await engine.answer(channel, [params]);
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    } });
    ui.context.window.morrow.invoke = async (channel, value) => settings.answer(channel, [value]);
    ui.run(`
      const fields = new Map();
      $ = id => { if (!fields.has(id)) fields.set(id, { value: '', textContent: '', classList: {add(){},remove(){}} }); return fields.get(id); };
      renderList = paintListPaging = () => {};
      call = hostCall;
      state.accounts = [{id:'horizon',platform:'imap',folders:{primary:[{id:'INBOX',wellKnownName:'inbox'}]}}];
      state.accountId = 'horizon'; state.folderId = 'INBOX';
    `);
    async function choose(days) {
      await ui.run(`$('pref-sync-horizon').value='${days}'; savePref(prefRows().find(row=>row[0]==='pref-sync-horizon'))`);
      assert.equal(settings.syncHorizonDays(), days);
      assert.equal(ui.run("state.prefs.syncHorizon"), days);
    }

    await choose(180);
    await sync();
    assert.equal(list().total, 1005);
    assert.equal(db.folderByPath("horizon", "INBOX").sync_horizon_days, 180);
    assert.ok(searches.every(({ query }) => Math.abs(now - query.since.getTime() - 180 * day) < 10000));
    assert.ok(fetched.every(({ uids }) => uids.length <= 100), "header downloads stay bounded");
    await choose(365);
    assert.equal(list().initialSyncDone, false, "a completed shorter horizon must catch up");
    searches.length = 0;
    await sync();
    assert.equal(list().total, 1605);
    assert.equal(db.folderByPath("horizon", "INBOX").sync_horizon_days, 365);
    assert.ok(searches.every(({ query }) => !query.uid && Math.abs(now - query.since.getTime() - 365 * day) < 10000));
    await choose(0);
    assert.equal(list().initialSyncDone, false);
    searches.length = 0;
    await sync();
    assert.equal(list().total, count);
    assert.equal(list().initialSyncDone, true);
    assert.equal(db.folderByPath("horizon", "INBOX").sync_horizon_days, 0);
    assert.ok(searches.every(({ query }) => query.all === true && !query.since));
    assert.equal(list().emails.length, 2000, "default cache query reaches beyond 500");
    assert.equal(list({ limit: 999999 }).emails.length, 2000, "one query remains bounded");
    assert.equal(list({ limit: 2000, offset: 2000 }).emails.length, 105);
    const seen = new Set();
    await ui.run("loadList()");
    while (true) {
      const ids = Array.from(ui.run("state.emails.map(row=>row.id)"));
      assert.ok(ids.length <= 200);
      for (const id of ids) { assert.ok(!seen.has(id), "stable cache pages do not overlap"); seen.add(id); }
      if (ui.run("state.listOffset + state.emails.length >= state.listTotal")) break;
      await ui.run("changeListPage(1)");
    }
    assert.equal(seen.size, count, "every downloaded message is reachable");
    await ui.run("loadList()");
    assert.equal(ui.run("state.listOffset"), 2000, "background reload keeps the page");
    await ui.run("changeListPage(-1)");
    assert.equal(ui.run("state.listOffset"), 1800);
    // All has no SINCE constraint in the UID refresh or deletion reconciliation.
    searches.length = 0;
    deletedOldest = true;
    await sync();
    assert.ok(searches.some(({ query }) => query.uid));
    assert.ok(searches.every(({ query }) => !query.since));
    assert.equal(list().total, count - 1, "All reconciles deletion of old server mail");
    await choose(180);
    await sync();
    assert.equal(list().total, count - 1, "shortening history keeps old cached mail");

    // A changed preference cannot relabel the in-flight download as unlimited.
    await choose(365);
    changeDuringFetch = true;
    await sync("Notes");
    assert.equal(db.folderByPath("horizon", "Notes").sync_horizon_days, 365);
    assert.equal(settings.syncHorizonDays(), 0);
    assert.equal((await sync("Notes")).total, 3);
    assert.equal(db.folderByPath("horizon", "Notes").sync_horizon_days, 0);
    await sync("Empty");
    assert.equal(db.folderByPath("horizon", "Empty").sync_horizon_days, 0, "empty unlimited folder can complete");
    db.applyFolderSync("horizon", "Empty", { messages: [], validity: 1, windowDone: true, horizonDays: null });
    assert.equal(engine.answer("mail:listFromCache", [{accountId:"horizon",folderId:"Empty"}]).data.initialSyncDone,
      false, "legacy NULL horizon is unknown, not unlimited");
    // Changing folders resets the list offset; an empty folder has no phantom next page.
    await ui.run("state.folderId='Empty'; loadList()");
    assert.equal(ui.run("state.listOffset"), 0);
    assert.equal(ui.run("state.listTotal"), 0);
    settings.answer("morrow:configSetCompactMessageList", [true]);
    const reloaded = spawnSync(process.execPath, ["-e", `const settings=require('./host/settings'); process.stdout.write(JSON.stringify({days:settings.syncHorizonDays(),compact:settings.answer('morrow:configGetCompactMessageList',[])}))`],
      { cwd: path.join(__dirname, ".."), encoding: "utf8" });
    assert.equal(reloaded.status, 0, reloaded.stderr);
    assert.deepEqual(JSON.parse(reloaded.stdout), {days:0,compact:true}, "All and compact mode survive a new process");
    db.close();
    await engine.init();
    assert.equal(list().total, count - 1);
    assert.equal(db.folderByPath("horizon", "Notes").sync_horizon_days, 0, "completed horizon survives restart");
    // UID validity reset must invalidate the unlimited completion marker.
    validity = 2;
    await sync("Notes");
    assert.equal(db.folderByPath("horizon", "Notes").sync_horizon_days, null);
    assert.equal(db.folderByPath("horizon", "Notes").window_done, 0);
    engine.syncGates.delete("horizon");
    console.log("settings-horizon-ok (180/365/All, catch-up, restart, race, UID reset, 2105-row paging)");
  } finally {
    Object.assign(remote, saved);
    secrets.deletePassword("horizon");
    engine.syncGates.delete("horizon");
    db.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
