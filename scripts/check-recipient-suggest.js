// Synthetic recipient autocomplete. No live mailbox, contacts API, or provider scope.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const suggest = require("../shared/recipient-suggest");

const DAY = 24 * 60 * 60 * 1000;
const T = 1700000000000;
const root = path.join(__dirname, "..");

function row(partial) {
  return {
    account_id: "box",
    id: partial.id,
    gmail_id: partial.gmail_id || null,
    from_addr: partial.from_addr || "",
    from_address: partial.from_address || null,
    from_display_name: partial.from_display_name,
    to_json: JSON.stringify(partial.to || []),
    cc_json: JSON.stringify(partial.cc || []),
    bcc_json: JSON.stringify(partial.bcc || []),
    list_sort_ts: partial.ts,
    is_draft: partial.draft ? 1 : 0,
    subject: partial.subject || "hello",
    uid: partial.uid,
  };
}

function rankingFixture() {
  const old = T - 30 * DAY;
  return [
    row({ id: "ada-1", uid: 1, ts: old, subject: "secret-subject-token", from_addr: "Old Ada <ada@example.test>", from_address: "ada@example.test" }),
    row({ id: "ada-2", uid: 2, ts: old, from_addr: "Old Ada <ada@example.test>", from_address: "ada@example.test" }),
    row({ id: "ada-3", uid: 3, ts: old, from_addr: "Old Ada <ada@example.test>", from_address: "ada@example.test" }),
    row({ id: "ada-4", uid: 4, ts: old + 1000, from_addr: "Ignored <ada@example.test>", from_address: "ada@example.test", from_display_name: "Ada Lovelace" }),
    row({ id: "ada-5", uid: 5, ts: old + 2000, from_addr: "ada@example.test", from_address: "ada@example.test", from_display_name: "" }),
    row({ id: "grace-1", uid: 6, ts: T, to: ['"Hopper, Grace" <grace@example.test>'] }),
    row({ id: "week-1", uid: 7, ts: T - DAY, from_addr: "Weekly <weekly@example.test>", from_address: "weekly@example.test" }),
    row({ id: "week-2", uid: 8, ts: T - DAY, from_addr: "Weekly <weekly@example.test>", from_address: "weekly@example.test" }),
    row({ id: "week-3", uid: 9, ts: T - DAY, from_addr: "Weekly <weekly@example.test>", from_address: "weekly@example.test" }),
    row({ id: "week-4", uid: 10, ts: T - DAY, from_addr: "Weekly <weekly@example.test>", from_address: "weekly@example.test" }),
    row({ id: "real-1", uid: 11, ts: T - 6 * DAY, from_addr: "Real <real@example.test>", from_address: "real@example.test" }),
    row({ id: "real-2", uid: 12, ts: T - 6 * DAY, from_addr: "Real <real@example.test>", from_address: "real@example.test" }),
    row({ id: "dup-1", uid: 13, ts: T - 6 * DAY, gmail_id: "g-dup", from_addr: "Dup <dup@example.test>", from_address: "dup@example.test" }),
    row({ id: "dup-2", uid: 14, ts: T - 6 * DAY, gmail_id: "g-dup", from_addr: "Dup <dup@example.test>", from_address: "dup@example.test", folder: "Sent" }),
    row({ id: "alpha", uid: 15, ts: T - 10 * DAY, to: ["alpha@example.test"] }),
    row({ id: "beta", uid: 16, ts: T - 10 * DAY, to: ["beta@example.test"] }),
    row({ id: "cc-1", uid: 17, ts: T - 40 * DAY, cc: ["Carbon <carbon@example.test>"], bcc: ["Blind <blind@example.test>"] }),
    row({ id: "chen", uid: 18, ts: T - 3 * DAY, to: ["陳大文 <chen@example.com>"] }),
    row({ id: "bad", uid: 19, ts: T, to: ["not an email", "o'hara@example.com"] }),
    row({ id: "draft", uid: 20, ts: T, draft: true, to: ["draft-only@example.test"] }),
  ];
}

function emails(query, rows) {
  return suggest.filter(suggest.rank(rows), query).map((item) => item.email);
}

function rankChecks() {
  assert.equal(suggest.EXTRA_SIGHTING_MS, 7 * DAY);
  assert.equal(suggest.SUGGEST_LIMIT, 8);
  const rows = rankingFixture();
  assert.deepEqual(emails("example.test", rows), [
    "weekly@example.test",
    "real@example.test",
    "grace@example.test",
    "ada@example.test",
    "dup@example.test",
    "alpha@example.test",
    "beta@example.test",
    "blind@example.test",
  ]);
  assert.equal(emails("example.test", rows).includes("carbon@example.test"), false);
  assert.deepEqual(emails("carbon", rows), ["carbon@example.test"]);
  assert.deepEqual(emails("blind", rows), ["blind@example.test"]);
  const doubled = [
    row({ id: "tie", uid: 40, ts: T, to: ["tie@example.test"] }),
    row({ id: "dbl", uid: 41, ts: T - 7 * DAY + 1000, to: ["dbl@example.test"], cc: ["Dbl <dbl@example.test>"] }),
  ];
  assert.deepEqual(emails("example.test", doubled), ["tie@example.test", "dbl@example.test"]);
  assert.deepEqual(emails("lov", rows), ["ada@example.test"]);
  assert.equal(suggest.filter(suggest.rank(rows), "lov")[0].name, "Ada Lovelace");
  assert.deepEqual(emails("HOPPER", rows), ["grace@example.test"]);
  assert.equal(suggest.filter(suggest.rank(rows), "hopper")[0].name, "Hopper, Grace");
  assert.deepEqual(emails("chen", rows), ["chen@example.com"]);
  assert.equal(suggest.filter(suggest.rank(rows), "陳")[0].name, "陳大文");
  assert.deepEqual(emails("draft-only", rows), []);
  assert.deepEqual(emails("o'hara", rows), ["o'hara@example.com"]);
  assert.deepEqual(emails("not an", rows), []);
  assert.deepEqual(suggest.filter(suggest.rank(rows), ""), []);
  assert.deepEqual(suggest.filter(suggest.rank(rows), "   "), []);
  assert.deepEqual(suggest.filter(suggest.rank(rows), 12), []);

  const many = [];
  for (let i = 0; i < 10; i++) {
    many.push(row({ id: "sam-" + i, uid: 100 + i, ts: T - i * DAY, to: ["Sam " + i + " <sam" + i + "@example.test>"] }));
  }
  assert.equal(suggest.filter(suggest.rank(many), "sam").length, 8);
  assert.equal(suggest.filter(suggest.rank(many), "sam")[0].email, "sam0@example.test");

  assert.equal(suggest.activeQuery("Ada"), "ada");
  assert.equal(suggest.activeQuery("Grace Hopper <gr"), "gr");
  assert.equal(suggest.activeQuery("a@b.com,  Hi"), "hi");
  assert.equal(suggest.activeQuery('"Hopper, Grace" <g@example.com>, nex'), "nex");
  assert.deepEqual([...suggest.usedAddresses("ada@example.test, gr")], ["ada@example.test"]);
  assert.equal(suggest.applyChoice("", { email: "Grace <grace@example.test>", name: "Hopper, Grace" }), '"Hopper, Grace" <grace@example.test>, ');
  assert.equal(suggest.applyChoice("ada@example.test, gr", { email: "greg@example.test", name: "Greg" }), "ada@example.test, Greg <greg@example.test>, ");
  assert.equal(suggest.applyChoice("ada@example.test; gr", { email: "greg@example.test", name: "" }), "ada@example.test; greg@example.test, ");
  assert.equal(suggest.applyChoice("not-an-email", { email: "nope", name: "Nope" }), "not-an-email");
  assert.equal(suggest.keyAction("ArrowDown", false, -1), "");
  assert.equal(suggest.keyAction("Enter", true, -1), "");
  assert.equal(suggest.keyAction("Enter", true, 0), "choose");
  assert.equal(suggest.keyAction("Escape", true, -1), "close");
  assert.equal(suggest.keyAction("ArrowUp", true, 1), "prev");
  assert.equal(suggest.usedAddresses("Grace Hopper <grace@example.test>, gr").has("grace@example.test"), true);
}

function sourceChecks() {
  const host = fs.readFileSync(path.join(root, "host/mail/recipient-suggest.js"), "utf8");
  const shared = fs.readFileSync(path.join(root, "shared/recipient-suggest.js"), "utf8");
  const dbSrc = fs.readFileSync(path.join(root, "host/mail/db.js"), "utf8");
  const engine = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
  const preload = fs.readFileSync(path.join(root, "renderer/preload.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  const adr = fs.readFileSync(path.join(root, "docs/adr/2026-10-28-compose-recipient-autocomplete.md"), "utf8");
  const catalog = require("../renderer/features-catalog");
  const oauth = require("../host/mail/oauth-config");
  assert.doesNotMatch(host + shared, /people\.googleapis|contacts\.google|Contacts\.Read/i);
  assert.equal(oauth.SCOPES.google.includes("contacts"), false);
  assert.equal(oauth.SCOPES.google.includes("people"), false);
  assert.equal(oauth.SCOPES.microsoft.includes("Contacts"), false);
  assert.match(dbSrc, /function recipientHeaderRows\(\) \{\s*return all\(`SELECT account_id, id, gmail_id[\s\S]*?WHERE is_draft = 0`\)/);
  assert.doesNotMatch(dbSrc.slice(dbSrc.indexOf("function recipientHeaderRows"), dbSrc.indexOf("function recipientHeaderStamp")), /html_body|text_body/);
  assert.match(engine, /case "mail:suggestRecipients"/);
  assert.match(preload, /"mail:suggestRecipients"/);
  assert.match(app, /mail:suggestRecipients/);
  assert.match(app, /morrowRecipientSuggest/);
  assert.match(app, /applyChoice/);
  assert.match(app, /keyAction/);
  assert.match(html, /id="recipient-suggest"/);
  assert.match(html, /recipient-suggest\.js/);
  assert.match(html, /aria-controls="recipient-suggest"/);
  const feature = catalog.items.find((item) => item.id === "compose-window");
  assert.match(feature.blurb, /suggest up to eight addresses already in synced mail/);
  assert.match(feature.blurb, /do not read a contacts directory/);
  assert.doesNotMatch(feature.blurb, /planned|will suggest|coming soon/i);
  assert.match(adr, /Phase 1 is implemented/);
  assert.match(adr, /Phase 2/);
  assert.doesNotMatch(adr, /Not implemented/);
}

async function engineChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-recipients-"));
  const env = ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS"].map((key) => [key, process.env[key]]);
  Object.assign(process.env, {
    MORROW_USER_DATA: dir,
    MORROW_MAIL_DIR: dir,
    MORROW_AI_CONFIG_DIR: dir,
    MORROW_MAIL_SECRETS: "memory",
  });
  const db = require("../host/mail/db");
  const engine = require("../host/mail/engine");
  const rows = rankingFixture();
  try {
    await engine.init();
    db.insertAccount({
      id: "box", email: "box@example.test", username: "box", profile: "custom", createdAt: T,
      imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true,
    });
    for (const item of rows) {
      db.insertMessage({
        id: item.id, accountId: item.account_id, folderPath: "INBOX", uid: item.uid,
        date: new Date(item.list_sort_ts).toISOString(), listSortTs: item.list_sort_ts,
        from: item.from_addr, fromAddress: item.from_address, fromDisplayName: item.from_display_name,
        to: JSON.parse(item.to_json), cc: JSON.parse(item.cc_json), bcc: JSON.parse(item.bcc_json),
        isDraft: item.is_draft === 1, subject: item.subject || "hello",
      });
      if (item.gmail_id) db.updateMessage(item.id, { gmail_id: item.gmail_id });
    }
    const listed = engine.answer("mail:suggestRecipients", [{ query: "example.test" }]);
    assert.equal(listed.success, true);
    assert.deepEqual(listed.data.suggestions, suggest.filter(suggest.rank(rows), "example.test"));
    assert.equal(JSON.stringify(listed.data).includes("secret"), false);
    assert.equal(listed.data.suggestions.some((item) => item.email === "draft-only@example.test"), false);
    assert.deepEqual(Object.keys(listed.data.suggestions[0]).sort(), ["email", "name"]);
    assert.deepEqual(engine.answer("mail:suggestRecipients", [{ query: "" }]).data.suggestions, []);
    assert.deepEqual(engine.answer("mail:suggestRecipients", [{ query: { bad: true } }]).data.suggestions, []);
    assert.equal(engine.answer("mail:suggestRecipients", [{ query: "Ada Lovelace" }]).data.suggestions[0].name, "Ada Lovelace");
    db.insertMessage({
      id: "late", accountId: "box", folderPath: "INBOX", uid: 80,
      date: new Date(T + DAY).toISOString(), listSortTs: T + DAY,
      from: "Late <late@example.test>", fromAddress: "late@example.test",
      to: [], cc: [], bcc: [], subject: "later",
    });
    const late = engine.answer("mail:suggestRecipients", [{ query: "late@" }]);
    assert.deepEqual(late.data.suggestions, [{ email: "late@example.test", name: "Late" }]);
  } finally {
    await db.close();
    for (const [key, value] of env) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function uiChecks() {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "renderer/index.html"), "utf8"));
  const { renderer } = require("./check-ux-workflows");
  const rows = [
    row({ id: "g", uid: 1, ts: T, to: ["Grace Hopper <grace@example.test>"] }),
    row({ id: "r", uid: 2, ts: T - DAY, to: ["Greg <greg@example.test>"] }),
    row({ id: "a", uid: 3, ts: T - 2 * DAY, from_addr: "Ada Lovelace <ada@example.test>", from_address: "ada@example.test" }),
  ];
  const ui = renderer({
    document: dom.window.document,
    window: {
      morrow: { on() {}, invoke: async () => ({ success: true, data: {} }) },
      morrowComposePolicy: require("../shared/compose-policy"),
      morrowRecipientSuggest: suggest,
      addEventListener() {},
    },
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    requestAnimationFrame: (fn) => fn(),
  });
  ui.context.suggestLib = suggest;
  ui.context.fixtureRows = rows;
  ui.run("wire()");
  ui.run(`
    state.accounts = [{ id: "box", email: "me@example.test", platform: "imap", preferredFromAddress: "me@example.test" }];
    state.composeMeta = { accountId: "box", fromAddress: "me@example.test", fromDisplayName: "Me" };
    state.accountId = "box";
    globalThis.suggestCalls = [];
    call = async (channel, payload) => {
      suggestCalls.push(channel);
      if (channel === "mail:suggestRecipients") return { suggestions: suggestLib.filter(suggestLib.rank(fixtureRows), payload.query) };
      return {};
    };
  `);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  ui.run(`{
    const input = document.getElementById("compose-to");
    input.focus();
    input.value = "gr";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }`);
  await sleep(180);
  const opened = ui.run(`({
    hidden: document.getElementById("recipient-suggest").hidden,
    labels: [...document.getElementById("recipient-suggest").querySelectorAll('[role="option"]')].map((node) => node.getAttribute("aria-label")),
    expanded: document.getElementById("compose-to").getAttribute("aria-expanded"),
    active: document.activeElement && document.activeElement.id,
  })`);
  assert.equal(opened.hidden, false, JSON.stringify(opened));
  assert.deepEqual(JSON.parse(JSON.stringify(opened.labels)), ["Grace Hopper grace@example.test", "Greg greg@example.test"]);
  assert.equal(opened.expanded, "true");
  ui.run(`
    document.getElementById("compose-to").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  `);
  assert.equal(ui.run('document.getElementById("compose-to").value'), "gr", "Enter without a highlight keeps the typed text");
  ui.run(`{
    const input = document.getElementById("compose-to");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  }`);
  assert.equal(ui.run('document.getElementById("compose-to").value'), "Grace Hopper <grace@example.test>, ");
  assert.equal(ui.run('document.getElementById("recipient-suggest").hidden'), true);
  assert.equal(ui.run("suggestCalls.includes('mail:send')"), false);

  ui.run(`{
    const input = document.getElementById("compose-cc");
    input.focus();
    input.value = "ada";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }`);
  await sleep(180);
  ui.run(`{
    const button = document.getElementById("recipient-suggest").querySelector("button");
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }`);
  assert.equal(ui.run('document.getElementById("compose-cc").value'), "Ada Lovelace <ada@example.test>, ");

  ui.run(`{
    const input = document.getElementById("compose-bcc");
    input.focus();
    input.value = "not-an-email";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }`);
  await sleep(180);
  assert.equal(ui.run('document.getElementById("compose-bcc").value'), "not-an-email");
  assert.equal(ui.run('document.getElementById("recipient-suggest").hidden'), true);

  ui.run(`{
    const input = document.getElementById("compose-to");
    input.focus();
    input.value = "Grace Hopper <grace@example.test>, gr";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }`);
  await sleep(180);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.run(`[...document.getElementById("recipient-suggest").querySelectorAll('[role="option"]')].map((node) => node.dataset.email)`))), ["greg@example.test"]);
  ui.run(`document.getElementById("compose-to").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  assert.equal(ui.run('document.getElementById("recipient-suggest").hidden'), true);
  assert.equal(ui.run("takeRecipientSuggestEscape()"), true);
  assert.equal(ui.run("takeRecipientSuggestEscape()"), false);
}

async function main() {
  rankChecks();
  sourceChecks();
  await engineChecks();
  await uiChecks();
  console.log("recipient-suggest-ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
