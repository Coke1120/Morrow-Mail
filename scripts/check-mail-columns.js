"use strict";
// Synthetic stores and mocked renderer IPC only; never open a real mailbox.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const fixture = require("./mail-performance-fixture");

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-columns-"));
  const environment = { ...process.env };
  Object.assign(process.env, { MORROW_MAIL_DIR: directory, MORROW_USER_DATA: directory, MORROW_MAIL_SECRETS: "memory" });
  const db = require("../host/mail/db"), engine = require("../host/mail/engine");
  const ask = async (channel, params) => {
    const result = await engine.answer(channel, [params]);
    assert.equal(result.success, true, JSON.stringify(result));
    return result.data;
  };
  try {
    await engine.init();
    for (const id of ["alpha", "beta"]) {
      db.insertAccount({ ...fixture.account, id, email: id + "@fixture.invalid" });
      db.replaceFolders(id, [...fixture.folders, { path: "Drafts", name: "Drafts", wellKnown: "drafts" }]);
      for (const folder of ["INBOX", "Sent", "Drafts"]) {
        const rows = Array.from({ length: 241 }, (_, n) => fixture.message(n + 1, {
          id: `${id}-${folder}-${String(n).padStart(3, "0")}`,
          subject: n % 17 === 0 ? "" : `Topic ${String((n * 13) % 37).padStart(2, "0")}`,
          from: n % 19 === 0 ? "" : `${id}@fixture.invalid`,
          fromDisplayName: n % 19 === 0 ? "" : `Name ${String((n * 11) % 29).padStart(2, "0")}`,
          to: n % 23 === 0 ? [] : [`recipient${String((n * 7) % 31).padStart(2, "0")}@fixture.invalid`, "second@fixture.invalid"],
          date: new Date(1700000000000 + (n % 41) * 1000).toISOString(),
          listSortTs: 1700000000000 + (n % 41) * 1000,
          textBody: "needle", unread: n % 2 === 0, isDraft: folder === "Drafts",
        }));
        db.applyFolderSync(id, folder, fixture.report(rows));
      }
    }
    const value = (row, field) => field === "date" ? row.listSortTs : field === "sender"
      ? row.from.replace(/ <.*$/, "").toLowerCase() : field === "recipient" ? (row.to[0] || "").toLowerCase() : row.subject.toLowerCase();
    const compare = (field, dir) => (a, b) => {
      const x = value(a, field), y = value(b, field);
      return (x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * (dir === "asc" ? 1 : -1);
    };
    const scopes = [
      ...["INBOX", "Sent", "Drafts"].map(folderId => ({ accountId: "alpha", folderId })),
      { folderKey: "primary", mailboxes: ["alpha", "beta"].map(accountId => ({ accountId, path: "INBOX" })) },
      { accountId: "alpha", folderId: "INBOX", filterUnread: true },
    ];
    let checks = 0;
    for (const scope of scopes) {
      const baseline = (await ask("mail:listFromCache", { ...scope, limit: 2000 })).emails;
      for (const sortBy of ["date", "recipient", "sender", "subject"]) {
        for (const sortDirection of ["asc", "desc"]) {
          const result = [];
          let pageCursor;
          for (let offset = 0; offset < baseline.length; offset += 100) {
            const page = await ask("mail:listFromCache", { ...scope, sortBy, sortDirection, offset, limit: 100, pageCursor });
            result.push(...page.emails); pageCursor = page.nextCursor;
            if (sortBy !== "date" || sortDirection !== "desc") assert.equal(pageCursor, null);
          }
          assert.deepEqual(result.map(row => row.id), baseline.slice().sort(compare(sortBy, sortDirection)).map(row => row.id));
          assert.equal(new Set(result.map(row => row.id)).size, baseline.length);
          checks++;
        }
      }
    }
    const base = (await ask("mail:listFromCache", { accountId: "alpha", folderId: "INBOX", limit: 2000 })).emails;
    // Search scope includes all three folders; verify order before the 100-hit cap.
    const all = (await ask("mail:listFromCache", { accountId: "alpha", limit: 2000 })).emails;
    for (const sortBy of ["date", "recipient", "sender", "subject"]) for (const sortDirection of ["asc", "desc"]) {
      const hits = await ask("mail:searchLocal", { query: "needle", accountId: "alpha", limit: 100, sortBy, sortDirection });
      assert.deepEqual(hits.map(row => row.id), all.slice().sort(compare(sortBy, sortDirection)).slice(0, 100).map(row => row.id));
    }
    const first = await ask("mail:listFromCache", { accountId: "alpha", folderId: "INBOX", limit: 100 });
    const stale = await ask("mail:listFromCache", { accountId: "alpha", folderId: "INBOX", limit: 100, offset: 100, pageCursor: first.nextCursor, sortBy: "subject", sortDirection: "asc" });
    assert.equal(stale.cursorReset, true);
    assert.deepEqual(stale.emails.map(row => row.id), base.slice().sort(compare("subject", "asc")).slice(100, 200).map(row => row.id));
    const unsafe = await ask("mail:listFromCache", { accountId: "alpha", folderId: "INBOX", sortBy: "subject; DROP TABLE messages", sortDirection: "not SQL", limit: 100 });
    assert.deepEqual(unsafe.emails.map(row => row.id), first.emails.map(row => row.id));
    console.log(`mail-columns-db-ok: ${checks} paginated orders, 8 global search orders, stale cursor and input allowlist`);
  } finally {
    await db.close();
    for (const key of ["MORROW_MAIL_DIR", "MORROW_USER_DATA", "MORROW_MAIL_SECRETS"]) {
      if (environment[key] == null) delete process.env[key]; else process.env[key] = environment[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }

  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8"), { url: "https://fixture.invalid" });
  const ui = renderer({ document: dom.window.document, localStorage: dom.window.localStorage });
  ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  ui.run(`
    state.listOffset = 200; state.listCursors = [{offset:200}];
    state.email = {id:'reader-stays'};
    globalThis.loads = [];
    loadList = async (network, offset) => { loads.push({network,offset,sort:{...state.listSort}}); };
    paintMailListColumns($('message-list'));
  `);
  assert.equal(dom.window.document.querySelectorAll('[role="columnheader"]').length, 4);
  assert.equal(dom.window.document.querySelector('[data-sort-key="status"]'), null);
  for (const [replied, forwarded, expected] of [[true, false, ["replied"]], [false, true, ["forwarded"]], [true, true, ["replied", "forwarded"]], [false, false, []], [null, null, []], [true, null, ["replied"]]]) {
    ui.context.flagFixture = { id: "flags", subject: "Synthetic subject", replied, forwarded };
    const row = ui.run("messageRow(flagFixture)");
    const prefix = row.querySelector('[data-mail-column="subject"] .mail-reply-forward');
    assert.equal(row.querySelector('[data-mail-column="status"]'), null);
    assert.deepEqual([...prefix.querySelectorAll("svg")].map(icon => icon.dataset.state), expected);
    assert.equal(prefix.hidden, !expected.length);
    assert.equal(prefix.nextElementSibling.className, "subject");
    assert.doesNotMatch(prefix.textContent, /—/);
    if (expected.length) assert.match(prefix.title, /saved evidence/);
  }
  await ui.run(`changeMailListSort('subject')`);
  ui.run(`paintMailListColumns($('message-list'))`);
  assert.equal(dom.window.document.querySelector('[data-sort-key="subject"]').getAttribute("aria-sort"), "ascending");
  await ui.run(`changeMailListSort('subject')`);
  ui.run(`paintMailListColumns($('message-list'))`);
  assert.equal(dom.window.document.querySelector('[data-sort-key="subject"]').getAttribute("aria-sort"), "descending");
  assert.equal(ui.run("state.listCursors.length"), 0);
  assert.equal(ui.run("state.email.id"), "reader-stays");
  assert.ok(ui.run("loads.every(row => row.offset === 0 && row.network === false)"));
  assert.equal(ui.run("readMailListSort().sortDirection"), "desc");
  assert.equal(ui.run(`mailListRequest({allInbox:true,listSort:state.listSort}).params.sortBy`), "subject");
  assert.equal(ui.run(`mailRecipientText({to:['first@fixture.invalid','second@fixture.invalid']})`), "first@fixture.invalid, second@fixture.invalid");
  ui.run(`
    state.emails = [{id:'refresh-flags',accountId:'synthetic',subject:'Flag refresh',replied:true,forwarded:false}];
    renderList();
    globalThis.flagRow = $('message-list').querySelector('.message-row');
    globalThis.flagButton = flagRow.querySelector('button.message');
    flagButton.focus();
    state.emails[0].replied = false; state.emails[0].forwarded = true; renderList();
  `);
  assert.equal(ui.run("$('message-list').querySelector('.message-row') === flagRow"), true);
  assert.equal(ui.run("document.activeElement === flagButton"), true);
  assert.equal(dom.window.document.querySelector('[data-mail-column="subject"] .mail-reply-forward svg').dataset.state, "forwarded");
  ui.run("state.emails[0].forwarded = null; renderList()");
  assert.equal(dom.window.document.querySelector('[data-mail-column="subject"] .mail-reply-forward').hidden, true);
  ui.run(`state.outbox=true;paintMailListColumns($('message-list'))`);
  assert.ok([...dom.window.document.querySelectorAll('[role="columnheader"][aria-sort] button')].every(button => button.disabled));
  assert.equal(ui.run(`messageRow({id:"missing",to:[],date:""}).querySelector("time").textContent`), "");
  assert.equal(ui.run(`messageRow({id:"bad-date",to:[],date:"invalid"}).querySelector("time").textContent`), "");
  ui.run(`paintFeatureCatalog()`);
  assert.match(dom.window.document.getElementById("features-catalog").textContent, /sort all matching downloaded mail before paging/);
  assert.match(dom.window.document.getElementById("features-catalog").textContent, /Reply \/ forward icons appear inline before Subject/);
  const dispositionHelp = dom.window.document.getElementById("mail-columns-provider-help").textContent;
  assert.match(dispositionHelp, /confirmed successful Morrow sends/);
  assert.match(dispositionHelp, /emoji reactions are excluded/);
  assert.match(dispositionHelp, /cross-device forwards cannot be inferred/);
  assert.doesNotMatch(dom.window.document.getElementById("features-catalog").textContent, /The Reply \/ forward column shows/);
  assert.match(dom.window.document.getElementById("mail-sort-help").textContent, /first To recipient/);
  assert.match(dom.window.document.getElementById("mail-sort-help").textContent, /icons appear before the subject/);
  dom.window.close();
  console.log("mail-columns-ui-ok: toggles, persistence, page reset, reader retention, accessible headers and rendered Features help");
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
