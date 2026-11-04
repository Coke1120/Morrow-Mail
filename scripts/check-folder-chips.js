const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");

function account(id, profile = "custom") {
  return {
    id, email: `${id}@example.invalid`, platform: "imap", imapSmtpProfile: profile, delimiter: "/",
    folders: {
      primary: [
        { id: "Archive/Old/Sent", name: "Sent", wellKnownName: "sentitems", chip: true },
        { id: "sent", name: "sent", wellKnownName: "SENT", chip: true },
        { id: "Sent Items", name: "Sent Items", wellKnownName: "sentitems", chip: true },
        { id: "Sent", name: "Sent", wellKnownName: "sentitems", chip: true },
        { id: "Drafts", name: "Drafts", wellKnownName: "drafts", chip: true },
        { id: "INBOX", name: "INBOX", wellKnownName: "inbox", chip: true, unreadCount: 2 },
        { id: "starred", name: "Starred", wellKnownName: "starred", type: "virtual", chip: false },
        { id: "unread", name: "Unread", wellKnownName: "unread", type: "virtual", chip: true },
      ],
      more: [
        { id: "Sent Mail", name: "Sent Mail", wellKnown: "Sent Mail", chip: true },
        { id: "Projects", name: "Projects", chip: true },
      ],
    },
  };
}

function fixture(testContext, accounts = [account("custom"), account("gmail", "gmail"), account("outlook", "outlook")]) {
  const window = new JSDOM(fs.readFileSync(require.resolve("../renderer/index.html"), "utf8"), { url: "https://fixture.invalid" }).window;
  testContext.after(() => window.close());
  const calls = [];
  window.morrow = {
    on() {},
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === "morrow:configSetSidebarAccountFoldersExpanded") return { [payload.accountId]: payload.expanded };
      return payload;
    },
  };
  window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  window.morrowMailColumns = require("../shared/mail-columns");
  const ui = renderer({
    window, document: window.document, localStorage: window.localStorage, Event: window.Event, Node: window.Node,
    morrowFolderCollapse: require("../shared/folder-collapse"),
    morrowMailboxRoles: require("../shared/mailbox-roles"),
    morrowPrimaryMailboxes: require("../shared/primary-mailboxes"),
    fixtureAccounts: accounts,
  });
  ui.run(`
    state.accounts = fixtureAccounts;
    state.accountId = fixtureAccounts[0].id;
    state.folderId = "INBOX";
    state.prefs.gmailOpen = true;
    state.prefs.outlookOpen = true;
  `);
  const get = id => window.document.getElementById(id);
  const chips = () => [...get("list-chips").querySelectorAll("button")];
  return { ui, window, calls, get, chips, accounts };
}

test("noisy IMAP roles produce a bounded, canonical chip order without changing server folders", testContext => {
  const view = fixture(testContext);
  const original = JSON.stringify(view.accounts);
  view.ui.run("renderChips(selectedAccount())");
  assert.deepEqual(view.chips().map(button => button.textContent), ["Inbox", "Sent", "Drafts", "Unread"]);
  assert.equal(view.chips().filter(button => button.hasAttribute("aria-current")).length, 1);
  assert.equal(view.chips()[0].getAttribute("aria-current"), "true");
  assert.equal(view.ui.run("chipFolders(selectedAccount()).find(folder => folder.label === 'Sent').id"), "Sent");
  view.ui.run("state.accounts[0].folders.primary.reverse(); renderChips(selectedAccount())");
  assert.deepEqual(view.chips().map(button => button.textContent), ["Inbox", "Sent", "Drafts", "Unread"]);
  assert.equal(view.ui.run("chipFolders(selectedAccount()).find(folder => folder.label === 'Sent').id"), "Sent");
  view.ui.run("state.accounts[0].folders.primary.reverse()");
  assert.equal(JSON.stringify(view.accounts), original);
});

test("known aliases share labels while disabled, malformed and custom folders do not create chips", testContext => {
  const rows = [
    ["ARCHIVED", "Archived"], ["junk_email", "Junk"], ["deleted items", "Trash"], ["unread", "Unread"],
    ["starred", "Starred"], ["Draft", "Drafts"], ["Sent Mail", "Sent"], ["INBOX", "Inbox"],
  ].map(([wellKnownName, name]) => ({ id: wellKnownName, wellKnownName, name, chip: true }));
  const view = fixture(testContext, [{ id: "aliases", folders: { primary: [null, { chip: true }, { id: "wrong", name: "Sent", chip: true }], more: rows } }]);
  view.ui.run("renderChips(selectedAccount())");
  assert.deepEqual(view.chips().map(button => button.textContent), ["Inbox", "Sent", "Drafts", "Starred", "Unread", "Trash", "Junk", "Archived"]);
  view.ui.run("state.accounts[0].folders.more.forEach(folder => { folder.chip = false; }); renderChips(selectedAccount())");
  assert.equal(view.get("list-chips").hidden, true);
  assert.equal(view.chips().length, 0);
});

test("the selected duplicate retains its real folder id and chip click stays in that mailbox", async testContext => {
  const view = fixture(testContext);
  view.ui.run(`
    state.accountId = "gmail";
    state.folderId = "Sent Items";
    globalThis.selectedFolders = [];
    selectFolder = async (accountId, folderId) => selectedFolders.push({ accountId, folderId });
    renderList();
  `);
  const sent = view.chips().find(button => button.textContent === "Sent");
  assert.equal(sent.getAttribute("aria-current"), "true");
  assert.equal(sent.title, "Sent Items");
  assert.equal(view.get("list-title").classList.contains("sr"), true);
  sent.click();
  await Promise.resolve();
  assert.deepEqual(JSON.parse(view.ui.run("JSON.stringify(selectedFolders)")), [{ accountId: "gmail", folderId: "Sent Items" }]);
  assert.equal(view.ui.run("state.accounts[1].folders.primary.find(folder => folder.id === 'Sent Items').name"), "Sent Items");
});

test("adding and switching accounts never merges folder chips; All Account Mail and Outbox keep their own views", testContext => {
  const view = fixture(testContext);
  view.ui.context.addedAccount = account("added");
  view.ui.run("renderList(); state.accounts.push(addedAccount); renderList()");
  assert.deepEqual(view.chips().map(button => button.textContent), ["Inbox", "Sent", "Drafts", "Unread"]);
  view.ui.run("state.allInbox = true; renderList()");
  assert.equal(view.get("list-chips").hidden, true);
  assert.equal(view.get("list-title").textContent, "All Account Mail");
  view.ui.run("state.allInbox = false; state.outbox = true; renderList()");
  assert.equal(view.get("list-chips").hidden, true);
  view.ui.run("state.outbox = false; state.accountId = 'outlook'; state.folderId = 'INBOX'; renderList()");
  assert.deepEqual(view.chips().map(button => button.textContent), ["Inbox", "Sent", "Drafts", "Unread"]);
  view.ui.run("state.prefs.chips = false; renderList()");
  assert.equal(view.get("list-chips").hidden, true);
});

test("expanded custom IMAP, Gmail and Outlook accounts retain identical colorful icon rows", testContext => {
  const view = fixture(testContext);
  for (const row of view.accounts) {
    row.folders.more.push(
      { id: "Trash", name: "Trash", wellKnownName: "deleteditems" },
      { id: "Junk", name: "Junk", wellKnownName: "junk email" },
      { id: "Archived", name: "Archived", wellKnown: "ARCHIVED" },
    );
  }
  view.ui.run("renderAccounts()");
  const expected = { INBOX: "📥", Sent: "📤", "Sent Items": "📤", sent: "📤", Drafts: "📝", starred: "⭐", unread: "✉️", Trash: "🗑️", Junk: "🚫", Archived: "📦", Projects: "📁" };
  for (const row of view.accounts) {
    for (const [folderId, icon] of Object.entries(expected)) {
      const button = [...view.get("folders").querySelectorAll("button.folder")].find(node => node.dataset.accountId === row.id && node.dataset.folderId === folderId);
      assert.ok(button, `${row.id}/${folderId}`);
      assert.equal(button.querySelector(".folder-icon").textContent, icon, `${row.id}/${folderId}`);
      assert.equal(button.querySelector(".folder-icon").getAttribute("aria-hidden"), "true");
      assert.ok(button.querySelector(".name").textContent);
      assert.equal(button.dataset.dropAccount, row.id);
    }
  }
  assert.equal(view.get("folders").querySelectorAll('button.folder[data-folder-id="Sent Items"]').length, 3);
});

test("saved provider collapse is respected and expanding restores the shared icon list", async testContext => {
  const view = fixture(testContext);
  view.ui.run("state.prefs.outlookOpen = false; renderAccounts()");
  const heading = () => [...view.get("folders").querySelectorAll("button.account")].find(button => button.title === "outlook@example.invalid");
  assert.equal(heading().getAttribute("aria-expanded"), "false");
  assert.equal(view.get("folders").querySelector('[data-account-id="outlook"].folder'), null);
  heading().click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(heading().getAttribute("aria-expanded"), "true");
  assert.equal(view.get("folders").querySelector('[data-account-id="outlook"][data-folder-id="INBOX"] .folder-icon').textContent, "📥");
  assert.deepEqual(JSON.parse(JSON.stringify(view.calls.filter(row => row.channel === "morrow:configSetSidebarAccountFoldersExpanded"))), [{ channel: "morrow:configSetSidebarAccountFoldersExpanded", payload: { accountId: "outlook", expanded: true } }]);
});

test("a known-role metadata refresh updates the cached sidebar icon without renaming a custom folder", testContext => {
  const view = fixture(testContext);
  view.ui.run("renderAccounts()");
  const project = () => view.get("folders").querySelector('[data-account-id="custom"][data-folder-id="Projects"]');
  assert.equal(project().querySelector(".folder-icon").textContent, "📁");
  view.ui.run("state.accounts[0].folders.more.find(folder => folder.id === 'Projects').wellKnown = 'Archived'; renderAccounts()");
  assert.equal(project().querySelector(".folder-icon").textContent, "📦");
  assert.equal(project().querySelector(".name").textContent, "Projects");
});

test("the actual Features catalog tab describes chip scope, supported roles and shared folder icons", testContext => {
  const view = fixture(testContext);
  view.ui.run("paintFeatureCatalog(); showFeaturesTab('catalog')");
  const card = [...view.get("features-catalog").querySelectorAll(".feature-card")].find(node => node.querySelector("h4").textContent === "Folder chips and sidebar icons");
  assert.ok(card);
  assert.match(card.textContent, /one canonical name per enabled role/);
  assert.match(card.textContent, /Sent Items, Sent Mail and casing variants share one Sent chip/);
  assert.match(card.textContent, /Expanded IMAP, Gmail and Outlook accounts share the same colorful folder icons/);
  assert.match(card.textContent, /cross-account Sent, Drafts, Trash, Junk and Archived chips are unavailable/);
  assert.equal(view.get("features-pane-catalog").hidden, false);
  assert.equal(view.get("features-tab-catalog").getAttribute("aria-selected"), "true");
});
