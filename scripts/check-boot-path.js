const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");

const syntax = [
  "host/main.js",
  "host/asar.js",
  "host/ipc.js",
  "host/mail/engine.js",
  "host/mail/oauth.js",
  "host/mail/oauth-config.js",
  "host/mail/secrets.js",
  "host/mail/provider-http.js",
  "host/mail/provider-api.js",
  "host/mail/calendar-api.js",
  "host/mail/sidecar.js",
  "host/brain.js",
  "host/agent.js",
  "renderer/preload.js",
  "renderer/app.js",
  "renderer/motion-ui.js",
];
for (const file of syntax) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

const asar = require("../host/asar");
delete process.env.GENMAIL_ASAR;
assert.strictEqual(asar.resolveAsarPath(), null);
assert.throws(() => asar.openAsar(), /GENMAIL_ASAR/);
process.env.GENMAIL_ASAR = "  /tmp/from-env.asar  ";
assert.strictEqual(asar.resolveAsarPath(), "/tmp/from-env.asar");
assert.strictEqual(asar.resolveAsarPath("/tmp/explicit.asar"), "/tmp/explicit.asar");
process.env.GENMAIL_ASAR = "";
assert.strictEqual(asar.resolveAsarPath(), null);

const forbidden = "Genspark Super App.app";
for (const file of ["host/main.js", "host/asar.js"]) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  assert.ok(!text.includes(forbidden), `${file} still hardcodes the external app path`);
}

const preload = fs.readFileSync(path.join(root, "renderer/preload.js"), "utf8");
const registered = new Set();
for (const match of preload.matchAll(/"([a-zA-Z][\w-]*:[^"\n]{1,180})"/g)) {
  registered.add(match[1]);
}
const appJs = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
const used = new Set();
for (const match of appJs.matchAll(/"((?:mail|app|host|genmail|config|aiDraftWrite|emailBrain|nativeAgent|calendar):[^"]+)"/g)) used.add(match[1]);
assert.ok(used.size >= 8, "renderer stopped calling mail IPC");
for (const channel of used) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
}
for (const channel of ["mail:accountsUpdated", "mail:emailsUpdated"]) {
  assert.ok(registered.has(channel), `preload does not listen for ${channel}`);
}

const main = fs.readFileSync(path.join(root, "host/main.js"), "utf8");
assert.ok(main.includes('path.join(__dirname, "..", "renderer")'));
assert.ok(main.includes("externalAsarPath"));
assert.ok(main.includes("loadFile(FIRST_PARTY_HTML)"));

const pkg = require("../package.json");
assert.ok(pkg.build.files.includes("renderer/**/*"));
assert.strictEqual(pkg.build.detectUpdateChannel, false);
assert.strictEqual(pkg.build.win.signAndEditExecutable, false);
assert.deepStrictEqual(
  pkg.build.win.target.map((target) => `${target.target}:${target.arch.join(",")}`),
  ["nsis:x64", "portable:x64"],
);
const githubPublish = pkg.build.publish[0];
assert.deepStrictEqual(
  {
    provider: githubPublish.provider,
    owner: githubPublish.owner,
    repo: githubPublish.repo,
    private: githubPublish.private,
    releaseType: githubPublish.releaseType,
  },
  {
    provider: "github",
    owner: "Coke1120",
    repo: "genmail-rea",
    private: true,
    releaseType: "prerelease",
  },
);

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function extractFunction(source, name) {
  return new Function(`${functionSource(source, name)}; return ${name};`)();
}

function loadFunctions(source, names) {
  const body = names.map((name) => functionSource(source, name)).join("\n");
  return new Function(`${body}; return { ${names.join(", ")} };`)();
}

const senderName = extractFunction(appJs, "senderName");
assert.strictEqual(senderName(""), "(unknown sender)");
assert.strictEqual(senderName("charles@example.com"), "charles@example.com");
assert.strictEqual(senderName("Charles Babbage <charles@example.com>"), "Charles Babbage");
assert.strictEqual(senderName('"Ada Lovelace" <ada@example.com>'), "Ada Lovelace");

const senderInitial = extractFunction(appJs, "senderInitial");
assert.strictEqual(senderInitial("Charles Babbage"), "C");
assert.strictEqual(senderInitial("charles@example.com"), "C");
assert.strictEqual(senderInitial("(unknown sender)"), "U");
assert.strictEqual(senderInitial(""), "?");
assert.strictEqual(senderInitial("樂天Kobo"), "樂");

const applyShellTheme = extractFunction(appJs, "applyShellTheme");
const themeRoot = {
  dataset: {},
  style: {
    props: {},
    setProperty(key, value) { this.props[key] = value; },
    removeProperty(key) { delete this.props[key]; },
  },
};
assert.strictEqual(applyShellTheme(themeRoot, "dark", "#112233"), "dark");
assert.strictEqual(themeRoot.dataset.theme, "dark");
assert.strictEqual(themeRoot.style.props["--accent"], "#112233");
assert.strictEqual(applyShellTheme(themeRoot, "neon", "nope"), "light");
assert.strictEqual(themeRoot.dataset.theme, "light");
assert.strictEqual(themeRoot.style.props["--accent"], undefined);
assert.strictEqual(applyShellTheme(null, "dark", "#112233"), "light");

const nextRow = extractFunction(appJs, "nextRow");
assert.strictEqual(nextRow(0, -1, 1), -1);
assert.strictEqual(nextRow(3, -1, 1), 0);
assert.strictEqual(nextRow(3, -1, -1), 2);
assert.strictEqual(nextRow(3, 0, -1), 0);
assert.strictEqual(nextRow(3, 2, 1), 2);
assert.strictEqual(nextRow(3, 1, 1), 2);

assert.ok(appJs.includes('className = "when"'), "message list does not render a date");
assert.ok(appJs.includes("ArrowDown") && appJs.includes("moveCursor"), "message list has no arrow-key cursor");
const css = fs.readFileSync(path.join(root, "renderer/app.css"), "utf8");
assert.ok(css.includes(".list-title") && css.includes(".when"), "shell css missing dense list styles");
assert.ok(css.includes("#410c42") && css.includes("#572658") && css.includes("[data-theme=\"dark\"]"), "shell css missing GenMail plum tokens");
assert.ok(appJs.includes("applyShellTheme(document.documentElement"), "shell does not paint theme or accent");
assert.ok(css.includes(".thread") && css.includes(".attachments"), "shell css missing thread or attachment styles");
const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
assert.ok(html.includes('id="search-query"'), "toolbar has no search box");
assert.ok(html.includes('src="./motion.bundle.js"'), "renderer does not load the Motion bundle");
assert.ok(pkg.dependencies && pkg.dependencies.motion, "motion is not a dependency");
const motionSrc = fs.readFileSync(path.join(root, "renderer/motion-ui.js"), "utf8");
assert.ok(motionSrc.includes('from "motion"'), "Motion UI does not import motion");
assert.ok(motionSrc.includes("prefers-reduced-motion: reduce"), "Motion UI ignores reduced motion");
assert.ok(fs.existsSync(path.join(root, "renderer/motion.bundle.js")), "Motion bundle was not built");
assert.ok(fs.readFileSync(path.join(root, "renderer/motion.bundle.js"), "utf8").includes("genmailMotion"), "Motion bundle missing genmailMotion");
assert.ok(appJs.includes("genmailMotion") && appJs.includes("wantsCloseMotion"), "shell does not call Motion");
assert.ok(css.includes("margin: 0 auto"), "dialog is not centered without a transform");

const threadMembers = extractFunction(appJs, "threadMembers");
assert.deepStrictEqual(threadMembers([{ id: "a" }, { id: "b" }], [{ id: "c" }]).map((row) => row.id), ["a", "b"]);
assert.deepStrictEqual(threadMembers([], [{ id: "a" }, { id: "b" }]).map((row) => row.id), ["a", "b"]);
assert.deepStrictEqual(threadMembers([{ id: "" }], null), []);
assert.deepStrictEqual(threadMembers(null, null), []);

const mailbox = require("../host/mailbox");
const opened = mailbox.answer("mail:openEmail", [{ emailId: "m-compiler" }]);
assert.strictEqual(opened.data.threadMessages.length, 0);
assert.strictEqual(opened.data.email.threadId, "t-compiler");
assert.strictEqual(opened.data.email.attachments[0].filename, "notes.txt");
assert.strictEqual(opened.data.email.attachments[0]._bytes, undefined);
const members = mailbox.answer("mail:listThreadMessages", [{ threadId: "t-compiler", accountId: "gmail-ada" }]);
assert.ok(members.data.filter((row) => row.threadId === "t-compiler").length >= 2);
const found = mailbox.answer("mail:search", [{ query: "compiler", limit: 10, filters: {} }]);
assert.ok(found.data.some((row) => row.id === "m-compiler" && row.attachments[0].filename === "notes.txt"));

const paneWidth = extractFunction(appJs, "paneWidth");
assert.strictEqual(paneWidth(200, -80, 140, 400), 140);
assert.strictEqual(paneWidth(200, 300, 140, 400), 400);
assert.strictEqual(paneWidth(200, 20, 140, 400), 220);

const folderIcon = extractFunction(appJs, "folderIcon");
assert.strictEqual(folderIcon("inbox"), "📥");
assert.strictEqual(folderIcon("archive"), "📦");
assert.strictEqual(folderIcon("deleteditems"), "🗑️");
assert.strictEqual(folderIcon(null), "📁");

const chipFolders = extractFunction(appJs, "chipFolders");
const folderProvider = extractFunction(appJs, "folderProvider");
const providerExpanded = extractFunction(appJs, "providerExpanded");
const opensAiWrite = extractFunction(appJs, "opensAiWrite");
const sampleAccounts = mailbox.accountList();
const gmailAccount = sampleAccounts.find((account) => account.platform === "gmail");
const outlookAccount = sampleAccounts.find((account) => account.platform === "outlook");
assert.deepStrictEqual(chipFolders(gmailAccount).map((folder) => folder.wellKnownName), ["inbox", "sentitems", "drafts"]);
assert.deepStrictEqual(chipFolders(outlookAccount).map((folder) => folder.wellKnownName), ["inbox", "drafts", "sentitems"]);
assert.deepStrictEqual(chipFolders(null), []);
assert.deepStrictEqual(chipFolders({ folders: { primary: [], more: [{ id: "in", wellKnownName: "inbox" }] } }).map((folder) => folder.id), ["in"]);
assert.deepStrictEqual(chipFolders({ folders: { primary: [{ id: "x", wellKnownName: "archive" }] } }), []);
assert.strictEqual(folderProvider({ platform: "gmail" }), "gmail");
assert.strictEqual(folderProvider({ platform: "IMAP", imapSmtpProfile: "outlook" }), "outlook");
assert.strictEqual(folderProvider({ platform: "imap", profile: "gmail" }), "gmail");
assert.strictEqual(folderProvider({ platform: "imap", imapSmtpProfile: "icloud" }), "");
assert.strictEqual(folderProvider(null), "");
assert.strictEqual(providerExpanded("gmail", {}), true);
assert.strictEqual(providerExpanded("gmail", { gmailOpen: false }), false);
assert.strictEqual(providerExpanded("outlook", {}), false);
assert.strictEqual(providerExpanded("outlook", { outlookOpen: true }), true);
assert.strictEqual(providerExpanded("", { gmailOpen: false, outlookOpen: false }), true);
assert.strictEqual(providerExpanded("gmail", null), true);
assert.strictEqual(opensAiWrite({ aiWrite: true }, { aiReply: true }), true);
assert.strictEqual(opensAiWrite({ aiWrite: true }, { aiReply: false }), false);
assert.strictEqual(opensAiWrite({ aiWrite: true }, null), false);
assert.strictEqual(opensAiWrite({}, { aiReply: true }), false);
const showTidy = extractFunction(appJs, "showTidy");
assert.strictEqual(showTidy({ tidy: true }, "inbox", ""), true);
assert.strictEqual(showTidy({ tidy: true }, "Inbox", ""), true);
assert.strictEqual(showTidy({ tidy: false }, "inbox", ""), false);
assert.strictEqual(showTidy({ tidy: true }, "archive", ""), false);
assert.strictEqual(showTidy({ tidy: true }, "inbox", "promo"), false);
assert.strictEqual(showTidy(null, "inbox", ""), false);

const shellLook = extractFunction(appJs, "shellLook");
const shouldListThread = extractFunction(appJs, "shouldListThread");
const remoteImageSrcs = extractFunction(appJs, "remoteImageSrcs");
const sendDelayMs = extractFunction(appJs, "sendDelayMs");
assert.deepStrictEqual(shellLook(null), { theme: "light", accent: "#7C3AED" });
assert.deepStrictEqual(shellLook({ theme: "dark", accent: "#abcdef" }), { theme: "dark", accent: "#ABCDEF" });
assert.deepStrictEqual(shellLook({ theme: "DARK", accent: "purple" }), { theme: "dark", accent: "#7C3AED" });
assert.strictEqual(shouldListThread(false, [], "t-compiler"), false);
assert.strictEqual(shouldListThread(false, [{ id: "a" }, { id: "b" }], "t"), false);
assert.strictEqual(shouldListThread(true, [{ id: "a" }], "t"), false);
assert.strictEqual(shouldListThread(true, [], "t-compiler"), true);
assert.strictEqual(shouldListThread(true, [], ""), false);
assert.deepStrictEqual(remoteImageSrcs(""), []);
assert.deepStrictEqual(remoteImageSrcs('<img alt="x">'), []);
assert.deepStrictEqual(remoteImageSrcs('<img src="https://cdn.example/a.png">'), [{ src: "https://cdn.example/a.png", alt: "" }]);
assert.deepStrictEqual(remoteImageSrcs("<img alt='Ada' src='http://cdn.example/b.jpg'>"), [{ src: "http://cdn.example/b.jpg", alt: "Ada" }]);
assert.deepStrictEqual(remoteImageSrcs('<img src="data:image/png;base64,aaaa">'), []);
assert.deepStrictEqual(remoteImageSrcs('<img src="javascript:alert(1)">'), []);
assert.deepStrictEqual(remoteImageSrcs("<img src=https://cdn.example/c.gif>"), [{ src: "https://cdn.example/c.gif", alt: "" }]);
const babbage = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/af/Charles_Babbage.jpg/330px-Charles_Babbage.jpg";
assert.deepStrictEqual(remoteImageSrcs(mailbox.answer("mail:openEmail", [{ emailId: "m-engine" }]).data.email.htmlBody), [{ src: babbage, alt: "Charles Babbage" }]);
assert.strictEqual(sendDelayMs(0), 0);
assert.strictEqual(sendDelayMs(5), 5000);
assert.strictEqual(sendDelayMs(30), 30000);
assert.strictEqual(sendDelayMs(31), 5000);
assert.strictEqual(sendDelayMs(-1), 5000);
assert.strictEqual(sendDelayMs("5"), 5000);
assert.strictEqual(sendDelayMs(null), 5000);
assert.ok(html.includes("img-src 'self' data: https: http:"));
assert.ok(html.includes("script-src 'self'") && html.includes("default-src 'none'"));
assert.ok(!html.includes("img-src *"));
assert.ok(html.includes('id="undo-send"'));
assert.ok(css.includes('[data-theme="dark"]') && css.includes("--current") && css.includes("--ghost"));
assert.ok(appJs.includes("dataset.theme") && appJs.includes('setProperty("--accent"'));

const snoozeUntil = extractFunction(appJs, "snoozeUntil");
const afternoon = new Date("2026-10-16T15:00:00");
assert.strictEqual(snoozeUntil("1h", afternoon).getTime() - afternoon.getTime(), 60 * 60 * 1000);
assert.strictEqual(snoozeUntil("tonight", afternoon).getHours(), 18);
assert.strictEqual(snoozeUntil("tonight", new Date("2026-10-16T19:00:00")).getHours(), 22);
const pastTonight = snoozeUntil("tonight", new Date("2026-10-16T23:00:00"));
assert.strictEqual(pastTonight.getDate(), 17);
assert.strictEqual(pastTonight.getHours(), 18);
const morning = snoozeUntil("morning", afternoon);
assert.strictEqual(morning.getDate(), 17);
assert.strictEqual(morning.getHours(), 8);

const removalPayload = extractFunction(appJs, "removalPayload");
assert.deepStrictEqual(removalPayload({ accountId: "a", id: "e", threadId: "t" }, false), {
  accountId: "a",
  emailId: "e",
});
assert.deepStrictEqual(removalPayload({ accountId: "a", id: "e", threadId: "t" }, true), {
  accountId: "a",
  emailId: "e",
  threadId: "t",
});
const usesThread = extractFunction(appJs, "usesThread");
assert.strictEqual(usesThread({ id: "e" }, [{ id: "e" }]), false);
assert.strictEqual(usesThread({ id: "e" }, [{ id: "e" }, { id: "f" }]), true);

for (const channel of [
  "mail:toggleStar",
  "mail:archive",
  "mail:threadArchive",
  "mail:delete",
  "mail:threadTrash",
  "mail:moveToFolder",
  "mail:undoRemoval",
  "mail:snoozeThread",
  "mail:unsnoozeThread",
  "mail:listSnoozed",
]) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(appJs.includes('"Unstar"') && appJs.includes('"Archive"') && appJs.includes('"Trash"') && appJs.includes('"Unsnooze"'));
assert.ok(html.includes('id="undo"') && html.includes('class="split"'), "shell is missing undo or resize handles");
assert.ok(css.includes("--folders") && css.includes("--list") && css.includes(".split") && css.includes(".folder-icon") && css.includes(".reader-actions"));

function idsIn(accountId, folderId) {
  const listed = mailbox.answer("mail:listFromCache", [{ accountId, folderId, limit: 20 }]);
  assert.strictEqual(listed.success, true);
  return listed.data.emails.map((row) => row.id);
}

assert.ok(idsIn("gmail-ada", "starred").includes("m-compiler"));
const starred = mailbox.answer("mail:toggleStar", [{ emailId: "m-engine", accountId: "gmail-ada", isStarred: true }]);
assert.strictEqual(starred.success, true);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-engine"));
assert.ok(mailbox.answer("mail:listFromCache", [{ accountId: "gmail-ada", folderId: "gmail-ada:inbox", limit: 20 }]).data.emails.some((row) => row.id === "m-engine" && row.isStarred === true));
assert.ok(idsIn("gmail-ada", "starred").includes("m-engine"));
mailbox.answer("mail:toggleStar", [{ emailId: "m-engine", accountId: "gmail-ada", isStarred: false }]);

const archived = mailbox.answer("mail:archive", [{ emailId: "m-salon", accountId: "gmail-ada" }]);
assert.ok(archived.data.opIds.length === 1);
assert.ok(!idsIn("gmail-ada", "gmail-ada:inbox").includes("m-salon"));
assert.ok(idsIn("gmail-ada", "gmail-ada:archive").includes("m-salon"));
assert.strictEqual(mailbox.answer("mail:undoRemoval", [{ opIds: archived.data.opIds, kind: "move" }]).success, true);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-salon"));

const threaded = mailbox.answer("mail:threadArchive", [{ accountId: "gmail-ada", threadId: "t-compiler", emailId: "m-compiler" }]);
assert.ok(threaded.data.opIds.length === 1);
assert.ok(!idsIn("gmail-ada", "gmail-ada:inbox").some((id) => id === "m-compiler" || id === "m-compiler-2"));
assert.strictEqual(idsIn("gmail-ada", "gmail-ada:archive").filter((id) => id === "m-compiler" || id === "m-compiler-2").length, 2);
mailbox.answer("mail:undoRemoval", [{ opIds: threaded.data.opIds, kind: "move" }]);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-compiler"));

const trashed = mailbox.answer("mail:delete", [{ emailId: "m-trajectory", accountId: "outlook-grace" }]);
assert.ok(trashed.data.opIds.length === 1);
assert.ok(idsIn("outlook-grace", "outlook-grace:trash").includes("m-trajectory"));
mailbox.answer("mail:undoRemoval", [{ opIds: trashed.data.opIds, kind: "move" }]);
assert.ok(idsIn("outlook-grace", "outlook-grace:inbox").includes("m-trajectory"));

const threadTrash = mailbox.answer("mail:threadTrash", [{ accountId: "outlook-grace", threadId: "m-apollo", emailId: "m-apollo" }]);
assert.ok(threadTrash.data.opIds.length === 1);
assert.ok(idsIn("outlook-grace", "outlook-grace:trash").includes("m-apollo"));
mailbox.answer("mail:undoRemoval", [{ opIds: threadTrash.data.opIds, kind: "move" }]);
assert.ok(idsIn("outlook-grace", "outlook-grace:inbox").includes("m-apollo"));

const moved = mailbox.answer("mail:moveToFolder", [{
  emailId: "m-engine",
  accountId: "gmail-ada",
  targetFolderId: "gmail-ada:notes",
  folderId: "gmail-ada:inbox",
}]);
assert.ok(moved.data.opIds.length === 1);
assert.ok(idsIn("gmail-ada", "gmail-ada:notes").includes("m-engine"));
assert.ok(!idsIn("gmail-ada", "gmail-ada:inbox").includes("m-engine"));
mailbox.answer("mail:undoRemoval", [{ opIds: moved.data.opIds, kind: "move" }]);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-engine"));
const toStar = mailbox.answer("mail:moveToFolder", [{
  emailId: "m-engine",
  accountId: "gmail-ada",
  targetFolderId: "starred",
  folderId: "gmail-ada:inbox",
}]);
assert.ok(idsIn("gmail-ada", "starred").includes("m-engine"));
assert.ok(!idsIn("gmail-ada", "gmail-ada:inbox").includes("m-engine"));
mailbox.answer("mail:undoRemoval", [{ opIds: toStar.data.opIds, kind: "move" }]);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-engine"));

const snoozed = mailbox.answer("mail:snoozeThread", [{
  accountId: "gmail-ada",
  threadId: "m-salon",
  snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
}]);
assert.strictEqual(snoozed.success, true);
assert.ok(!idsIn("gmail-ada", "gmail-ada:inbox").includes("m-salon"));
const snoozeList = mailbox.answer("mail:listSnoozed", [{ accountId: "gmail-ada" }]);
assert.ok(snoozeList.data.records.some((row) => row.threadId === "m-salon" && row.state === "snoozed"));
mailbox.answer("mail:unsnoozeThread", [{ accountId: "gmail-ada", threadId: "m-salon" }]);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-salon"));
assert.ok(!mailbox.answer("mail:listSnoozed", [{ accountId: "gmail-ada" }]).data.records.some((row) => row.threadId === "m-salon"));

assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-promo"));
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-news"));
const skipped = mailbox.answer("mail:tidyInbox", [{ accountId: "outlook-grace" }]);
assert.strictEqual(skipped.success, true);
assert.strictEqual(skipped.data.accepted, true);
assert.strictEqual(skipped.data.archived, 0);
assert.deepStrictEqual(skipped.data.opIds, []);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-promo"));
const tidied = mailbox.answer("mail:tidyInbox", [{ accountId: "gmail-ada" }]);
assert.strictEqual(tidied.data.accepted, true);
assert.strictEqual(tidied.data.archived, 2);
assert.deepStrictEqual(tidied.data.ids.slice().sort(), ["m-news", "m-promo"]);
assert.ok(tidied.data.opIds.length === 1);
assert.ok(!idsIn("gmail-ada", "gmail-ada:inbox").includes("m-promo"));
assert.ok(!idsIn("gmail-ada", "gmail-ada:inbox").includes("m-news"));
assert.ok(idsIn("gmail-ada", "gmail-ada:archive").includes("m-promo"));
assert.ok(idsIn("gmail-ada", "gmail-ada:archive").includes("m-news"));
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-engine"));
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-salon"));
const again = mailbox.answer("mail:tidyInbox", [{ accountId: "gmail-ada" }]);
assert.strictEqual(again.data.archived, 0);
assert.deepStrictEqual(again.data.opIds, []);
assert.strictEqual(mailbox.answer("mail:undoRemoval", [{ opIds: tidied.data.opIds, kind: "move" }]).success, true);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-promo"));
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-news"));
assert.ok(!idsIn("gmail-ada", "gmail-ada:archive").includes("m-promo"));

const bodyNodes = extractFunction(appJs, "bodyNodes");
assert.deepStrictEqual(bodyNodes("One\n\nTwo"), [
  { node_id: "n0", text: "One" },
  { node_id: "n1", text: "Two" },
]);
assert.deepStrictEqual(bodyNodes("  "), []);
assert.deepStrictEqual(bodyNodes("Line"), [{ node_id: "n0", text: "Line" }]);

const applyTranslate = extractFunction(appJs, "applyTranslate");
const translationText = extractFunction(appJs, "translationText");
const view = {
  reqId: "t",
  nodes: [{ node_id: "n0", text: "Hi" }],
  texts: {},
  error: "",
  pending: true,
};
applyTranslate(view, { reqId: "other", type: "error", message: "nope" });
applyTranslate(view, { reqId: "t", type: "progress", current: 0, total: 1 });
applyTranslate(view, { reqId: "t", type: "node", nodeId: "n0", translatedText: "Hola", status: "success" });
applyTranslate(view, { reqId: "t", type: "done" });
assert.strictEqual(translationText(view), "Hola");
assert.strictEqual(view.pending, false);
assert.strictEqual(view.current, 0);
applyTranslate(view, { reqId: "t", type: "error", message: "late" });
assert.strictEqual(view.error, "");
const missingKey = {
  reqId: "t",
  nodes: [{ node_id: "n0", text: "Hi" }],
  texts: {},
  error: "",
  pending: true,
};
applyTranslate(missingKey, { reqId: "t", type: "error", message: "Add an API key in GenMail → AI Setup." });
assert.strictEqual(missingKey.pending, false);
assert.strictEqual(missingKey.error, "Add an API key in GenMail → AI Setup.");
assert.strictEqual(translationText(missingKey), "");

const signatureRows = extractFunction(appJs, "signatureRows");
const chosenSignatureId = extractFunction(appJs, "chosenSignatureId");
const signaturePlain = extractFunction(appJs, "signaturePlain");
const applySignature = extractFunction(appJs, "applySignature");
const pack = {
  signatures: [
    { id: "s1", name: "Work", html: "<p>Thanks,<br>Ada</p>" },
    { id: "s2", name: "Short", text: "— Ada" },
  ],
  defaultSignatureId: "s2",
  defaultSignaturePerAccount: { "gmail-ada": "s1" },
};
assert.strictEqual(chosenSignatureId(pack, "gmail-ada"), "s1");
assert.strictEqual(chosenSignatureId(pack, "other"), "s2");
assert.strictEqual(chosenSignatureId({ signatures: [] }, "a"), "");
assert.strictEqual(signaturePlain(pack.signatures[0]), "Thanks,\nAda");
assert.strictEqual(signaturePlain(pack.signatures[1]), "— Ada");
assert.strictEqual(applySignature("Hello", "", "— Ada"), "Hello\n\n— Ada");
assert.strictEqual(applySignature("Hello\n\n— Ada", "— Ada", "Thanks,\nAda"), "Hello\n\nThanks,\nAda");
assert.strictEqual(applySignature("— Ada", "— Ada", ""), "");
assert.deepStrictEqual(signatureRows({ signatures: [] }), []);
assert.deepStrictEqual(signatureRows(null), []);
const signatureDraft = extractFunction(appJs, "signatureDraft");
const signatureFields = extractFunction(appJs, "signatureFields");
assert.deepStrictEqual(signatureDraft({ name: " Work ", body: "Hi", html: false, isDefault: true }), {
  name: "Work",
  text: "Hi",
  isDefault: true,
});
assert.deepStrictEqual(signatureDraft({ id: "s1", name: "Work", body: "<p>Hi</p>", html: true, isDefault: false }), {
  id: "s1",
  name: "Work",
  html: "<p>Hi</p>",
  isDefault: false,
});
assert.deepStrictEqual(signatureFields(null, true), { id: "", name: "", body: "", html: false, isDefault: false });
assert.deepStrictEqual(signatureFields({ id: "s1", name: "Work", html: "<p>Hi</p>", text: "nope" }, true), {
  id: "s1",
  name: "Work",
  body: "<p>Hi</p>",
  html: true,
  isDefault: true,
});
assert.deepStrictEqual(signatureFields({ id: "s2", name: "Short", text: "— Ada" }, false), {
  id: "s2",
  name: "Short",
  body: "— Ada",
  html: false,
  isDefault: false,
});
const emptySignatures = {
  signatures: [],
  defaultSignatureId: null,
  defaultSignaturePerAccount: {},
};
assert.deepStrictEqual(mailbox.answer("mail:listSignatures", [{ accountId: "gmail-ada" }]).data, emptySignatures);
assert.strictEqual(mailbox.answer("mail:upsertSignature", [{ text: "Hi" }]).error.code, "invalid");
assert.strictEqual(mailbox.answer("mail:upsertSignature", [{ name: "  ", text: "Hi" }]).error.code, "invalid");
assert.strictEqual(mailbox.answer("mail:upsertSignature", [{ name: "Work", text: "  ", html: "" }]).error.code, "invalid");
assert.strictEqual(mailbox.answer("mail:upsertSignature", [{ name: "Work", text: 1 }]).error.code, "invalid");
assert.strictEqual(mailbox.answer("mail:deleteSignature", [{}]).error.code, "not-found");
const createdSignature = mailbox.answer("mail:upsertSignature", [{
  name: " Work ",
  text: "Thanks,\nAda",
  isDefault: true,
}]);
assert.strictEqual(createdSignature.success, true);
assert.strictEqual(createdSignature.data.name, "Work");
assert.strictEqual(createdSignature.data.text, "Thanks,\nAda");
assert.strictEqual(createdSignature.data.html, undefined);
const createdSignatureId = createdSignature.data.id;
const listedSignatures = mailbox.answer("mail:listSignatures", [{ accountId: "gmail-ada" }]);
assert.strictEqual(listedSignatures.data.defaultSignatureId, createdSignatureId);
assert.deepStrictEqual(signatureRows(listedSignatures.data).map((row) => row.name), ["Work"]);
assert.strictEqual(chosenSignatureId(listedSignatures.data, "gmail-ada"), createdSignatureId);
listedSignatures.data.signatures[0].name = "mutated";
assert.strictEqual(mailbox.answer("mail:listSignatures", []).data.signatures[0].name, "Work");
const htmlSignature = mailbox.answer("mail:upsertSignature", [{
  id: createdSignatureId,
  name: "Work",
  html: "<p>Thanks,<br>Ada</p>",
  text: "ignored",
  isDefault: true,
}]);
assert.strictEqual(htmlSignature.success, true);
assert.strictEqual(htmlSignature.data.html, "<p>Thanks,<br>Ada</p>");
assert.strictEqual(htmlSignature.data.text, undefined);
assert.strictEqual(signaturePlain(htmlSignature.data), "Thanks,\nAda");
const textAgain = mailbox.answer("mail:upsertSignature", [{
  id: createdSignatureId,
  name: "Work",
  text: "Thanks,\nAda",
  isDefault: true,
}]);
assert.strictEqual(textAgain.success, true);
assert.strictEqual(textAgain.data.text, "Thanks,\nAda");
assert.strictEqual(textAgain.data.html, undefined);
const secondSignature = mailbox.answer("mail:upsertSignature", [{
  name: "Short",
  text: "— Ada",
  isDefault: true,
}]);
assert.strictEqual(secondSignature.success, true);
const bothSignatures = mailbox.answer("mail:listSignatures", [{ accountId: "outlook-grace" }]);
assert.deepStrictEqual(bothSignatures.data.signatures.map((row) => row.id), [createdSignatureId, secondSignature.data.id]);
assert.strictEqual(bothSignatures.data.defaultSignatureId, secondSignature.data.id);
assert.deepStrictEqual(bothSignatures.data.defaultSignaturePerAccount, {});
const keptDefault = mailbox.answer("mail:upsertSignature", [{
  id: createdSignatureId,
  name: "Work",
  text: "Thanks,\nAda",
  isDefault: false,
}]);
assert.strictEqual(keptDefault.success, true);
assert.strictEqual(mailbox.answer("mail:listSignatures", []).data.defaultSignatureId, secondSignature.data.id);
const clearedDefault = mailbox.answer("mail:upsertSignature", [{
  id: secondSignature.data.id,
  name: "Short",
  text: "— Ada",
  isDefault: false,
}]);
assert.strictEqual(clearedDefault.success, true);
assert.strictEqual(mailbox.answer("mail:listSignatures", []).data.defaultSignatureId, null);
const missingSignature = mailbox.answer("mail:upsertSignature", [{ id: "missing", name: "Nope", text: "x" }]);
assert.strictEqual(missingSignature.success, false);
assert.strictEqual(missingSignature.error.code, "not-found");
assert.strictEqual(mailbox.answer("mail:deleteSignature", [{ id: secondSignature.data.id }]).success, true);
assert.deepStrictEqual(mailbox.answer("mail:listSignatures", []).data.signatures.map((row) => row.id), [createdSignatureId]);
assert.strictEqual(mailbox.answer("mail:listSignatures", []).data.defaultSignatureId, null);
const deletedTwice = mailbox.answer("mail:deleteSignature", [{ id: secondSignature.data.id }]);
assert.strictEqual(deletedTwice.success, false);
assert.strictEqual(deletedTwice.error.code, "not-found");
assert.strictEqual(mailbox.answer("mail:upsertSignature", [{
  id: createdSignatureId,
  name: "Work",
  text: "Thanks,\nAda",
  isDefault: true,
}]).data.id, createdSignatureId);
assert.strictEqual(mailbox.answer("mail:deleteSignature", [{ id: createdSignatureId }]).success, true);
assert.deepStrictEqual(mailbox.answer("mail:listSignatures", []).data, emptySignatures);

for (const channel of [
  "mail:listSignatures",
  "mail:translateStart",
  "mail:translateCancel",
  "mail:translate:event",
]) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(appJs.includes('"Translate"') && appJs.includes('"Cancel"') && appJs.includes('"No signatures."'));
assert.ok(html.includes('id="signature"') && html.includes("No signatures."));
assert.ok(css.includes(".translate") && css.includes(".translation") && css.includes(".body p"));
for (const channel of ["mail:upsertSignature", "mail:deleteSignature"]) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(html.includes('id="signatures"') && html.includes('id="signature-name"') && html.includes('id="signature-body"'));
assert.ok(html.includes('id="signature-html"') && html.includes('id="signature-default"') && html.includes('id="signatures-open"'));
assert.ok(html.includes('id="signatures-from-compose"'));
assert.ok(html.includes("Sample signatures stay in memory"));
assert.ok(appJs.includes('"Add a name."') && appJs.includes('"Add signature text."'));
assert.ok(css.includes(".signature-row") && css.includes("#signatures-status") && css.includes("#signature-form textarea"));

const updateView = extractFunction(appJs, "updateView");
const idle = updateView({}, "0.1.0");
assert.strictEqual(idle.version, "0.1.0");
assert.strictEqual(idle.status, "Up to date.");
assert.strictEqual(idle.error, "");
assert.strictEqual(idle.install, false);
assert.strictEqual(idle.busy, false);
assert.strictEqual(updateView({ enabled: false }, "0.1.0").status, "Updater is off until the app is packaged.");
const failed = updateView({ error: "network", downloaded: true }, "");
assert.strictEqual(failed.status, "Update failed.");
assert.strictEqual(failed.error, "network");
assert.strictEqual(failed.install, false);
assert.strictEqual(updateView({ downloaded: true, version: "0.2.0" }, "0.1.0").status, "Update 0.2.0 ready.");
assert.strictEqual(updateView({ downloaded: true, version: "0.2.0" }, "0.1.0").install, true);
assert.strictEqual(updateView({ downloaded: true }, "").status, "Update ready.");
const downloading = updateView({ downloading: true, progress: 42.2 }, "");
assert.strictEqual(downloading.status, "Downloading 42%…");
assert.strictEqual(downloading.busy, true);
assert.strictEqual(downloading.install, false);
assert.strictEqual(updateView({ checking: true }, "").status, "Checking for updates…");
assert.strictEqual(updateView({ checking: true }, "").busy, true);
const installing = updateView({ installing: true, downloaded: true, version: "0.2.0" }, "");
assert.strictEqual(installing.status, "Installing…");
assert.strictEqual(installing.install, false);
assert.strictEqual(installing.busy, true);
assert.strictEqual(updateView({ available: true, version: "0.2.0" }, "").status, "Update 0.2.0 available.");
assert.strictEqual(updateView({ available: true }, "").status, "Update available.");
assert.strictEqual(updateView(null, 12).version, "");
assert.strictEqual(updateView(null, 12).status, "Up to date.");
assert.strictEqual(updateView({ downloading: true, progress: "nope" }, "").status, "Downloading 0%…");

const prefRows = extractFunction(appJs, "prefRows");
const readPref = extractFunction(appJs, "readPref");
const applyPref = extractFunction(appJs, "applyPref");
const control = { checked: false, value: "" };
applyPref("bool", control, true);
assert.strictEqual(readPref("bool", control), true);
applyPref("bool", control, false);
assert.strictEqual(readPref("bool", control), false);
applyPref("seconds", control, 0);
assert.strictEqual(readPref("seconds", control), 0);
applyPref("seconds", control, 30);
assert.strictEqual(readPref("seconds", control), 30);
control.value = "nope";
assert.strictEqual(readPref("seconds", control), "nope");
applyPref("text", control, "#7C3AED");
assert.strictEqual(readPref("text", control), "#7C3AED");
applyPref("select", control, "dark");
assert.strictEqual(readPref("select", control), "dark");
applyPref("text", control, null);
assert.strictEqual(control.value, "");
const ipcSrc = fs.readFileSync(path.join(root, "host/ipc.js"), "utf8");
const settingsSrc = fs.readFileSync(path.join(root, "host/settings.js"), "utf8");
const prefs = prefRows();
assert.strictEqual(prefs.length, 11);
const prefKinds = new Set();
for (const [id, getChannel, setChannel, kind] of prefs) {
  assert.ok(html.includes('id="' + id + '"'), `settings control missing ${id}`);
  assert.ok(registered.has(getChannel), `preload does not register ${getChannel}`);
  assert.ok(registered.has(setChannel), `preload does not register ${setChannel}`);
  assert.ok(used.has(getChannel) && used.has(setChannel), `renderer does not call ${setChannel}`);
  assert.ok(settingsSrc.includes('"' + getChannel + '"'), `settings store missing ${getChannel}`);
  assert.ok(settingsSrc.includes('"' + setChannel + '"'), `settings store missing ${setChannel}`);
  assert.ok(kind === "select" || kind === "text" || kind === "bool" || kind === "seconds");
  prefKinds.add(kind);
}
assert.ok(prefKinds.has("select") && prefKinds.has("text") && prefKinds.has("bool") && prefKinds.has("seconds"));
const settingsHtml = html.slice(html.indexOf('id="settings"'), html.indexOf("</dialog>", html.indexOf('id="settings"')));
assert.ok(settingsHtml.includes("<select") && settingsHtml.includes('type="checkbox"') && settingsHtml.includes('type="number"'));
assert.ok(settingsHtml.includes('id="ai-base"') && settingsHtml.includes('id="ai-model"') && settingsHtml.includes('id="ai-key"'));
assert.ok(settingsHtml.includes('type="password"') && settingsHtml.includes('list="ai-model-list"'));
assert.ok(settingsHtml.includes("Save AI") && settingsHtml.includes("Fetch models") && settingsHtml.includes("Test connection"));
assert.ok(settingsHtml.includes("saved config"));
for (const channel of ["host:aiGetConfig", "host:aiSaveConfig", "host:aiTest", "host:aiListModels"]) {
  assert.ok(appJs.includes('"' + channel + '"'), channel);
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(main.split('"' + channel + '"').length - 1 >= 2, channel + " must be listed and handled");
}
assert.ok(main.includes("[...updater.CHANNELS, ...AI_CHANNELS]"));
assert.ok(!settingsSrc.includes("apiKey"));
const settingsCall = ipcSrc.indexOf("settingsAnswer(channel, args)");
const overrideCall = ipcSrc.indexOf("hasOwnProperty.call(OVERRIDES, channel)");
assert.ok(ipcSrc.includes('require("./settings")'));
assert.ok(settingsCall > 0 && settingsCall < overrideCall);
assert.ok(settingsCall < ipcSrc.indexOf("/Effective$|Enabled$/"));
assert.ok(!ipcSrc.includes('"config:getTheme"'));
for (const channel of [
  "genmail:configGetAiWriteAutoOpenOnReply",
  "genmail:configGetShowFolderChips",
  "genmail:configGetShowOneClickTidy",
  "genmail:configGetSidebarGmailFoldersExpanded",
  "genmail:configGetSidebarOutlookFoldersExpanded",
]) {
  assert.ok(!ipcSrc.includes('"' + channel + '"'), channel + " still stubbed in ipc");
}
checkSettingsRoundTrip();

function checkSettingsRoundTrip() {
  const os = require("os");
  const prev = {
    GENMAIL_USER_DATA: process.env.GENMAIL_USER_DATA,
    GENMAIL_MAIL_DIR: process.env.GENMAIL_MAIL_DIR,
    GENMAIL_AI_CONFIG_DIR: process.env.GENMAIL_AI_CONFIG_DIR,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genmail-settings-"));
  process.env.GENMAIL_USER_DATA = dir;
  delete process.env.GENMAIL_MAIL_DIR;
  delete process.env.GENMAIL_AI_CONFIG_DIR;
  try {
    const { answer } = require("../host/settings");
    const file = path.join(dir, "settings.json");
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(answer("config:getTheme", []), "light");
    assert.strictEqual(answer("genmail:configGetAccent", []), "#7C3AED");
    assert.strictEqual(answer("genmail:configGetConversationViewEnabled", []), true);
    assert.strictEqual(answer("genmail:configGetAutoLoadRemoteImages", []), false);
    assert.strictEqual(answer("genmail:configGetUndoSendDelaySeconds", []), 5);
    assert.strictEqual(answer("genmail:configGetSnoozeEffective", []), true);
    assert.strictEqual(answer("genmail:configGetAiWriteAutoOpenOnReply", []), false);
    assert.strictEqual(answer("genmail:configGetShowFolderChips", []), true);
    assert.strictEqual(answer("genmail:configGetShowOneClickTidy", []), false);
    assert.strictEqual(answer("genmail:configGetSidebarGmailFoldersExpanded", []), true);
    assert.strictEqual(answer("genmail:configGetSidebarOutlookFoldersExpanded", []), false);
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(answer("config:setTheme", ["dark"]), "dark");
    assert.strictEqual(answer("genmail:configSetAccent", ["#112233"]), "#112233");
    assert.strictEqual(answer("genmail:configSetConversationViewEnabled", [false]), false);
    assert.strictEqual(answer("genmail:configSetAutoLoadRemoteImages", [true]), true);
    assert.strictEqual(answer("genmail:configSetUndoSendDelaySeconds", [0]), 0);
    assert.strictEqual(answer("genmail:configSetSnoozeEffective", [false]), false);
    assert.strictEqual(answer("genmail:configSetAiWriteAutoOpenOnReply", [true]), true);
    assert.strictEqual(answer("genmail:configSetShowFolderChips", [false]), false);
    assert.strictEqual(answer("genmail:configSetShowOneClickTidy", [true]), true);
    assert.strictEqual(answer("genmail:configSetSidebarGmailFoldersExpanded", [false]), false);
    assert.strictEqual(answer("genmail:configSetSidebarOutlookFoldersExpanded", [true]), true);
    assert.strictEqual(answer("config:getTheme", []), "dark");
    assert.strictEqual(answer("genmail:configGetAccent", []), "#112233");
    assert.strictEqual(answer("genmail:configGetConversationViewEnabled", []), false);
    assert.strictEqual(answer("genmail:configGetAutoLoadRemoteImages", []), true);
    assert.strictEqual(answer("genmail:configGetUndoSendDelaySeconds", []), 0);
    assert.strictEqual(answer("genmail:configGetSnoozeEffective", []), false);
    assert.strictEqual(answer("genmail:configGetAiWriteAutoOpenOnReply", []), true);
    assert.strictEqual(answer("genmail:configGetShowFolderChips", []), false);
    assert.strictEqual(answer("genmail:configGetShowOneClickTidy", []), true);
    assert.strictEqual(answer("genmail:configGetSidebarGmailFoldersExpanded", []), false);
    assert.strictEqual(answer("genmail:configGetSidebarOutlookFoldersExpanded", []), true);
    assert.strictEqual(answer("genmail:configSetAccent", ["#abcdef"]), "#ABCDEF");
    const reloaded = spawnSync(process.execPath, ["-e", `
      const { answer } = require(${JSON.stringify(path.join(root, "host/settings.js"))});
      process.stdout.write(JSON.stringify({
        theme: answer("config:getTheme", []),
        accent: answer("genmail:configGetAccent", []),
        conversation: answer("genmail:configGetConversationViewEnabled", []),
        images: answer("genmail:configGetAutoLoadRemoteImages", []),
        undo: answer("genmail:configGetUndoSendDelaySeconds", []),
        snooze: answer("genmail:configGetSnoozeEffective", []),
        aiReply: answer("genmail:configGetAiWriteAutoOpenOnReply", []),
        chips: answer("genmail:configGetShowFolderChips", []),
        tidy: answer("genmail:configGetShowOneClickTidy", []),
        gmailFolders: answer("genmail:configGetSidebarGmailFoldersExpanded", []),
        outlookFolders: answer("genmail:configGetSidebarOutlookFoldersExpanded", []),
      }));
    `], { encoding: "utf8" });
    assert.strictEqual(reloaded.status, 0, reloaded.stderr);
    assert.deepStrictEqual(JSON.parse(reloaded.stdout), {
      theme: "dark",
      accent: "#ABCDEF",
      conversation: false,
      images: true,
      undo: 0,
      snooze: false,
      aiReply: true,
      chips: false,
      tidy: true,
      gmailFolders: false,
      outlookFolders: true,
    });
    assert.throws(() => answer("config:setTheme", ["neon"]), /light or dark/);
    assert.strictEqual(answer("config:getTheme", []), "dark");
    assert.throws(() => answer("genmail:configSetAccent", ["purple"]), /#RRGGBB/);
    assert.strictEqual(answer("genmail:configGetAccent", []), "#ABCDEF");
    assert.throws(() => answer("genmail:configSetUndoSendDelaySeconds", [31]), /0 to 30/);
    assert.strictEqual(answer("genmail:configGetUndoSendDelaySeconds", []), 0);
    assert.throws(() => answer("genmail:configSetSnoozeEffective", ["yes"]), /on or off/);
    assert.strictEqual(answer("genmail:configGetSnoozeEffective", []), false);
    assert.throws(() => answer("genmail:configSetShowFolderChips", ["yes"]), /on or off/);
    assert.strictEqual(answer("genmail:configGetShowFolderChips", []), false);
    fs.writeFileSync(file, "{");
    assert.strictEqual(answer("config:getTheme", []), "light");
    assert.strictEqual(answer("config:setTheme", ["dark"]), "dark");
    assert.strictEqual(answer("config:getTheme", []), "dark");
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

for (const channel of ["host:updateGetState", "host:updateCheck", "host:updateInstall"]) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(main.includes("directHost.has(channel)"), "attachIpc would register updater channels twice");
const updaterSrc = fs.readFileSync(path.join(root, "host/updater.js"), "utf8");
assert.ok(updaterSrc.includes("CHANNELS"));
for (const channel of ["host:updateGetState", "host:updateCheck", "host:updateInstall"]) {
  const count = updaterSrc.split('"' + channel + '"').length - 1;
  assert.ok(count >= 2, channel + " must be registered and listed");
}
assert.ok(html.includes('id="updates"') && html.includes('id="update-check"') && html.includes('id="update-install"'));
assert.ok(html.includes("Check for updates") && html.includes(">Install<"));
assert.ok(html.includes('id="settings"') && html.includes('id="prefs"') && html.includes("AI Setup"));
assert.ok(css.includes("#updates") && css.includes("#prefs") && css.includes("#settings-status"));

const timing = loadFunctions(appJs, ["snoozeUntil", "scheduleAt"]);
const laterAfternoon = new Date("2026-10-16T15:00:00");
assert.strictEqual(timing.scheduleAt("1h", "", laterAfternoon).getTime(), snoozeUntil("1h", laterAfternoon).getTime());
assert.strictEqual(timing.scheduleAt("tonight", "", laterAfternoon).getHours(), 18);
assert.strictEqual(timing.scheduleAt("morning", "", laterAfternoon).getHours(), 8);
const picked = timing.scheduleAt("custom", "2026-10-17T09:30", laterAfternoon);
assert.strictEqual(picked.getFullYear(), 2026);
assert.strictEqual(picked.getMonth(), 9);
assert.strictEqual(picked.getDate(), 17);
assert.strictEqual(picked.getHours(), 9);
assert.strictEqual(picked.getMinutes(), 30);
assert.strictEqual(timing.scheduleAt("custom", "2026-10-16T14:00", laterAfternoon), null);
assert.strictEqual(timing.scheduleAt("custom", "", laterAfternoon), null);
assert.strictEqual(timing.scheduleAt("custom", "nope", laterAfternoon), null);
assert.strictEqual(timing.scheduleAt("nope", "", laterAfternoon), null);

const scheduledRows = extractFunction(appJs, "scheduledRows");
const scheduledLine = extractFunction(appJs, "scheduledLine");
assert.deepStrictEqual(scheduledRows(null), []);
assert.deepStrictEqual(scheduledRows({ records: [] }), []);
assert.deepStrictEqual(scheduledRows([{ id: "a" }, null, { subject: "no id" }]).map((row) => row.id), ["a"]);
const line = scheduledLine({ subject: "Hi", to: "ada@example.com", sendAt: "2026-10-17T09:30:00" });
assert.ok(line.includes("Hi") && line.includes("ada@example.com"));
assert.strictEqual(scheduledLine({ subject: "  ", to: "" }), "(no subject)");
assert.strictEqual(scheduledLine({ subject: "Hi", to: ["ada@example.com", "grace@example.com"] }).includes("ada@example.com, grace@example.com"), true);

const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
assert.deepStrictEqual(mailbox.answer("mail:listScheduled").data, []);
const first = mailbox.answer("mail:scheduleSend", [{
  accountId: "gmail-ada",
  to: "grace@example.com",
  subject: "Later",
  sendAt: future,
}]);
assert.strictEqual(first.success, true);
assert.ok(first.data.id);
const second = mailbox.answer("mail:scheduleSend", [{
  accountId: "outlook-grace",
  to: ["ada@example.com"],
  subject: "Also later",
  sendAt: future,
}]);
assert.strictEqual(second.success, true);
assert.strictEqual(second.data.to, "ada@example.com");
const bare = mailbox.answer("mail:scheduleSend", [{
  accountId: "gmail-ada",
  to: "grace@example.com",
  sendAt: future,
}]);
assert.strictEqual(bare.success, true);
assert.strictEqual(bare.data.subject, "");
const adaScheduled = mailbox.answer("mail:listScheduled", [{ accountId: "gmail-ada" }]);
assert.strictEqual(adaScheduled.success, true);
assert.deepStrictEqual(adaScheduled.data.map((row) => row.subject), ["Later", ""]);
assert.strictEqual(adaScheduled.data[0].to, "grace@example.com");
assert.strictEqual(adaScheduled.data[0].sendAt, future);
assert.strictEqual(mailbox.answer("mail:listScheduled", [{ accountId: "outlook-grace" }]).data.length, 1);
assert.strictEqual(mailbox.answer("mail:listScheduled", [{}]).data.length, 3);
const pastSend = mailbox.answer("mail:scheduleSend", [{
  accountId: "gmail-ada",
  to: "grace@example.com",
  sendAt: new Date(Date.now() - 1000).toISOString(),
}]);
assert.strictEqual(pastSend.success, false);
assert.strictEqual(pastSend.error.code, "send_at_in_past");
const nobodySend = mailbox.answer("mail:scheduleSend", [{
  accountId: "gmail-ada",
  to: "  ",
  sendAt: future,
}]);
assert.strictEqual(nobodySend.success, false);
assert.strictEqual(nobodySend.error.code, "invalid");
assert.strictEqual(mailbox.answer("mail:scheduleSend", [{ accountId: "gmail-ada", to: "a@b.c" }]).success, false);
assert.strictEqual(mailbox.answer("mail:listScheduled").data.length, 3);

const engineSrc = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
assert.ok(engineSrc.includes('case "mail:scheduleSend"'));
assert.ok(engineSrc.includes('case "mail:listScheduled"'));
assert.ok(engineSrc.includes("imap_schedule_send_unsupported"));
assert.ok(engineSrc.indexOf("if (sidecar.handles(channel))") < engineSrc.indexOf("if (!db.hasAccounts())"));
assert.ok(engineSrc.includes('case "mail:upsertSignature"'));
assert.ok(engineSrc.includes('case "mail:deleteSignature"'));
assert.ok(engineSrc.includes("imap_signatures_unsupported"));
for (const name of ["mail:cancelScheduled", "mail:deleteScheduled", "mail:unschedule", "mail:cancelScheduleSend"]) {
  assert.ok(!engineSrc.includes(name), `${name} appeared`);
  assert.ok(!appJs.includes(name), `renderer calls ${name}`);
}
for (const channel of ["mail:scheduleSend", "mail:listScheduled"]) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(appJs.includes("Nothing scheduled."));
assert.ok(html.includes('id="schedule-preset"') && html.includes('id="schedule-at"') && html.includes('id="compose-schedule"') && html.includes('id="scheduled"'));
assert.ok(html.includes("Schedule send") && html.includes("In 1 hour") && html.includes("Pick a time") && html.includes("Tomorrow morning"));
assert.ok(css.includes("#scheduled") && css.includes("#compose textarea") && css.includes("max-height: calc(100vh - 32px)"));
assert.ok(css.includes("[hidden] { display: none !important; }"));

const compose = loadFunctions(appJs, [
  "people",
  "readable",
  "addressRows",
  "replyAddresses",
  "prefixedSubject",
  "quoteBlock",
  "replyBody",
  "attachmentNote",
  "forwardBody",
  "composeSeed",
]);
const ada = "ada.lovelace@example.com";
const engineMail = mailbox.answer("mail:openEmail", [{ emailId: "m-engine" }]).data.email;
assert.deepStrictEqual(engineMail.cc, ["Mary Somerville <mary@example.com>"]);
const reply = compose.composeSeed(engineMail, "reply", ada);
assert.strictEqual(reply.title, "Reply");
assert.strictEqual(reply.aiWrite, true);
assert.strictEqual(reply.to, "Charles Babbage <charles@example.com>");
assert.strictEqual(reply.subject, "Re: Notes on the Analytical Engine");
assert.ok(reply.body.includes("Charles Babbage <charles@example.com> wrote:"));
assert.ok(reply.body.includes("> The table of operations is ready for a second reading."));
assert.ok(!reply.body.includes("mary@example.com"));
assert.strictEqual(reply.threadId, "m-engine");
assert.strictEqual(reply.inReplyTo, undefined);
const replyAll = compose.composeSeed(engineMail, "all", ada);
assert.strictEqual(replyAll.title, "Reply All");
assert.strictEqual(replyAll.aiWrite, true);
assert.strictEqual(opensAiWrite(replyAll, { aiReply: true }), true);
assert.strictEqual(opensAiWrite(reply, { aiReply: false }), false);
assert.strictEqual(replyAll.to, "Charles Babbage <charles@example.com>, Mary Somerville <mary@example.com>");
assert.ok(!replyAll.to.toLowerCase().includes(ada));
assert.ok(!compose.replyAddresses(engineMail, "Ada Lovelace <ada.lovelace@example.com>", true).toLowerCase().includes(ada));
const own = mailbox.answer("mail:openEmail", [{ emailId: "m-compiler-2" }]).data.email;
assert.strictEqual(compose.composeSeed(own, "reply", ada).to, "Grace Hopper <grace.hopper@example.com>");
assert.strictEqual(compose.composeSeed(own, "reply", ada).subject, "Re: A compiler is just another program");
assert.strictEqual(
  compose.replyAddresses(own, ada, true),
  compose.replyAddresses(own, ada, false),
);
const compiler = mailbox.answer("mail:openEmail", [{ emailId: "m-compiler" }]).data.email;
const forwarded = compose.composeSeed(compiler, "forward", ada);
assert.strictEqual(forwarded.to, "");
assert.strictEqual(forwarded.aiWrite, undefined);
assert.strictEqual(opensAiWrite(forwarded, { aiReply: true }), false);
assert.strictEqual(forwarded.subject, "Fwd: A compiler is just another program");
assert.ok(forwarded.body.includes("---------- Forwarded message ----------"));
assert.ok(forwarded.body.includes("From: Grace Hopper <grace.hopper@example.com>"));
assert.ok(forwarded.body.includes("Once the machine can read its own instructions, the rest follows."));
assert.ok(forwarded.body.includes("Attachments: notes.txt"));
assert.strictEqual(forwarded.inReplyTo, undefined);
assert.strictEqual(forwarded.threadId, undefined);
assert.ok(!Object.hasOwn(forwarded, "attachments"));
assert.strictEqual(compose.prefixedSubject("Re: Already", "Re:"), "Re: Already");
assert.strictEqual(compose.prefixedSubject("FW: Already", "Fwd:"), "FW: Already");
assert.strictEqual(compose.prefixedSubject("Re: Keep", "Fwd:"), "Fwd: Re: Keep");
assert.strictEqual(compose.prefixedSubject("", "Re:"), "Re:");
assert.strictEqual(compose.prefixedSubject("Regarding this", "Re:"), "Re: Regarding this");
const htmlReply = compose.composeSeed({
  from: "Charles Babbage <charles@example.com>",
  subject: "Notes",
  htmlBody: "<p>Ready &amp; waiting.</p><p>Second line</p>",
  messageId: "<abc@example.com>",
  threadId: "t-notes",
}, "reply", ada);
assert.ok(htmlReply.body.includes("> Ready & waiting."));
assert.ok(htmlReply.body.includes("> Second line"));
assert.ok(!htmlReply.body.includes("<p>"));
assert.strictEqual(htmlReply.inReplyTo, "<abc@example.com>");
assert.strictEqual(htmlReply.threadId, "t-notes");
assert.strictEqual(compose.composeSeed({
  from: "Lovelace, Ada <ada.lovelace@example.com>",
  to: ["Grace Hopper <grace.hopper@example.com>"],
  subject: "Sent",
  textBody: "See you",
}, "reply", ada).to, "Grace Hopper <grace.hopper@example.com>");
const namedOnly = compose.composeSeed({
  from: "A <a@b.c>",
  subject: "File",
  textBody: "See attached",
  hasAttachments: true,
}, "forward", "");
assert.ok(namedOnly.body.includes("This message has attachments."));
assert.ok(!namedOnly.body.includes("Attachments:"));
assert.strictEqual(compose.attachmentNote({ attachments: [{ id: "x" }] }), "Attachments: attachment");
assert.strictEqual(compose.composeSeed({ subject: "Hi" }, "reply", ada).to, "");
assert.strictEqual(compose.composeSeed({ subject: "Hi" }, "forward", ada).body.includes("Forwarded message"), true);
const scheduledReply = mailbox.answer("mail:scheduleSend", [{
  accountId: "gmail-ada",
  to: reply.to,
  subject: reply.subject,
  sendAt: future,
  threadId: reply.threadId,
}]);
assert.strictEqual(scheduledReply.success, true);
assert.strictEqual(scheduledReply.data.subject, "Re: Notes on the Analytical Engine");
assert.strictEqual(scheduledReply.data.to, reply.to);
assert.strictEqual(mailbox.answer("mail:upsertDraft", [{
  accountId: "gmail-ada",
  to: reply.to,
  subject: reply.subject,
  body: "<p>Thanks</p>",
  threadId: reply.threadId,
}]).success, true);
assert.strictEqual(mailbox.answer("mail:send", [{
  accountId: "gmail-ada",
  to: reply.to,
  subject: reply.subject,
  body: "<p>Thanks</p>",
  threadId: reply.threadId,
}]).success, true);
assert.strictEqual(mailbox.answer("mail:scheduleSend", [{
  accountId: "gmail-ada",
  to: "",
  subject: forwarded.subject,
  sendAt: future,
}]).success, false);
assert.ok(appJs.includes('readerButton("reply"') && appJs.includes('readerButton("reply-all"') && appJs.includes('readerButton("forward"'));
assert.ok(appJs.includes("inReplyTo") && appJs.includes("threadId"));
for (const channel of ["mail:reply", "mail:forward"]) {
  assert.ok(!appJs.includes(channel), `renderer invented ${channel}`);
  assert.ok(!preload.includes(channel), `preload registers ${channel}`);
}

const ai = loadFunctions(appJs, [
  "readable",
  "withSuggestion",
  "suggestionItems",
  "suggestionEmail",
  "draftBlockReason",
  "draftInstruction",
  "draftBase",
  "shownDraft",
  "htmlChunkToText",
  "applyDraftEvent",
]);
assert.strictEqual(ai.draftBlockReason("custom", "  ", "Hello"), "Add a prompt.");
assert.strictEqual(ai.draftBlockReason("rewrite", "", "  "), "Add some text, or a prompt.");
assert.strictEqual(ai.draftBlockReason("continue", "go on", ""), "");
assert.strictEqual(ai.draftBlockReason("rewrite", "", "Hello"), "");
assert.deepStrictEqual(ai.draftInstruction("rewrite", " shorter ", "Hello", "Hi"), {
  mode: "rewrite",
  user_prompt: "shorter",
  existing_draft_content: "Hello",
  subject: "Hi",
});
assert.strictEqual(ai.draftBase("continue", "Hello"), "Hello");
assert.strictEqual(ai.draftBase("rewrite", "Hello"), "");
assert.strictEqual(ai.draftBase("custom", "Hello"), "");
assert.strictEqual(ai.shownDraft({ pending: true, text: "", base: "", previous: "Hello" }), "Hello");
assert.strictEqual(ai.shownDraft({ pending: true, text: "Hi", base: "", previous: "Hello" }), "Hi");
assert.strictEqual(ai.shownDraft({ pending: false, text: "", base: "", previous: "Hello", error: "no key" }), "Hello");
assert.strictEqual(ai.shownDraft({ pending: true, text: " more", base: "Hello", previous: "Hello" }), "Hello more");
assert.strictEqual(ai.shownDraft(null), "");
assert.strictEqual(ai.htmlChunkToText("Hi<br>there"), "Hi\nthere");
assert.strictEqual(ai.htmlChunkToText("A &amp; B &lt;tag&gt;"), "A & B <tag>");
const streamed = { reqId: "d", pending: true, error: "", text: "", base: "Keep\n" };
ai.applyDraftEvent(streamed, { reqId: "other", type: "chunk", data: "nope" });
ai.applyDraftEvent(streamed, { reqId: "d", type: "chunk", data: "Hi &amp; you<br>" });
ai.applyDraftEvent(streamed, { reqId: "d", type: "chunk", data: "Next" });
assert.strictEqual(streamed.base + streamed.text, "Keep\nHi & you\nNext");
assert.strictEqual(streamed.pending, true);
ai.applyDraftEvent(streamed, { reqId: "d", type: "done" });
assert.strictEqual(streamed.pending, false);
ai.applyDraftEvent(streamed, { reqId: "d", type: "chunk", data: "late" });
assert.strictEqual(streamed.text.endsWith("Next"), true);
const failedDraft = { reqId: "d", pending: true, error: "", text: "Hi", base: "" };
ai.applyDraftEvent(failedDraft, { reqId: "d", type: "error", message: "Add an API key in GenMail → AI Setup." });
assert.strictEqual(failedDraft.pending, false);
assert.strictEqual(failedDraft.error, "Add an API key in GenMail → AI Setup.");
assert.strictEqual(failedDraft.text, "Hi");
ai.applyDraftEvent(failedDraft, { reqId: "d", type: "chunk", data: "more" });
assert.strictEqual(failedDraft.text, "Hi");
assert.deepStrictEqual(ai.suggestionItems({ suggestions: [" Thanks ", "", "Ask"] }), ["Thanks", "Ask"]);
assert.deepStrictEqual(ai.suggestionItems(null), []);
assert.deepStrictEqual(ai.suggestionItems({ suggestions: "nope" }), []);
const suggestMail = ai.suggestionEmail({
  subject: "Notes",
  from: "Ada <ada@example.com>",
  snippet: "short",
  textBody: "longer",
  htmlBody: "<p>Ready &amp; waiting.</p>",
});
assert.strictEqual(suggestMail.subject, "Notes");
assert.strictEqual(suggestMail.snippet, "short");
assert.strictEqual(suggestMail.text_body, "Ready & waiting.");
const suggested = ai.withSuggestion(compose.composeSeed({
  from: "Charles Babbage <charles@example.com>",
  subject: "Notes",
  textBody: "See you",
}, "reply", "ada.lovelace@example.com"), "Thanks, I'll read it.");
assert.strictEqual(suggested.title, "Reply");
assert.strictEqual(suggested.to, "Charles Babbage <charles@example.com>");
assert.ok(suggested.body.startsWith("Thanks, I'll read it.\n\n"));
assert.ok(suggested.body.includes("> See you"));
assert.strictEqual(ai.withSuggestion(suggested, "  "), suggested);
for (const channel of [
  "aiDraftWrite:start",
  "aiDraftWrite:cancel",
  "aiDraftWrite:replySuggestions",
  "aiDraftWrite:event",
]) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(html.includes('id="ai-mode"') && html.includes('id="ai-prompt"') && html.includes('id="ai-generate"') && html.includes('id="ai-cancel"'));
assert.ok(html.includes(">Generate<") && html.includes(">Cancel<") && html.includes(">Rewrite<") && html.includes(">Continue<") && html.includes(">Custom<"));
assert.ok(appJs.includes("Suggesting replies…") && appJs.includes('"Add a prompt."'));
assert.ok(css.includes(".ai-write") && css.includes(".suggestions") && css.includes(".suggest-list"));
assert.ok(fs.readFileSync(path.join(root, "docs/PARITY_SHELL.md"), "utf8").includes("aiDraftWrite:replySuggestions"));

const brainUi = loadFunctions(appJs, [
  "brainSections",
  "brainUserRules",
  "brainRowText",
  "brainMessage",
  "brainProfileMeta",
  "brainLearnedRow",
  "brainPaneIds",
  "brainRefreshChannels",
  "blankCategory",
  "categoryLine",
  "readCategoryPayload",
  "upsertCategory",
  "removeCategory",
  "categoryFromCommand",
  "categoryFromFix",
  "defaultCategoryHint",
  "brainSkillLists",
  "skillIdOf",
  "skillResultMessage",
]);
assert.deepStrictEqual(brainUi.brainSections(null), []);
assert.deepStrictEqual(brainUi.brainSections({ persona: {} }), []);
assert.deepStrictEqual(brainUi.brainUserRules(null), []);
assert.deepStrictEqual(brainUi.brainUserRules([{
  rows: [
    { id: "how-you-write:user:1", value: "Short", source: "user" },
    { id: "how-you-write:0", value: "Auto", source: "auto" },
    { value: "No id", source: "user" },
  ],
}]).map((row) => row.id), ["how-you-write:user:1"]);
assert.strictEqual(brainUi.brainRowText({ label: "Tone", value: "Warm" }), "Tone — Warm");
assert.strictEqual(brainUi.brainRowText({ value: "Short" }), "Short");
assert.strictEqual(brainUi.brainRowText(null), "");
assert.strictEqual(brainUi.brainMessage(null).text, "");
assert.strictEqual(brainUi.brainMessage({ accepted: false }).text, "Needs an AI key. Open GenMail → AI Setup.");
assert.strictEqual(brainUi.brainMessage({ accepted: false }).error, true);
assert.strictEqual(brainUi.brainMessage({ fixing: true }).text, "Fixing…");
assert.deepStrictEqual(brainUi.brainProfileMeta(null), []);
assert.deepStrictEqual(brainUi.brainProfileMeta({
  persona: { profile: { meta: { ownerName: " Ada ", emailsAnalyzed: 3, factsLearned: 2, updatedAt: "2026-01-01T00:00:00.000Z" } } },
}).map((row) => row.key), ["ownerName", "emailsAnalyzed", "factsLearned", "updatedAt"]);
assert.strictEqual(brainUi.brainProfileMeta({ persona: { profile: { meta: { ownerName: "Ada", emailsAnalyzed: "3" } } } })[0].key, "ownerName");
assert.strictEqual(brainUi.brainLearnedRow({ id: "how-you-write" }, { id: "how-you-write:0", source: "auto" }), true);
assert.strictEqual(brainUi.brainLearnedRow({ id: "priorities" }, { id: "priorities:0", source: "learned" }), true);
assert.strictEqual(brainUi.brainLearnedRow({ id: "ai-setup" }, { id: "ai-setup:0", source: "auto" }), false);
assert.strictEqual(brainUi.brainLearnedRow({ id: "recent-mail" }, { id: "recent-mail:0", source: "auto" }), false);
assert.strictEqual(brainUi.brainLearnedRow({ id: "how-you-write" }, { id: "how-you-write:user:1", source: "user" }), false);
assert.deepStrictEqual(brainUi.brainPaneIds().map((row) => row[0]), ["profile", "categories", "skills"]);
assert.strictEqual(brainUi.brainMessage({ error: "host down", accepted: false }).text, "host down");
assert.strictEqual(brainUi.brainMessage({ refreshing: true }).text, "Refreshing…");
assert.strictEqual(brainUi.brainMessage({ rebuilding: true, percent: 15, refreshing: true }).text, "Rebuilding 15%…");
assert.strictEqual(brainUi.brainMessage({ accepted: true }).text, "");
assert.deepStrictEqual(brainUi.brainRefreshChannels(), ["emailBrain:refresh", "emailBrain:rebuild"]);
assert.strictEqual(brainUi.blankCategory({ name: "  News ", description: "  d".repeat(250), collapseView: "yes" }, 3).name, "News");
assert.strictEqual(brainUi.blankCategory({ name: "n".repeat(90), description: "d".repeat(500), collapseView: true }, 0).name.length, 80);
assert.strictEqual(brainUi.blankCategory({ description: "d".repeat(500) }, 0).description.length, 400);
assert.strictEqual(brainUi.blankCategory({ description: "d".repeat(500) }, 0).collapseView, false);
assert.strictEqual(brainUi.blankCategory({ id: "cat-news", name: "News", collapseView: true }, 0).collapseView, true);
assert.strictEqual(brainUi.blankCategory(null, 0).id, "cat-1");
assert.strictEqual(brainUi.categoryLine({ id: "cat-primary", name: "Primary", description: "People", collapseView: false }), "cat-primary — Primary — People — shown");
assert.strictEqual(brainUi.categoryLine({ id: "cat-updates", name: "Updates", description: "Receipts", collapseView: true }), "cat-updates — Updates — Receipts — collapsed");
const categoryPayload = brainUi.readCategoryPayload({
  categories: [{ id: "cat-a", name: "A", description: "", collapseView: false }],
  defaultCategories: [{ id: "cat-primary", name: "Primary", description: "People", collapseView: false }],
});
assert.strictEqual(categoryPayload.categories[0].id, "cat-a");
assert.strictEqual(brainUi.defaultCategoryHint(categoryPayload.defaults), "Defaults: Primary.");
assert.strictEqual(brainUi.defaultCategoryHint([]), "");
assert.deepStrictEqual(brainUi.readCategoryPayload(null), { categories: [], defaults: [] });
assert.strictEqual(brainUi.readCategoryPayload([{ id: "cat-b", name: "B" }]).categories[0].name, "B");
const categoryAdded = brainUi.upsertCategory([], { id: "cat-news", name: "News", description: "Headlines", collapseView: true }, -1);
assert.strictEqual(categoryAdded.error, "");
assert.strictEqual(categoryAdded.categories[0].collapseView, true);
assert.strictEqual(brainUi.upsertCategory([], { name: "  " }, -1).error, "A category needs a name.");
const categoryEdited = brainUi.upsertCategory(categoryAdded.categories, { name: "Briefs", description: "Short", collapseView: false }, 0);
assert.strictEqual(categoryEdited.categories[0].id, "cat-news");
assert.strictEqual(categoryEdited.categories[0].name, "Briefs");
assert.strictEqual(categoryEdited.categories[0].collapseView, false);
assert.deepStrictEqual(brainUi.removeCategory(categoryEdited.categories, 0), []);
assert.strictEqual(brainUi.removeCategory(categoryEdited.categories, 4).length, 1);
assert.strictEqual(brainUi.categoryFromCommand({ command: { kind: "add_category", name: "Social", description: "Notes", collapseView: true } }).name, "Social");
assert.strictEqual(brainUi.categoryFromCommand({ command: { kind: "add_category", name: "  " } }), null);
assert.strictEqual(brainUi.categoryFromCommand({ command: { kind: "nope", name: "Social" } }), null);
assert.strictEqual(brainUi.categoryFromCommand(null), null);
assert.strictEqual(brainUi.categoryFromFix(null), null);
assert.strictEqual(brainUi.categoryFromFix({ category: { name: "  " } }), null);
assert.strictEqual(brainUi.categoryFromFix({ category: { id: "needs-you", name: "Needs you", description: "Reply", collapseView: true } }).collapseView, true);
for (const channel of [
  "emailBrain:getCached",
  "emailBrain:refresh",
  "emailBrain:rebuild",
  "emailBrain:addWritingRule",
  "emailBrain:setWritingRule",
  "emailBrain:deleteWritingRule",
  "emailBrain:fixItem",
  "emailBrain:forgetItem",
  "emailBrain:getCategories",
  "emailBrain:saveCategories",
  "emailBrain:addCategoryViaPrompt",
  "emailBrain:fixCategory",
  "emailBrain:getSkills",
  "emailBrain:getLibrarySkills",
  "emailBrain:runSkill",
  "emailBrain:updated",
  "emailBrain:refreshState",
  "emailBrain:rebuildState",
]) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(html.includes('id="brain"') && html.includes('id="brain-rule"') && html.includes('id="brain-add"') && html.includes('id="brain-refresh"') && html.includes('id="brain-rebuild"'));
assert.ok(html.includes('id="brain-tab-profile"') && html.includes('id="brain-tab-categories"') && html.includes('id="brain-tab-skills"') && html.includes('id="brain-meta"'));
assert.ok(html.includes(">Profile<") && html.includes(">Categories<") && html.includes(">Skills<"));
assert.ok(html.includes(">Brain<") && html.includes(">Add<") && html.includes("Writing rule"));
assert.ok(html.includes('id="brain-category-list"') && html.includes('id="brain-category-name"') && html.includes('id="brain-category-description"'));
assert.ok(html.includes('id="brain-category-collapse"') && html.includes('id="brain-category-save"') && html.includes('id="brain-category-ai"'));
assert.ok(html.includes('id="brain-skills"') && html.includes('id="brain-home-skills"') && html.includes('id="brain-library-skills"') && html.includes('id="brain-skill-status"'));
assert.deepStrictEqual(brainUi.brainSkillLists().map((row) => row[1]), [
  "emailBrain:getSkills",
  "emailBrain:getLibrarySkills",
]);
assert.deepStrictEqual(brainUi.brainSkillLists().map((row) => row[2]), [
  "No home skills.",
  "No library skills.",
]);
assert.strictEqual(brainUi.skillIdOf({ id: " morning-brief " }), "morning-brief");
assert.strictEqual(brainUi.skillIdOf("Match my tone"), "");
assert.strictEqual(brainUi.skillIdOf(null), "");
assert.deepStrictEqual(brainUi.skillResultMessage({ accepted: true, text: " Hi " }), { text: "Hi", error: false });
assert.deepStrictEqual(
  brainUi.skillResultMessage({ accepted: false, error: "Add an API key in GenMail → AI Setup." }),
  { text: "Add an API key in GenMail → AI Setup.", error: true },
);
assert.strictEqual(brainUi.skillResultMessage(null).error, true);
assert.strictEqual(brainUi.skillResultMessage({ accepted: true, text: "  " }).text, "Done.");
assert.strictEqual(brainUi.skillResultMessage({ accepted: true, summary: " Two notes " }).text, "Two notes");
const agentUi = loadFunctions(appJs, [
  "skillBlocks",
  "agentSections",
  "agentItemLine",
  "agentStatusCopy",
  "sectionEmptyCopy",
  "historyLine",
  "proposalLine",
  "runModeLabel",
]);
assert.deepStrictEqual(agentUi.skillBlocks(null), []);
assert.deepStrictEqual(agentUi.skillBlocks({ accepted: false, summary: "nope" }), []);
assert.strictEqual(agentUi.skillBlocks({ accepted: true, summary: "Hi", note: "Mail only", sections: [{ title: "Today", items: ["Ada"] }] })[2].title, "Today");
assert.deepStrictEqual(agentUi.agentSections(null), []);
assert.strictEqual(agentUi.agentItemLine({ from: "Ada", subject: "Hi", summary: "Reply" }), "Ada — Hi — Reply");
assert.strictEqual(agentUi.agentStatusCopy({ reason: "needs_key", error: "Add an API key in GenMail → AI Setup." }).error, true);
assert.match(agentUi.agentStatusCopy({ reason: "needs_mailbox" }).text, /Connect a mailbox/);
assert.strictEqual(agentUi.agentStatusCopy({ reason: "empty" }).error, false);
assert.strictEqual(agentUi.agentStatusCopy({ reason: "idle" }).text, "Triage has not run yet.");
assert.strictEqual(agentUi.sectionEmptyCopy("ready"), "Nothing in this section.");
assert.strictEqual(agentUi.sectionEmptyCopy("needs_key"), "");
assert.strictEqual(agentUi.historyLine({ name: "Morning Brief", summary: "Two notes" }), "Morning Brief — Two notes");
assert.strictEqual(agentUi.proposalLine({ subject: "Hello", labelName: "FYI" }), "Hello → FYI");
assert.match(agentUi.runModeLabel({ schedule: "disabled", runMode: "on_demand" }), /Auto-run is off/);
assert.ok(html.includes("Categories") && html.includes("Collapse view") && html.includes("Save categories") && html.includes("Use defaults"));
assert.ok(appJs.includes("No writing rules yet.") && appJs.includes("Needs an AI key."));
assert.ok(appJs.includes("emailBrain:fixItem") && appJs.includes("emailBrain:forgetItem") && appJs.includes("emailBrain:fixCategory"));
assert.ok(appJs.includes(">Fix<") || appJs.includes('textContent = "Fix"'));
assert.ok(appJs.includes('textContent = "Forget"') && appJs.includes('textContent = "Install"') && appJs.includes('textContent = "Run"'));
assert.ok(appJs.includes("No categories.") && appJs.includes("A category needs a name.") && appJs.includes("Describe a category."));
assert.ok(css.includes(".brain-row") && css.includes("#brain-status") && css.includes("#brain-category-status") && css.includes("#brain-categories"));
assert.ok(css.includes("#brain-skill-status") && css.includes("#brain-skills") && css.includes(".brain-skill"));
const parity = fs.readFileSync(path.join(root, "docs/PARITY_SHELL.md"), "utf8");
const studioUi = loadFunctions(appJs, ["skillRows", "skillLine", "studioLists", "envelopeError"]);
assert.deepStrictEqual(studioUi.studioLists().map((row) => row[1]), [
  "nativeAgent:home:skills",
  "nativeAgent:home:librarySkills",
]);
assert.deepStrictEqual(studioUi.skillRows(null), []);
assert.deepStrictEqual(studioUi.skillRows(undefined), []);
assert.deepStrictEqual(studioUi.skillRows({ nope: true }), []);
assert.deepStrictEqual(studioUi.skillRows({ skills: null }), []);
assert.deepStrictEqual(studioUi.skillRows([]), []);
assert.deepStrictEqual(studioUi.skillRows(["", "  ", null, "Catch Me Up"]).map(studioUi.skillLine), ["Catch Me Up"]);
assert.deepStrictEqual(studioUi.skillRows({
  items: [{ name: "Morning Brief", description: "Today" }, [], { id: "s1", summary: "Later" }],
}).map(studioUi.skillLine), ["Morning Brief — Today", "s1 — Later"]);
assert.strictEqual(studioUi.skillLine({ title: "Plan" }), "Plan");
assert.strictEqual(studioUi.skillLine("  Catch Me Up  "), "Catch Me Up");
assert.strictEqual(studioUi.skillLine(null), "");
assert.strictEqual(studioUi.envelopeError({ success: true, data: null }), null);
assert.strictEqual(studioUi.envelopeError(null), "No response from the mail host.");
assert.strictEqual(
  studioUi.envelopeError({ success: false, error: { message: "Add an API key in GenMail → AI Setup." } }),
  "Add an API key in GenMail → AI Setup.",
);
for (const channel of studioUi.studioLists().map((row) => row[1])) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
  assert.ok(ipcSrc.includes('"' + channel + '"'), `host stub missing ${channel}`);
}
assert.ok(html.includes('id="tidy"') && html.includes("One-click tidy"));
assert.ok(registered.has("mail:tidyInbox") && used.has("mail:tidyInbox"));
assert.ok(registered.has("genmail:configGetShowOneClickTidyEffective") && used.has("genmail:configGetShowOneClickTidyEffective"));
assert.ok(html.includes('id="agent-panel"') && html.includes('id="agent-open"') && html.includes('id="studio-home"') && html.includes('id="studio-library"'));
assert.ok(html.includes('id="rail-agent"') && html.includes('id="agent-sections"') && html.includes('id="agent-triage"'));
assert.ok(html.includes(">Agent<") && html.includes("Home skills") && html.includes("Library skills") && html.includes("Only when I ask"));
assert.ok(!html.includes("no agent loop"));
assert.ok(!html.includes("Sample mail runs"));
assert.ok(appJs.includes("No home skills.") && appJs.includes("No library skills."));
assert.ok(css.includes("#studio-status") && css.includes(".studio-row"));
assert.ok(parity.includes("emailBrain:getCached") && parity.includes("emailBrain:addWritingRule"));
assert.ok(parity.includes("emailBrain:getCategories") && parity.includes("emailBrain:saveCategories") && parity.includes("emailBrain:addCategoryViaPrompt"));
assert.ok(parity.includes("nativeAgent:home:skills") && parity.includes("nativeAgent:home:librarySkills"));
assert.ok(parity.includes("emailBrain:getSkills") && parity.includes("emailBrain:getLibrarySkills"));
assert.ok(parity.includes("emailBrain:runSkill"));
assert.ok(parity.includes("calendar") && parity.includes("nativeAgent:triage") && parity.includes("Needs You"));
assert.ok(!parity.includes("full agent skill runner"));
const brainDoc = fs.readFileSync(path.join(root, "docs/BRAIN_AGENT.md"), "utf8");
assert.ok(brainDoc.includes("Morning Brief") && brainDoc.includes("Meeting Prep") && brainDoc.includes("Organize Inbox"));
assert.ok(brainDoc.includes("on_demand") && /never send|Nothing is sent/i.test(brainDoc));
assert.ok(brainDoc.includes("Brief This Person") && brainDoc.includes("Plan My Week") && brainDoc.includes("Newsletter Digest"));
assert.ok(brainDoc.includes("Catch Me Up"));
assert.ok(brainDoc.includes("emailBrain:fixItem") && brainDoc.includes("emailBrain:forgetItem") && brainDoc.includes("emailBrain:fixCategory"));
assert.ok(parity.includes("emailBrain:fixItem") && parity.includes("emailBrain:forgetItem") && parity.includes("emailBrain:fixCategory"));
assert.ok(parity.includes("ownerName") && parity.includes("emailsAnalyzed") && parity.includes("factsLearned"));
assert.ok(parity.includes("genmail:configSetAiWriteAutoOpenOnReply") && parity.includes("genmail:configSetShowFolderChips"));
assert.ok(parity.includes("genmail:configSetShowOneClickTidy") && parity.includes("genmail:configSetSidebarGmailFoldersExpanded"));
assert.ok(parity.includes("genmail:configSetSidebarOutlookFoldersExpanded"));
assert.ok(parity.includes("above the message list") && parity.includes("open the compose AI write controls"));
assert.ok(parity.includes("mail:tidyInbox") && parity.includes("accepted: false"));
assert.ok(parity.includes("genmail:configGetShowOneClickTidyEffective"));
assert.ok(!parity.includes("does not add a button"));
assert.ok(css.includes(".chips") && css.includes("button.account") && css.includes(".ai-write.open"));
assert.ok(parity.includes("genmail:configGetDogfoodPrefs") && parity.includes("genmail:configGetShowJevClassification"));
assert.ok(parity.includes("genmail:configGetShowOneClickTidyEffective") && parity.includes("genmail:configGetCalendarSidebarOrder"));
assert.ok(!parity.includes("Other host preferences, calendar"));
assert.ok(!parity.includes("full skills library"));
assert.ok(!parity.includes("AI Studio, calendar"));
assert.ok(parity.includes("skills library"));
assert.ok(parity.includes("config:setTheme") && parity.includes("genmail:configSetSnoozeEffective"));
assert.ok(!parity.includes("the list is read-only"));
assert.ok(!parity.includes("full Brain category/skills UI"));
assert.ok(parity.includes("mail:upsertSignature") && parity.includes("imap_signatures_unsupported"));
assert.ok(!parity.includes("signatures editor"));

const providerUi = loadFunctions(appJs, [
  "oauthButtonState",
  "calendarGrantState",
  "providerFolderState",
  "providerCopy",
  "showOrganizeGrant",
  "calendarMode",
  "calendarCopy",
  "calendarView",
  "monthRange",
  "monthCells",
  "dayKey",
  "eventDay",
  "eventsOnDay",
  "calendarDraft",
]);
assert.deepStrictEqual(providerUi.oauthButtonState(null, "google"), { disabled: false, reason: "" });
assert.deepStrictEqual(providerUi.oauthButtonState({ google: true }, "google"), { disabled: false, reason: "" });
assert.deepStrictEqual(providerUi.oauthButtonState({ google: false }, "google"), {
  disabled: true,
  reason: "Google Desktop OAuth is not configured.",
});
assert.deepStrictEqual(providerUi.oauthButtonState({ google: false }, "microsoft"), { disabled: false, reason: "" });
assert.deepStrictEqual(providerUi.calendarGrantState(null, { platform: "gmail" }), {
  disabled: true,
  reason: "Connect a Google or Microsoft mailbox first.",
});
assert.deepStrictEqual(providerUi.calendarGrantState({ google: false }, {
  platform: "imap",
  imapSmtpProfile: "gmail",
}), {
  disabled: true,
  reason: "Google Desktop OAuth is not configured.",
});
assert.deepStrictEqual(providerUi.calendarGrantState({ google: false }, {
  platform: "imap",
  profile: "outlook",
}), { disabled: false, reason: "" });
assert.deepStrictEqual(providerUi.calendarGrantState({}, {
  platform: "imap",
  profile: "icloud",
}), {
  disabled: true,
  reason: "Calendar needs a Google or Microsoft account.",
});
assert.deepStrictEqual(providerUi.providerFolderState(null), {
  mode: "degraded",
  reason: "scope_missing",
  folders: [],
});
assert.deepStrictEqual(providerUi.providerFolderState({ api: false, reason: "oauth_not_ready" }), {
  mode: "degraded",
  reason: "oauth_not_ready",
  folders: [],
});
assert.deepStrictEqual(providerUi.providerFolderState({
  api: true,
  folders: [{ id: "Label_9", name: "Travel" }, { id: "blank" }, null],
}), {
  mode: "live",
  reason: "",
  folders: [{ id: "Label_9", name: "Travel" }],
});
assert.strictEqual(
  providerUi.providerCopy("scope_missing", "gmail"),
  "Gmail labels need the gmail.modify grant. This mailbox stays on IMAP until then.",
);
assert.strictEqual(
  providerUi.providerCopy("scope_missing", "outlook"),
  "Outlook folders need the Mail.ReadWrite grant. This mailbox stays on IMAP until then.",
);
assert.strictEqual(
  providerUi.providerCopy("password_account", "gmail"),
  "This mailbox uses a password. Grant the provider API to manage labels, or keep using IMAP folders.",
);
assert.strictEqual(providerUi.showOrganizeGrant("scope_missing"), true);
assert.strictEqual(providerUi.showOrganizeGrant("password_account"), true);
assert.strictEqual(providerUi.showOrganizeGrant("oauth_not_ready"), false);
assert.strictEqual(providerUi.showOrganizeGrant("imap_only"), false);
const needsAuth = providerUi.calendarView({ api: false, reason: "needs_auth" });
assert.strictEqual(needsAuth.showGrid, false);
assert.strictEqual(needsAuth.showForm, false);
assert.deepStrictEqual(needsAuth.events, []);
assert.strictEqual(
  needsAuth.status,
  "Calendar needs a calendar grant. This view does not keep events of its own.",
);
assert.strictEqual(providerUi.calendarCopy("oauth_not_ready"), "Google Desktop OAuth is not configured, so calendar stays offline.");
assert.strictEqual(providerUi.calendarView({
  api: true,
  calendars: [],
  events: [{ id: "fake", start: "2026-10-01", title: "Team sync" }],
}).status, "No calendars on this account.");
assert.strictEqual(providerUi.calendarView({
  api: true,
  calendars: [],
  events: [{ id: "fake", start: "2026-10-01" }],
}).showGrid, false);
const emptyMonth = providerUi.calendarView({
  api: true,
  calendars: [{ id: "cal-1", name: "Ada" }],
  events: [{ title: "Sample meeting", start: "2026-10-02" }],
});
assert.strictEqual(emptyMonth.showGrid, true);
assert.strictEqual(emptyMonth.showForm, true);
assert.strictEqual(emptyMonth.status, "No events this month.");
assert.deepStrictEqual(emptyMonth.events, []);
const partialMonth = providerUi.calendarView({
  api: true,
  truncated: true,
  calendars: [{ id: "cal-1" }],
  events: [{ id: "evt", start: "2026-10-02T15:00:00Z", title: "Design review" }],
});
assert.strictEqual(partialMonth.events.length, 1);
assert.strictEqual(partialMonth.events[0].id, "evt");
assert.ok(partialMonth.status.includes("The provider returned a partial list."));
const october = providerUi.monthRange(2026, 9);
assert.strictEqual(october.label.includes("2026"), true);
assert.strictEqual(october.timeMin, new Date(2026, 9, 1).toISOString());
assert.strictEqual(october.timeMax, new Date(2026, 10, 1).toISOString());
const cells = providerUi.monthCells(2026, 9);
assert.strictEqual(cells.length, 35);
assert.strictEqual(cells[3], 0);
assert.strictEqual(cells[4], 1);
assert.strictEqual(cells[34], 31);
assert.strictEqual(providerUi.eventDay({ start: "2026-10-03", allDay: true }), "2026-10-03");
assert.strictEqual(providerUi.eventDay({ start: "" }), "");
const midday = new Date(2026, 9, 5, 15, 0, 0);
assert.strictEqual(providerUi.eventDay({ start: midday.toISOString() }), providerUi.dayKey(2026, 9, 5));
assert.deepStrictEqual(providerUi.eventsOnDay([
  { id: "a", start: "2026-10-03", allDay: true },
  { id: "b", start: "2026-10-04", allDay: true },
], "2026-10-03").map((event) => event.id), ["a"]);
assert.deepStrictEqual(providerUi.eventsOnDay(null, "2026-10-03"), []);
assert.strictEqual(providerUi.calendarDraft({}).error, "Connect a Google or Microsoft mailbox first.");
assert.strictEqual(providerUi.calendarDraft({ accountId: "a" }).error, "Choose a calendar.");
assert.strictEqual(providerUi.calendarDraft({ accountId: "a", calendarId: "c" }).error, "Add a title.");
assert.strictEqual(providerUi.calendarDraft({
  accountId: "a",
  calendarId: "c",
  title: "Hi",
  start: "2026-10-17T11:00",
  end: "2026-10-17T10:00",
}).error, "Pick a start and a later end.");
const drafted = providerUi.calendarDraft({
  accountId: "a",
  calendarId: "c",
  title: " Hi ",
  start: "2026-10-17T10:00",
  end: "2026-10-17T11:00",
});
assert.strictEqual(drafted.error, "");
assert.strictEqual(drafted.title, "Hi");
assert.ok(drafted.start < drafted.end);
for (const channel of [
  "mail:oauthStatus",
  "mail:grantOrganize",
  "mail:listProviderFolders",
  "mail:createProviderFolder",
  "mail:renameProviderFolder",
  "mail:deleteProviderFolder",
  "mail:modifyMessageLabels",
  "mail:moveProviderMessage",
  "calendar:status",
  "calendar:connect",
  "calendar:list",
  "calendar:createEvent",
]) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
}
for (const channel of [
  "mail:oauthStatus",
  "mail:grantOrganize",
  "mail:listProviderFolders",
  "mail:createProviderFolder",
  "mail:renameProviderFolder",
  "mail:deleteProviderFolder",
  "mail:modifyMessageLabels",
  "mail:moveProviderMessage",
  "calendar:connect",
  "calendar:list",
  "calendar:createEvent",
]) {
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(html.includes('id="rail-calendar"') && html.includes('id="calendar-panel"'));
assert.ok(html.includes('id="calendar-grant"') && html.includes("Grant calendar access"));
assert.ok(html.includes('id="calendar-create"') && html.includes('id="calendar-pick"'));
assert.ok(appJs.includes("Grant Gmail labels") && appJs.includes("Grant Outlook folders"));
assert.ok(css.includes("#calendar-panel") && css.includes(".calendar-grid") && css.includes(".provider-block"));
assert.ok(!appJs.includes("Team sync") && !html.includes("Team sync"));
assert.ok(!appJs.includes("Sample meeting") && !html.includes("Sample meeting"));
const oauthDoc = fs.readFileSync(path.join(root, "docs/OAUTH.md"), "utf8");
for (const phrase of [
  "IMAP",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "Calendars.ReadWrite",
  "Mail.ReadWrite",
  "/api/calendar-oauth/google/callback",
  "/api/calendar-oauth/microsoft/callback",
  "Testing",
  "verification",
  "admin consent",
  "grantedScopes",
]) {
  assert.ok(oauthDoc.includes(phrase), `OAUTH.md missing ${phrase}`);
}
assert.ok(!/"client_secret"\s*:/.test(oauthDoc));
assert.ok(!oauthDoc.includes("ya29."));
assert.ok(fs.readFileSync(path.join(root, ".gitignore"), "utf8").includes("resources/google-oauth.json"));
const http = require("../host/mail/provider-http");
assert.strictEqual(http.safeNext("https://evil.example/next", "graph.microsoft.com"), "");
assert.strictEqual(http.safeNext("http://graph.microsoft.com/next", "graph.microsoft.com"), "");
assert.strictEqual(http.safeNext("https://user:pass@graph.microsoft.com/next", "graph.microsoft.com"), "");
assert.ok(http.safeNext("https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=abc", "graph.microsoft.com").includes("skiptoken"));
const gmailApi = require("../host/mail/provider-api");
assert.strictEqual(gmailApi.normalizeGmailLabel({ id: "Label_x", type: "user" }), null);
assert.strictEqual(gmailApi.normalizeGmailLabel({ id: "INBOX", type: "system" }).name, "INBOX");
assert.strictEqual(gmailApi.normalizeGmailLabel({ id: "INBOX", type: "system" }).editable, false);
assert.throws(() => gmailApi.normalizeGmailLabels({}), /label list/);
assert.ok(gmailApi.gmailModifyUrl("msg-1").endsWith("/messages/msg-1/modify"));
const oauthConfig = require("../host/mail/oauth-config");
assert.strictEqual(oauthConfig.SCOPES.google, "openid email https://mail.google.com/");
assert.strictEqual(
  oauthConfig.SCOPES.microsoft,
  "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
);
assert.strictEqual(oauthConfig.MARKERS.imap.microsoft, "https://outlook.office.com/IMAP.AccessAsUser.All");
assert.ok(!oauthConfig.SCOPES.microsoft.includes("User.Read"));
assert.strictEqual(oauthConfig.IMAP_PRESETS.microsoft.imap.host, "outlook.office365.com");
assert.strictEqual(oauthConfig.IMAP_PRESETS.microsoft.smtp.host, "smtp.office365.com");
assert.strictEqual(
  oauthConfig.ORGANIZE_SCOPES.google,
  `${oauthConfig.SCOPES.google} https://www.googleapis.com/auth/gmail.modify`,
);
assert.strictEqual(
  oauthConfig.ORGANIZE_SCOPES.microsoft,
  "offline_access User.Read Mail.ReadWrite Mail.Send",
);
assert.ok(!oauthConfig.ORGANIZE_SCOPES.microsoft.includes("outlook.office"));
assert.ok(!oauthConfig.CALENDAR_SCOPES.microsoft.includes("outlook.office"));
assert.strictEqual(
  oauthConfig.CALENDAR_SCOPES.google,
  "openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events",
);
assert.strictEqual(oauthConfig.CALENDAR_SCOPES.microsoft, "offline_access User.Read Calendars.ReadWrite");
assert.strictEqual(oauthConfig.scopesFor("gmail", "imap"), oauthConfig.SCOPES.google);
assert.strictEqual(oauthConfig.scopesFor("outlook", "organize"), oauthConfig.ORGANIZE_SCOPES.microsoft);
assert.strictEqual(oauthConfig.scopesFor("google", "calendar"), oauthConfig.CALENDAR_SCOPES.google);
assert.strictEqual(oauthConfig.normalizePurpose("mail-api"), "organize");
assert.strictEqual(oauthConfig.normalizePurpose("api"), "organize");
assert.strictEqual(oauthConfig.hasMarker("Mail.Read", "microsoft", "organize"), false);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.ORGANIZE_SCOPES.microsoft, "outlook", "organize"), true);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.ORGANIZE_SCOPES.google, "gmail", "organize"), true);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.SCOPES.google, "google", "organize"), false);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.CALENDAR_SCOPES.google, "google", "calendar"), true);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.CALENDAR_SCOPES.microsoft, "microsoft", "calendar"), true);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.SCOPES.google, "google", "imap"), true);
assert.strictEqual(oauthConfig.redirectPath("google", "imap"), "/api/oauth/google/callback");
assert.strictEqual(oauthConfig.redirectPath("google", "organize"), "/api/oauth/google/callback");
assert.strictEqual(oauthConfig.redirectPath("microsoft", "calendar"), "/api/calendar-oauth/microsoft/callback");
assert.strictEqual(oauthConfig.redirectPath("google", "calendar"), "/api/calendar-oauth/google/callback");
assert.strictEqual(oauthConfig.redirectUri(0, "google", "imap"), "");
assert.strictEqual(
  oauthConfig.redirectUri(42813, "google", "calendar"),
  "http://localhost:42813/api/calendar-oauth/google/callback",
);
assert.strictEqual(
  oauthConfig.profileUrl("google", "calendar"),
  "https://openidconnect.googleapis.com/v1/userinfo",
);
assert.strictEqual(
  oauthConfig.profileUrl("google", "imap"),
  "https://gmail.googleapis.com/gmail/v1/users/me/profile",
);
const authFields = {
  clientId: "check.apps.googleusercontent.com",
  state: "state",
  challenge: "challenge",
};
const googleAuth = new URL(oauthConfig.authorizeUrl("google", "organize", {
  ...authFields,
  redirectUri: "http://localhost:1/api/oauth/google/callback",
}));
assert.strictEqual(googleAuth.searchParams.get("include_granted_scopes"), "true");
assert.strictEqual(googleAuth.searchParams.get("prompt"), "consent");
assert.strictEqual(googleAuth.searchParams.get("access_type"), "offline");
assert.strictEqual(googleAuth.searchParams.get("scope"), oauthConfig.ORGANIZE_SCOPES.google);
const microsoftImap = new URL(oauthConfig.authorizeUrl("microsoft", "imap", {
  ...authFields,
  clientId: oauthConfig.MICROSOFT_CLIENT_ID,
  redirectUri: "http://localhost:1/api/oauth/microsoft/callback",
}));
assert.strictEqual(microsoftImap.searchParams.get("prompt"), "select_account");
assert.strictEqual(microsoftImap.searchParams.get("scope"), oauthConfig.SCOPES.microsoft);
const microsoftCalendar = new URL(oauthConfig.authorizeUrl("microsoft", "calendar", {
  ...authFields,
  clientId: oauthConfig.MICROSOFT_CLIENT_ID,
  redirectUri: "http://localhost:1/api/calendar-oauth/microsoft/callback",
}));
assert.strictEqual(microsoftCalendar.searchParams.get("prompt"), "consent");
assert.strictEqual(microsoftCalendar.searchParams.get("scope"), oauthConfig.CALENDAR_SCOPES.microsoft);
assert.strictEqual(oauthConfig.MICROSOFT_CLIENT_ID, "2ca9ca19-add5-4807-bfa1-c2a7ac3cc6bf");

async function checkAiDraft() {
  delete process.env.GENMAIL_AI_API_KEY;
  delete process.env.XAI_API_KEY;
  const os = require("os");
  process.env.GENMAIL_AI_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "genmail-ai-"));
  const Module = require("module");
  const originalRequire = Module.prototype.require;
  const sent = [];
  Module.prototype.require = function (id) {
    if (id === "electron") {
      return {
        BrowserWindow: {
          getAllWindows() {
            return [{
              isDestroyed() { return false; },
              webContents: {
                send(channel, payload) { sent.push({ channel, payload }); },
              },
            }];
          },
        },
      };
    }
    return originalRequire.apply(this, arguments);
  };
  const draft = require("../host/draft-write");
  const missing = await draft.answer("aiDraftWrite:replySuggestions", [{
    email: { subject: "Hi", from: "Ada <ada@example.com>", snippet: "Hello there" },
  }]);
  assert.strictEqual(missing.success, false);
  assert.match(missing.error.message, /API key/);
  const chunk = draft.escapeHtml("Hi <Ada> &\nNext").replace(/\n/g, "<br>");
  assert.strictEqual(ai.htmlChunkToText(chunk), "Hi <Ada> &\nNext");
  const started = await draft.answer("aiDraftWrite:start", [{
    reqId: "boot-draft",
    body: ai.draftInstruction("rewrite", "shorter", "Hello", "Hi"),
  }]);
  assert.strictEqual(started.success, true);
  assert.strictEqual(started.data.reqId, "boot-draft");
  await new Promise((resolve) => setImmediate(resolve));
  const errorEvent = sent.find((row) => row.payload && row.payload.type === "error" && row.payload.reqId === "boot-draft");
  assert.ok(errorEvent, "missing-key draft did not emit an error");
  assert.strictEqual(errorEvent.channel, "aiDraftWrite:event");
  assert.match(errorEvent.payload.message, /API key/);
  const hostError = { reqId: "boot-draft", pending: true, error: "", text: "", base: "" };
  ai.applyDraftEvent(hostError, errorEvent.payload);
  assert.strictEqual(hostError.pending, false);
  assert.match(hostError.error, /API key/);
  const cancelled = await draft.answer("aiDraftWrite:cancel", [{ reqId: "boot-draft" }]);
  assert.strictEqual(cancelled.success, true);
  const noId = await draft.answer("aiDraftWrite:start", [{}]);
  assert.strictEqual(noId.success, false);
  const brain = require("../host/brain");
  const { loadConfig } = require("../host/ai-config");
  assert.strictEqual(loadConfig().apiKey, "");
  const agent = require("../host/agent");
  const agentSrc = fs.readFileSync(path.join(root, "host/agent.js"), "utf8");
  assert.ok(!agentSrc.includes("mail:send"));
  assert.ok(!agentSrc.includes("skill-tone") && !agentSrc.includes("Match my tone"));
  const brainHome = brain.answer("emailBrain:getSkills", []);
  const brainLibrary = brain.answer("emailBrain:getLibrarySkills", []);
  assert.strictEqual(brainHome.success, true);
  assert.strictEqual(brainLibrary.success, true);
  assert.deepStrictEqual(studioUi.skillRows(brainHome.data).map(studioUi.skillLine), [
    "Morning Brief — What needs you this morning.",
    "Catch Me Up — Summarize recent inbox mail.",
    "Organize Inbox — Propose label or folder moves for you to confirm.",
    "Plan My Week — Plan the week from calendar or mail.",
    "Newsletter Digest — Summarize newsletters in the inbox.",
    "Brief This Person — A short brief on one sender.",
    "Meeting Prep — Prep from upcoming events and related mail.",
  ]);
  assert.deepStrictEqual(studioUi.skillRows(brainLibrary.data), []);
  assert.ok(brainHome.data.every((row) => row.runMode === "on_demand" && row.schedule === "disabled"));
  const removedSkill = brain.answer("emailBrain:removeSkill", [{ skillId: "newsletter-digest" }]);
  assert.strictEqual(removedSkill.success, true);
  assert.ok(removedSkill.data.library.some((row) => row.id === "newsletter-digest"));
  assert.ok(!removedSkill.data.skills.some((row) => row.id === "newsletter-digest"));
  const installedSkill = brain.answer("emailBrain:installSkill", [{ skillId: "newsletter-digest" }]);
  assert.strictEqual(installedSkill.success, true);
  assert.ok(installedSkill.data.skills.some((row) => row.id === "newsletter-digest"));
  assert.deepStrictEqual(installedSkill.data.library, []);
  assert.strictEqual(brain.answer("emailBrain:installSkill", [{ skillId: "skill-tone" }]).success, false);
  const missingKey = await brain.answer("emailBrain:runSkill", [{ skillId: "morning-brief" }]);
  assert.strictEqual(missingKey.success, true);
  assert.strictEqual(missingKey.data.accepted, false);
  assert.match(missingKey.data.error, /API key/);
  assert.strictEqual((await brain.answer("emailBrain:runSkill", [{}])).success, false);
  assert.strictEqual((await brain.answer("emailBrain:runSkill", [{ skillId: "nope" }])).success, false);
  assert.strictEqual((await brain.answer("emailBrain:runSkill", [{ skillId: "skill-sort" }])).success, false);
  const needsKeyHome = agent.answer("nativeAgent:getTriage", []);
  assert.strictEqual(needsKeyHome.data.reason, "needs_key");
  assert.strictEqual(needsKeyHome.data.sections.length, 5);
  assert.ok(needsKeyHome.data.sections.every((section) => section.items.length === 0));
  assert.ok(!JSON.stringify(needsKeyHome.data).includes("Analytical Engine"));
  const grouped = agent.groupTriage(
    [{ id: "needs-you", name: "Needs You" }, { id: "other", name: "Other" }],
    [
      { id: "m-live", from: "Ada", subject: "Need the notes", snippet: "Can you send the notes?" },
      { id: "m-other", from: "Bea", subject: "FYI", snippet: "Receipt" },
    ],
    [{ messageId: "m-live", categoryId: "needs-you", summary: "Ada needs a reply." }, { messageId: "made-up", summary: "Invented" }],
  );
  assert.strictEqual(grouped[0].items.length, 1);
  assert.strictEqual(grouped[0].items[0].messageId, "m-live");
  assert.strictEqual(grouped[1].items[0].messageId, "m-other");
  assert.ok(!JSON.stringify(grouped).includes("Invented"));
  const dropped = agent.normalizeSkillResult(
    { moves: true, name: "Organize Inbox" },
    { title: "Organize", summary: "One move.", moves: [{ messageId: "made-up", labelName: "FYI" }, { messageId: "m-live", labelName: "FYI", reason: "Bulk" }] },
    { messages: [{ id: "m-live" }] },
  );
  assert.strictEqual(dropped.moves.length, 1);
  assert.strictEqual(dropped.moves[0].messageId, "m-live");
  process.env.GENMAIL_AI_API_KEY = "sk-test";
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error("rebuild must not call the model without a mailbox"); };
  try {
    const noMailbox = await brain.answer("emailBrain:runSkill", [{ skillId: "morning-brief" }]);
    assert.strictEqual(noMailbox.data.accepted, false);
    assert.match(noMailbox.data.error, /mailbox/i);
    assert.strictEqual(agent.answer("nativeAgent:getTriage", []).data.reason, "needs_mailbox");
    const rebuildBefore = sent.length;
    const rebuildAccepted = brain.answer("emailBrain:rebuild", []);
    assert.strictEqual(rebuildAccepted.data.accepted, true);
    await new Promise((resolve) => setImmediate(resolve));
    const rebuildEvents = sent.slice(rebuildBefore);
    assert.ok(rebuildEvents.some((row) => row.payload && /mailbox/i.test(String(row.payload.error || ""))));
  } finally {
    global.fetch = originalFetch;
  }
  const db = require("../host/mail/db");
  const hadAccounts = db.hasAccounts;
  const hadInbox = db.recentInbox;
  db.hasAccounts = () => true;
  db.recentInbox = () => [{
    id: "m-live",
    accountId: "acct-1",
    from: "Ada Lovelace <ada@example.com>",
    subject: "Need the notes",
    snippet: "Can you send the notes?",
    date: "2026-10-17T08:00:00.000Z",
    unread: true,
    starred: false,
    hasAttachments: true,
    threadId: "t1",
    folderPath: "INBOX",
  }];
  const seenBodies = [];
  global.fetch = async (_url, opts) => {
    const body = String(opts && opts.body || "");
    seenBodies.push(body);
    const content = body.includes("Assign each message")
      ? JSON.stringify({
        items: [{
          messageId: "m-live",
          categoryId: "needs-you",
          summary: "Ada needs a reply.",
          followUps: [{ messageId: "m-live", kind: "draft", label: "Reply", body: "I will look." }],
        }, { messageId: "made-up", categoryId: "fyi", summary: "Invented row." }],
      })
      : JSON.stringify({
        title: "Skill result",
        summary: "Ada asked for the notes.",
        sections: [{ title: "Needs You", items: ["Reply to Ada"] }],
        drafts: [{ messageId: "m-live", to: "ada@example.com", subject: "Re: Need the notes", body: "I will look." }],
        moves: body.includes("Organize Inbox")
          ? [{ messageId: "m-live", labelName: "FYI", reason: "Bulk" }, { messageId: "made-up", labelName: "FYI", reason: "nope" }]
          : [],
        followUps: [{ messageId: "m-live", kind: "open", label: "Open" }],
      });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => "",
    };
  };
  try {
    const morning = await brain.answer("emailBrain:runSkill", [{ skillId: "morning-brief" }]);
    assert.strictEqual(morning.data.accepted, true);
    assert.strictEqual(morning.data.runMode, "on_demand");
    assert.strictEqual(morning.data.summary, "Ada asked for the notes.");
    assert.ok(seenBodies.some((body) => body.includes("Need the notes")));
    assert.ok(!JSON.stringify(morning.data).includes("Analytical Engine"));
    const week = await brain.answer("emailBrain:runSkill", [{ skillId: "plan-my-week" }]);
    assert.strictEqual(week.data.accepted, true);
    assert.match(week.data.note, /mail only/);
    const personMissing = await brain.answer("emailBrain:runSkill", [{ skillId: "brief-this-person" }]);
    assert.strictEqual(personMissing.data.accepted, false);
    assert.match(personMissing.data.error, /contact email|Select a message/);
    const person = await brain.answer("emailBrain:runSkill", [{ skillId: "brief-this-person", contactEmail: "ada@example.com" }]);
    assert.strictEqual(person.data.accepted, true);
    assert.strictEqual(person.data.summary, "Ada asked for the notes.");
    const organized = await brain.answer("emailBrain:runSkill", [{ skillId: "organize-inbox" }]);
    assert.strictEqual(organized.data.accepted, true);
    assert.strictEqual(organized.data.proposals.length, 1);
    assert.strictEqual(organized.data.proposals[0].messageId, "m-live");
    assert.strictEqual(organized.data.proposals[0].status, "pending");
    const confirmed = await brain.answer("emailBrain:confirmProposal", [{ proposalId: organized.data.proposals[0].id }]);
    assert.strictEqual(confirmed.data.accepted, false);
    assert.match(confirmed.data.error, /not in the local mailbox/);
    assert.ok(confirmed.data.proposals.some((row) => row.id === organized.data.proposals[0].id));
    const triaged = await agent.answer("nativeAgent:triage", []);
    assert.strictEqual(triaged.data.reason, "ready");
    const needsYou = triaged.data.sections.find((section) => section.id === "needs-you");
    assert.strictEqual(needsYou.items.length, 1);
    assert.strictEqual(needsYou.items[0].summary, "Ada needs a reply.");
    assert.ok(!JSON.stringify(triaged.data.sections).includes("Invented"));
    assert.ok(!JSON.stringify(triaged.data.sections).includes("made-up"));
    const history = agent.answer("nativeAgent:history", []);
    assert.ok(history.data.runs.some((row) => row.skillId === "morning-brief" && row.accepted === true));
  } finally {
    db.hasAccounts = hadAccounts;
    db.recentInbox = hadInbox;
    global.fetch = originalFetch;
    delete process.env.GENMAIL_AI_API_KEY;
  }
  assert.ok(!fs.existsSync(path.join(process.env.GENMAIL_AI_CONFIG_DIR, "brain.json")));
  const cached = brain.answer("emailBrain:getCached", []);
  assert.strictEqual(cached.success, true);
  const cachedSections = brainUi.brainSections(cached.data);
  assert.ok(cachedSections.some((section) => section.id === "how-you-write"));
  assert.deepStrictEqual(brainUi.brainUserRules(cachedSections), []);
  const before = sent.length;
  const refreshed = brain.answer("emailBrain:refresh", []);
  assert.strictEqual(refreshed.success, true);
  assert.strictEqual(refreshed.data.accepted, false);
  const rebuilt = brain.answer("emailBrain:rebuild", []);
  assert.strictEqual(rebuilt.success, true);
  assert.strictEqual(rebuilt.data.accepted, false);
  await new Promise((resolve) => setImmediate(resolve));
  const refreshEvents = sent.slice(before);
  assert.ok(refreshEvents.some((row) => row.channel === "emailBrain:refreshState"));
  assert.ok(refreshEvents.some((row) => row.channel === "emailBrain:rebuildState"));
  assert.ok(refreshEvents.every((row) => !row.payload || !row.payload.error));
  const added = brain.answer("emailBrain:addWritingRule", [{ text: "Keep it short." }]);
  assert.strictEqual(added.success, true);
  const addedRules = brainUi.brainUserRules(brainUi.brainSections(added.data));
  assert.strictEqual(addedRules.length, 1);
  assert.strictEqual(addedRules[0].value, "Keep it short.");
  assert.ok(addedRules[0].id);
  const edited = brain.answer("emailBrain:setWritingRule", [{ itemId: addedRules[0].id, text: "Keep it brief." }]);
  assert.strictEqual(edited.success, true);
  const editedRules = brainUi.brainUserRules(brainUi.brainSections(edited.data));
  assert.strictEqual(editedRules[0].id, addedRules[0].id);
  assert.strictEqual(editedRules[0].value, "Keep it brief.");
  const removed = brain.answer("emailBrain:deleteWritingRule", [{ itemId: addedRules[0].id }]);
  assert.strictEqual(removed.success, true);
  const after = brain.answer("emailBrain:getCached", []);
  assert.deepStrictEqual(brainUi.brainUserRules(brainUi.brainSections(after.data)), []);
  const emptyRule = brain.answer("emailBrain:addWritingRule", [{ text: "  " }]);
  assert.strictEqual(emptyRule.success, false);
  assert.ok(fs.existsSync(path.join(process.env.GENMAIL_AI_CONFIG_DIR, "brain.json")));
  const listed = brain.answer("emailBrain:getCategories", []);
  assert.strictEqual(listed.success, true);
  assert.ok(listed.data.categories.some((row) => row.id === "needs-you" && row.name === "Needs You"));
  assert.ok(listed.data.defaultCategories.some((row) => row.id === "needs-you" && row.collapseView === false));
  assert.ok(listed.data.categories.some((row) => row.name === "Upcoming Today"));
  assert.ok(listed.data.categories.some((row) => row.name === "Worth a look"));
  assert.ok(listed.data.categories.some((row) => row.name === "FYI"));
  assert.ok(listed.data.categories.some((row) => row.name === "Other"));
  const kept = brain.answer("emailBrain:addWritingRule", [{ text: "Keep categories apart." }]);
  assert.strictEqual(kept.success, true);
  const saved = brain.answer("emailBrain:saveCategories", [{
    categories: [
      { id: "cat-news", name: "News", description: "Headlines", collapseView: true },
      { name: "Notes", description: "Personal", collapseView: false },
    ],
  }]);
  assert.strictEqual(saved.success, true);
  assert.strictEqual(saved.data[0].id, "cat-news");
  assert.strictEqual(saved.data[0].name, "News");
  assert.strictEqual(saved.data[0].description, "Headlines");
  assert.strictEqual(saved.data[0].collapseView, true);
  assert.strictEqual(saved.data[1].id, "cat-2");
  assert.strictEqual(saved.data[1].collapseView, false);
  const again = brain.answer("emailBrain:getCategories", []);
  assert.strictEqual(again.success, true);
  assert.deepStrictEqual(again.data.categories.map((row) => row.id), ["cat-news", "cat-2"]);
  assert.strictEqual(again.data.categories[1].description, "Personal");
  const still = brain.answer("emailBrain:getCached", []);
  assert.ok(brainUi.brainUserRules(brainUi.brainSections(still.data)).some((row) => row.value === "Keep categories apart."));
  const long = brain.answer("emailBrain:saveCategories", [{
    categories: [{ id: "cat-long", name: "n".repeat(100), description: "d".repeat(500), collapseView: "yes" }],
  }]);
  assert.strictEqual(long.data[0].name.length, 80);
  assert.strictEqual(long.data[0].description.length, 400);
  assert.strictEqual(long.data[0].collapseView, false);
  const prompted = await brain.answer("emailBrain:addCategoryViaPrompt", [{ prompt: "newsletters" }]);
  assert.strictEqual(prompted.success, false);
  assert.match(prompted.error.message, /API key/);
  const unchanged = brain.answer("emailBrain:getCategories", []);
  assert.strictEqual(unchanged.data.categories[0].id, "cat-long");
  const emptied = brain.answer("emailBrain:saveCategories", [{ categories: [] }]);
  assert.deepStrictEqual(emptied.data, []);
  const restored = brain.answer("emailBrain:getCategories", []);
  assert.ok(restored.data.categories.some((row) => row.id === "needs-you"));
  const afterEmpty = brain.answer("emailBrain:getCached", []);
  assert.ok(brainUi.brainUserRules(brainUi.brainSections(afterEmpty.data)).some((row) => row.value === "Keep categories apart."));
  assert.ok(brainUi.brainProfileMeta(afterEmpty.data).some((row) => row.key === "factsLearned"));
  const fixedItem = await brain.answer("emailBrain:fixItem", [{ itemId: "how-you-write:0", prompt: "shorter" }]);
  assert.strictEqual(fixedItem.success, false);
  assert.match(fixedItem.error.message, /API key/);
  const fixedCategory = await brain.answer("emailBrain:fixCategory", [{ itemId: "needs-you", prompt: "shorter" }]);
  assert.strictEqual(fixedCategory.success, false);
  assert.match(fixedCategory.error.message, /API key/);
  const forgotten = brain.answer("emailBrain:forgetItem", [{ itemId: "missing-row" }]);
  assert.strictEqual(forgotten.success, true);
  const keptAfterForget = brain.answer("emailBrain:getCached", []);
  assert.ok(brainUi.brainUserRules(brainUi.brainSections(keptAfterForget.data)).some((row) => row.value === "Keep categories apart."));
  const { createIpc } = require("../host/ipc");
  const ipc = createIpc(path.join(os.tmpdir(), "genmail-studio-ipc.log"));
  const homeSkills = ipc.handle({}, "nativeAgent:home:skills");
  const librarySkills = ipc.handle({}, "nativeAgent:home:librarySkills");
  const otherAgent = ipc.handle({}, "nativeAgent:home");
  assert.strictEqual(homeSkills.success, true);
  assert.ok(homeSkills.data.some((row) => row.name === "Morning Brief" && row.runMode === "on_demand"));
  assert.deepStrictEqual(librarySkills.data, []);
  assert.strictEqual(otherAgent.success, true);
  assert.strictEqual(otherAgent.data.reason, "needs_key");
  assert.ok(otherAgent.data.sections.every((section) => section.items.length === 0));
  assert.ok(!JSON.stringify(otherAgent.data).includes("Analytical Engine"));
  assert.strictEqual(studioUi.envelopeError(homeSkills), null);
  assert.ok(studioUi.skillRows(homeSkills.data).length >= 7);
}

async function checkTidy() {
  const os = require("os");
  const prev = {
    GENMAIL_USER_DATA: process.env.GENMAIL_USER_DATA,
    GENMAIL_MAIL_DIR: process.env.GENMAIL_MAIL_DIR,
    GENMAIL_AI_CONFIG_DIR: process.env.GENMAIL_AI_CONFIG_DIR,
    GENMAIL_MAIL_SECRETS: process.env.GENMAIL_MAIL_SECRETS,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genmail-tidy-"));
  process.env.GENMAIL_USER_DATA = dir;
  process.env.GENMAIL_MAIL_DIR = dir;
  process.env.GENMAIL_AI_CONFIG_DIR = dir;
  process.env.GENMAIL_MAIL_SECRETS = "memory";
  try {
    const { answer: settingsAnswer } = require("../host/settings");
    assert.strictEqual(settingsAnswer("genmail:configSetShowOneClickTidy", [true]), true);
    assert.strictEqual(mailbox.answer("genmail:configGetShowOneClickTidyEffective", []), true);
    assert.strictEqual(settingsAnswer("genmail:configSetShowOneClickTidy", [false]), false);
    assert.strictEqual(mailbox.answer("genmail:configGetShowOneClickTidyEffective", []), false);
    assert.strictEqual(settingsAnswer("genmail:configSetShowOneClickTidy", [true]), true);
    const engine = require("../host/mail/engine");
    const db = require("../host/mail/db");
    const { createIpc } = require("../host/ipc");
    await engine.init();
    assert.strictEqual(engine.answer("genmail:configGetShowOneClickTidyEffective", []), undefined);
    assert.strictEqual(engine.answer("mail:tidyInbox", []), undefined);
    const ipc = createIpc(path.join(dir, "ipc.log"));
    assert.strictEqual(ipc.handle({}, "genmail:configGetShowOneClickTidyEffective"), true);
    db.insertAccount({
      id: "imap-test",
      email: "ada@example.com",
      username: "ada@example.com",
      profile: "custom",
      imapHost: "imap.example.test",
      imapPort: 993,
      imapTls: true,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      smtpTls: true,
      delimiter: "/",
      createdAt: Date.now(),
    });
    assert.strictEqual(engine.answer("genmail:configGetShowOneClickTidyEffective", []), false);
    assert.strictEqual(ipc.handle({}, "genmail:configGetShowOneClickTidyEffective"), false);
    const live = await ipc.handle({}, "mail:tidyInbox", { accountId: "imap-test" });
    assert.strictEqual(live.success, true);
    assert.strictEqual(live.data.accepted, false);
    assert.deepStrictEqual(live.data.opIds, []);
    assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-promo"));
    assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-news"));
    assert.strictEqual(mailbox.answer("genmail:configGetShowOneClickTidyEffective", []), true);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    async json() { return JSON.parse(text); },
  };
}

async function checkProviderApi() {
  const oauthMod = require("../host/mail/oauth");
  const calendarApi = require("../host/mail/calendar-api");
  const sidecar = require("../host/mail/sidecar");
  const envKeys = [
    "GENMAIL_GOOGLE_OAUTH_JSON",
    "GENMAIL_GOOGLE_OAUTH_FILE",
    "MORROW_GOOGLE_OAUTH_JSON",
    "MORROW_GOOGLE_OAUTH_FILE",
    "GOOGLE_DESKTOP_OAUTH_JSON",
    "GENMAIL_MAIL_SECRETS",
  ];
  const prev = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = global.fetch;
  for (const key of envKeys) delete process.env[key];
  process.env.GENMAIL_MAIL_SECRETS = "memory";
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init && init.body ? String(init.body) : "" });
    return jsonResponse({ access_token: "access-new", expires_in: 3600 });
  };
  try {
    const bundled = path.join(root, "resources", "google-oauth.json");
    if (!fs.existsSync(bundled)) assert.strictEqual(oauthConfig.oauthReady().google, false);
    assert.strictEqual(oauthConfig.oauthReady().microsoft, true);
    const kept = await oauthMod.refresh(
      "google",
      { clientId: "check.apps.googleusercontent.com", clientSecret: "check-secret" },
      "refresh-1",
      oauthConfig.SCOPES.google,
      oauthConfig.ORGANIZE_SCOPES.google,
    );
    assert.strictEqual(kept.grantedScopes, oauthConfig.ORGANIZE_SCOPES.google);
    assert.ok(!seen[0].body.includes("scope="), "Google refresh must not send scope");
    const microsoftRefresh = await oauthMod.refresh(
      "microsoft",
      { clientId: oauthConfig.MICROSOFT_CLIENT_ID, clientSecret: "" },
      "refresh-ms",
      oauthConfig.CALENDAR_SCOPES.microsoft,
      oauthConfig.CALENDAR_SCOPES.microsoft,
    );
    assert.ok(microsoftRefresh.grantedScopes.includes("Calendars.ReadWrite"));
    assert.ok(seen[1].body.includes("Calendars.ReadWrite"));
    const freshCount = seen.length;
    const fresh = await oauthMod.accessTokenFor({ profile: "gmail" }, JSON.stringify({
      provider: "google",
      refreshToken: "refresh-gmail",
      accessToken: "still-good",
      expiresAt: Date.now() + 5 * 60 * 1000,
      grantedScopes: oauthConfig.SCOPES.google,
    }));
    assert.strictEqual(fresh, "still-good");
    assert.strictEqual(seen.length, freshCount);
    if (!fs.existsSync(bundled)) {
      await assert.rejects(
        () => oauthMod.accessTokenFor({ profile: "gmail" }, JSON.stringify({
          provider: "google",
          refreshToken: "refresh-gmail",
          accessToken: "old",
          expiresAt: Date.now() - 1000,
          grantedScopes: oauthConfig.SCOPES.google,
        })),
        (error) => error && error.code === "oauth_not_ready",
      );
      assert.strictEqual(seen.length, freshCount);
    }

    let labelBody = null;
    const created = await gmailApi.createLabel("token", "Travel", async (url, init) => {
      assert.strictEqual(init.method, "POST");
      assert.ok(String(url).endsWith("/labels"));
      labelBody = JSON.parse(init.body);
      return jsonResponse({ id: "Label_1", name: "Travel", type: "user" });
    });
    assert.strictEqual(labelBody.name, "Travel");
    assert.strictEqual(labelBody.labelListVisibility, "labelShow");
    assert.strictEqual(created.id, "Label_1");
    assert.strictEqual(created.editable, true);
    const modifyUrls = [];
    const modified = await gmailApi.modifyLabels("token", "<abc@example.com>", ["Label_1"], [], async (url, init) => {
      modifyUrls.push(String(url));
      if (String(url).includes("rfc822msgid")) return jsonResponse({ messages: [{ id: "gm1" }] });
      assert.strictEqual(init.method, "POST");
      assert.deepStrictEqual(JSON.parse(init.body), { addLabelIds: ["Label_1"], removeLabelIds: [] });
      return jsonResponse({});
    });
    assert.strictEqual(modified.messageId, "gm1");
    assert.ok(modifyUrls.some((url) => url.endsWith("/messages/gm1/modify")));
    const dropped = await calendarApi.listEvents("google", "token", "cal-1", {
      timeMin: "2026-10-01T00:00:00.000Z",
      timeMax: "2026-11-01T00:00:00.000Z",
    }, async (url) => {
      const href = String(url);
      if (href.includes("pageToken=page2")) {
        return jsonResponse({
          items: [
            { id: "e2", status: "cancelled", summary: "Gone", start: { dateTime: "2026-10-03T10:00:00Z" }, end: { dateTime: "2026-10-03T11:00:00Z" } },
            { summary: "No id", start: { dateTime: "2026-10-03T10:00:00Z" }, end: { dateTime: "2026-10-03T11:00:00Z" } },
            { id: "e3", summary: "Two", start: { dateTime: "2026-10-04T10:00:00Z" }, end: { dateTime: "2026-10-04T11:00:00Z" } },
          ],
        });
      }
      return jsonResponse({
        items: [
          { id: "e1", summary: "One", start: { dateTime: "2026-10-02T10:00:00Z" }, end: { dateTime: "2026-10-02T11:00:00Z" } },
        ],
        nextPageToken: "page2",
      });
    });
    assert.deepStrictEqual(dropped.events.map((event) => event.id), ["e1", "e3"]);
    assert.strictEqual(dropped.truncated, false);
    assert.strictEqual(calendarApi.pageToken("ok_token-1"), "ok_token-1");
    assert.strictEqual(calendarApi.pageToken("../evil"), "");
    assert.strictEqual(calendarApi.preferredCalendarId([
      { id: "other" },
      { id: "primary", primary: true },
    ]), "primary");
    assert.strictEqual(sidecar.monthWindow("2026-01-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"), null);
    assert.ok(sidecar.monthWindow(october.timeMin, october.timeMax));

    const engine = require("../host/mail/engine");
    const db = require("../host/mail/db");
    const secrets = require("../host/mail/secrets");
    function liveAccount(row) {
      db.insertAccount({
        username: row.email,
        imapHost: "imap.example.test",
        imapPort: 993,
        imapTls: true,
        smtpHost: "smtp.example.test",
        smtpPort: 465,
        smtpTls: true,
        delimiter: "/",
        createdAt: Date.now(),
        ...row,
      });
    }
    const calls = [];
    function route(url, init) {
      const href = String(url);
      const method = (init && init.method) || "GET";
      calls.push({ href, method });
      if (href.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/labels") && method === "GET" && !href.includes("/labels/")) {
        return jsonResponse({
          labels: [
            { id: "Label_9", name: "Travel", type: "user" },
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "Label_blank", type: "user" },
          ],
        });
      }
      if (href.includes("rfc822msgid")) return jsonResponse({ messages: [{ id: "msg-1" }] });
      if (method === "POST" && href.includes("/messages/msg-1/modify")) return jsonResponse({});
      if (href.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders") && method === "GET") {
        return jsonResponse({ value: [{ id: "folder-1", displayName: "Projects" }] });
      }
      if (href.startsWith("https://graph.microsoft.com/v1.0/me/calendars") && !href.includes("/calendarView") && method === "GET") {
        return jsonResponse({ value: [{ id: "cal-ms", name: "Grace", isDefaultCalendar: true }] });
      }
      if (href.includes("/calendarView")) {
        return jsonResponse({
          value: [{
            id: "evt-1",
            subject: "Design review",
            start: { dateTime: "2026-10-06T15:00:00Z" },
            end: { dateTime: "2026-10-06T16:00:00Z" },
            isAllDay: false,
          }],
        });
      }
      throw new Error(`unexpected provider fetch ${method} ${href}`);
    }
    global.fetch = async (url, init) => route(url, init);

    liveAccount({
      id: "gmail-pass",
      email: "pass@example.com",
      profile: "gmail",
      authKind: "password",
    });
    const passwordList = await engine.answer("mail:listProviderFolders", [{ accountId: "gmail-pass" }]);
    assert.strictEqual(passwordList.success, true);
    assert.strictEqual(passwordList.data.api, false);
    assert.strictEqual(passwordList.data.reason, "scope_missing");
    assert.match(passwordList.data.message, /password/i);
    assert.deepStrictEqual(passwordList.data.folders, []);
    const customList = await engine.answer("mail:listProviderFolders", [{ accountId: "imap-test" }]);
    assert.strictEqual(customList.data.api, false);
    assert.strictEqual(customList.data.reason, "imap_only");
    assert.strictEqual(calls.length, 0);

    liveAccount({
      id: "gmail-live",
      email: "ada.live@example.com",
      profile: "gmail",
      authKind: "oauth2",
    });
    db.insertMessage({
      id: "m-live",
      accountId: "gmail-live",
      folderPath: "INBOX",
      uid: 1,
      date: "2026-10-17T12:00:00.000Z",
      listSortTs: Date.now(),
      rfcMessageId: "<live@example.com>",
      subject: "Hi",
      from: "Ada <ada.live@example.com>",
    });
    const missingScope = await engine.answer("mail:modifyMessageLabels", [{
      accountId: "gmail-live",
      emailId: "m-live",
      addLabelIds: ["Label_9"],
    }]);
    assert.strictEqual(missingScope.success, false);
    assert.strictEqual(missingScope.error.code, "scope_missing");
    assert.strictEqual(calls.length, 0);
    const noCalendar = await engine.answer("calendar:list", [{
      accountId: "gmail-live",
      timeMin: october.timeMin,
      timeMax: october.timeMax,
    }]);
    assert.strictEqual(noCalendar.success, true);
    assert.strictEqual(noCalendar.data.api, false);
    assert.strictEqual(noCalendar.data.reason, "needs_auth");
    assert.deepStrictEqual(noCalendar.data.events, []);
    const deniedCreate = await engine.answer("calendar:createEvent", [{
      accountId: "gmail-live",
      calendarId: "cal-1",
      title: "Nope",
      start: "2026-10-17T10:00:00.000Z",
      end: "2026-10-17T11:00:00.000Z",
    }]);
    assert.strictEqual(deniedCreate.success, false);
    assert.strictEqual(calls.length, 0);

    secrets.setPassword("gmail-live:organize", JSON.stringify({
      provider: "google",
      purpose: "organize",
      refreshToken: "refresh-gmail",
      accessToken: "access-gmail",
      expiresAt: Date.now() + 10 * 60 * 1000,
      grantedScopes: oauthConfig.ORGANIZE_SCOPES.google,
      requestedScopes: oauthConfig.ORGANIZE_SCOPES.google,
    }));
    if (!fs.existsSync(bundled)) {
      const blocked = await engine.answer("mail:listProviderFolders", [{ accountId: "gmail-live" }]);
      assert.strictEqual(blocked.success, true);
      assert.strictEqual(blocked.data.api, false);
      assert.strictEqual(blocked.data.reason, "oauth_not_ready");
      assert.strictEqual(calls.length, 0);
    }
    process.env.GENMAIL_GOOGLE_OAUTH_JSON = JSON.stringify({
      installed: {
        client_id: "check-provider.apps.googleusercontent.com",
        client_secret: "check-provider-secret",
      },
    });
    const listed = await engine.answer("mail:listProviderFolders", [{ accountId: "gmail-live" }]);
    assert.strictEqual(listed.success, true);
    assert.strictEqual(listed.data.api, true);
    assert.strictEqual(listed.data.source, "gmail");
    assert.ok(listed.data.folders.some((folder) => folder.id === "Label_9" && folder.name === "Travel"));
    assert.ok(!listed.data.folders.some((folder) => folder.id === "Label_blank"));
    const changed = await engine.answer("mail:modifyMessageLabels", [{
      accountId: "gmail-live",
      emailId: "m-live",
      addLabelIds: ["Label_9"],
    }]);
    assert.strictEqual(changed.success, true);
    assert.ok(calls.some((call) => call.href.includes("/messages/msg-1/modify")));

    liveAccount({
      id: "outlook-live",
      email: "grace.live@example.com",
      profile: "outlook",
      authKind: "oauth2",
    });
    secrets.setPassword("outlook-live:organize", JSON.stringify({
      provider: "microsoft",
      purpose: "organize",
      refreshToken: "refresh-ms",
      accessToken: "access-ms",
      expiresAt: Date.now() + 10 * 60 * 1000,
      grantedScopes: oauthConfig.ORGANIZE_SCOPES.microsoft,
      requestedScopes: oauthConfig.ORGANIZE_SCOPES.microsoft,
    }));
    secrets.setPassword("outlook-live:calendar", JSON.stringify({
      provider: "microsoft",
      purpose: "calendar",
      refreshToken: "refresh-cal",
      accessToken: "access-cal",
      expiresAt: Date.now() + 10 * 60 * 1000,
      grantedScopes: oauthConfig.CALENDAR_SCOPES.microsoft,
      requestedScopes: oauthConfig.CALENDAR_SCOPES.microsoft,
    }));
    const folders = await engine.answer("mail:listProviderFolders", [{ accountId: "outlook-live" }]);
    assert.strictEqual(folders.success, true);
    assert.strictEqual(folders.data.api, true);
    assert.strictEqual(folders.data.source, "graph");
    assert.ok(folders.data.folders.some((folder) => folder.id === "folder-1" && folder.name === "Projects" && folder.editable === true));
    const month = await engine.answer("calendar:list", [{
      accountId: "outlook-live",
      timeMin: october.timeMin,
      timeMax: october.timeMax,
    }]);
    assert.strictEqual(month.success, true);
    assert.strictEqual(month.data.api, true);
    assert.strictEqual(month.data.events.length, 1);
    assert.strictEqual(month.data.events[0].id, "evt-1");
    assert.strictEqual(month.data.events[0].title, "Design review");
    assert.strictEqual(month.data.calendars[0].id, "cal-ms");
    const wide = await engine.answer("calendar:list", [{
      accountId: "outlook-live",
      timeMin: "2026-01-01T00:00:00.000Z",
      timeMax: "2026-06-01T00:00:00.000Z",
    }]);
    assert.strictEqual(wide.success, false);
    assert.strictEqual(wide.error.code, "invalid");
    const status = engine.answer("mail:oauthStatus", []);
    const statusText = JSON.stringify(status);
    assert.ok(!statusText.includes("refresh-cal"));
    assert.ok(!statusText.includes("access-cal"));
    assert.ok(!statusText.includes("check-provider-secret"));
    assert.ok(status.data.accounts.some((account) => account.id === "gmail-live" && account.organize === true && account.calendar === false));
    assert.ok(status.data.accounts.some((account) => account.id === "outlook-live" && account.calendar === true && account.organize === true));
    assert.ok(status.data.grantedScopes === undefined);
    assert.ok(status.data.accounts.some((account) => account.id === "outlook-live" && account.grantedScopes.calendar.includes("Calendars.ReadWrite")));
    secrets.setPassword("gmail-live", "imap-secret");
    const removed = await engine.answer("mail:removeAccount", [{ accountId: "gmail-live" }]);
    assert.strictEqual(removed.success, true);
    assert.strictEqual(secrets.getPassword("gmail-live"), null);
    assert.strictEqual(secrets.getPassword("gmail-live:organize"), null);
    assert.strictEqual(secrets.getPassword("gmail-live:calendar"), null);
  } finally {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function checkGoogleOauthAlias() {
  const oauth = require("../host/mail/oauth-config");
  const keys = [
    "GENMAIL_GOOGLE_OAUTH_JSON",
    "GENMAIL_GOOGLE_OAUTH_FILE",
    "MORROW_GOOGLE_OAUTH_JSON",
    "MORROW_GOOGLE_OAUTH_FILE",
    "GOOGLE_DESKTOP_OAUTH_JSON",
  ];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const desktop = JSON.stringify({
    installed: {
      client_id: "desktop-alias.apps.googleusercontent.com",
      client_secret: "desktop-alias-secret",
    },
  });
  try {
    for (const key of keys) delete process.env[key];
    process.env.GOOGLE_DESKTOP_OAUTH_JSON = `  ${desktop}  `;
    assert.deepStrictEqual(oauth.loadGoogleClient(), {
      clientId: "desktop-alias.apps.googleusercontent.com",
      clientSecret: "desktop-alias-secret",
    });
    assert.strictEqual(oauth.credentials("google").clientId, "desktop-alias.apps.googleusercontent.com");
    process.env.GENMAIL_GOOGLE_OAUTH_JSON = JSON.stringify({
      installed: {
        client_id: "genmail-primary.apps.googleusercontent.com",
        client_secret: "genmail-primary-secret",
      },
    });
    assert.strictEqual(oauth.loadGoogleClient().clientId, "genmail-primary.apps.googleusercontent.com");
    for (const key of keys) delete process.env[key];
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genmail-gclient-"));
    fs.writeFileSync(path.join(dir, "google-oauth.json"), JSON.stringify({
      installed: {
        client_id: "packaged-desktop.apps.googleusercontent.com",
        client_secret: "packaged-desktop-secret",
      },
    }));
    const prevResources = process.resourcesPath;
    process.resourcesPath = dir;
    try {
      const files = oauth.googleClientFiles();
      assert.strictEqual(files[0], path.join(root, "resources", "google-oauth.json"));
      assert.strictEqual(files[1], path.join(dir, "google-oauth.json"));
      process.env.GOOGLE_DESKTOP_OAUTH_JSON = `  ${desktop}  `;
      assert.strictEqual(oauth.loadGoogleClient().clientId, "desktop-alias.apps.googleusercontent.com");
      delete process.env.GOOGLE_DESKTOP_OAUTH_JSON;
      if (!fs.existsSync(files[0])) {
        assert.strictEqual(oauth.loadGoogleClient().clientId, "packaged-desktop.apps.googleusercontent.com");
        assert.strictEqual(oauth.oauthReady().google, true);
      }
    } finally {
      if (prevResources === undefined) delete process.resourcesPath;
      else process.resourcesPath = prevResources;
    }
  } finally {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

async function checkAiModels() {
  const os = require("os");
  const { modelsUrl, publicConfig, saveConfig, configPath } = require("../host/ai-config");
  const { modelIds, listModels } = require("../host/openai-client");
  assert.strictEqual(modelsUrl("https://api.x.ai/v1/"), "https://api.x.ai/v1/models");
  assert.strictEqual(modelsUrl("https://api.x.ai/v1"), "https://api.x.ai/v1/models");
  assert.strictEqual(modelsUrl("https://example.com/v1/models"), "https://example.com/v1/models");
  assert.deepStrictEqual(
    modelIds({ data: [{ id: "grok-4.7" }, { id: " grok-4 " }, { id: "grok-4.7" }, {}, { id: "" }] }),
    ["grok-4.7", "grok-4"],
  );
  assert.deepStrictEqual(modelIds(null), []);
  const keys = ["GENMAIL_AI_CONFIG_DIR", "GENMAIL_AI_API_KEY", "GENMAIL_AI_BASE_URL", "GENMAIL_AI_MODEL", "XAI_API_KEY"];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genmail-ai-"));
  const originalFetch = global.fetch;
  try {
    process.env.GENMAIL_AI_CONFIG_DIR = dir;
    for (const key of keys.slice(1)) delete process.env[key];
    const empty = publicConfig();
    assert.strictEqual(empty.hasKey, false);
    assert.strictEqual(empty.keyHint, "");
    assert.ok(!Object.prototype.hasOwnProperty.call(empty, "apiKey"));
    const missing = await listModels({ baseUrl: "https://api.x.ai/v1", apiKey: "" });
    assert.deepStrictEqual(missing, { ok: false, message: "Add an API key in GenMail → AI Setup." });
    let seen = null;
    global.fetch = async (url, opts) => {
      seen = { url, auth: opts.headers.authorization };
      return {
        ok: true,
        async json() {
          return { data: [{ id: "grok-4.7" }, { id: "grok-4.7" }] };
        },
      };
    };
    const drafted = await listModels({ baseUrl: "https://api.x.ai/v1/", apiKey: "sk-draft-key" });
    assert.deepStrictEqual(drafted, { ok: true, models: ["grok-4.7"] });
    assert.strictEqual(seen.url, "https://api.x.ai/v1/models");
    assert.strictEqual(seen.auth, "Bearer sk-draft-key");
    assert.ok(!JSON.stringify(drafted).includes("sk-draft"));
    const saved = saveConfig({ baseUrl: "https://example.test/v1/", model: "demo-model", apiKey: "sk-file-key" });
    assert.strictEqual(saved.baseUrl, "https://example.test/v1/");
    assert.strictEqual(saved.model, "demo-model");
    assert.strictEqual(saved.hasKey, true);
    assert.strictEqual(saved.keyHint, "••••-key");
    assert.ok(!Object.prototype.hasOwnProperty.call(saved, "apiKey"));
    assert.strictEqual(JSON.parse(fs.readFileSync(configPath(), "utf8")).apiKey, "sk-file-key");
    assert.strictEqual(fs.existsSync(path.join(dir, "settings.json")), false);
    const kept = saveConfig({ baseUrl: "https://example.test/v1", model: "demo-model", apiKey: "  " });
    assert.strictEqual(JSON.parse(fs.readFileSync(configPath(), "utf8")).apiKey, "sk-file-key");
    assert.strictEqual(kept.keyHint, "••••-key");
    global.fetch = async (url, opts) => {
      seen = { url, auth: opts.headers.authorization };
      return { ok: false, status: 401, async text() { return "bad key"; } };
    };
    const failed = await listModels({ baseUrl: "", apiKey: "" });
    assert.strictEqual(failed.ok, false);
    assert.match(failed.message, /bad key/);
    assert.ok(!Object.prototype.hasOwnProperty.call(failed, "models"));
    assert.strictEqual(seen.auth, "Bearer sk-file-key");
    assert.strictEqual(seen.url, "https://example.test/v1/models");
    process.env.GENMAIL_AI_API_KEY = "sk-env-override-zz";
    const hinted = publicConfig();
    assert.strictEqual(hinted.hasKey, true);
    assert.strictEqual(hinted.keyHint, "••••e-zz");
    assert.ok(!JSON.stringify(hinted).includes("sk-env"));
    assert.ok(!JSON.stringify(hinted).includes("sk-file"));
    global.fetch = async (_url, opts) => {
      seen = { auth: opts.headers.authorization };
      return { ok: true, async json() { return { data: [] }; } };
    };
    const fromEnv = await listModels({});
    assert.deepStrictEqual(fromEnv, { ok: true, models: [] });
    assert.strictEqual(seen.auth, "Bearer sk-env-override-zz");
    global.fetch = async () => { throw new Error("offline"); };
    const offline = await listModels({ apiKey: "sk-draft-key", baseUrl: "https://api.x.ai/v1" });
    assert.strictEqual(offline.ok, false);
    assert.match(offline.message, /offline/);
    assert.ok(!JSON.stringify(offline).includes("sk-draft"));
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

checkGoogleOauthAlias();

checkAiDraft().then(() => checkTidy()).then(() => checkProviderApi()).then(() => checkAiModels()).then(() => {
  console.log("ui-path-ok");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
