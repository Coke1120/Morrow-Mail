const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { account, message } = require("./mail-performance-fixture");
const { renderer } = require("./check-ux-workflows");
const { JSDOM } = require("jsdom");

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-runtime-10k-"));
  const environment = { ...process.env };
  Object.assign(process.env, { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_AI_CONFIG_DIR: directory,
    MORROW_MAIL_SECRETS: "memory" });
  const db = require("../host/mail/db"), engine = require("../host/mail/engine");
  const { Persistence } = require("../host/mail/persistence");
  const virtuals = require("../host/mail/virtual-folders");
  const remote = require("../host/mail/remote");
  const originals = { prepare: Database.prototype.prepare, append: Persistence.prototype.append, fetch: global.fetch,
    withClient: remote.withClient, search: db.searchMessages, now: Date.now };
  let captured = null, raw;
  Database.prototype.prepare = function(sql) {
    const statement = originals.prepare.call(this, sql), read = statement.all;
    statement.all = function(...args) {
      if (captured) captured.push({ sql, params: Array.isArray(args[0]) ? args[0] : args });
      return read.apply(this, args);
    };
    return statement;
  };
  global.fetch = remote.withClient = async () => { throw new Error("Live provider access forbidden"); };
  const ask = async (channel, params) => {
    const result = await engine.answer(channel, [params]);
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data;
  };
  const trace = async work => {
    captured = [];
    try { return { value: await work(), statements: captured }; } finally { captured = null; }
  };
  const aggregates = sample => sample.statements.filter(entry => /SELECT COUNT\(\*\) AS total.*FROM messages\s/s.test(entry.sql));
  const ids = rows => rows.map(row => row.id);
  const plan = entry => originals.prepare.call(raw, `EXPLAIN QUERY PLAN ${entry.sql}`).all(entry.params).map(row => row.detail).join("\n");
  try {
    await engine.init();
    for (const [owner, count] of [["a", 10640], ["b", 461]]) {
      db.insertAccount({ ...account, id: owner, email: `${owner}@fixture.invalid` });
      db.replaceFolders(owner, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }, { path: "Archive", name: "Archive", wellKnown: "archive" },
        { path: "Trash", name: "Trash", wellKnown: "deleteditems" }]);
      for (let first = 0; first < count; first += 80) {
        const messages = Array.from({ length: Math.min(80, count - first) }, (_unused, index) => {
          const uid = first + index;
          return message(uid + 1, { id: `${owner}-${String(uid).padStart(5, "0")}`, threadId: `${owner}-thread-${uid}`,
            subject: (uid % 7 ? "Common alpha" : "Common ζήτα rareterm") + (uid === count - 1 ? " uniqueonly" : "") + (uid < 8 ? " bodyedge" : ""), from: uid % 11 ? "Morrow, 测试 <sender@fixture.invalid>" : "Common <common@fixture.invalid>",
            fromDisplayName: "Morrow, 测试", fromAddress: "sender@fixture.invalid", listSortTs: 1700000000000 + Math.floor(uid / 3),
            textBody: uid >= count - 128 ? "common alpha apple body ".repeat(2800) : [null, "", " \t\u3000", "common alpha apple body"][uid % 4],
            htmlBody: uid % 4 === 0 ? "<p>common alpha apple HTML</p>" : null, bodyComplete: uid !== 2,
            unread: uid % 9 === 0, starred: uid % 23 === 0, isDraft: uid % 101 === 0,
            hasAttachments: uid % 101 === 0, attachments: uid % 101 === 0 ? [{ id: "inline", cid: "inline", filename: "图.png", size: 4 }] : [] });
        });
        db.applyFolderSync(owner, first < 160 ? "Archive" : "INBOX", { messages, validity: 7, keepOthers: true, uidCursor: first + messages.length, windowDone: true, horizonDays: 0 });
      }
    }
    raw = new Database(db.file() + ".live", { readonly: true });
    try {
      console.log("partial-index-bytes", JSON.stringify(originals.prepare.call(raw,
        "SELECT name, SUM(pgsize) AS bytes FROM dbstat WHERE name IN ('messages_unread_page', 'messages_starred_page') GROUP BY name").all()));
    } catch (error) {
      assert.match(error.message, /no such table: dbstat/);
      console.log("partial-index-bytes unavailable: SQLite dbstat is not enabled");
    }
    const referenceSearch = (tokens, owner) => {
      const params = [], joins = tokens.map((token, index) => {
        params.push(token, token.slice(0, -1) + String.fromCodePoint(token.codePointAt(token.length - 1) + 1));
        return `JOIN (SELECT message_id, MAX(CASE field WHEN 'subject' THEN 6 WHEN 'sender' THEN 4 ELSE 1 END) AS weight
          FROM message_fts WHERE term >= ? AND term < ? GROUP BY message_id) t${index} ON t${index}.message_id = m.id`;
      });
      if (owner) params.push(owner);
      return originals.prepare.call(raw, `SELECT m.id FROM messages m JOIN accounts connected ON connected.id = m.account_id ${joins.join(" ")}
        ${owner ? "WHERE m.account_id = ?" : ""} ORDER BY (${tokens.map((_token, index) => `t${index}.weight`).join(" + ")}) DESC,
        m.list_sort_ts DESC, m.id DESC LIMIT 100`).all(params);
    };
    for (const owner of [null, "a", "b"]) for (const tokens of [["common"], ["c"], ["common", "a"], ["rareterm"], ["ζήτα"], ["uniqueonly"], ["bodyedge"]]) {
      const input = { tokens, accountId: owner, limit: 100 };
      const full = db.searchMessages(input), headers = db.searchMessages(input, { headersOnly: true });
      assert.deepEqual(headers, full.map(({ html_body, text_body, ...row }) => row));
      assert.deepEqual(ids(headers), ids(referenceSearch(tokens, owner)), "AND/prefix/weight/date/id ranking remains exact");
    }
    const scopedSearch = await trace(() => db.searchMessages({ query: "common a", accountId: "b" }, { headersOnly: true }));
    const searchStatement = scopedSearch.statements.find(entry => entry.sql.includes("FROM message_fts f"));
    assert.equal(searchStatement.sql.match(/JOIN messages scoped ON scoped.id = f.message_id AND scoped.account_id = \?/g).length, 2);
    console.log("scoped-search-plan", plan(searchStatement));
    for (const [query, owner] of [["common", "b"], ["rareterm", "a"]]) {
      const sample = await trace(() => db.searchMessages({ query, accountId: owner }, { headersOnly: true }));
      const current = sample.statements.find(entry => entry.sql.includes("FROM message_fts f"));
      const baseline = { sql: current.sql.replace(/(?:CROSS )?JOIN messages scoped ON scoped.id = f.message_id AND scoped.account_id = \?/g, ""), params: current.params.slice(1) };
      if (query === "rareterm") {
        assert.match(current.sql, /CROSS JOIN messages scoped/);
        assert.match(plan(current), /SEARCH f USING COVERING INDEX .*\(term>\? AND term<\?\)/);
      }
      const timings = {};
      for (const [label, entry] of [["scoped", current], ["global", baseline]]) {
        const statement = originals.prepare.call(raw, entry.sql);
        statement.all(entry.params);
        const started = performance.now();
        for (let repeat = 0; repeat < 3; repeat++) statement.all(entry.params);
        timings[label] = Math.round((performance.now() - started) * 1000 / 3) / 1000;
      }
      console.log("search-query-warm-ms", JSON.stringify({ query, owner, ...timings }));
    }
    let boundaryRows = 0;
    db.searchMessages = (input, options) => {
      assert.equal(options.headersOnly, true);
      const rows = originals.search(input, options);
      boundaryRows += rows.length;
      assert.ok(rows.every(row => !Object.hasOwn(row, "text_body") && !Object.hasOwn(row, "html_body")));
      return rows;
    };
    const projected = await ask("mail:searchLocal", { query: "common", accountId: "a" });
    assert.equal(boundaryRows, 100);
    const edges = await ask("mail:searchLocal", { query: "bodyedge", accountId: "a" });
    assert.equal(edges.length, 8);
    assert.ok(edges.some(row => row.hasBody) && edges.some(row => !row.hasBody));
    db.searchMessages = input => originals.search(input);
    assert.deepEqual(projected, await ask("mail:searchLocal", { query: "common", accountId: "a" }));
    assert.deepEqual(edges, await ask("mail:searchLocal", { query: "bodyedge", accountId: "a" }), "search preserves whitespace/HTML/partial/draft/inline/sender metadata");
    db.searchMessages = originals.search;
    const opened = await ask("mail:openEmail", { emailId: "a-10639" });
    assert.ok(opened.email.textBody.length > 64000, "opening still reads full cached content");

    const cold = await trace(() => ask("mail:listAccounts"));
    assert.equal(aggregates(cold).length, 6);
    assert.ok(aggregates(cold).every(entry => !entry.sql.includes("MIN(")), "badges use count-only reads");
    assert.equal(aggregates(await trace(() => ask("mail:listAccounts"))).length, 0);
    db.updateMessage("a-00001", { starred: 1 });
    const star = await trace(() => ask("mail:listAccounts"));
    assert.equal(aggregates(star).length, 1);
    assert.ok(aggregates(star).every(entry => !entry.params.includes("b")));
    console.log("summary-scans", JSON.stringify({ cold: aggregates(cold).length, afterArchiveStar: aggregates(star).length,
      untouchedAccount: aggregates(star).filter(entry => entry.params.includes("b")).length }));
    db.updateMessage("a-00001", { unread: 1 });
    assert.equal(aggregates(await trace(() => ask("mail:listAccounts"))).length, 1);
    db.saveAccountLabel("a", "Synthetic label");
    db.updateMessage("a-00001", { body_complete: 0, body_retry_after: 1000, snippet: "Updated metadata" });
    db.applyFolderSync("a", "INBOX", { messages: [], keepOthers: true, uidCursor: 11000 });
    assert.equal(aggregates(await trace(() => ask("mail:listAccounts"))).length, 0);
    const physical = { accountId: "a", folderId: "INBOX" };
    db.messageSummary(physical);
    db.updateMessage("a-00002", { unread: 1, starred: 1 });
    assert.equal(aggregates(await trace(() => db.messageSummary(physical))).length, 0, "another folder does not invalidate physical totals");
    const canonical = await trace(() => {
      db.countMessages({ ...physical, filterFlagged: false, offset: 200 });
      db.countMessages({ ...physical, filterUnread: false, offset: 400 });
    });
    assert.equal(aggregates(canonical).length, 1);
    const before = db.countMessages(physical);
    const moved = db.messageById("a-00003");
    db.updateMessage(moved.id, { folder_path: "INBOX" });
    assert.equal(db.countMessages(physical), before + 1);
    db.deleteMessage(moved.id);
    assert.equal(db.countMessages(physical), before);
    const attention = virtuals.apply({ accountId: "a", folderId: virtuals.UNREAD_ID });
    const unread = db.countMessages(attention);
    let clock = originals.now();
    Date.now = () => clock;
    db.setSnooze("a", "a-thread-9", new Date(clock + 1000).toISOString());
    assert.equal(db.countMessages(attention), unread - 1);
    const other = await trace(() => db.countMessages(virtuals.apply({ accountId: "b", folderId: virtuals.UNREAD_ID })));
    assert.equal(aggregates(other).length, 0);
    clock += 1001;
    assert.equal(db.countMessages(attention), unread);
    Date.now = originals.now;
    db.clearSnooze("a", "a-thread-9");
    db.countMessages(attention);
    Persistence.prototype.append = () => { throw new Error("Synthetic journal failure"); };
    assert.throws(() => db.transaction(() => {
      db.updateMessage("a-00009", { unread: 0 });
      assert.equal(db.countMessages(attention), unread - 1);
    }), /Synthetic journal failure/);
    Persistence.prototype.append = originals.append;
    assert.equal(db.countMessages(attention), unread, "uncommitted summaries cannot escape rollback");
    db.updateMessage("a-00018", { unread: 0 });
    assert.equal(db.countMessages(attention), unread - 1, "rolled-back revision numbers cannot reuse speculative cache entries");

    for (const [folderId, index] of [[virtuals.UNREAD_ID, "messages_unread_page"], [virtuals.STARRED_ID, "messages_starred_page"]]) {
      const query = { ...virtuals.apply({ accountId: "a", folderId }), limit: 200 };
      const sample = await trace(() => db.selectMessages(query, { headersOnly: true }));
      const entry = sample.statements.find(row => row.sql.includes("FROM messages m"));
      assert.match(plan(entry), new RegExp(index));
      assert.doesNotMatch(plan(entry), /TEMP B-TREE FOR ORDER BY/);
      console.log("virtual-page-plan", index, plan(entry));
      if (folderId === virtuals.UNREAD_ID) {
        const held = db.messageById("a-10639");
        const retained = await trace(() => db.selectMessages({ ...query, retainIds: [held.id] }, { headersOnly: true }));
        assert.ok(retained.value.some(row => row.id === held.id));
        assert.equal(new Set(ids(retained.value)).size, retained.value.length);
        assert.match(plan(retained.statements.find(row => row.sql.includes("UNION ALL"))), /messages_unread_page/);
      }
    }
    for (const scope of [attention, { ...physical, filterUnread: true }, { folderKey: "primary", filterUnread: true }]) {
      db.insertMessage({ ...message(40001), id: "summary-plan-probe", accountId: "a", folderPath: "INBOX", uidValidity: 7 });
      const query = scope;
      const base = await trace(() => db.messageSummary(query));
      assert.equal(aggregates(base).length, 1);
      assert.match(plan(aggregates(base)[0]), /messages_unread_page/, "the aggregate, not just the page, must visit the unread index");
      console.log("unread-aggregate-plan", plan(aggregates(base)[0]));
      const heldRows = db.selectMessages({ ...scope, filterUnread: false, limit: 2000 }, { headersOnly: true }).filter(row => !row.unread).slice(0, 20);
      const summaries = await trace(() => heldRows.map(row => {
        const held = db.messageSummary({ ...query, retainIds: [row.id] });
        assert.equal(held.total, base.value.total + 1);
        assert.equal(held.oldest, Math.min(base.value.oldest, row.list_sort_ts));
        return held;
      }));
      assert.equal(aggregates(summaries).length, 0, "different held selections share the ordinary unread aggregate");
      const heldUnread = db.selectMessages({ ...query, limit: 1 }, { headersOnly: true })[0];
      assert.equal(db.messageSummary({ ...query, retainIds: [heldUnread.id] }).total, base.value.total, "held unread contribution is disjoint");
      assert.equal(db.messageSummary({ ...query, retainIds: ["absent-held-id"] }).total, base.value.total);
      db.deleteMessage("summary-plan-probe");
    }
    const heldQuery = { ...physical, filterUnread: true };
    const holdId = "synthetic-held-read";
    db.insertMessage({ ...message(40000), id: holdId, accountId: "a", folderPath: "INBOX", uidValidity: 7, listSortTs: 1, unread: false });
    const unheld = db.messageSummary(heldQuery);
    assert.equal(db.messageSummary({ ...heldQuery, retainIds: [holdId] }).oldest, 1);
    db.updateMessage(holdId, { folder_path: "Archive" });
    assert.equal(db.messageSummary({ ...heldQuery, retainIds: [holdId] }).total, unheld.total, "moved held rows are checked against physical scope");
    assert.equal(db.messageSummary({ ...heldQuery, excludeFolderPaths: ["Archive"], folderId: null, retainIds: [holdId] }).total,
      db.messageSummary({ ...heldQuery, excludeFolderPaths: ["Archive"], folderId: null }).total);
    db.updateMessage(holdId, { folder_path: "INBOX" });
    const holdClock = originals.now();
    db.setSnooze("a", "thread-40000", new Date(holdClock + 1000).toISOString());
    assert.equal(db.messageSummary({ ...heldQuery, retainIds: [holdId] }, { now: holdClock }).total, unheld.total);
    assert.equal(db.messageSummary({ ...heldQuery, retainIds: [holdId] }, { now: holdClock + 1001 }).total, unheld.total + 1);
    db.clearSnooze("a", "thread-40000");
    Persistence.prototype.append = () => { throw new Error("Synthetic held rollback"); };
    assert.throws(() => db.transaction(() => {
      db.updateMessage(holdId, { unread: 1 });
      assert.equal(db.messageSummary({ ...heldQuery, retainIds: [holdId] }).total, unheld.total + 1);
    }), /Synthetic held rollback/);
    Persistence.prototype.append = originals.append;
    db.deleteMessage(holdId);
    assert.equal(db.messageSummary({ ...heldQuery, retainIds: [holdId] }).total, unheld.total);
    const imap = await trace(() => db.applyFolderSync("a", "INBOX", { messages: [], validity: 7, exists: 12000, unseen: 81 }));
    assert.equal(imap.statements.filter(entry => /SELECT COUNT/.test(entry.sql)).length, 0);
    assert.equal(db.folderByPath("a", "INBOX").unread, 81);
    db.applyFolderSync("a", "INBOX", { messages: [], validity: 7 });
    assert.equal(db.folderByPath("a", "INBOX").unread, db.countMessages({ ...physical, filterUnread: true }));
    const gmail = await trace(() => {
      for (let cursor = 0; cursor < 20; cursor++) db.gmailSyncState("a", "INBOX", { cursor, complete: false });
    });
    assert.ok(aggregates(gmail).length <= 2, "Gmail progress commits share exact local counts");
    assert.equal(db.gmailSyncState("a", "INBOX").cursor, 19);
    const nested = await trace(() => {
      for (let cursor = 0; cursor < 20; cursor++) db.transaction(() => db.gmailSyncState("a", "INBOX", { cursor, complete: false }));
    });
    assert.equal(aggregates(nested).length, 0, "nested content/cursor transactions reuse matching committed dependency stamps");
    console.log("sync-counts", JSON.stringify({ imapSupplied: imap.statements.filter(entry => /SELECT COUNT/.test(entry.sql)).length,
      gmailTwentySaves: aggregates(gmail).length, nestedTwentySaves: aggregates(nested).length }));
    db.updateMessage("a-00180", { unread: 0 });
    db.gmailSyncState("a", "INBOX", { cursor: 20, complete: true });
    assert.equal(db.folderByPath("a", "INBOX").unread, db.countMessages({ ...physical, filterUnread: true }));

    const merged = { folderKey: "primary", limit: 200 };
    const expected = originals.prepare.call(raw, "SELECT id FROM messages WHERE folder_path = 'INBOX' ORDER BY list_sort_ts DESC, id DESC").all();
    const visited = [];
    let cursor = null, last;
    for (let offset = 0; offset < expected.length; offset += 200) {
      const sample = await trace(() => ask("mail:listFromCache", { ...merged, offset, ...(cursor ? { pageCursor: cursor } : {}) }));
      last = sample.value;
      assert.equal(last.cursorReset, false);
      assert.equal(last.total, expected.length);
      assert.equal(last.geometry.aboveTop, offset);
      visited.push(...ids(last.emails));
      if (offset > 0) {
        const entry = sample.statements.find(row => row.sql.includes("UNION ALL"));
        assert.ok(entry.params.filter(value => value === 200).length >= 3);
        assert.equal(entry.params.at(-1), 0, "tuple pages never widen the merge with OFFSET");
        assert.match(plan(entry), /messages_folder_page.*\(list_sort_ts,id\)</);
        if (offset === 10000) console.log("tuple-page-plan-at-10000", plan(entry));
      }
      cursor = last.nextCursor;
    }
    assert.deepEqual(visited, ids(expected));
    assert.equal(cursor, null);
    const duplicateScope = { ...merged, accountId: "b", mailboxes: [{ accountId: "a", path: "INBOX" }, { accountId: "b", path: "INBOX" }, { accountId: "b", path: "INBOX" }] };
    const unique = db.selectMessages(duplicateScope, { headersOnly: true });
    assert.ok(unique.every(row => row.account_id === "b"));
    assert.equal(new Set(ids(unique)).size, unique.length);
    const first = await ask("mail:listFromCache", { ...physical, limit: 200 });
    db.updateMessage("a-10639", { starred: 1, body_retry_after: 1001 });
    const unchangedOrder = await trace(() => ask("mail:listFromCache", { ...physical, limit: 200, offset: 200, pageCursor: first.nextCursor }));
    assert.equal(unchangedOrder.value.cursorReset, false, "non-ordering changes keep the host-validated boundary");
    assert.equal(unchangedOrder.statements.find(entry => entry.sql.includes("ORDER BY m.list_sort_ts DESC")).params.at(-1), 0);
    const wrongScope = await ask("mail:listFromCache", { accountId: "b", folderId: "INBOX", offset: 200, pageCursor: first.nextCursor });
    assert.equal(wrongScope.cursorReset, true);
    db.insertMessage({ ...message(60000), id: "cursor-fresh-arrival", accountId: "a", folderPath: "INBOX", uidValidity: 7, listSortTs: 1800000000000 });
    const arrived = await ask("mail:listFromCache", { ...physical, limit: 200, offset: 200, pageCursor: first.nextCursor });
    assert.equal(arrived.cursorReset, true, "fresh membership invalidates a retained page boundary");
    assert.equal(arrived.geometry.aboveTop, 200);
    assert.deepEqual(ids(arrived.emails), ids(db.selectMessages({ ...physical, limit: 200, offset: 200 }, { headersOnly: true })));
    db.deleteMessage("cursor-fresh-arrival");
    db.updateMessage("a-10638", { list_sort_ts: 1700000100000 });
    const changed = await ask("mail:listFromCache", { ...physical, limit: 200, offset: 200, pageCursor: first.nextCursor });
    assert.equal(changed.cursorReset, true);
    assert.deepEqual(ids(changed.emails), ids(db.selectMessages({ ...physical, offset: 200, limit: 200 }, { headersOnly: true })));

    const document = new JSDOM('<div id="list-paging"></div><button id="list-prev"></button><button id="list-next"></button><button id="list-sync-more"></button><span id="list-page-status"></span><div id="message-list"></div><div id="features-catalog"></div><p id="features-empty"></p>').window.document;
    const ui = renderer({ document });
    ui.context.testCall = ask;
    ui.context.morrowPrimaryMailboxes = require("../shared/primary-mailboxes");
    ui.context.testAccounts = await ask("mail:listAccounts");
    ui.run(`state.accounts = testAccounts; state.allInbox = true; call = testCall;
      renderList = () => {}; noteMailListLoaded = () => {}; noteUnreadScope = () => {};`);
    const testAggregateUnread = accounts => accounts.reduce((sum, account) => sum + account.folders.primary.find(row => row.id === "__morrow_unread__").totalCount, 0);
    const chrome = document.createElement("div");
    chrome.innerHTML = '<button class="all-inbox"></button><button class="all-unread"><span class="count"></span></button>';
    ui.context.testChrome = chrome;
    ui.run("applyAllAccountMailChrome(testChrome)");
    assert.equal(Number(chrome.querySelector(".all-unread .count").textContent), testAggregateUnread(ui.context.testAccounts));
    await ui.run("loadList(false, 0)");
    await ui.run("changeListPage(1)");
    assert.equal(ui.run("state.listOffset"), 200);
    await ui.run("changeListPage(-1)");
    assert.equal(ui.run("state.listOffset"), 0);
    assert.match(document.getElementById("list-page-status").textContent, /1–200 \/ .* downloaded/);
    for (let page = 0; page < 34; page++) await ui.run("changeListPage(1)");
    assert.equal(ui.run("state.listCursors.length"), 32);
    const status = document.getElementById("list-page-status").textContent;
    assert.match(status, /6,801–7,000/);
    const refresh = await trace(() => ui.run("loadList(false)"));
    assert.equal(ui.run("state.listOffset"), 6800);
    assert.equal(refresh.value.cursorReset, false);
    assert.equal(refresh.statements.find(entry => entry.sql.includes("UNION ALL")).params.at(-1), 0, "ordinary deep-page refresh preserves its validated seek");
    db.updateMessage("a-10637", { list_sort_ts: 1700000200000 });
    const refreshChanged = await ui.run("loadList(false)");
    assert.equal(refreshChanged.cursorReset, true, "the host, not the renderer, decides whether a retained boundary is stale");
    ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
    ui.run("paintFeatureCatalog()");
    assert.match(document.getElementById("features-catalog").textContent, /search results.*without copying message bodies/);
    assert.match(document.getElementById("features-catalog").textContent, /held read row.*scope, exclusions and snoozes/);
    assert.match(document.getElementById("features-catalog").textContent, /identity-only rows/);
    assert.match(document.getElementById("features-catalog").textContent, /one-hour age.*dispatch gates/);
    const help = new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8")).window.document;
    assert.match(help.getElementById("runtime-paging-help").textContent, /cursor.*Previous.*offset/i);
    assert.match(help.getElementById("runtime-paging-help").textContent, /host validation.*Gmail commits exact local count deltas/);
    assert.match(help.getElementById("cli-runtime-queries").textContent, /node scripts\/check-runtime-10k\.js.*bot offset pagination is unchanged/);

    const oldPrimary = db.countMessages({ folderKey: "primary" });
    const boxes = [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }, { path: "Archive", name: "Archive", wellKnown: "archive" }, { path: "Trash", name: "Trash", wellKnown: "deleteditems" }];
    db.replaceFolders("b", boxes.map(box => ({ ...box, wellKnown: box.path === "INBOX" ? "archive" : box.path === "Archive" ? "inbox" : box.wellKnown })));
    assert.equal(db.countMessages({ folderKey: "primary" }), oldPrimary - 301 + 160, "primary remaps change the resolved summary key");
    db.replaceFolders("b", boxes.map(box => ({ ...box, wellKnown: box.path === "Archive" ? "deleteditems" : box.wellKnown })));
    const excludedUnread = originals.prepare.call(raw, "SELECT COUNT(*) AS total FROM messages WHERE account_id = 'b' AND unread = 1 AND folder_path = 'INBOX'").get().total;
    assert.equal(db.countMessages(virtuals.apply({ accountId: "b", folderId: virtuals.UNREAD_ID })), excludedUnread);
    db.replaceFolders("b", boxes);
    ui.run("state.allInbox = false; state.accountId = 'b'; state.folderId = 'INBOX'");
    await ui.run("loadList(false, 200)");
    const removed = originals.prepare.call(raw, "SELECT id FROM messages WHERE account_id = 'b' AND folder_path = 'INBOX' ORDER BY id LIMIT 201").all();
    db.transaction(() => { for (const row of removed) db.deleteMessage(row.id); });
    await ui.run("loadList(false)");
    assert.equal(ui.run("state.listOffset"), 0, "last-page shrink reanchors with offset fallback");
    assert.equal(ui.run("state.listTotal"), 100);
    db.insertAccount({ ...account, id: "empty" }); db.replaceFolders("empty", boxes);
    for (const folderId of [virtuals.UNREAD_ID, virtuals.STARRED_ID]) {
      const empty = virtuals.apply({ accountId: "empty", folderId });
      assert.equal(db.countMessages(empty), 0); assert.deepEqual(db.selectMessages(empty), []);
    }
    db.insertMessage({ ...message(1), id: "single", accountId: "empty", folderPath: "INBOX", unread: true, starred: true });
    for (const folderId of [virtuals.UNREAD_ID, virtuals.STARRED_ID]) assert.equal(db.countMessages(virtuals.apply({ accountId: "empty", folderId })), 1);
    db.updateMessage("single", { unread: 0 });
    const emptyUnread = { accountId: "empty", folderId: "INBOX", filterUnread: true };
    assert.equal(db.messageSummary(emptyUnread).oldest, null);
    assert.equal(db.messageSummary({ ...emptyUnread, retainIds: ["single"] }).oldest, 1);
    assert.equal(db.countMessages({ ...emptyUnread, retainIds: ["single"] }), 1);
    assert.equal(db.countMessages({ ...emptyUnread, retainIds: ["a-10639"] }), 0, "another account's held row cannot contribute");
    db.removeAccount("empty");
    assert.equal(db.countMessages({ accountId: "empty" }), 0);

    db.enableGmail("a");
    for (const path of ["INBOX", "Archive", "Trash"]) db.gmailSyncState("a", path, { cursor: 20, complete: true });
    const exactFolder = path => {
      const expected = originals.prepare.call(raw, `SELECT COUNT(*) AS total, COALESCE(SUM(unread = 1), 0) AS unread
        FROM messages WHERE account_id = ? AND folder_path = ?`).get("a", path);
      const stored = originals.prepare.call(raw, "SELECT total, unread FROM mail_folder_counts WHERE account_id = ? AND folder_path = ?").get("a", path);
      assert.deepEqual(stored, expected);
      const folder = db.folderByPath("a", path);
      assert.equal(folder.total, expected.total); assert.equal(folder.unread, expected.unread);
    };
    const gmailMessage = cursor => ({ ...message(50000 + cursor), providerId: `perf-delta-${cursor}`, unread: true });
    let acknowledgements = 0;
    Persistence.prototype.append = function(commands) { acknowledgements++; return originals.append.call(this, commands); };
    const contentCommits = await trace(() => {
      for (let cursor = 0; cursor < 20; cursor++) db.transaction(() => {
        db.applyGmailMessage("a", ["INBOX", "Archive"], gmailMessage(cursor));
        for (const path of ["INBOX", "Archive"]) db.gmailSyncState("a", path, { cursor: cursor + 21, complete: true });
      });
    });
    Persistence.prototype.append = originals.append;
    assert.equal(acknowledgements, 20, "each content/resume pair retains its own durable acknowledgement");
    assert.equal(contentCommits.statements.filter(entry => /SELECT COUNT.*FROM messages/s.test(entry.sql)).length, 0);
    for (const path of ["INBOX", "Archive"]) exactFolder(path);
    const unreadCommits = await trace(() => {
      for (let cursor = 0; cursor < 20; cursor++) db.transaction(() => {
        db.applyGmailMessage("a", ["INBOX", "Archive"], { ...gmailMessage(cursor), unread: false });
        for (const path of ["INBOX", "Archive"]) db.gmailSyncState("a", path, { cursor: cursor + 41, complete: true });
      });
    });
    assert.equal(unreadCommits.statements.filter(entry => /SELECT COUNT.*FROM messages/s.test(entry.sql)).length, 0);
    for (const path of ["INBOX", "Archive"]) exactFolder(path);
    const pendingCopy = db.gmailCopies("a", "perf-delta-0").find(row => row.folder_path === "INBOX");
    db.updateMessage(pendingCopy.id, { draft_pending: 1 });
    db.transaction(() => {
      db.applyGmailMessage("a", ["INBOX"], gmailMessage(0));
      db.pruneGmailCopies("a", "perf-delta-0", []);
      for (const path of ["INBOX", "Archive"]) db.gmailSyncState("a", path, { cursor: 60, complete: true });
    });
    assert.equal(db.messageById(pendingCopy.id).unread, 0, "pending local work remains protected");
    for (const path of ["INBOX", "Archive"]) exactFolder(path);
    db.updateMessage(pendingCopy.id, { draft_pending: 0, folder_path: "Trash", unread: 1 });
    for (const path of ["INBOX", "Archive", "Trash"]) db.gmailSyncState("a", path, { cursor: 60, complete: true });
    for (const path of ["INBOX", "Archive", "Trash"]) exactFolder(path);
    db.gmailSyncState("b", "Trash", { complete: true });
    db.transaction(() => {
      db.updateMessage(pendingCopy.id, { account_id: "b" });
      db.gmailSyncState("a", "Trash", { cursor: 60, complete: true });
      db.gmailSyncState("b", "Trash", { complete: true });
    });
    exactFolder("Trash");
    assert.equal(db.folderByPath("b", "Trash").total, 1);
    assert.equal(db.folderByPath("b", "Trash").unread, 1);
    db.transaction(() => {
      db.updateMessage(pendingCopy.id, { account_id: "a" });
      db.gmailSyncState("a", "Trash", { cursor: 60, complete: true });
      db.gmailSyncState("b", "Trash", { complete: true });
    });
    exactFolder("Trash");
    assert.equal(db.folderByPath("b", "Trash").total, 0);
    Persistence.prototype.append = () => { throw new Error("Synthetic content/resume journal failure"); };
    assert.throws(() => db.transaction(() => {
      db.applyGmailMessage("a", ["INBOX", "Archive"], gmailMessage(21));
      db.gmailSyncState("a", "INBOX", { cursor: 61, complete: true });
    }), /Synthetic content\/resume journal failure/);
    Persistence.prototype.append = originals.append;
    assert.equal(db.gmailMap("a", "perf-delta-21"), null);
    assert.equal(db.gmailSyncState("a", "INBOX").cursor, 60, "failed content cannot advance the resume cursor");
    exactFolder("INBOX");
    const deletions = await trace(() => {
      for (let cursor = 0; cursor < 20; cursor++) db.transaction(() => {
        db.pruneGmailCopies("a", `perf-delta-${cursor}`, []);
        for (const path of ["INBOX", "Archive", "Trash"]) db.gmailSyncState("a", path, { cursor: 20, complete: true });
      });
    });
    assert.equal(deletions.statements.filter(entry => /SELECT COUNT.*FROM messages/s.test(entry.sql)).length, 0);
    for (const path of ["INBOX", "Archive", "Trash"]) exactFolder(path);
    console.log("gmail-content-counts", JSON.stringify({ messages: 20, acknowledgements, insertScans: 0, unreadScans: 0, deletionScans: 0 }));

    for (let index = 10610; index < 10630; index++) db.updateMessage(`a-${index}`, { thread_id: "performance-wide-thread" });
    const membership = await trace(() => db.threadMembership("a", "performance-wide-thread"));
    assert.equal(membership.value.length, 20);
    assert.ok(membership.value.every(row => Object.keys(row).sort().join(",") === "account_id,folder_path,gmail_id,id,thread_id,uid,uid_validity"));
    assert.doesNotMatch(membership.statements[0].sql, /\*|html_body|text_body|attachments_json/);
    assert.deepEqual(ids(membership.value), ids(db.messagesByThread("a", "performance-wide-thread", { headersOnly: true })));
    const noThread = await trace(() => ask("mail:openEmail", { emailId: "a-10629", includeThread: false }));
    assert.deepEqual(noThread.value.threadMessages, []); assert.equal(noThread.value.isThread, false);
    assert.ok(!noThread.statements.some(entry => /FROM messages WHERE account_id = \? AND thread_id = \?/.test(entry.sql)));
    const withThread = await ask("mail:openEmail", { emailId: "a-10629" });
    assert.equal(withThread.threadMessages.length, 20, "legacy callers retain the complete conversation contract");
    assert.deepEqual(noThread.value.email, withThread.email);
    const freshOpen = ask("mail:openEmail", { emailId: "a-10629", includeThread: false });
    db.updateMessage("a-10629", { subject: "Fresh after await" });
    assert.equal((await freshOpen).email.subject, "Fresh after await", "omitting thread metadata preserves the post-await message read");

    raw.close(); raw = null;
    db.transaction(() => {
      db.applyGmailMessage("a", ["INBOX", "Archive"], gmailMessage(30));
      db.gmailSyncState("a", "INBOX", { cursor: 21, complete: true });
      db.gmailSyncState("a", "Archive", { cursor: 21, complete: true });
    });
    await db.close(); await engine.init();
    raw = new Database(db.file() + ".live", { readonly: true });
    assert.equal(db.gmailSyncState("a", "INBOX").cursor, 21);
    for (const path of ["INBOX", "Archive"]) exactFolder(path);
    db.transaction(() => {
      db.pruneGmailCopies("a", "perf-delta-30", []);
      for (const path of ["INBOX", "Archive"]) db.gmailSyncState("a", path, { cursor: 20, complete: true });
    });
    raw.close(); raw = null;
    await db.checkpoint();
    const source = db.file();
    await db.close();
    const legacyFile = path.join(directory, "legacy.sqlite");
    fs.copyFileSync(source, legacyFile);
    const legacy = new Database(legacyFile);
    try {
      legacy.exec("DROP INDEX messages_unread_page; DROP INDEX messages_starred_page");
      legacy.prepare("UPDATE messages SET account_id = 'disconnected' WHERE id = ?").run("b-00460");
    } finally { legacy.close(); }
    await db.open(legacyFile);
    raw = new Database(legacyFile + ".live", { readonly: true });
    assert.equal(originals.prepare.call(raw, "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'index' AND name IN ('messages_unread_page', 'messages_starred_page')").get().total, 2);
    assert.ok(db.messageById("b-00460"));
    assert.ok(!db.searchMessages({ query: "common", accountId: "disconnected" }, { headersOnly: true }).length);
    assert.equal(db.countMessages({ accountId: "a", folderPath: "INBOX" }), before);
    raw.close(); raw = null;
    await db.close(); await engine.init();
    assert.equal(db.gmailSyncState("a", "INBOX").cursor, 20);
    const reopened = new Database(db.file() + ".live", { readonly: true });
    try {
      assert.deepEqual(reopened.pragma("integrity_check"), [{ integrity_check: "ok" }]);
      for (const folderPath of ["INBOX", "Archive", "Trash"]) {
        const actual = reopened.prepare("SELECT total, unread FROM mail_folder_counts WHERE account_id = ? AND folder_path = ?").get("a", folderPath);
        const expectedCounts = reopened.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(unread = 1), 0) AS unread FROM messages WHERE account_id = ? AND folder_path = ?").get("a", folderPath);
        assert.deepEqual(actual, expectedCounts, "folder count deltas survive authoritative journal recovery");
      }
      const indexes = reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name);
      assert.ok(indexes.includes("messages_unread_page") && indexes.includes("messages_starred_page"));
    } finally { reopened.close(); }
    console.log("runtime-10k-ok: 11101 rows, projection/ranking parity, scoped count-only badges/rollback/snooze, indexed virtuals, durable count reuse, tuple IPC/renderer paging and help");
  } finally {
    Database.prototype.prepare = originals.prepare;
    Persistence.prototype.append = originals.append;
    global.fetch = originals.fetch; remote.withClient = originals.withClient; db.searchMessages = originals.search; Date.now = originals.now;
    if (raw?.open) raw.close();
    await db.close();
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(environment, key)) delete process.env[key];
    Object.assign(process.env, environment);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run };
