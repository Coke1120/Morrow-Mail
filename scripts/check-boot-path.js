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
  "host/update-auth.js",
  "host/updater.js",
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
const accountLabel = extractFunction(appJs, "accountLabel");
const preferredAccountId = extractFunction(appJs, "preferredAccountId");
assert.strictEqual(accountLabel({ name: "Grace Hopper", email: "grace@example.com" }), "Grace Hopper · grace@example.com");
assert.strictEqual(accountLabel({ email: "grace@example.com" }), "grace@example.com");
assert.strictEqual(accountLabel({ name: "Grace", email: "Grace" }), "Grace");
assert.strictEqual(preferredAccountId({ activeAccountId: "oauth-1", accountId: "other" }), "oauth-1");
assert.strictEqual(preferredAccountId({ accountId: "other" }), "");
assert.strictEqual(preferredAccountId(null), "");
assert.ok(appJs.includes("mail:cancelOAuth"));
assert.ok(appJs.includes("activeAccountId"));

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
assert.ok(css.includes(".dialog-body") && css.includes(".row-actions"), "shell css missing dialog scroll or row actions");
assert.ok(html.includes('id="list-filter"') && html.includes("Does not search the server."), "message list has no loaded-mail filter");
const rowActionSrc = functionSource(appJs, "rowAction");
assert.ok(!rowActionSrc.includes("textContent"), "row actions still render text labels");
assert.ok(rowActionSrc.includes('setAttribute("aria-label", label)') && rowActionSrc.includes("button.title = label"), "row actions missing accessible names");
assert.ok(appJs.includes('className = "row-actions"') && appJs.includes("Mark unread"), "message rows have no hover actions");
assert.ok(css.includes(".row-action svg"), "row actions are not icon buttons");
const filteredEmails = extractFunction(appJs, "filteredEmails");
assert.deepStrictEqual(filteredEmails([
  { subject: "Engine", from: "Charles", snippet: "table" },
  { subject: "Hello", from: "Ada", snippet: "notes" },
], "engine").map((row) => row.subject), ["Engine"]);
assert.strictEqual(filteredEmails([{ subject: "Engine", from: "Charles", snippet: "" }], "charles").length, 1);
assert.strictEqual(filteredEmails([{ subject: "Engine", from: "A", snippet: "snippet" }], "SNIPPET").length, 1);
assert.strictEqual(filteredEmails([{ subject: "Engine", from: "A", snippet: "B" }], "  ").length, 1);
assert.strictEqual(filteredEmails(null, "x").length, 0);

const threadMembers = extractFunction(appJs, "threadMembers");
assert.deepStrictEqual(threadMembers([{ id: "a" }, { id: "b" }], [{ id: "c" }]).map((row) => row.id), ["a", "b"]);
assert.deepStrictEqual(threadMembers([], [{ id: "a" }, { id: "b" }]).map((row) => row.id), ["a", "b"]);
assert.deepStrictEqual(threadMembers([{ id: "" }], null), []);
assert.deepStrictEqual(threadMembers(null, null), []);

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
const gmailAccount = {
  platform: "gmail",
  folders: {
    primary: [
      { id: "in", wellKnownName: "inbox" },
      { id: "sent", wellKnownName: "sentitems" },
      { id: "drafts", wellKnownName: "drafts" },
      { id: "arch", wellKnownName: "archive" },
    ],
    more: [],
  },
};
const outlookAccount = {
  platform: "outlook",
  folders: {
    primary: [
      { id: "in", wellKnownName: "inbox" },
      { id: "drafts", wellKnownName: "drafts" },
      { id: "sent", wellKnownName: "sentitems" },
    ],
    more: [],
  },
};
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
assert.deepStrictEqual(remoteImageSrcs(`<p>Ready.</p><img alt="Charles Babbage" src="${babbage}">`), [{ src: babbage, alt: "Charles Babbage" }]);
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
assert.ok(html.includes("Saved on this computer for the selected account"));
assert.ok(html.includes("Default for this account"));
assert.ok(html.includes("Sends while the app is open"));
assert.ok(!html.includes("Sample signatures"));
assert.ok(!appJs.includes("Sample mailbox"));
assert.ok(appJs.includes("No mailbox yet"));
assert.ok(appJs.includes("No messages yet."));
assert.ok(appJs.includes("mail:cancelScheduled"));
assert.ok(functionSource(appJs, "connectButton").includes("Connect account"));
assert.ok(functionSource(appJs, "renderReader").includes("connectButton()"));
assert.ok(functionSource(appJs, "renderAccounts").includes("connectButton()"));
assert.ok(functionSource(appJs, "renderBanner").includes("No mailbox yet"));
assert.ok(!functionSource(appJs, "renderBanner").includes("Sample"));
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
const needsToken = updateView({
  needsToken: true,
  available: true,
  error: "404 releases.atom",
}, "0.1.0");
assert.strictEqual(needsToken.status, "Private updates need a GitHub token.");
assert.ok(!needsToken.status.includes("available"));
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
assert.ok(updaterSrc.includes("setFeedURL"));
assert.ok(updaterSrc.includes("resolveGithubToken"));
assert.ok(updaterSrc.includes("needsToken"));
assert.ok(!updaterSrc.includes("releases.atom"));
assert.ok(!updaterSrc.includes("requestHeaders"));
assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(updaterSrc));
assert.ok(fs.readFileSync(path.join(root, "docs/PACKAGING.md"), "utf8").includes("github-update.json"));
assert.ok(fs.readFileSync(path.join(root, "docs/UPDATER_TEST.md"), "utf8").includes("github-update.json"));
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

const engineSrc = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
assert.ok(!engineSrc.includes("INBOX_LIMIT") && !engineSrc.includes("OTHER_LIMIT"));
assert.ok(engineSrc.includes("const REFRESH_PAGES = [20, 30, 30]"));
assert.ok(engineSrc.includes("const SYNC_DAYS = 30"));
assert.ok(engineSrc.includes("const POLL_MS = 45000"));
assert.ok(engineSrc.includes("mail:syncStatus"));
assert.ok(engineSrc.includes("limit: 40"));
const independentDoc = fs.readFileSync(path.join(root, "docs/INDEPENDENT_UI.md"), "utf8");
const parityDoc = fs.readFileSync(path.join(root, "docs/PARITY_SHELL.md"), "utf8");
assert.ok(independentDoc.includes("does not download the whole mailbox"));
assert.ok(independentDoc.includes("already downloaded"));
assert.ok(parityDoc.includes("30-day window"));
assert.ok(parityDoc.includes("does not call `mail:search`"));
assert.ok(appJs.includes("Searching all mail"));
assert.ok(html.includes("Search all mail"));
assert.ok(registered.has("mail:syncStatus"));
const syncStatusLabel = extractFunction(appJs, "syncStatusLabel");
assert.strictEqual(syncStatusLabel({ state: "paused", message: "Paused for rate limit" }), "Paused for rate limit");
assert.strictEqual(syncStatusLabel({ state: "done" }), "Sync done");
assert.strictEqual(syncStatusLabel(null), "");
assert.ok(engineSrc.includes('case "mail:scheduleSend"'));
assert.ok(engineSrc.includes('case "mail:listScheduled"'));
assert.ok(engineSrc.includes('case "mail:cancelScheduled"'));
assert.ok(!engineSrc.includes("imap_schedule_send_unsupported"));
assert.ok(!engineSrc.includes("imap_signatures_unsupported"));
assert.ok(!engineSrc.includes('require("../mailbox")'));
assert.ok(!engineSrc.includes("if (!db.hasAccounts()) return undefined"));
assert.ok(engineSrc.includes("defaultSignaturePerAccount"));
assert.ok(engineSrc.includes("SCHEDULE_TICK_MS"));
assert.ok(engineSrc.includes("while the app is closed"));
assert.ok(engineSrc.indexOf("if (sidecar.handles(channel))") < engineSrc.indexOf('case "mail:listAccounts"'));
assert.ok(!fs.existsSync(path.join(root, "host/mailbox.js")));
assert.ok(!ipcSrc.includes("./mailbox"));
assert.ok(engineSrc.includes('case "mail:upsertSignature"'));
assert.ok(engineSrc.includes('case "mail:deleteSignature"'));
for (const name of ["mail:deleteScheduled", "mail:unschedule", "mail:cancelScheduleSend"]) {
  assert.ok(!engineSrc.includes(name), `${name} appeared`);
  assert.ok(!appJs.includes(name), `renderer calls ${name}`);
}
for (const channel of ["mail:scheduleSend", "mail:listScheduled", "mail:cancelScheduled"]) {
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
  "replyParties",
  "remoteVisible",
  "prefixedSubject",
  "quoteBlock",
  "replyBody",
  "attachmentNote",
  "forwardBody",
  "composeSeed",
]);
const ada = "ada.lovelace@example.com";
const engineMail = {
  id: "m-engine",
  threadId: "m-engine",
  from: "Charles Babbage <charles@example.com>",
  to: ["Ada Lovelace <ada.lovelace@example.com>"],
  cc: ["Mary Somerville <mary@example.com>"],
  subject: "Notes on the Analytical Engine",
  htmlBody: "<p>The table of operations is ready for a second reading.</p>",
  textBody: "The table of operations is ready for a second reading.",
};
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
assert.strictEqual(reply.cc, "");
assert.strictEqual(replyAll.to, "Charles Babbage <charles@example.com>");
assert.strictEqual(replyAll.cc, "Mary Somerville <mary@example.com>");
assert.ok(!`${replyAll.to} ${replyAll.cc}`.toLowerCase().includes(ada));
const namedReply = compose.replyParties(engineMail, "Ada Lovelace <ada.lovelace@example.com>", true);
assert.ok(!`${namedReply.to} ${namedReply.cc}`.toLowerCase().includes(ada));
const own = {
  from: "Ada Lovelace <ada.lovelace@example.com>",
  to: ["Grace Hopper <grace.hopper@example.com>"],
  subject: "Re: A compiler is just another program",
  textBody: "I sketched the first pass as a table of substitutions.",
};
assert.strictEqual(compose.composeSeed(own, "reply", ada).to, "Grace Hopper <grace.hopper@example.com>");
assert.strictEqual(compose.composeSeed(own, "reply", ada).subject, "Re: A compiler is just another program");
assert.deepStrictEqual(compose.replyParties(own, ada, true), compose.replyParties(own, ada, false));
assert.deepStrictEqual(compose.replyParties(own, ada, false), {
  to: "Grace Hopper <grace.hopper@example.com>",
  cc: "",
});
const sentAll = compose.replyParties({
  from: "Ada Lovelace <ada.lovelace@example.com>",
  to: ["Grace Hopper <grace.hopper@example.com>", "Mary Somerville <mary@example.com>"],
  cc: ["Charles Babbage <charles@example.com>", "Ada Lovelace <ada.lovelace@example.com>"],
}, ada, true);
assert.strictEqual(sentAll.to, "Grace Hopper <grace.hopper@example.com>, Mary Somerville <mary@example.com>");
assert.strictEqual(sentAll.cc, "Charles Babbage <charles@example.com>");
assert.strictEqual(compose.replyParties({
  from: "Ada Lovelace <ada.lovelace@example.com>",
  to: ["Grace Hopper <grace.hopper@example.com>", "Mary Somerville <mary@example.com>"],
  cc: ["Charles Babbage <charles@example.com>"],
}, ada, false).cc, "");
assert.strictEqual(compose.remoteVisible(false, false), false);
assert.strictEqual(compose.remoteVisible(false, true), true);
assert.strictEqual(compose.remoteVisible(true, false), true);
const compiler = {
  from: "Grace Hopper <grace.hopper@example.com>",
  to: ["Ada Lovelace <ada.lovelace@example.com>"],
  subject: "A compiler is just another program",
  textBody: "Once the machine can read its own instructions, the rest follows.",
  htmlBody: "<p>Once the machine can read its own instructions, the rest follows.</p>",
  attachments: [{ id: "a-notes", filename: "notes.txt" }],
};
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
assert.ok(appJs.includes('readerButton("reply"') && appJs.includes('readerButton("reply-all"') && appJs.includes('readerButton("forward"'));
assert.ok(appJs.includes("Load remote content") && appJs.includes("remote-gate"));
assert.ok(html.includes('id="compose-cc"') && html.includes('id="compose-bcc"') && html.includes('class="compose-fields"'));
assert.ok(css.includes(".icon-btn") && css.includes(".remote-gate") && css.includes(".compose-fields") && css.includes(".field-row"));
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
assert.strictEqual(agentUi.agentStatusCopy({ reason: "idle" }).text, "");
assert.strictEqual(agentUi.agentStatusCopy({ reason: "idle", stale: true }).text, "Updating suggested todos…");
assert.strictEqual(agentUi.sectionEmptyCopy("ready"), "Nothing in this section.");
assert.strictEqual(agentUi.sectionEmptyCopy("needs_key"), "");
assert.strictEqual(agentUi.sectionEmptyCopy("idle"), "Nothing suggested yet.");
assert.strictEqual(agentUi.historyLine({ name: "Morning Brief", summary: "Two notes" }), "Morning Brief — Two notes");
assert.strictEqual(agentUi.proposalLine({ subject: "Hello", labelName: "FYI" }), "Hello → FYI");
assert.match(agentUi.runModeLabel({ schedule: "disabled", runMode: "on_demand" }), /Auto-run is off/);
const requestUi = loadFunctions(appJs, [
  "skillIdOf",
  "isLive",
  "agentContact",
  "agentContextCopy",
  "agentFollowUps",
  "agentWhen",
  "skillName",
  "skillDetail",
  "skillRequest",
  "historyRunView",
  "sectionItemsAreMail",
]);
assert.strictEqual(requestUi.agentContact("Ada <ada@example.com>"), "ada@example.com");
assert.strictEqual(requestUi.agentContact("not an email"), "");
assert.deepStrictEqual(requestUi.skillRequest({ id: "brief-this-person" }, {
  account: { id: "acct", platform: "imap" },
  email: { id: "m1", subject: "Hi", from: "Ada", snippet: "Yo" },
  contact: "Ada <ada@example.com>",
}), {
  skillId: "brief-this-person",
  accountId: "acct",
  email: { id: "m1", subject: "Hi", from: "Ada", snippet: "Yo" },
  contactEmail: "ada@example.com",
});
assert.ok(!requestUi.skillRequest({ id: "morning-brief" }, { contact: "ada@example.com" }).contactEmail);
assert.match(requestUi.agentContextCopy(null), /No message is open/);
assert.match(requestUi.agentContextCopy({ id: "m1", from: "Ada", subject: "Hi" }), /Ada — Hi/);
assert.strictEqual(requestUi.agentFollowUps({ messageId: "m1", followUps: [] }).length, 1);
assert.strictEqual(requestUi.agentFollowUps({
  messageId: "m1",
  followUps: [{ kind: "open", messageId: "m1", label: "Open" }],
}).length, 1);
assert.strictEqual(requestUi.agentFollowUps({ followUps: [{ kind: "open", messageId: "m1" }] }).length, 1);
assert.strictEqual(requestUi.agentWhen(""), "");
assert.ok(requestUi.agentWhen("2026-10-17T08:00:00.000Z"));
assert.strictEqual(requestUi.skillName({ name: "Morning Brief" }), "Morning Brief");
assert.strictEqual(requestUi.skillDetail({ description: "Today" }), "Today");
assert.strictEqual(requestUi.sectionItemsAreMail({ items: [{ messageId: "m1" }] }), true);
assert.strictEqual(requestUi.sectionItemsAreMail({ items: ["Ada"] }), false);
const viewed = requestUi.historyRunView({
  name: "Morning Brief",
  summary: "Two notes",
  accepted: true,
  sections: [{ title: "Today", items: ["Ada"] }],
  drafts: [{ body: "Hi" }],
});
assert.strictEqual(viewed.summary, "Two notes");
assert.strictEqual(viewed.sections[0].items[0], "Ada");
assert.strictEqual(requestUi.historyRunView(null), null);
assert.strictEqual(requestUi.historyRunView({ accepted: false, summary: "nope" }).accepted, false);
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
assert.ok(html.includes('id="agent-composer"') && html.includes('id="agent-send"') && html.includes('id="agent-input"'));
assert.ok(html.includes('id="agent-memory"') && html.includes('id="rail-brain"') && html.includes('id="agent-home"') && html.includes('id="side-mail"'));
assert.ok(!html.includes('id="side-agent"') && !html.includes('id="side-brain"') && !html.includes("side-switch"));
assert.ok(!html.includes('id="chrome-panel"') && !html.includes('id="agent-mail"') && !html.includes("Triage inbox"));
assert.ok(html.includes("Ask GenMail Agent") && html.includes("Manage Skills") && html.includes("Refresh todos"));
assert.ok(html.indexOf('id="rail-agent"') < html.indexOf('id="rail-mail"'));
assert.ok(html.indexOf('id="rail-mail"') < html.indexOf('id="rail-calendar"'));
assert.ok(html.indexOf('id="rail-calendar"') < html.indexOf('id="rail-brain"'));
assert.ok(html.indexOf('id="shell"') < html.indexOf('id="agent-panel"'));
assert.ok(html.indexOf('id="calendar-panel"') < html.indexOf('id="brain"'));
assert.ok(appJs.includes('["shell", "calendar-panel", "agent-panel", "brain"]') && appJs.includes("nativeAgent:home:todosCached"));
assert.ok(appJs.includes("nativeAgent:home:refreshTaxonomy") && appJs.includes("nativeAgent:home:todoUpdate"));
assert.ok(appJs.includes('source: "manual"') && appJs.includes('source: "open"'));
assert.ok(appJs.includes("nativeAgent:chat") && appJs.includes("nativeAgent:memorySet") && appJs.includes("nativeAgent:chatHistory"));
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
assert.ok(parity.includes("mail:upsertSignature") && parity.includes("defaultSignaturePerAccount"));
assert.ok(parity.includes("mail:cancelScheduled"));
assert.ok(parity.includes("while the app is open"));
assert.ok(parity.includes("mail.sqlite"));
assert.ok(!parity.includes("imap_signatures_unsupported"));
assert.ok(!parity.includes("imap_schedule_send_unsupported"));
assert.ok(!parity.includes("host/mailbox.js"));
assert.ok(independentDoc.includes("while the app is open"));
assert.ok(independentDoc.includes("mail.sqlite"));
assert.ok(independentDoc.includes("mail:cancelScheduled"));
assert.ok(!independentDoc.includes("host/mailbox.js"));
assert.ok(brainDoc.includes("no sample mailbox"));
assert.ok(!parity.includes("signatures editor"));

const providerUi = loadFunctions(appJs, [
  "oauthButtonState",
  "calendarGrantState",
  "providerFolderState",
  "providerCopy",
  "showOrganizeGrant",
  "calendarMode",
  "calendarCopy",
  "calendarConnection",
  "calendarView",
  "monthRange",
  "monthCells",
  "dayKey",
  "eventDay",
  "eventCoversDay",
  "eventsOnDay",
  "clockLabel",
  "formatEventWhen",
  "eventChip",
  "agendaEvents",
  "agendaLine",
  "sameDay",
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
assert.strictEqual(needsAuth.error, false);
assert.deepStrictEqual(needsAuth.events, []);
assert.strictEqual(providerUi.calendarView({
  api: false,
  reason: "error",
  message: "Outlook did not return events.",
}).status, "Outlook did not return events.");
assert.strictEqual(providerUi.calendarView({ api: false, reason: "error" }).error, true);
assert.strictEqual(providerUi.calendarView({ api: false, reason: "no_account" }).showGrid, false);
assert.strictEqual(
  needsAuth.status,
  "Calendar needs a calendar grant. This view does not keep events of its own.",
);
assert.strictEqual(providerUi.calendarCopy("oauth_not_ready"), "Google Desktop OAuth is not configured, so calendar stays offline.");
assert.strictEqual(providerUi.calendarCopy("no_account"), "Connect a Google or Microsoft mailbox. Calendar does not keep events of its own.");
assert.strictEqual(
  providerUi.calendarCopy("needs_auth", "ada@example.com"),
  "Calendar needs a calendar grant for ada@example.com. This view does not keep events of its own.",
);
assert.deepStrictEqual(providerUi.calendarConnection(null, null), {
  connected: false,
  canGrant: false,
  reason: "Connect a Google or Microsoft mailbox first.",
  label: "Grant calendar access",
});
assert.deepStrictEqual(providerUi.calendarConnection({
  accounts: [{ id: "a", calendar: true }],
}, { id: "a", platform: "imap", profile: "outlook" }, null), {
  connected: true,
  canGrant: true,
  reason: "",
  label: "Update calendar access",
});
assert.strictEqual(providerUi.calendarConnection({
  accounts: [{ id: "a", calendar: false, calendarReason: "needs_auth" }],
}, { id: "a", platform: "imap", profile: "outlook" }).label, "Grant calendar access");
assert.strictEqual(providerUi.calendarConnection(null, {
  id: "a",
  platform: "imap",
  profile: "gmail",
}, { api: true }).connected, true);
assert.strictEqual(providerUi.calendarConnection({ google: false }, {
  id: "a",
  platform: "imap",
  imapSmtpProfile: "gmail",
}, { api: true }).canGrant, false);
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
assert.deepStrictEqual(providerUi.eventsOnDay([
  { id: "span", start: "2026-10-03", end: "2026-10-05", allDay: true },
], "2026-10-04").map((event) => event.id), ["span"]);
assert.deepStrictEqual(providerUi.eventsOnDay([
  { id: "span", start: "2026-10-03", end: "2026-10-05", allDay: true },
], "2026-10-05"), []);
const timedDay = { start: new Date(2026, 9, 3, 15, 0).toISOString() };
assert.strictEqual(providerUi.eventCoversDay(timedDay, providerUi.dayKey(2026, 9, 3)), true);
assert.strictEqual(providerUi.eventCoversDay(timedDay, providerUi.dayKey(2026, 9, 4)), false);
assert.deepStrictEqual(providerUi.eventsOnDay(null, "2026-10-03"), []);
assert.strictEqual(providerUi.formatEventWhen({ allDay: true, start: "2026-10-03" }), "All day");
assert.strictEqual(providerUi.formatEventWhen(null), "");
assert.strictEqual(providerUi.formatEventWhen({
  start: new Date(2026, 9, 5, 15, 0).toISOString(),
  end: new Date(2026, 9, 5, 16, 30).toISOString(),
}), "3:00 PM–4:30 PM");
assert.strictEqual(providerUi.eventChip({ allDay: true, title: "Offsite", start: "2026-10-03" }), "Offsite");
assert.deepStrictEqual(providerUi.agendaEvents([
  { id: "b", start: "2026-10-04T10:00:00Z" },
  { id: "a", start: "2026-10-03", allDay: true },
]).map((event) => event.id), ["a", "b"]);
assert.match(providerUi.agendaLine({
  title: "Offsite",
  start: "2026-10-03",
  allDay: true,
  location: "HQ",
}), /All day/);
assert.strictEqual(providerUi.sameDay(2026, 9, 17, new Date(2026, 9, 17, 12)), true);
assert.strictEqual(providerUi.sameDay(2026, 9, 16, new Date(2026, 9, 17, 12)), false);
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
assert.strictEqual(drafted.location, "");
assert.ok(drafted.start < drafted.end);
assert.strictEqual(providerUi.calendarDraft({
  accountId: "a",
  calendarId: "c",
  title: "Hi",
  location: " Room 2 ",
  start: "2026-10-17T10:00",
  end: "2026-10-17T11:00",
}).location, "Room 2");
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
  "calendar:status",
  "calendar:connect",
  "calendar:list",
  "calendar:createEvent",
]) {
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(html.includes('id="rail-calendar"') && html.includes('id="calendar-panel"'));
assert.ok(html.includes('id="calendar-grant"') && html.includes("Grant calendar access"));
assert.ok(html.includes('id="calendar-create"') && html.includes('id="calendar-pick"'));
assert.ok(html.includes('id="calendar-today"') && html.includes('id="calendar-agenda"') && html.includes('id="calendar-location"'));
assert.ok(html.includes('id="agent-contact"') && html.includes('id="agent-context"'));
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
  "https://outlook.office.com/api/v2.0/me",
  "does not call Microsoft Graph",
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
assert.strictEqual(http.isRateLimit({ status: 429 }), true);
assert.strictEqual(http.isRateLimit({ code: "rate_limit" }), true);
assert.strictEqual(http.isRateLimit({ serverResponseCode: "OVERQUOTA" }), true);
assert.strictEqual(http.isRateLimit({ message: "temporary throttle" }), true);
assert.strictEqual(http.isRateLimit({ message: "login failed" }), false);
assert.strictEqual(http.retryAfterMs({ retryAfterMs: 5000 }), 5000);
assert.strictEqual(http.retryAfterMs({ retryAfterMs: 60 * 60 * 1000 }), 15 * 60 * 1000);
assert.strictEqual(http.retryAfterMs({ headers: { get(name) { return String(name).toLowerCase() === "retry-after" ? "12" : ""; } } }), 12000);
assert.strictEqual(http.retryAfterMs({}), null);
const gmailApi = require("../host/mail/provider-api");
assert.strictEqual(gmailApi.normalizeGmailLabel({ id: "Label_x", type: "user" }), null);
assert.strictEqual(gmailApi.normalizeGmailLabel({ id: "INBOX", type: "system" }).name, "INBOX");
assert.strictEqual(gmailApi.normalizeGmailLabel({ id: "INBOX", type: "system" }).editable, false);
assert.throws(() => gmailApi.normalizeGmailLabels({}), /label list/);
assert.ok(gmailApi.gmailModifyUrl("msg-1").endsWith("/messages/msg-1/modify"));
assert.ok(decodeURIComponent(gmailApi.graphSearchUrl('say "hi"', 10)).includes('$search="say+hi"'));
assert.strictEqual(gmailApi.SEARCH_CAP, 80);
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
  assert.ok(!agentSrc.includes("mail:send") && !agentSrc.includes("genmailSend"));
  const brainSrc = fs.readFileSync(path.join(root, "host/brain.js"), "utf8");
  assert.ok(brainSrc.includes("function refreshFromMail") && brainSrc.includes("function rebuildFromMail"));
  assert.ok(!/case "emailBrain:refresh":\s*case "emailBrain:rebuild"/.test(brainSrc));
  assert.ok(agentSrc.includes("agent-chat.json") && agentSrc.includes("agent-memory.json"));
  assert.ok(!agentSrc.includes("openclaw") && !agentSrc.includes("OpenClaw"));
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
      { id: "m-live", from: "Ada", subject: "Need the notes", snippet: "Can you send the notes?", date: "2026-10-17T08:00:00.000Z", unread: true },
      { id: "m-other", from: "Bea", subject: "FYI", snippet: "Receipt" },
    ],
    [{ messageId: "m-live", categoryId: "needs-you", summary: "Ada needs a reply." }, { messageId: "made-up", summary: "Invented" }],
  );
  assert.strictEqual(grouped[0].items.length, 1);
  assert.strictEqual(grouped[0].items[0].messageId, "m-live");
  assert.strictEqual(grouped[0].items[0].date, "2026-10-17T08:00:00.000Z");
  assert.strictEqual(grouped[0].items[0].unread, true);
  assert.strictEqual(grouped[1].items[0].messageId, "m-other");
  assert.strictEqual(grouped[1].items[0].date, "");
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
  const hadSent = db.recentInWellKnown;
  db.hasAccounts = () => true;
  db.recentInWellKnown = () => [{
    id: "m-sent",
    accountId: "acct-1",
    from: "Me <me@example.com>",
    subject: "Notes",
    snippet: "I'll send the notes today — short and direct.",
    date: "2026-10-17T09:00:00.000Z",
    unread: false,
    starred: false,
    hasAttachments: false,
    threadId: "t-sent",
    folderPath: "Sent",
  }];
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
    const dossier = JSON.stringify({
      ownerName: "Ada",
      writing: ["Short and direct."],
      voiceQuotes: ["I'll send the notes today."],
      sections: [
        { id: "communication-style", title: "Communication style", rows: [{ label: "Tone", value: "Direct" }] },
        { id: "work-patterns", title: "Work patterns", rows: [{ label: "Hours", value: "Mornings" }] },
        { id: "key-relationships", title: "Key relationships", rows: [{ label: "Ada", value: "Notes" }] },
        { id: "decision-preferences", title: "Decision preferences", rows: [{ label: "Speed", value: "Decide fast" }] },
      ],
    });
    const content = body.includes("personaMode")
      ? dossier
      : body.includes("draftReply")
        ? JSON.stringify({ to: "ada@example.com", subject: "Re: Need the notes", body: "Draft only.", summary: "Draft ready." })
        : body.includes("Assign each message")
      ? JSON.stringify({
        items: [{
          messageId: "m-live",
          categoryId: "needs-you",
          summary: "Ada needs a reply.",
          followUps: [{ messageId: "m-live", kind: "draft", label: "Reply", body: "I will look." }],
        }, { messageId: "made-up", categoryId: "fyi", summary: "Invented row." }],
      })
      : body.includes("question")
        ? "Ada needs a reply about the notes."
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
    assert.strictEqual(agent.routeChat("", []).kind, "empty");
    assert.strictEqual(agent.routeChat("Triage inbox", []).kind, "triage");
    assert.strictEqual(agent.routeChat("Morning Brief", agent.listHomeSkills()).skillId, "morning-brief");
    assert.strictEqual(agent.routeChat("What is unread?", agent.listHomeSkills()).kind, "chat");
    const savedMemory = agent.answer("nativeAgent:memorySet", [{ notes: "Prefer short replies." }]);
    assert.strictEqual(savedMemory.data.notes, "Prefer short replies.");
    const asked = await agent.answer("nativeAgent:chat", [{ text: "What should I handle?" }]);
    assert.strictEqual(asked.data.intent, "chat");
    assert.strictEqual(asked.data.turn.role, "agent");
    assert.match(asked.data.turn.text, /Ada needs a reply about the notes/);
    assert.ok(seenBodies.some((body) => body.includes("Prefer short replies.") && body.includes("Never invent")));
    assert.ok(!JSON.stringify(asked.data).includes("Analytical Engine"));
    const viaSkill = await agent.answer("nativeAgent:chat", [{ text: "Run Morning Brief" }]);
    assert.strictEqual(viaSkill.data.intent, "skill");
    assert.strictEqual(viaSkill.data.turn.kind, "skill");
    assert.strictEqual(viaSkill.data.turn.error, false);
    assert.ok(viaSkill.data.turn.drafts.some((row) => row.body === "I will look."));
    const viaTriage = await agent.answer("nativeAgent:chat", [{ text: "sort the inbox" }]);
    assert.strictEqual(viaTriage.data.intent, "triage");
    assert.ok(viaTriage.data.turn.triage.sections.some((section) => section.items && section.items.length));
    const chatFile = path.join(process.env.GENMAIL_AI_CONFIG_DIR, "agent-chat.json");
    const disk = JSON.parse(fs.readFileSync(chatFile, "utf8"));
    assert.ok(disk.turns.filter((turn) => turn.role === "user").length >= 3);
    const loaded = agent.answer("nativeAgent:chatHistory", []);
    assert.strictEqual(loaded.data.memory.notes, "Prefer short replies.");
    assert.strictEqual(loaded.data.turns.length, disk.turns.length);
    const briefRun = history.data.runs.find((row) => row.skillId === "morning-brief");
    const shown = agent.answer("nativeAgent:chatShow", [{ runId: briefRun.id }]);
    assert.strictEqual(shown.success, true);
    assert.ok(shown.data.turns.length > loaded.data.turns.length);
    const sample = agent.profileSample("rebuild");
    assert.strictEqual(sample.messages[0].folder, "sent");
    assert.ok(sample.messages.some((row) => row.folder === "inbox"));
    brain.answer("emailBrain:addWritingRule", [{ text: "Sticky rule." }]);
    const rebuiltPersona = brain.answer("emailBrain:rebuild", []);
    assert.strictEqual(rebuiltPersona.data.accepted, true);
    assert.strictEqual(rebuiltPersona.data.mode, "rebuild");
    async function settlePersona() {
      for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
    }
    await settlePersona();
    const afterRebuild = brain.answer("emailBrain:getCached", []);
    const rebuiltSections = brainUi.brainSections(afterRebuild.data);
    assert.ok(rebuiltSections.some((section) => section.id === "communication-style"));
    assert.ok(brainUi.brainUserRules(rebuiltSections).some((row) => row.value === "Sticky rule."));
    assert.ok((afterRebuild.data.persona.recentActivity || []).some((row) => row.kind === "rebuild"));
    assert.ok(seenBodies.some((body) => body.includes("personaMode") && body.includes("rebuild") && body.includes("I'll send the notes today")));
    const manual = brain.answer("emailBrain:refresh", [{ source: "manual" }]);
    assert.strictEqual(manual.data.accepted, true);
    assert.strictEqual(manual.data.mode, "refresh");
    assert.ok(!manual.data.cached);
    await settlePersona();
    const afterRefresh = brain.answer("emailBrain:getCached", []);
    assert.ok(brainUi.brainUserRules(brainUi.brainSections(afterRefresh.data)).some((row) => row.value === "Sticky rule."));
    assert.ok((afterRefresh.data.persona.recentActivity || []).some((row) => row.kind === "refresh"));
    assert.ok(seenBodies.some((body) => body.includes('"personaMode":"refresh"') || (body.includes("personaMode") && body.includes("refresh"))));
    brain.answer("emailBrain:saveCategories", [{
      categories: [
        { id: "fyi", name: "FYI", description: "skim", collapseView: true },
        { id: "needs-you", name: "Needs You", description: "reply", collapseView: false },
      ],
    }]);
    const reordered = agent.answer("nativeAgent:home:refreshTaxonomy", []).data;
    assert.strictEqual(reordered.stale, true);
    assert.deepStrictEqual(reordered.sections.map((section) => section.id), ["fyi", "needs-you"]);
    assert.strictEqual(reordered.sections[0].collapseView, true);
    assert.strictEqual(reordered.sections.find((section) => section.id === "needs-you").items[0].messageId, "m-live");
    const hiddenTodo = agent.answer("nativeAgent:home:todoUpdate", [{ messageId: "m-live", status: "done" }]).data;
    assert.ok(!hiddenTodo.sections.some((section) => section.items.some((item) => item.messageId === "m-live")));
    const openedTodo = agent.answer("nativeAgent:home:todoUpdate", [{ messageId: "m-live", status: "open" }]).data;
    assert.ok(openedTodo.sections.some((section) => section.items.some((item) => item.messageId === "m-live")));
    assert.strictEqual(agent.routeChat("draft a reply", agent.listHomeSkills()).kind, "draft");
    const drafted = await agent.answer("nativeAgent:chat", [{ text: "draft a reply" }]);
    assert.strictEqual(drafted.data.intent, "draft");
    assert.strictEqual(drafted.data.turn.drafts[0].body, "Draft only.");
    assert.ok(!JSON.stringify(drafted.data).includes("Analytical Engine"));
    for (const channel of ["emailBrain:setSkillAutoExecute", "emailBrain:setSkillSchedule", "emailBrain:previewRuleMatches"]) {
      const refused = brain.answer(channel, [{ skillId: "morning-brief", enabled: true }]);
      assert.strictEqual(refused.data.accepted, false);
      assert.match(refused.data.error, /only when you ask/i);
    }
  } finally {
    db.hasAccounts = hadAccounts;
    db.recentInbox = hadInbox;
    db.recentInWellKnown = hadSent;
    fs.rmSync(path.join(process.env.GENMAIL_AI_CONFIG_DIR, "brain.json"), { force: true });
    global.fetch = originalFetch;
    delete process.env.GENMAIL_AI_API_KEY;
  }
  const blockedChat = await agent.answer("nativeAgent:chat", [{ text: "Hello from the sidebar" }]);
  assert.strictEqual(blockedChat.data.intent, "chat");
  assert.strictEqual(blockedChat.data.turn.error, true);
  assert.match(blockedChat.data.turn.text, /API key/);
  const keptChat = agent.answer("nativeAgent:chatHistory", []);
  assert.ok(keptChat.data.turns.some((turn) => turn.text === "Hello from the sidebar"));
  assert.strictEqual(keptChat.data.memory.notes, "Prefer short replies.");
  assert.strictEqual((await agent.answer("nativeAgent:chat", [{ text: "  " }])).success, false);
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

async function checkSignaturesAndSchedule(engine, db) {
  const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  assert.deepStrictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]).data.signatures, []);
  assert.strictEqual(engine.answer("mail:upsertSignature", [{ accountId: "imap-test", text: "Hi" }]).error.code, "invalid");
  assert.strictEqual(engine.answer("mail:upsertSignature", [{ accountId: "imap-test", name: "  ", text: "Hi" }]).error.code, "invalid");
  assert.strictEqual(engine.answer("mail:upsertSignature", [{ accountId: "imap-test", name: "Work", text: "  ", html: "" }]).error.code, "invalid");
  assert.strictEqual(engine.answer("mail:upsertSignature", [{ accountId: "imap-test", name: "Work", text: 1 }]).error.code, "invalid");
  assert.strictEqual(engine.answer("mail:deleteSignature", [{}]).error.code, "not-found");
  const created = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    name: " Work ",
    text: "Thanks,\nAda",
    isDefault: true,
  }]);
  assert.strictEqual(created.success, true);
  assert.strictEqual(created.data.name, "Work");
  assert.strictEqual(created.data.text, "Thanks,\nAda");
  assert.strictEqual(created.data.html, undefined);
  assert.strictEqual(created.data.accountId, "imap-test");
  const createdId = created.data.id;
  const listed = engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]);
  assert.strictEqual(listed.data.defaultSignatureId, createdId);
  assert.deepStrictEqual(listed.data.defaultSignaturePerAccount, { "imap-test": createdId });
  assert.deepStrictEqual(listed.data.signatures.map((row) => row.name), ["Work"]);
  listed.data.signatures[0].name = "mutated";
  assert.strictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]).data.signatures[0].name, "Work");
  const htmlSignature = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    id: createdId,
    name: "Work",
    html: "<p>Thanks,<br>Ada</p>",
    text: "ignored",
    isDefault: true,
  }]);
  assert.strictEqual(htmlSignature.data.html, "<p>Thanks,<br>Ada</p>");
  assert.strictEqual(htmlSignature.data.text, undefined);
  const textAgain = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    id: createdId,
    name: "Work",
    text: "Thanks,\nAda",
    isDefault: true,
  }]);
  assert.strictEqual(textAgain.data.text, "Thanks,\nAda");
  assert.strictEqual(textAgain.data.html, undefined);
  const otherList = engine.answer("mail:listSignatures", [{ accountId: "imap-ol" }]);
  assert.deepStrictEqual(otherList.data.signatures, []);
  assert.strictEqual(otherList.data.defaultSignatureId, null);
  assert.strictEqual(otherList.data.defaultSignaturePerAccount["imap-test"], createdId);
  const second = engine.answer("mail:upsertSignature", [{
    accountId: "imap-ol",
    name: "Short",
    text: "— Ada",
    isDefault: true,
  }]);
  assert.strictEqual(second.success, true);
  const both = engine.answer("mail:listSignatures", []);
  assert.deepStrictEqual(both.data.signatures.map((row) => row.id), [createdId, second.data.id]);
  assert.strictEqual(both.data.defaultSignatureId, null);
  assert.deepStrictEqual(both.data.defaultSignaturePerAccount, {
    "imap-test": createdId,
    "imap-ol": second.data.id,
  });
  const keptDefault = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    id: createdId,
    name: "Work",
    text: "Thanks,\nAda",
    isDefault: false,
  }]);
  assert.strictEqual(keptDefault.success, true);
  assert.strictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]).data.defaultSignatureId, null);
  assert.strictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-ol" }]).data.defaultSignatureId, second.data.id);
  assert.strictEqual(engine.answer("mail:upsertSignature", [{
    accountId: "imap-ol",
    id: createdId,
    name: "Nope",
    text: "x",
  }]).error.code, "not-found");
  assert.strictEqual(engine.answer("mail:upsertSignature", [{ id: "missing", accountId: "imap-test", name: "Nope", text: "x" }]).error.code, "not-found");
  assert.strictEqual(engine.answer("mail:deleteSignature", [{ id: second.data.id }]).success, true);
  assert.deepStrictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-ol" }]).data.signatures, []);
  assert.strictEqual(engine.answer("mail:deleteSignature", [{ id: second.data.id }]).error.code, "not-found");
  assert.strictEqual(engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    id: createdId,
    name: "Work",
    text: "Thanks,\nAda",
    isDefault: true,
  }]).data.id, createdId);

  assert.deepStrictEqual(engine.answer("mail:listScheduled").data, []);
  const first = engine.answer("mail:scheduleSend", [{
    accountId: "imap-test",
    to: "grace@example.com",
    subject: "Later",
    body: "<p>Hi</p>",
    sendAt: future,
  }]);
  assert.strictEqual(first.success, true);
  assert.ok(first.data.id);
  const secondSend = engine.answer("mail:scheduleSend", [{
    accountId: "imap-ol",
    to: ["ada@example.com"],
    subject: "Also later",
    sendAt: future,
  }]);
  assert.strictEqual(secondSend.success, true);
  assert.strictEqual(secondSend.data.to, "ada@example.com");
  const bare = engine.answer("mail:scheduleSend", [{
    accountId: "imap-test",
    to: "grace@example.com",
    sendAt: future,
  }]);
  assert.strictEqual(bare.success, true);
  assert.strictEqual(bare.data.subject, "");
  const adaScheduled = engine.answer("mail:listScheduled", [{ accountId: "imap-test" }]);
  assert.deepStrictEqual(adaScheduled.data.map((row) => row.subject), ["Later", ""]);
  assert.strictEqual(adaScheduled.data[0].to, "grace@example.com");
  assert.strictEqual(adaScheduled.data[0].sendAt, future);
  assert.strictEqual(adaScheduled.data[0].status, "pending");
  assert.strictEqual(engine.answer("mail:listScheduled", [{ accountId: "imap-ol" }]).data.length, 1);
  assert.strictEqual(engine.answer("mail:listScheduled", [{}]).data.length, 3);
  assert.strictEqual(engine.answer("mail:scheduleSend", [{
    accountId: "imap-test",
    to: "grace@example.com",
    sendAt: new Date(Date.now() - 1000).toISOString(),
  }]).error.code, "send_at_in_past");
  assert.strictEqual(engine.answer("mail:scheduleSend", [{
    accountId: "imap-test",
    to: "  ",
    sendAt: future,
  }]).error.code, "invalid");
  assert.strictEqual(engine.answer("mail:scheduleSend", [{ accountId: "imap-test", to: "a@b.c" }]).success, false);
  assert.strictEqual(engine.answer("mail:listScheduled").data.length, 3);
  const ccOnly = engine.answer("mail:scheduleSend", [{
    accountId: "imap-test",
    cc: "mary@example.com",
    sendAt: future,
  }]);
  assert.strictEqual(ccOnly.success, true);
  assert.strictEqual(ccOnly.data.to, "");
  assert.strictEqual(ccOnly.data.cc, "mary@example.com");
  assert.strictEqual(engine.answer("mail:cancelScheduled", [{ id: first.data.id }]).success, true);
  assert.strictEqual(engine.answer("mail:cancelScheduled", [{ id: secondSend.data.id }]).success, true);
  assert.strictEqual(engine.answer("mail:cancelScheduled", [{ id: bare.data.id }]).success, true);
  assert.strictEqual(engine.answer("mail:cancelScheduled", [{ id: ccOnly.data.id }]).success, true);
  assert.deepStrictEqual(engine.answer("mail:listScheduled").data, []);
  assert.strictEqual(engine.answer("mail:cancelScheduled", [{ id: first.data.id }]).error.code, "not-found");

  const queued = engine.answer("mail:scheduleSend", [{
    accountId: "imap-test",
    to: "grace@example.com",
    subject: "After restart",
    body: "<p>Later</p>",
    threadId: "thr-later",
    sendAt: future,
  }]);
  assert.strictEqual(queued.success, true);
  db.close();
  await db.open(db.file());
  const againSig = engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]);
  assert.ok(againSig.data.signatures.some((row) => row.id === createdId && row.text === "Thanks,\nAda"));
  assert.strictEqual(againSig.data.defaultSignaturePerAccount["imap-test"], createdId);
  const againSched = engine.answer("mail:listScheduled", [{ accountId: "imap-test" }]);
  assert.ok(againSched.data.some((row) => row.id === queued.data.id && row.subject === "After restart"));

  const remote = require("../host/mail/remote");
  const savedSend = remote.sendSmtp;
  remote.sendSmtp = async () => ({ messageId: "<sched@example.test>" });
  db.setScheduledSendAt(queued.data.id, Date.now() - 1000);
  await engine.pumpScheduled();
  assert.ok(!engine.answer("mail:listScheduled").data.some((row) => row.id === queued.data.id));
  remote.sendSmtp = async () => { throw new Error("smtp down"); };
  const doomed = engine.answer("mail:scheduleSend", [{
    accountId: "imap-test",
    to: "grace@example.com",
    subject: "Will fail",
    sendAt: future,
  }]);
  db.setScheduledSendAt(doomed.data.id, Date.now() - 1000);
  await engine.pumpScheduled();
  const failed = engine.answer("mail:listScheduled", [{ accountId: "imap-test" }]).data.find((row) => row.id === doomed.data.id);
  assert.strictEqual(failed.status, "failed");
  assert.match(failed.error, /smtp down/);
  await engine.pumpScheduled();
  assert.strictEqual(engine.answer("mail:listScheduled", [{ accountId: "imap-test" }]).data.filter((row) => row.id === doomed.data.id).length, 1);
  assert.strictEqual(engine.answer("mail:cancelScheduled", [{ id: doomed.data.id }]).success, true);
  remote.sendSmtp = savedSend;

  db.insertAccount({
    id: "imap-drop",
    email: "drop@example.com",
    username: "drop@example.com",
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
  const dropSig = engine.answer("mail:upsertSignature", [{
    accountId: "imap-drop",
    name: "Drop",
    text: "Gone",
  }]);
  const dropSend = engine.answer("mail:scheduleSend", [{
    accountId: "imap-drop",
    to: "grace@example.com",
    subject: "Drop",
    sendAt: future,
  }]);
  assert.strictEqual(dropSig.success, true);
  assert.strictEqual(dropSend.success, true);
  const removed = await engine.answer("mail:removeAccount", [{ accountId: "imap-drop" }]);
  assert.strictEqual(removed.success, true);
  assert.deepStrictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-drop" }]).data.signatures, []);
  assert.deepStrictEqual(engine.answer("mail:listScheduled", [{ accountId: "imap-drop" }]).data, []);
  assert.ok(!engine.answer("mail:listAccounts").data.some((row) => row.id === "imap-drop"));
  assert.ok(engine.answer("mail:listAccounts").data.some((row) => row.id === "imap-test"));
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
  let savedRemote = null;
  try {
    const { answer: settingsAnswer } = require("../host/settings");
    assert.strictEqual(settingsAnswer("genmail:configSetShowOneClickTidy", [true]), true);
    assert.strictEqual(settingsAnswer("genmail:configGetShowOneClickTidy", []), true);
    assert.strictEqual(settingsAnswer("genmail:configSetShowOneClickTidy", [false]), false);
    assert.strictEqual(settingsAnswer("genmail:configGetShowOneClickTidy", []), false);
    assert.strictEqual(settingsAnswer("genmail:configSetShowOneClickTidy", [true]), true);
    const engine = require("../host/mail/engine");
    const db = require("../host/mail/db");
    const { createIpc } = require("../host/ipc");
    await engine.init();
    assert.strictEqual(engine.answer("genmail:configGetShowOneClickTidyEffective", []), false);
    const emptyTidy = engine.answer("mail:tidyInbox", []);
    assert.strictEqual(emptyTidy.success, true);
    assert.strictEqual(emptyTidy.data.accepted, false);
    assert.deepStrictEqual(emptyTidy.data.ids, []);
    const ipc = createIpc(path.join(dir, "ipc.log"));
    assert.strictEqual(ipc.handle({}, "genmail:configGetShowOneClickTidyEffective"), false);
    const emptyAccounts = ipc.handle({}, "mail:listAccounts");
    assert.strictEqual(emptyAccounts.success, true);
    assert.deepStrictEqual(emptyAccounts.data, []);
    const emptyList = ipc.handle({}, "mail:listFromCache", { limit: 20 });
    assert.strictEqual(emptyList.success, true);
    assert.deepStrictEqual(emptyList.data.emails, []);
    assert.ok(!JSON.stringify(emptyList.data).includes("Newsletter"));
    assert.ok(!JSON.stringify(emptyList.data).includes("ada.lovelace@example.com"));
    const blockedSend = await ipc.handle({}, "mail:send", { to: "a@b.c", subject: "x", body: "<p>x</p>" });
    assert.strictEqual(blockedSend.success, false);
    const blockedSchedule = engine.answer("mail:scheduleSend", [{
      to: "a@b.c",
      sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }]);
    assert.strictEqual(blockedSchedule.success, false);
    assert.strictEqual(engine.answer("mail:upsertSignature", [{ name: "Work", text: "Hi" }]).success, false);
    assert.deepStrictEqual(engine.answer("mail:listSignatures", []).data, {
      signatures: [],
      defaultSignatureId: null,
      defaultSignaturePerAccount: {},
    });
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

    process.env.GENMAIL_PAGE_DELAY_MS = "0";
    const remote = require("../host/mail/remote");
    const secrets = require("../host/mail/secrets");
    savedRemote = {
      withClient: remote.withClient,
      searchUids: remote.searchUids,
      fetchMessages: remote.fetchMessages,
      listFolderRecords: remote.listFolderRecords,
      findText: remote.findText,
    };
    const folders = [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Notes", name: "Notes", wellKnown: null },
    ];
    remote.listFolderRecords = async () => ({ folders, delimiter: "/" });
    remote.withClient = async (_account, _password, fn) => fn({});
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
        htmlBody: null,
        textBody: null,
        bodyComplete: true,
      };
    }
    secrets.setPassword("imap-test", "pw");
    const first = [];
    const inboxUids = Array.from({ length: 150 }, (_item, index) => index + 1);
    remote.searchUids = async () => ({ uids: inboxUids.slice(), validity: 7, exists: 500, unseen: 0 });
    remote.fetchMessages = async (_client, _folder, page) => {
      first.push(page.slice());
      return { validity: 7, messages: page.map(header) };
    };
    await engine.syncAccountById("imap-test", { onlyPath: "INBOX" });
    assert.deepStrictEqual(first.map((page) => page.length), [100, 50]);
    const inbox = db.folderByPath("imap-test", "INBOX");
    assert.strictEqual(inbox.window_done, 1);
    assert.strictEqual(inbox.uid_cursor, 150);
    first.length = 0;
    await engine.syncAccountById("imap-test", { onlyPath: "INBOX" });
    assert.deepStrictEqual(first, []);
    const burst = [];
    remote.searchUids = async (_client, _folder, query) => {
      if (query && query.uid) {
        return { uids: Array.from({ length: 100 }, (_item, index) => 151 + index), validity: 7, exists: 250, unseen: 0 };
      }
      return { uids: Array.from({ length: 250 }, (_item, index) => index + 1), validity: 7, exists: 250, unseen: 0 };
    };
    remote.fetchMessages = async (_client, _folder, page) => {
      burst.push(page.slice());
      return { validity: 7, messages: page.map(header) };
    };
    await engine.syncAccountById("imap-test", { onlyPath: "INBOX" });
    assert.deepStrictEqual(burst.map((page) => page.length), [20, 30, 30]);
    assert.strictEqual(db.folderByPath("imap-test", "INBOX").uid_cursor, 230);

    db.insertAccount({
      id: "imap-ol",
      email: "ol@example.com",
      username: "ol@example.com",
      profile: "outlook",
      imapHost: "imap.example.test",
      imapPort: 993,
      imapTls: true,
      smtpHost: "smtp.example.test",
      smtpPort: 587,
      smtpTls: true,
      delimiter: "/",
      createdAt: Date.now(),
    });
    secrets.setPassword("imap-ol", "pw");
    const outlookPages = [];
    remote.searchUids = async () => ({ uids: Array.from({ length: 60 }, (_item, index) => index + 1), validity: 3, exists: 60, unseen: 0 });
    remote.fetchMessages = async (_client, _folder, page) => {
      outlookPages.push(page.length);
      return { validity: 3, messages: page.map(header) };
    };
    await engine.syncAccountById("imap-ol", { onlyPath: "INBOX" });
    assert.deepStrictEqual(outlookPages, [50, 10]);
    assert.strictEqual(db.folderByPath("imap-ol", "INBOX").window_done, 1);

    const touched = [];
    remote.searchUids = async (_client, folder) => {
      touched.push(folder);
      return { uids: [], validity: 7, exists: 0, unseen: 0 };
    };
    remote.fetchMessages = async () => { throw new Error("background fetched a body"); };
    await engine.syncAccountById("imap-test", { background: true });
    assert.deepStrictEqual([...new Set(touched)], ["INBOX"]);
    engine.noteActive("imap-test", "Notes");
    touched.length = 0;
    await engine.syncAccountById("imap-test", { background: true });
    assert.deepStrictEqual([...new Set(touched)].sort(), ["INBOX", "Notes"]);

    const limited = Object.assign(new Error("slow down"), { status: 429, retryAfterMs: 0 });
    remote.searchUids = async () => { throw limited; };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await engine.syncAccountById("imap-ol", { onlyPath: "INBOX" });
    }
    const gate = engine.syncGates.get("imap-ol");
    assert.strictEqual(gate.strikes, 3);
    assert.ok(gate.until - Date.now() > 14 * 60 * 1000);
    let blocked = 0;
    remote.searchUids = async () => {
      blocked += 1;
      return { uids: [], validity: 3, exists: 0, unseen: 0 };
    };
    await engine.syncAccountById("imap-ol", { onlyPath: "INBOX" });
    assert.strictEqual(blocked, 0);
    assert.strictEqual(engine.syncPolicy.syncDays, 30);
    assert.deepStrictEqual(engine.syncPolicy.refreshPages, [20, 30, 30]);
    assert.strictEqual(engine.syncPolicy.headerBatch, 100);
    assert.strictEqual(engine.syncPolicy.outlookBatch, 50);
    assert.strictEqual(engine.syncPolicy.pollMs, 45000);
    assert.strictEqual(engine.syncPolicy.rateLimitMs, 30000);
    assert.strictEqual(engine.syncPolicy.stormMs, 15 * 60 * 1000);

    db.insertMessage({
      id: "m-local-only",
      accountId: "imap-test",
      folderPath: "INBOX",
      uid: 0,
      uidValidity: 7,
      threadId: "thr-local",
      subject: "Local only secret",
      snippet: "not on the server",
      from: "Local <local@example.com>",
      date: new Date().toISOString(),
      listSortTs: Date.now(),
      unread: true,
      bodyComplete: true,
    });
    let served = false;
    remote.findText = async () => {
      if (served) return { messages: [], validity: 7, searched: true };
      served = true;
      return { messages: [header(9)], validity: 7, searched: true };
    };
    const hit = await engine.answer("mail:search", [{ accountId: "imap-test", query: "Local only secret", limit: 10, filters: {} }]);
    assert.strictEqual(hit.success, true);
    assert.strictEqual(hit.data.length, 1);
    assert.strictEqual(hit.data[0].subject, "S9");
    assert.notStrictEqual(hit.data[0].id, "m-local-only");
    remote.findText = async () => ({ messages: [], validity: 7, searched: true });
    const miss = await engine.answer("mail:search", [{ accountId: "imap-test", query: "not on the server", limit: 10, filters: {} }]);
    assert.strictEqual(miss.success, true);
    assert.deepStrictEqual(miss.data, []);

    db.insertAccount({
      id: "imap-gm",
      email: "gm@example.com",
      username: "gm@example.com",
      profile: "gmail",
      imapHost: "imap.example.test",
      imapPort: 993,
      imapTls: true,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      smtpTls: true,
      delimiter: "/",
      createdAt: Date.now(),
    });
    secrets.setPassword("imap-gm", "pw");
    const boxes = [];
    remote.findText = async (_client, folder) => {
      boxes.push(folder);
      return { messages: [], validity: 4, searched: true };
    };
    const gmail = await engine.answer("mail:search", [{ accountId: "imap-gm", query: "anything", limit: 5, filters: {} }]);
    assert.strictEqual(gmail.success, true);
    assert.deepStrictEqual(gmail.data, []);
    assert.deepStrictEqual(boxes, ["[Gmail]/All Mail"]);
    await checkSignaturesAndSchedule(engine, db);
  } finally {
    if (savedRemote) {
      const remote = require("../host/mail/remote");
      remote.withClient = savedRemote.withClient;
      remote.searchUids = savedRemote.searchUids;
      remote.fetchMessages = savedRemote.fetchMessages;
      remote.listFolderRecords = savedRemote.listFolderRecords;
      remote.findText = savedRemote.findText;
    }
    delete process.env.GENMAIL_PAGE_DELAY_MS;
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
  const gmailHits = await gmailApi.searchGmail("token", "needle", 80, async (url) => {
    const href = String(url);
    if (href.includes("format=metadata")) {
      return jsonResponse({
        id: "m1",
        internalDate: "1700000000000",
        snippet: "hello",
        payload: { headers: [
          { name: "Subject", value: "Hello" },
          { name: "From", value: "a@b.c" },
          { name: "Message-ID", value: "<a@b.c>" },
        ] },
      });
    }
    return jsonResponse({ messages: [{ id: "m1" }] });
  });
  assert.strictEqual(gmailHits.length, 1);
  assert.strictEqual(gmailHits[0].subject, "Hello");
  assert.strictEqual(gmailHits[0].rfcMessageId, "<a@b.c>");
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
    assert.strictEqual(calendarApi.googleEventBody({
      title: "Standup",
      start: "2026-10-17T10:00:00.000Z",
      end: "2026-10-17T11:00:00.000Z",
    }).location, undefined);
    assert.strictEqual(calendarApi.graphEventBody({
      title: "Standup",
      start: "2026-10-17T10:00:00.000Z",
      end: "2026-10-17T11:00:00.000Z",
      location: "Room 2",
    }).location.displayName, "Room 2");
    const utcEvent = calendarApi.normalizeGraphEvent({
      id: "evt-utc",
      subject: "UTC",
      start: { dateTime: "2026-10-06T15:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-10-06T16:00:00.0000000", timeZone: "UTC" },
      isAllDay: false,
      location: { displayName: "Room 2" },
    }, "cal-ms");
    assert.strictEqual(utcEvent.start, "2026-10-06T15:00:00Z");
    assert.strictEqual(utcEvent.end, "2026-10-06T16:00:00Z");
    assert.strictEqual(utcEvent.location, "Room 2");
    const posted = [];
    const createdEvent = await calendarApi.createEvent("google", "token", "cal-1", {
      title: "Standup",
      start: "2026-10-17T10:00:00.000Z",
      end: "2026-10-17T11:00:00.000Z",
      location: "Room 2",
    }, async (_url, init) => {
      posted.push(JSON.parse(init.body));
      return jsonResponse({
        id: "evt-new",
        summary: "Standup",
        location: "Room 2",
        start: { dateTime: "2026-10-17T10:00:00Z" },
        end: { dateTime: "2026-10-17T11:00:00Z" },
      });
    });
    assert.strictEqual(posted[0].location, "Room 2");
    assert.strictEqual(posted[0].start.timeZone, "UTC");
    assert.strictEqual(createdEvent.location, "Room 2");
    assert.strictEqual(createdEvent.id, "evt-new");
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
    db.insertAccount({
      id: "oauth-draft",
      email: "draft@example.com",
      username: "draft@example.com",
      profile: "outlook",
      imapHost: "outlook.office365.com",
      imapPort: 993,
      imapTls: true,
      smtpHost: "smtp.office365.com",
      smtpPort: 587,
      smtpTls: true,
      delimiter: "/",
      createdAt: Date.now(),
      authKind: "oauth2",
    });
    db.insertAccount({
      id: "named-oauth",
      email: "named@example.com",
      username: "named@example.com",
      profile: "outlook",
      imapHost: "outlook.office365.com",
      imapPort: 993,
      imapTls: true,
      smtpHost: "smtp.office365.com",
      smtpPort: 587,
      smtpTls: true,
      delimiter: "/",
      createdAt: Date.now(),
      authKind: "oauth2",
      displayName: "Grace Hopper",
    });
    secrets.setPassword("named-oauth", JSON.stringify({ refreshToken: "keep" }));
    const namedList = engine.answer("mail:listAccounts", []);
    const named = namedList.data.find((account) => account.id === "named-oauth");
    assert.strictEqual(named.name, "Grace Hopper");
    assert.strictEqual(named.senderName, "Grace Hopper");
    assert.ok(db.accountById("oauth-draft"));
    const canceledDraft = engine.answer("mail:cancelOAuth", []);
    assert.strictEqual(canceledDraft.success, true);
    assert.strictEqual(canceledDraft.data.canceled, true);
    assert.strictEqual(db.accountById("oauth-draft"), null);
    assert.ok(db.accountById("named-oauth"));
    assert.ok(db.accountById("outlook-live"));
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

function checkUpdateAuth() {
  const os = require("os");
  const auth = require("../host/update-auth");
  const prev = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GENMAIL_USER_DATA: process.env.GENMAIL_USER_DATA,
    GENMAIL_MAIL_DIR: process.env.GENMAIL_MAIL_DIR,
    GENMAIL_AI_CONFIG_DIR: process.env.GENMAIL_AI_CONFIG_DIR,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "genmail-update-"));
  const secret = "ghp_supersecretvalue1234567890";
  try {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    process.env.GENMAIL_USER_DATA = dir;
    process.env.GENMAIL_MAIL_DIR = dir;
    process.env.GENMAIL_AI_CONFIG_DIR = dir;
    assert.strictEqual(auth.resolveGithubToken(), "");
    const missing = auth.missingTokenMessage();
    assert.ok(missing.includes("github-update.json"));
    assert.ok(missing.includes(dir));
    assert.ok(missing.includes("GH_TOKEN"));
    assert.ok(missing.includes("private"));
    assert.ok(!missing.includes("releases.atom"));
    assert.ok(!missing.includes(secret));
    const explained = auth.explainUpdateError(new Error(
      '404 "method: GET url: https://github.com/Coke1120/genmail-rea/releases.atom token ' + secret + '"'
    ));
    assert.ok(!explained.includes("releases.atom"));
    assert.ok(!explained.includes(secret));
    assert.ok(!explained.includes("available"));
    assert.match(explained, /GH_TOKEN/);
    assert.strictEqual(auth.explainUpdateError(new Error("Could not reach the mail server.")), "Could not reach the mail server.");
    fs.writeFileSync(auth.tokenFile(), JSON.stringify({ token: secret }));
    assert.strictEqual(auth.resolveGithubToken(), secret);
    process.env.GITHUB_TOKEN = "env-token-wins";
    assert.strictEqual(auth.resolveGithubToken(), "env-token-wins");
    fs.writeFileSync(auth.tokenFile(), "{");
    delete process.env.GITHUB_TOKEN;
    assert.strictEqual(auth.resolveGithubToken(), "");
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeJwt(claims) {
  return `aaa.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function hitLoopback(target) {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const req = http.get(target, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
  });
}

async function checkOauthSession() {
  const http = require("http");
  const oauthMod = require("../host/mail/oauth");
  const originalFetch = global.fetch;
  function callbackFrom(authUrl) {
    const auth = new URL(authUrl);
    const redirect = new URL(auth.searchParams.get("redirect_uri"));
    redirect.hostname = "127.0.0.1";
    redirect.searchParams.set("code", "abc");
    redirect.searchParams.set("state", auth.searchParams.get("state"));
    return redirect.toString();
  }
  try {
    assert.strictEqual(oauthMod.cancelActive(), false);
    const seen = [];
    global.fetch = async (url) => {
      const href = String(url);
      seen.push(href);
      if (href.includes("graph.microsoft.com")) throw new Error(`IMAP profile called Graph: ${href}`);
      if (href.includes("login.microsoftonline.com")) {
        return jsonResponse({
          access_token: fakeJwt({ preferred_username: "fallback@example.com", name: "Fallback" }),
          refresh_token: "refresh-imap",
          expires_in: 3600,
          scope: oauthConfig.SCOPES.microsoft,
          id_token: fakeJwt({ name: "Grace Hopper" }),
        });
      }
      if (href.startsWith("https://outlook.office.com/api/v2.0/me")) {
        return jsonResponse({ EmailAddress: "grace@example.com", DisplayName: "Grace Hopper" });
      }
      throw new Error(`unexpected oauth fetch ${href}`);
    };
    let responded = false;
    let pagePromise = null;
    const signed = await oauthMod.signIn("microsoft", "imap", {
      timeoutMs: 5000,
      openBrowser: (url) => {
        pagePromise = hitLoopback(callbackFrom(url)).then((page) => {
          responded = true;
          return page;
        });
        return Promise.resolve();
      },
    });
    assert.strictEqual(signed.email, "grace@example.com");
    assert.strictEqual(signed.displayName, "Grace Hopper");
    assert.strictEqual(responded, false);
    assert.ok(seen.some((href) => href.startsWith("https://outlook.office.com/api/v2.0/me")));
    assert.ok(!seen.some((href) => href.includes("graph.microsoft.com")));
    signed.complete({ ok: true });
    const page = await pagePromise;
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /<h1>Connected<\/h1>/);

    seen.length = 0;
    global.fetch = async (url) => {
      const href = String(url);
      seen.push(href);
      if (href.includes("graph.microsoft.com")) throw new Error(`IMAP profile called Graph: ${href}`);
      if (href.includes("login.microsoftonline.com")) {
        return jsonResponse({
          access_token: "opaque-token",
          refresh_token: "refresh-imap",
          expires_in: 3600,
          scope: oauthConfig.SCOPES.microsoft,
        });
      }
      return jsonResponse({ error: "denied" }, 401);
    };
    let failedPage = null;
    await assert.rejects(
      oauthMod.signIn("microsoft", "imap", {
        timeoutMs: 5000,
        openBrowser: (url) => {
          failedPage = hitLoopback(callbackFrom(url));
          return Promise.resolve();
        },
      }),
      (error) => error && /could not read the Outlook account profile/i.test(error.message) && /outlook\.office\.com/.test(error.message) && !/graph\.microsoft\.com\/v1\.0\/me/.test(String(seen)),
    );
    const failed = await failedPage;
    assert.strictEqual(failed.status, 400);
    assert.ok(!failed.body.includes("<h1>Connected</h1>"));
    assert.match(failed.body, /Sign-in not finished/);

    seen.length = 0;
    global.fetch = async (url) => {
      const href = String(url);
      seen.push(href);
      if (href.includes("graph.microsoft.com")) throw new Error(`IMAP profile called Graph: ${href}`);
      if (href.includes("login.microsoftonline.com")) {
        return jsonResponse({
          access_token: fakeJwt({ preferred_username: "live.com#ada@example.com", name: "Ada Lovelace" }),
          refresh_token: "refresh-imap",
          expires_in: 3600,
          scope: oauthConfig.SCOPES.microsoft,
        });
      }
      return jsonResponse({ error: "gone" }, 404);
    };
    const fallback = await oauthMod.fetchProfile(
      "microsoft",
      fakeJwt({ preferred_username: "live.com#ada@example.com", name: "Ada Lovelace" }),
      "imap",
      "",
      global.fetch,
    );
    assert.strictEqual(fallback.email, "ada@example.com");
    assert.strictEqual(fallback.displayName, "Ada Lovelace");
    assert.ok(seen.some((href) => href.startsWith("https://outlook.office.com/")));
    assert.ok(!seen.some((href) => href.includes("graph.microsoft.com")));

    global.fetch = async (url) => {
      assert.ok(String(url).includes("graph.microsoft.com"));
      return jsonResponse({ mail: "grace@example.com", displayName: "Grace" });
    };
    const graph = await oauthMod.fetchProfile("microsoft", "graph-token", "organize");
    assert.strictEqual(graph.email, "grace@example.com");
    assert.strictEqual(graph.displayName, "Grace");

    const pending = oauthMod.signIn("microsoft", "imap", {
      timeoutMs: 5000,
      openBrowser: async () => {},
    });
    const started = Date.now();
    let aborted = false;
    while (!aborted) {
      aborted = oauthMod.cancelActive();
      if (aborted) break;
      if (Date.now() - started > 1000) throw new Error("oauth session did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(pending, (error) => error && error.code === "oauth_cancelled");
    assert.strictEqual(oauthMod.cancelActive(), false);

    await assert.rejects(
      oauthMod.signIn("microsoft", "imap", { timeoutMs: 80, openBrowser: async () => {} }),
      (error) => error && error.code === "oauth_timeout",
    );
  } finally {
    global.fetch = originalFetch;
  }
}

checkGoogleOauthAlias();
checkUpdateAuth();

checkAiDraft().then(() => checkTidy()).then(() => checkProviderApi()).then(() => checkOauthSession()).then(() => checkAiModels()).then(() => {
  console.log("ui-path-ok");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
