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
  "host/mail/idle.js",
  "host/mail/remote.js",
  "host/mail/oauth.js",
  "host/mail/oauth-config.js",
  "scripts/check-mail-calendar-consent.js",
  "host/update-auth.js",
  "host/updater.js",
  "host/mail/secrets.js",
  "host/mail/secret-service.js",
  "host/mail/mac-secrets.js",
  "host/mail/win-secrets.js",
  "host/mail/provider-http.js",
  "host/mail/provider-api.js",
  "host/mail/inbox-rules.js",
  "host/mail/vacation-api.js",
  "host/mail/sieve-vacation.js",
  "host/mail/calendar-api.js",
  "host/mail/sidecar.js",
  "host/brain.js",
  "host/agent.js",
  "host/bot/constants.js",
  "host/bot/json.js",
  "host/bot/store.js",
  "host/bot/text.js",
  "host/bot/observe.js",
  "host/bot/budget.js",
  "host/bot/audit.js",
  "host/bot/auth.js",
  "host/bot/drafts.js",
  "host/bot/reads.js",
  "host/bot/service.js",
  "host/bot/server.js",
  "host/bot/manage.js",
  "scripts/morrow-bot-call.js",
  "scripts/windows-icon.js",
  "scripts/check-bot-bridge.js",
  "renderer/preload.js",
  "renderer/app.js",
  "renderer/motion-ui.js",
  "scripts/check-vacation.js",
  "scripts/bake-google-desktop-oauth.js",
  "scripts/check-bake-google-oauth.js",
];
for (const file of syntax) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

const asar = require("../host/asar");
delete process.env.MORROW_ASAR;
assert.strictEqual(asar.resolveAsarPath(), null);
assert.throws(() => asar.openAsar(), /MORROW_ASAR/);
process.env.MORROW_ASAR = "  /tmp/from-env.asar  ";
assert.strictEqual(asar.resolveAsarPath(), "/tmp/from-env.asar");
assert.strictEqual(asar.resolveAsarPath("/tmp/explicit.asar"), "/tmp/explicit.asar");
process.env.MORROW_ASAR = "";
assert.strictEqual(asar.resolveAsarPath(), null);

const forbidden = "Super App.app";
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
for (const match of appJs.matchAll(/"((?:mail|app|host|morrow|config|aiDraftWrite|emailBrain|nativeAgent|calendar|bot):[^"]+)"/g)) used.add(match[1]);
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
assert.strictEqual(pkg.build.afterPack, "./scripts/windows-icon.js");
assert.ok(pkg.build.extraResources.some((item) => item.from === "build/icon.png" && item.to === "icon.png"));
assert.strictEqual(pkg.build.nsis.installerIcon, "build/icon.ico");
assert.strictEqual(pkg.build.nsis.uninstallerIcon, "build/icon.ico");
const windowsIcon = fs.readFileSync(path.join(root, "scripts/windows-icon.js"), "utf8");
assert.ok(windowsIcon.includes('path.join(__dirname, "..", "build", "icon.ico")'));
assert.ok(windowsIcon.includes("ProductName") && windowsIcon.includes("ignoreCert: true"));
assert.ok(!windowsIcon.includes("signtool") && !windowsIcon.includes("generateExecutableWithSign"));
const { windowsFileVersion } = require("./windows-icon");
assert.deepStrictEqual(windowsFileVersion("0.1.0-alpha.13"), [0, 1, 0, 0]);
assert.deepStrictEqual(windowsFileVersion("1.2.3.4"), [1, 2, 3, 4]);
assert.throws(() => windowsFileVersion("alpha"), /numeric version/);
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
    repo: "Morrow-Mail",
    private: false,
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
assert.ok(/button\.message \{\s*display:\s*flex;[^}]*min-height:\s*60px/.test(css), "message rows are 60px");
assert.ok(css.includes("#compose[open].is-quoting") && css.includes("height: calc(100vh - 32px)"), "quoting dialog fills the window");
assert.ok(!css.includes("min(820px"), "quoting dialog no longer stops at 820px");
assert.ok(css.includes('#compose[data-quote-collapsed="true"] .compose-quote-body'), "collapse hides the quote body");
assert.ok(css.includes("#193c34") && css.includes("#102822") && css.includes("#b9d5ad") && css.includes("[data-theme=\"dark\"]"), "shell css missing logo green tokens");
assert.ok(!css.includes("#410c42") && !css.includes("#572658") && !css.includes("#7c3aed"), "shell css still uses the plum palette");
assert.ok(appJs.includes("applyShellTheme(document.documentElement"), "shell does not paint theme or accent");
assert.ok(css.includes(".thread") && css.includes(".attachments"), "shell css missing thread or attachment styles");
const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
assert.strictEqual(pkg.name, "morrow-mail");
assert.strictEqual(pkg.version, "0.1.0-alpha.13");
assert.strictEqual(pkg.build.productName, "Morrow Mail");
assert.strictEqual(pkg.build.appId, "com.coke1120.morrow-mail");
assert.notStrictEqual(pkg.build.appId, "org.morrowmail.desktop");
assert.strictEqual(pkg.build.mac.icon, "build/icon.icns");
assert.strictEqual(pkg.build.win.icon, "build/icon.ico");
assert.strictEqual(pkg.build.linux.icon, "build/icon.png");
assert.strictEqual(pkg.build.mac.extendInfo.CFBundleDisplayName, "Morrow Mail");
assert.strictEqual(pkg.build.mac.extendInfo.CFBundleName, "Morrow Mail");
assert.ok(main.includes('title: "Morrow Mail"') && main.includes('label: "Morrow Mail"'));
assert.ok(main.includes('applicationName: "Morrow Mail"') && main.includes("com.coke1120.morrow-mail"));
assert.ok(main.includes('path.join(process.resourcesPath, "icon.png")'));
assert.ok(main.includes('path.join(__dirname, "..", "build", "icon.png")'));
assert.ok(main.includes("nativeImage.createFromPath(APP_ICON)") && main.includes("app.dock.setIcon(image)"));
assert.ok(main.includes("applyDockIcon()"));
assert.ok(html.includes("<title>Morrow Mail</title>"));
assert.ok(html.includes('src="./morrow-icon.svg"') && html.includes('class="rail-logo"') && html.includes('title="Morrow Mail"'));
assert.ok(html.includes('class="rail-name"') && html.includes(">Morrow Mail</span>"));
assert.ok(html.includes('aria-label="Settings sections"'));
assert.ok(html.includes('id="product-name"') && html.includes('class="product-name"') && html.includes(">Morrow Mail</p>"));
assert.ok(html.includes('id="list-chips"') && html.includes('aria-label="Primary folders"'));
assert.ok(html.includes('aria-label="Email Brain"') && html.includes('id="rail-brain"'));
assert.ok(!html.includes('id="agent-open"') && !html.includes('id="brain-open"'));
assert.ok(main.includes('getElementById("rail-brain")') && main.includes('getElementById("rail-agent")'));
assert.ok(main.includes('setTitle("Morrow Mail")'));
assert.ok(!html.includes(">G</div>") && !html.includes("GenMail"));
const iconPng = fs.readFileSync(path.join(root, "build/icon.png"));
assert.ok(iconPng.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
assert.strictEqual(iconPng.readUInt32BE(16), 1024);
assert.strictEqual(iconPng.readUInt32BE(20), 1024);
assert.strictEqual(fs.readFileSync(path.join(root, "build/icon.icns")).slice(0, 4).toString(), "icns");
const iconIco = fs.readFileSync(path.join(root, "build/icon.ico"));
assert.strictEqual(iconIco.readUInt16LE(0), 0);
assert.strictEqual(iconIco.readUInt16LE(2), 1);
const iconSizes = Array.from({ length: iconIco.readUInt16LE(4) }, (_, i) => iconIco[6 + i * 16] || 256);
for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256]) assert.ok(iconSizes.includes(size), `Windows ICO missing ${size}px`);
assert.ok(pkg.build.extraResources.some(item => item.from === "build/icon.ico" && item.to === "icon.ico"));
const railSvg = fs.readFileSync(path.join(root, "renderer/morrow-icon.svg"), "utf8");
assert.ok(railSvg.includes("#193c34") && railSvg.includes("Morrow Mail"));
assert.strictEqual(fs.readFileSync(path.join(root, "build/morrow-icon.svg"), "utf8"), railSvg);
const { SERVICE } = require("../host/mail/secret-service");
assert.strictEqual(SERVICE, "morrow-mail");
const macSecrets = fs.readFileSync(path.join(root, "host/mail/mac-secrets.js"), "utf8");
const winSecrets = fs.readFileSync(path.join(root, "host/mail/win-secrets.js"), "utf8");
const serviceSrc = fs.readFileSync(path.join(root, "host/mail/secret-service.js"), "utf8");
assert.ok(serviceSrc.includes('const SERVICE = "morrow-mail"'));
assert.ok(!serviceSrc.includes("LEGACY_SERVICE"));
assert.ok(macSecrets.includes("return find(SERVICE, account)") && macSecrets.includes('require("./secret-service")'));
assert.ok(!macSecrets.includes("migrateRead"));
assert.ok(winSecrets.includes('const STORE_DIR = "morrow-mail"') && winSecrets.includes("return readPassword(STORE_DIR, SERVICE, account)"));
assert.ok(!winSecrets.includes("LEGACY_STORE_DIR"));
const dataPaths = require("../host/paths");
assert.strictEqual(dataPaths.PRODUCT_DATA_DIR, "Morrow Mail");
assert.ok(!Object.prototype.hasOwnProperty.call(dataPaths, "migrateLegacyUserData"));
assert.ok(!main.includes("migrateLegacyUserData"));
assert.ok(html.includes('id="search-query"'), "toolbar has no search box");
assert.ok(html.includes('src="./motion.bundle.js"'), "renderer does not load the Motion bundle");
assert.ok(pkg.dependencies && pkg.dependencies.motion, "motion is not a dependency");
const motionSrc = fs.readFileSync(path.join(root, "renderer/motion-ui.js"), "utf8");
assert.ok(motionSrc.includes('from "motion"'), "Motion UI does not import motion");
assert.ok(motionSrc.includes("prefers-reduced-motion: reduce"), "Motion UI ignores reduced motion");
assert.ok(fs.existsSync(path.join(root, "renderer/motion.bundle.js")), "Motion bundle was not built");
const motionBundle = fs.readFileSync(path.join(root, "renderer/motion.bundle.js"), "utf8");
assert.ok(motionBundle.includes("morrowMotion"), "Motion bundle missing morrowMotion");
assert.ok(motionSrc.includes("function sections(") && motionSrc.includes("function fold("), "Motion UI missing section or fold motion");
assert.ok(motionBundle.includes("sections") && motionBundle.includes("fold"), "Motion bundle missing section or fold motion");
assert.ok(appJs.includes("morrowMotion") && appJs.includes("wantsCloseMotion"), "shell does not call Motion");
assert.ok(appJs.includes("playPageSections") && appJs.includes("revealSettingsFold"));
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
assert.strictEqual(folderIcon("starred"), "⭐");
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
assert.deepStrictEqual(chipFolders({
  folders: {
    primary: [
      { id: "in", wellKnownName: "inbox" },
      { id: "__morrow_starred__", wellKnownName: "starred", type: "virtual" },
      { id: "sent", wellKnownName: "sentitems" },
      { id: "drafts", wellKnownName: "drafts" },
    ],
  },
}).map((folder) => folder.id), ["in", "sent", "drafts"]);
const chipLabel = extractFunction(appJs, "chipLabel");
assert.strictEqual(chipLabel({ name: "INBOX" }), "Inbox");
assert.strictEqual(chipLabel({ name: "inbox" }), "Inbox");
assert.strictEqual(chipLabel({ label: "INBOX", name: "Inbox" }), "Inbox");
assert.strictEqual(chipLabel({ name: "Sent Mail" }), "Sent Mail");
assert.strictEqual(chipLabel({ id: "drafts", name: "Drafts" }), "Drafts");
assert.strictEqual(chipLabel(null), "");
assert.strictEqual(chipLabel(undefined), "");
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

const shellLook = extractFunction(appJs, "shellLook");
const shouldListThread = extractFunction(appJs, "shouldListThread");
const remoteImageSrcs = extractFunction(appJs, "remoteImageSrcs");
const sendDelayMs = extractFunction(appJs, "sendDelayMs");
assert.deepStrictEqual(shellLook(null), { theme: "light", accent: "#193C34" });
assert.deepStrictEqual(shellLook({ theme: "dark", accent: "#abcdef" }), { theme: "dark", accent: "#ABCDEF" });
assert.deepStrictEqual(shellLook({ theme: "DARK", accent: "purple" }), { theme: "dark", accent: "#193C34" });
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
applyTranslate(missingKey, { reqId: "t", type: "error", message: "Add an API key in Morrow Mail → AI Setup." });
assert.strictEqual(missingKey.pending, false);
assert.strictEqual(missingKey.error, "Add an API key in Morrow Mail → AI Setup.");
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
assert.ok(appJs.includes("Connect a mailbox to download messages here."));
assert.ok(appJs.includes("mail:cancelScheduled"));
assert.ok(functionSource(appJs, "connectButton").includes("Connect account"));
assert.ok(functionSource(appJs, "renderReader").includes("connectButton()"));
assert.ok(functionSource(appJs, "renderAccounts").includes("connectButton()"));
assert.ok(!html.includes('id="banner"'));
assert.ok(appJs.includes('"Add a name."') && appJs.includes('"Add signature text."'));
assert.ok(css.includes(".signature-row") && css.includes("#signatures-status") && css.includes("#signature-form textarea"));

const updateView = extractFunction(appJs, "updateView");
const idle = updateView({}, "0.1.0");
assert.strictEqual(idle.version, "0.1.0");
assert.strictEqual(idle.status, "Updates have not been checked yet.");
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
assert.strictEqual(needsToken.status, "Update failed.");
assert.ok(!needsToken.status.includes("available"));
assert.ok(!needsToken.status.includes("Private"));
const rejectedToken = updateView({
  needsToken: true,
  available: true,
  error: "The GitHub token configured for Coke1120/Morrow-Mail was rejected.",
}, "0.1.0");
assert.strictEqual(rejectedToken.status, "Update failed.");
assert.ok(!rejectedToken.status.includes("available"));
assert.ok(!appJs.includes("Private updates"));
assert.ok(!appJs.includes("private repo"));
assert.strictEqual(updateView(null, 12).version, "");
assert.strictEqual(updateView(null, 12).status, "Updates have not been checked yet.");
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
assert.strictEqual(prefs.length, 10);
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
  "morrow:configGetAiWriteAutoOpenOnReply",
  "morrow:configGetShowFolderChips",
  "morrow:configGetSidebarGmailFoldersExpanded",
  "morrow:configGetSidebarOutlookFoldersExpanded",
]) {
  assert.ok(!ipcSrc.includes('"' + channel + '"'), channel + " still stubbed in ipc");
}
checkSettingsRoundTrip();

function checkSettingsRoundTrip() {
  const os = require("os");
  const prev = {
    MORROW_USER_DATA: process.env.MORROW_USER_DATA,
    MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR,
    MORROW_AI_CONFIG_DIR: process.env.MORROW_AI_CONFIG_DIR,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-settings-"));
  process.env.MORROW_USER_DATA = dir;
  delete process.env.MORROW_MAIL_DIR;
  delete process.env.MORROW_AI_CONFIG_DIR;
  try {
    const { answer } = require("../host/settings");
    const file = path.join(dir, "settings.json");
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(answer("config:getTheme", []), "light");
    assert.strictEqual(answer("morrow:configGetAccent", []), "#193C34");
    fs.writeFileSync(file, JSON.stringify({ accent: "#7C3AED" }));
    assert.strictEqual(answer("morrow:configGetAccent", []), "#193C34");
    fs.unlinkSync(file);
    assert.strictEqual(answer("morrow:configGetConversationViewEnabled", []), true);
    assert.strictEqual(answer("morrow:configGetAutoLoadRemoteImages", []), false);
    assert.strictEqual(answer("morrow:configGetUndoSendDelaySeconds", []), 5);
    assert.strictEqual(answer("morrow:configGetSnoozeEffective", []), true);
    assert.strictEqual(answer("morrow:configGetAiWriteAutoOpenOnReply", []), false);
    assert.strictEqual(answer("morrow:configGetShowFolderChips", []), true);
    assert.strictEqual(answer("morrow:configGetSidebarGmailFoldersExpanded", []), true);
    assert.strictEqual(answer("morrow:configGetSidebarOutlookFoldersExpanded", []), false);
    assert.strictEqual(answer("morrow:configGetComposeQuoteWidth", []), 420);
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(answer("config:setTheme", ["dark"]), "dark");
    assert.strictEqual(answer("morrow:configSetAccent", ["#112233"]), "#112233");
    assert.strictEqual(answer("morrow:configSetConversationViewEnabled", [false]), false);
    assert.strictEqual(answer("morrow:configSetAutoLoadRemoteImages", [true]), true);
    assert.strictEqual(answer("morrow:configSetUndoSendDelaySeconds", [0]), 0);
    assert.strictEqual(answer("morrow:configSetSnoozeEffective", [false]), false);
    assert.strictEqual(answer("morrow:configSetAiWriteAutoOpenOnReply", [true]), true);
    assert.strictEqual(answer("morrow:configSetShowFolderChips", [false]), false);
    assert.strictEqual(answer("morrow:configSetSidebarGmailFoldersExpanded", [false]), false);
    assert.strictEqual(answer("morrow:configSetSidebarOutlookFoldersExpanded", [true]), true);
    assert.strictEqual(answer("morrow:configSetComposeQuoteWidth", [560]), 560);
    assert.strictEqual(answer("config:getTheme", []), "dark");
    assert.strictEqual(answer("morrow:configGetAccent", []), "#112233");
    assert.strictEqual(answer("morrow:configGetConversationViewEnabled", []), false);
    assert.strictEqual(answer("morrow:configGetAutoLoadRemoteImages", []), true);
    assert.strictEqual(answer("morrow:configGetUndoSendDelaySeconds", []), 0);
    assert.strictEqual(answer("morrow:configGetSnoozeEffective", []), false);
    assert.strictEqual(answer("morrow:configGetAiWriteAutoOpenOnReply", []), true);
    assert.strictEqual(answer("morrow:configGetShowFolderChips", []), false);
    assert.strictEqual(answer("morrow:configGetSidebarGmailFoldersExpanded", []), false);
    assert.strictEqual(answer("morrow:configGetSidebarOutlookFoldersExpanded", []), true);
    assert.strictEqual(answer("morrow:configGetComposeQuoteWidth", []), 560);
    assert.strictEqual(answer("morrow:configSetAccent", ["#abcdef"]), "#ABCDEF");
    const reloaded = spawnSync(process.execPath, ["-e", `
      const { answer } = require(${JSON.stringify(path.join(root, "host/settings.js"))});
      process.stdout.write(JSON.stringify({
        theme: answer("config:getTheme", []),
        accent: answer("morrow:configGetAccent", []),
        conversation: answer("morrow:configGetConversationViewEnabled", []),
        images: answer("morrow:configGetAutoLoadRemoteImages", []),
        undo: answer("morrow:configGetUndoSendDelaySeconds", []),
        snooze: answer("morrow:configGetSnoozeEffective", []),
        aiReply: answer("morrow:configGetAiWriteAutoOpenOnReply", []),
        chips: answer("morrow:configGetShowFolderChips", []),
        gmailFolders: answer("morrow:configGetSidebarGmailFoldersExpanded", []),
        outlookFolders: answer("morrow:configGetSidebarOutlookFoldersExpanded", []),
        quoteWidth: answer("morrow:configGetComposeQuoteWidth", []),
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
      gmailFolders: false,
      outlookFolders: true,
      quoteWidth: 560,
    });
    assert.throws(() => answer("config:setTheme", ["neon"]), /light or dark/);
    assert.strictEqual(answer("config:getTheme", []), "dark");
    assert.throws(() => answer("morrow:configSetAccent", ["purple"]), /#RRGGBB/);
    assert.strictEqual(answer("morrow:configGetAccent", []), "#ABCDEF");
    assert.throws(() => answer("morrow:configSetUndoSendDelaySeconds", [31]), /0 to 30/);
    assert.strictEqual(answer("morrow:configGetUndoSendDelaySeconds", []), 0);
    assert.throws(() => answer("morrow:configSetSnoozeEffective", ["yes"]), /on or off/);
    assert.strictEqual(answer("morrow:configGetSnoozeEffective", []), false);
    assert.throws(() => answer("morrow:configSetShowFolderChips", ["yes"]), /on or off/);
    assert.strictEqual(answer("morrow:configGetShowFolderChips", []), false);
    assert.throws(() => answer("morrow:configSetComposeQuoteWidth", [10]), /220 to 720/);
    assert.strictEqual(answer("morrow:configGetComposeQuoteWidth", []), 560);
    assert.throws(() => answer("morrow:configSetComposeQuoteWidth", [800]), /220 to 720/);
    assert.strictEqual(answer("morrow:configGetComposeQuoteWidth", []), 560);
    fs.writeFileSync(file, "{");
    assert.strictEqual(answer("config:getTheme", []), "light");
    assert.strictEqual(answer("morrow:configGetComposeQuoteWidth", []), 420);
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
assert.ok(updaterSrc.includes("githubFeed"));
assert.ok(!updaterSrc.includes("resolveGithubToken"));
assert.ok(updaterSrc.includes("needsToken"));
assert.ok(!updaterSrc.includes("private: true"));
assert.ok(!updaterSrc.includes("missingTokenMessage"));
assert.ok(!updaterSrc.includes("releases.atom"));
assert.ok(!updaterSrc.includes("requestHeaders"));
assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(updaterSrc));
const prepareUpdater = functionSource(updaterSrc, "prepareUpdater");
assert.ok(!prepareUpdater.includes("return null"));
assert.ok(!prepareUpdater.includes("if (!token)"));
const authSrc = fs.readFileSync(path.join(root, "host/update-auth.js"), "utf8");
assert.ok(authSrc.includes("private: false"));
assert.ok(!authSrc.includes("private repo"));
assert.ok(!authSrc.includes("returns 404"));
assert.ok(!authSrc.includes("missingTokenMessage"));
for (const doc of ["docs/PACKAGING.md", "docs/UPDATER_TEST.md"]) {
  const text = fs.readFileSync(path.join(root, doc), "utf8");
  assert.ok(text.includes("github-update.json"), doc);
  assert.ok(text.includes("private: false"), doc);
  assert.ok(!text.includes("private: true"), doc);
  assert.ok(!text.includes("private repo"), doc);
  assert.ok(!text.includes("returns 404"), doc);
}
for (const channel of ["host:updateGetState", "host:updateCheck", "host:updateInstall"]) {
  const count = updaterSrc.split('"' + channel + '"').length - 1;
  assert.ok(count >= 2, channel + " must be registered and listed");
}
assert.ok(!html.includes('id="updates"') && !html.includes('id="update-check"'));
assert.ok(html.includes('id="rail-about"') && html.includes('id="about-update-install"'));
assert.ok(html.includes('id="rail-folders"') && html.includes('id="provider-panel"'));
assert.ok(html.includes("Check for updates") && html.includes("Restart and install"));
assert.ok(html.includes('id="settings"') && html.includes('id="prefs"') && html.includes("AI Setup"));
assert.ok(css.includes("#about-version") && css.includes("#prefs") && css.includes("#settings-status"));

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
assert.strictEqual(scheduledLine({ subject: "  ", to: "" }), "(no subject) · Unknown time · Pending");
assert.strictEqual(scheduledLine({ subject: "Hi", to: ["ada@example.com", "grace@example.com"] }).includes("ada@example.com, grace@example.com"), true);

const engineSrc = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
assert.ok(!engineSrc.includes("INBOX_LIMIT") && !engineSrc.includes("OTHER_LIMIT"));
assert.ok(engineSrc.includes("const REFRESH_PAGES = [20, 30, 30]"));
assert.ok(engineSrc.includes("const SYNC_DAYS = 180"));
assert.ok(engineSrc.includes("const POLL_MS = 45000"));
assert.ok(engineSrc.includes('require("./idle")'));
assert.ok(engineSrc.includes("backgroundPollDue"));
assert.ok(engineSrc.includes("openIdleClient"));
assert.ok(engineSrc.includes("stopIdle"));
assert.ok(main.includes('powerMonitor.on("suspend"'));
assert.ok(main.includes('powerMonitor.on("resume"'));
assert.ok(main.includes("stopIdle"));
assert.ok(html.includes('id="settings-accounts"'));
assert.ok(appJs.includes("Push connected") && appJs.includes("Checking periodically"));
assert.ok(appJs.includes("mail:setOnline"));
const pushStatusLabel = extractFunction(appJs, "pushStatusLabel");
assert.strictEqual(pushStatusLabel({ push: "push", platform: "imap" }), "Push connected");
assert.strictEqual(pushStatusLabel({ push: "polling", platform: "imap" }), "Checking periodically");
assert.strictEqual(pushStatusLabel({ platform: "imap" }), "Checking periodically");
assert.strictEqual(pushStatusLabel(null), "Checking periodically");
const remoteSrc = fs.readFileSync(path.join(root, "host/mail/remote.js"), "utf8");
assert.ok(remoteSrc.includes("disableAutoIdle: true"));
assert.ok(remoteSrc.includes("const IDLE_SOCKET_MS = 28 * 60 * 1000"));
assert.ok(engineSrc.includes("mail:syncStatus"));
assert.ok(engineSrc.includes("limit: 40"));
assert.ok(engineSrc.includes("sync_horizon_days"));
const dbSrc = fs.readFileSync(path.join(root, "host/mail/db.js"), "utf8");
assert.ok(dbSrc.includes("ADD COLUMN sync_horizon_days INTEGER"));
assert.ok(dbSrc.includes("CREATE TABLE IF NOT EXISTS message_fts"));
assert.ok(engineSrc.includes('case "mail:searchLocal"'));
assert.ok(appJs.includes("mail:searchLocal"));
assert.ok(!functionSource(appJs, "filteredEmails").includes("mail:search"));
assert.ok(!functionSource(appJs, "filteredEmails").includes("textBody"));
const independentDoc = fs.readFileSync(path.join(root, "docs/INDEPENDENT_UI.md"), "utf8");
const parityDoc = fs.readFileSync(path.join(root, "docs/PARITY_SHELL.md"), "utf8");
assert.ok(independentDoc.includes("does not download the whole mailbox"));
assert.ok(independentDoc.includes("already downloaded"));
assert.ok(independentDoc.includes("last 180 days"));
assert.ok(independentDoc.includes("advertises IDLE"));
assert.ok(parityDoc.includes("Push: on"));
assert.ok(parityDoc.includes("Push: polling"));
assert.ok(parityDoc.includes("about every 25 minutes"));
assert.ok(!independentDoc.includes("last 30 days"));
assert.ok(parityDoc.includes("180-day window"));
assert.ok(parityDoc.includes("Older than 180 days is not downloaded."));
assert.ok(!parityDoc.includes("30-day window"));
assert.ok(!parityDoc.includes("Older than 30 days"));
assert.ok(parityDoc.includes("does not call `mail:search`"));
assert.ok(appJs.includes("Searching downloaded mail"));
assert.ok(html.includes("Search downloaded mail"));
assert.ok(registered.has("mail:syncStatus"));
const syncStatusLabel = loadFunctions(appJs, ["redactDebugText", "syncStatusLabel"]).syncStatusLabel;
assert.strictEqual(syncStatusLabel({ state: "paused", message: "Paused for rate limit" }), "Paused for rate limit");
assert.strictEqual(syncStatusLabel({ state: "done" }), "Not synced yet");
assert.strictEqual(syncStatusLabel(null), "");
assert.strictEqual(syncStatusLabel({ state: "error", message: "password: hunter2" }), "password [redacted]");
const syncUi = loadFunctions(appJs, ["redactDebugText", "phaseWord", "syncClock", "syncDetail", "syncButtonLabel"]);
assert.strictEqual(syncUi.phaseWord("listing"), "Listing folders");
assert.strictEqual(syncUi.phaseWord("fetching"), "Fetching mail");
assert.strictEqual(syncUi.syncClock(0), "");
assert.ok(syncUi.syncClock(Date.UTC(2026, 0, 2, 15, 4)));
assert.strictEqual(syncUi.syncDetail(null), "");
assert.ok(syncUi.syncDetail({
  state: "syncing",
  phase: "fetching",
  accountLabel: "ada@example.com",
  folderLabel: "Inbox",
  lastSuccessAt: Date.UTC(2026, 0, 2, 15, 4),
}).includes("ada@example.com") && syncUi.syncDetail({
  state: "syncing",
  phase: "fetching",
  accountLabel: "ada@example.com",
  folderLabel: "Inbox",
}).includes("Fetching mail"));
assert.ok(syncUi.syncDetail({ state: "error", accountLabel: "ada@example.com", folderLabel: "Inbox", lastError: "Sync failed" }).includes("Sync failed"));
assert.ok(!syncUi.syncDetail({ state: "error", lastError: "password: hunter2 ya29.secrettoken" }).includes("hunter2"));
assert.strictEqual(syncUi.syncDetail({ state: "paused", message: "Paused for rate limit" }), "Paused for rate limit · Waiting before retrying");
assert.ok(syncUi.syncDetail({ state: "done", accountId: "a", folderId: "inbox", accountLabel: "Ada", folderLabel: "Inbox", lastSuccessAt: Date.UTC(2026, 0, 2, 15, 4) }).startsWith("Ada · Inbox · Last checked "));
assert.strictEqual(syncUi.syncButtonLabel({ state: "syncing" }), "Syncing");
assert.strictEqual(syncUi.syncButtonLabel({ state: "error" }), "Sync failed");
assert.strictEqual(syncUi.redactDebugText("bearer ya29.secretvalue password: hunter2"), "bearer [redacted] password [redacted]");
assert.strictEqual(syncUi.redactDebugText("api_key=sk-abcdefghij1234567890"), "api_key [redacted]");
assert.ok(syncUi.redactDebugText("synced ada@example.com").includes("ada@example.com"));
assert.ok(html.includes('id="sync-detail"') && html.includes('id="log-panel"') && html.includes('id="nav-collapse"') && html.includes('id="rail-log"'));
assert.ok(html.includes('data-label="Calendar"') && html.includes('data-label="Settings"') && html.includes('data-label="Email Brain"'));
assert.ok(html.indexOf('id="settings-open"') < html.indexOf('id="refresh"'));
assert.ok(html.indexOf('id="rail-brain"') < html.indexOf('id="settings-open"'));
assert.ok(registered.has("host:getDebugLog") && registered.has("mail:getSyncStatus"));
assert.ok(appJs.includes("host:getDebugLog") && appJs.includes("mail:getSyncStatus"));
assert.ok(css.includes('html[data-nav="collapsed"]') && css.includes(".sync-detail"));
assert.ok(engineSrc.includes('case "mail:getSyncStatus"'));
assert.ok(parityDoc.includes("host:getDebugLog") && independentDoc.includes("mail:getSyncStatus"));
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
assert.ok(appJs.includes("No pending or failed scheduled mail on this computer."));
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
  "quoteShownDefault",
  "quoteSource",
  "outgoingBody",
  "quoteWidthPref",
  "paneWidth",
  "quotePaneWidth",
  "composeLayoutMode",
  "composeFrame",
  "composeDismisses",
  "composeOutcome",
  "composeSession",
  "dismissCompose",
  "quoteStateFromSeed",
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
assert.strictEqual(reply.kind, "reply");
assert.strictEqual(reply.body, "");
assert.strictEqual(reply.quoteShown, true);
assert.ok(reply.quote.includes("Charles Babbage <charles@example.com> wrote:"));
assert.ok(reply.quote.includes("> The table of operations is ready for a second reading."));
assert.ok(!reply.quote.includes("<p>"));
assert.ok(!reply.quote.includes("mary@example.com"));
assert.strictEqual(reply.quoteEmail.htmlBody.includes("table of operations"), true);
assert.ok(compose.outgoingBody("Thanks.", reply.quote).startsWith("Thanks.\n\n"));
assert.ok(compose.outgoingBody("Thanks.", reply.quote).includes("> The table of operations is ready for a second reading."));
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
assert.strictEqual(forwarded.kind, "forward");
assert.strictEqual(forwarded.body, "");
assert.strictEqual(forwarded.quoteShown, false);
assert.ok(forwarded.quote.includes("---------- Forwarded message ----------"));
assert.ok(forwarded.quote.includes("From: Grace Hopper <grace.hopper@example.com>"));
assert.ok(forwarded.quote.includes("Once the machine can read its own instructions, the rest follows."));
assert.ok(forwarded.quote.includes("Original attachment names: notes.txt"));
assert.ok(compose.outgoingBody("Please see this.", forwarded.quote).startsWith("Please see this.\n\n"));
assert.ok(compose.outgoingBody("", forwarded.quote).includes("Forwarded message"));
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
assert.ok(htmlReply.quote.includes("> Ready & waiting."));
assert.ok(htmlReply.quote.includes("> Second line"));
assert.ok(!htmlReply.quote.includes("<p>"));
assert.strictEqual(htmlReply.quoteShown, true);
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
assert.ok(namedOnly.quote.includes("The original message has attachments. Files are not included in this forward."));
assert.ok(!namedOnly.quote.includes("Attachments:"));
assert.strictEqual(compose.attachmentNote({ attachments: [{ id: "x" }] }), "Original attachment names: attachment. Files are not included in this forward.");
assert.strictEqual(compose.composeSeed({ subject: "Hi" }, "reply", ada).to, "");
assert.strictEqual(compose.composeSeed({ subject: "Hi" }, "forward", ada).quote.includes("Forwarded message"), true);
assert.strictEqual(compose.quoteShownDefault("reply"), true);
assert.strictEqual(compose.quoteShownDefault("all"), true);
assert.strictEqual(compose.quoteShownDefault("forward"), false);
assert.strictEqual(compose.composeLayoutMode(900, 0, 0), "wide");
assert.strictEqual(compose.composeLayoutMode(899, 800, 1400), "narrow");
assert.strictEqual(compose.composeLayoutMode(0, 640, 1280), "wide");
assert.strictEqual(compose.composeLayoutMode(0, 700, 700), "narrow");
assert.strictEqual(compose.composeLayoutMode(0, 100, 1400), "wide");
assert.deepStrictEqual(compose.composeFrame(1100, 200, 1400, true, false), {
  layout: "wide",
  quote: "shown",
  direction: "row",
  divider: true,
  collapsed: false,
});
assert.deepStrictEqual(compose.composeFrame(720, 200, 800, true, false), {
  layout: "narrow",
  quote: "shown",
  direction: "column",
  divider: false,
  collapsed: false,
});
assert.strictEqual(compose.composeFrame(720, 200, 800, true, true).collapsed, true);
assert.strictEqual(compose.composeFrame(1100, 200, 1400, true, true).collapsed, false);
assert.strictEqual(compose.composeFrame(1100, 200, 1400, false, false).divider, false);
assert.strictEqual(compose.composeFrame(1100, 200, 1400, false, false).direction, "column");
assert.strictEqual(compose.quoteWidthPref(420), 420);
assert.strictEqual(compose.quoteWidthPref("480"), 480);
assert.strictEqual(compose.quoteWidthPref(219), 420);
assert.strictEqual(compose.quoteWidthPref(721), 420);
assert.strictEqual(compose.quotePaneWidth(480, 0), 480);
assert.strictEqual(compose.quotePaneWidth(200, 1100), 220);
assert.strictEqual(compose.quotePaneWidth(800, 1100), 720);
assert.strictEqual(compose.quotePaneWidth(700, 900), 580);
assert.deepStrictEqual(compose.composeSession(["close"]), []);
assert.deepStrictEqual(compose.composeSession(["cancel"]), []);
assert.deepStrictEqual(compose.composeSession(["cancel", "close"]), []);
assert.deepStrictEqual(compose.composeSession(["save", "close"]), ["mail:upsertDraft"]);
assert.deepStrictEqual(compose.composeSession(["send"]), ["mail:send"]);
assert.strictEqual(compose.dismissCompose("close"), true);
assert.strictEqual(compose.dismissCompose("cancel"), true);
assert.strictEqual(compose.dismissCompose("send"), false);
assert.strictEqual(compose.composeOutcome("close"), "");
assert.strictEqual(compose.composeOutcome("cancel"), "");
const hostile = compose.composeSeed({
  from: "Eve <eve@example.com>",
  subject: "Hi",
  htmlBody: '<p>Hello</p><script>alert(1)</script><img src="javascript:alert(2)" alt="x"><img src="https://example.com/a.png" alt="Gear">',
}, "reply", ada);
assert.ok(hostile.quote.includes("> Hello"));
assert.ok(!hostile.quote.includes("<script>"));
assert.ok(!hostile.quote.includes("javascript:"));
assert.ok(hostile.quoteEmail.htmlBody.includes("<script>"));
const remoteImages = extractFunction(appJs, "remoteImageSrcs");
assert.deepStrictEqual(remoteImages(hostile.quoteEmail.htmlBody).map((image) => image.src), ["https://example.com/a.png"]);
const quotePaint = functionSource(appJs, "paintQuoteBody");
const bodyPaint = functionSource(appJs, "appendMessageBody");
assert.ok(quotePaint.includes("appendMessageBody"));
assert.ok(bodyPaint.includes("textContent"));
assert.ok(bodyPaint.includes("readable("));
assert.ok(!bodyPaint.includes("innerHTML"));
assert.ok(functionSource(appJs, "renderBody").includes("appendMessageBody"));
assert.ok(functionSource(appJs, "composePayload").includes("outgoingBody"));
assert.ok(!functionSource(appJs, "dismissCompose").includes("mail:send"));
assert.ok(appJs.includes("requestComposeClose()") && html.includes('id="compose-close-review"'));
assert.ok(html.includes('id="compose-quote"') && html.includes('id="compose-split-handle"') && html.includes('id="compose-quote-toggle"'));
assert.ok(html.includes('id="compose-quote-collapse"') && html.includes("Hide quoted message") === false);
assert.ok(html.includes("Show original preview") && html.includes("The quoted original is still included when you save, send, or schedule."));
assert.ok(html.includes("M1 12s4-8 11-8") && html.includes("M17.94 17.94A10.07") && html.includes('points="6 9 12 15 18 9"'));
assert.ok(css.includes('#compose[data-layout="wide"][data-quote="shown"] .compose-split'));
assert.ok(css.includes('#compose[data-layout="narrow"][data-quote="shown"] .compose-quote'));
const wideRule = css.slice(css.indexOf('#compose[data-layout="wide"][data-quote="shown"] .compose-split'));
assert.ok(wideRule.slice(0, 240).includes("flex-direction: row"));
assert.ok(css.includes("--compose-quote") && css.includes("prefers-reduced-motion: reduce"));
assert.ok(appJs.includes("fadePane") && motionSrc.includes("function fadePane"));
assert.ok(appJs.includes("morrow:configGetComposeQuoteWidth") && appJs.includes("morrow:configSetComposeQuoteWidth"));
assert.strictEqual(compose.quoteStateFromSeed({}), null);
assert.strictEqual(compose.quoteStateFromSeed(null), null);
assert.ok(appJs.includes("Hide original preview"));
assert.strictEqual(replyAll.quoteShown, true);
assert.strictEqual(compose.quoteStateFromSeed(reply).shown, true);
assert.strictEqual(compose.quoteStateFromSeed(forwarded).shown, false);
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
ai.applyDraftEvent(failedDraft, { reqId: "d", type: "error", message: "Add an API key in Morrow Mail → AI Setup." });
assert.strictEqual(failedDraft.pending, false);
assert.strictEqual(failedDraft.error, "Add an API key in Morrow Mail → AI Setup.");
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
assert.strictEqual(suggested.body, "Thanks, I'll read it.");
assert.ok(suggested.quote.includes("> See you"));
assert.ok(compose.outgoingBody(suggested.body, suggested.quote).startsWith("Thanks, I'll read it.\n\n"));
assert.ok(compose.outgoingBody(suggested.body, suggested.quote).includes("> See you"));
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
assert.strictEqual(brainUi.brainMessage({ accepted: false }).text, "Needs an AI key. Open Morrow Mail → AI Setup.");
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
assert.deepStrictEqual(brainUi.brainPaneIds().map((row) => row[0]), ["profile", "categories", "skills", "rules"]);
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
assert.ok(html.includes('id="brain-tab-profile"') && html.includes('id="brain-tab-categories"') && html.includes('id="brain-tab-skills"') && html.includes('id="brain-tab-rules"') && html.includes('id="brain-meta"'));
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
  brainUi.skillResultMessage({ accepted: false, error: "Add an API key in Morrow Mail → AI Setup." }),
  { text: "Add an API key in Morrow Mail → AI Setup.", error: true },
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
  "scheduleFormValue",
]);
assert.deepStrictEqual(agentUi.skillBlocks(null), []);
assert.deepStrictEqual(agentUi.skillBlocks({ accepted: false, summary: "nope" }), []);
assert.strictEqual(agentUi.skillBlocks({ accepted: true, summary: "Hi", note: "Mail only", sections: [{ title: "Today", items: ["Ada"] }] })[2].title, "Today");
assert.deepStrictEqual(agentUi.agentSections(null), []);
assert.strictEqual(agentUi.agentItemLine({ from: "Ada", subject: "Hi", summary: "Reply" }), "Ada — Hi — Reply");
assert.strictEqual(agentUi.agentStatusCopy({ reason: "needs_key", error: "Add an API key in Morrow Mail → AI Setup." }).error, true);
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
assert.match(agentUi.runModeLabel({ schedule: "interval", everyMinutes: 30 }), /Every 30 min/);
assert.match(agentUi.runModeLabel({ schedule: "paused", paused: true, kind: "cron", cron: "0 8 * * 1" }), /Paused/);
assert.match(agentUi.runModeLabel({ schedule: "cron", cron: "0 8 * * 1-5" }), /0 8 \* \* 1-5/);
assert.strictEqual(agentUi.scheduleFormValue({ kind: "off" }).action, "delete");
assert.strictEqual(agentUi.scheduleFormValue({ kind: "interval", everyMinutes: 15 }).everyMinutes, 15);
assert.strictEqual(agentUi.scheduleFormValue({ kind: "interval", everyMinutes: 0 }).error.includes("10080"), true);
assert.strictEqual(agentUi.scheduleFormValue({ kind: "cron", cron: "  0   8 * * 1-5  " }).cron, "0 8 * * 1-5");
assert.ok(agentUi.scheduleFormValue({ kind: "cron", cron: "   " }).error);
assert.ok(appJs.includes("emailBrain:setSkillSchedule") && appJs.includes("emailBrain:deleteSkillSchedule"));
assert.ok(appJs.includes("emailBrain:scheduleFired") && appJs.includes('textContent = paused ? "Resume" : "Pause"'));
assert.ok(appJs.includes('textContent = "Save schedule"'));
assert.ok(main.includes("startSkillScheduler"));
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
  studioUi.envelopeError({ success: false, error: { message: "Add an API key in Morrow Mail → AI Setup." } }),
  "Add an API key in Morrow Mail → AI Setup.",
);
for (const channel of studioUi.studioLists().map((row) => row[1])) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
  assert.ok(ipcSrc.includes('"' + channel + '"'), `host stub missing ${channel}`);
}
assert.ok(!html.includes('id="tidy"') && !html.includes("One-click tidy") && !html.includes('id="pref-tidy"'));
assert.ok(!registered.has("mail:tidyInbox") && !used.has("mail:tidyInbox"));
assert.ok(!registered.has("morrow:configGetShowOneClickTidy") && !registered.has("morrow:configSetShowOneClickTidy"));
assert.ok(!registered.has("morrow:configGetShowOneClickTidyEffective") && !used.has("morrow:configGetShowOneClickTidyEffective"));
assert.ok(!appJs.includes("function showTidy") && !appJs.includes("function tidyInbox") && !appJs.includes("mail:tidyInbox"));
assert.ok(html.includes('id="agent-panel"') && !html.includes('id="agent-open"') && html.includes('id="studio-home"') && html.includes('id="studio-library"'));
assert.ok(html.includes('id="agent-composer"') && html.includes('id="agent-send"') && html.includes('id="agent-input"'));
assert.ok(html.includes('id="agent-memory"') && html.includes('id="rail-brain"') && html.includes('id="agent-home"') && html.includes('id="side-mail"'));
assert.ok(!html.includes('id="side-agent"') && !html.includes('id="side-brain"') && !html.includes("side-switch"));
assert.ok(!html.includes('id="chrome-panel"') && !html.includes('id="agent-mail"') && !html.includes("Triage inbox"));
assert.ok(html.includes("Ask Morrow Mail") && html.includes("Manage Skills") && html.includes("Refresh todos"));
assert.ok(html.indexOf('id="rail-agent"') < html.indexOf('id="rail-mail"'));
assert.ok(html.indexOf('id="rail-mail"') < html.indexOf('id="rail-calendar"'));
assert.ok(html.indexOf('id="rail-calendar"') < html.indexOf('id="rail-brain"'));
assert.ok(html.indexOf('id="shell"') < html.indexOf('id="agent-panel"'));
assert.ok(html.indexOf('id="calendar-panel"') < html.indexOf('id="brain"'));
assert.ok(appJs.includes('["shell", "calendar-panel", "agent-panel", "brain", "provider-panel"]') && appJs.includes("nativeAgent:home:todosCached"));
assert.ok(appJs.includes("nativeAgent:home:refreshTaxonomy") && appJs.includes("nativeAgent:home:todoUpdate"));
assert.ok(appJs.includes('source: "manual"') && appJs.includes('source: "open"'));
assert.ok(appJs.includes("nativeAgent:chat") && appJs.includes("nativeAgent:memorySet") && appJs.includes("nativeAgent:chatHistory"));
assert.ok(html.includes('id="rail-agent"') && html.includes('id="agent-sections"') && html.includes('id="agent-triage"'));
assert.ok(html.includes(">Agent<") && html.includes("Home skills") && html.includes("Library skills") && html.includes("Skills run on demand"));
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
assert.ok(parity.includes("morrow:configSetAiWriteAutoOpenOnReply") && parity.includes("morrow:configSetShowFolderChips"));
assert.ok(parity.includes("morrow:configSetSidebarGmailFoldersExpanded"));
assert.ok(parity.includes("morrow:configSetSidebarOutlookFoldersExpanded"));
assert.ok(parity.includes("above the message list") && parity.includes("open the compose AI write controls"));
assert.ok(parity.includes("Brain → Organize Inbox") && independentDoc.includes("Brain → Organize Inbox"));
assert.ok(!parity.includes("mail:tidyInbox") && !parity.includes("morrow:configSetShowOneClickTidy"));
assert.ok(!parity.includes("morrow:configGetShowOneClickTidyEffective") && !independentDoc.includes("one-click tidy"));
assert.ok(!parity.includes("does not add a button"));
assert.ok(css.includes(".chips") && css.includes("button.account") && css.includes(".ai-write.open"));
assert.ok(parity.includes("morrow:configGetDogfoodPrefs") && parity.includes("morrow:configGetShowJevClassification"));
assert.ok(parity.includes("morrow:configGetCalendarSidebarOrder"));
assert.ok(!parity.includes("Other host preferences, calendar"));
assert.ok(!parity.includes("full skills library"));
assert.ok(!parity.includes("AI Studio, calendar"));
assert.ok(parity.includes("skills library"));
assert.ok(parity.includes("config:setTheme") && parity.includes("morrow:configSetSnoozeEffective"));
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
  "grantApiOutcome",
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
  "vacationProvider",
  "vacationLink",
  "vacationDraft",
  "vacationView",
  "vacationConfirm",
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
const organizeUi = loadFunctions(appJs, [
  "providerFolderState",
  "providerCopy",
  "folderDelimiter",
  "nestRows",
  "imapParent",
  "folderTree",
  "providerParent",
  "providerLabelText",
  "providerLabelTree",
  "messageDragPayload",
  "isStarredFolder",
  "isVirtualMailbox",
  "storableFolders",
  "organizeDrop",
  "organizeMenu",
]);
assert.deepStrictEqual(organizeUi.folderTree([
  { id: "INBOX", name: "Inbox" },
  { id: "INBOX/Work", name: "Work" },
  { id: "INBOX/Work/2024", name: "2024" },
  { id: "Notes", name: "Notes" },
  { id: "Archive/Old", name: "Old" },
]).map((folder) => [folder.id, folder.depth, folder.label, folder.parentId]), [
  ["INBOX", 0, "Inbox", ""],
  ["INBOX/Work", 1, "Work", "INBOX"],
  ["INBOX/Work/2024", 2, "2024", "INBOX/Work"],
  ["Notes", 0, "Notes", ""],
  ["Archive/Old", 0, "Old", ""],
]);
assert.strictEqual(organizeUi.folderDelimiter([
  { id: "INBOX", name: "Inbox" },
  { id: "INBOX.Work", name: "Work" },
]), ".");
assert.deepStrictEqual(organizeUi.folderTree([
  { id: "INBOX", name: "Inbox" },
  { id: "INBOX.Work", name: "Work" },
]).map((folder) => [folder.id, folder.depth, folder.parentId]), [
  ["INBOX", 0, ""],
  ["INBOX.Work", 1, "INBOX"],
]);
assert.deepStrictEqual(organizeUi.providerLabelTree([
  { id: "INBOX", name: "INBOX", editable: false },
  { id: "L1", name: "Work", editable: true },
  { id: "L2", name: "Work/Travel", editable: true },
  { id: "L3", name: "Work/Travel/2024", editable: true },
  { id: "L4", name: "Solo/Missing", editable: true },
]).map((folder) => [folder.id, folder.depth, folder.label, folder.parentId]), [
  ["INBOX", 0, "INBOX", ""],
  ["L1", 0, "Work", ""],
  ["L2", 1, "Travel", "L1"],
  ["L3", 2, "2024", "L2"],
  ["L4", 0, "Solo/Missing", ""],
]);
assert.deepStrictEqual(organizeUi.providerLabelTree([
  { id: "in", name: "Inbox", parentId: "msgfolderroot", editable: false },
  { id: "c1", name: "Receipts", parentId: "in", editable: true },
]).map((folder) => [folder.id, folder.depth, folder.label, folder.parentId]), [
  ["in", 0, "Inbox", ""],
  ["c1", 1, "Receipts", "in"],
]);
assert.deepStrictEqual(organizeUi.providerLabelTree([
  { id: "a", name: "A", parentId: "b" },
  { id: "b", name: "B", parentId: "a" },
]).map((folder) => [folder.id, folder.depth]), [
  ["a", 0],
  ["b", 1],
]);
const dragMessage = { id: "m1", accountId: "a1", folderId: "INBOX" };
assert.deepStrictEqual(organizeUi.messageDragPayload(dragMessage), {
  id: "m1",
  accountId: "a1",
  folderId: "INBOX",
});
assert.strictEqual(organizeUi.messageDragPayload({ id: "m1" }), null);
assert.deepStrictEqual(organizeUi.organizeDrop({ kind: "imap", id: "Notes", accountId: "a1" }, dragMessage), {
  ok: true,
  channel: "mail:moveToFolder",
  params: {
    emailId: "m1",
    accountId: "a1",
    targetFolderId: "Notes",
    folderId: "INBOX",
  },
});
assert.strictEqual(organizeUi.organizeDrop({ kind: "imap", id: "INBOX", accountId: "a1" }, dragMessage).reason, "same_folder");
assert.strictEqual(organizeUi.organizeDrop({ kind: "imap", id: "Notes", accountId: "other" }, dragMessage).reason, "other_account");
assert.deepStrictEqual(organizeUi.organizeDrop({ kind: "gmail", id: "Label_9", api: true }, dragMessage), {
  ok: true,
  channel: "mail:modifyMessageLabels",
  params: {
    accountId: "a1",
    emailId: "m1",
    addLabelIds: ["Label_9"],
    removeLabelIds: [],
  },
});
const blockedDrop = organizeUi.organizeDrop({
  kind: "gmail",
  id: "Label_9",
  api: false,
  reason: "scope_missing",
}, dragMessage);
assert.strictEqual(blockedDrop.ok, false);
assert.strictEqual(blockedDrop.reason, "scope_missing");
assert.strictEqual(
  blockedDrop.message,
  "Gmail labels need the gmail.modify grant. This mailbox stays on IMAP until then.",
);
assert.deepStrictEqual(organizeUi.organizeDrop({ kind: "outlook", id: "folder-1", api: true }, dragMessage), {
  ok: true,
  channel: "mail:moveProviderMessage",
  params: {
    accountId: "a1",
    emailId: "m1",
    destinationId: "folder-1",
  },
});
const blockedOutlook = organizeUi.organizeDrop({
  kind: "outlook",
  id: "folder-1",
  api: false,
  reason: "scope_missing",
  gate: "Outlook folders need the Mail.ReadWrite grant. This mailbox stays on IMAP until then.",
}, dragMessage);
assert.strictEqual(blockedOutlook.ok, false);
assert.strictEqual(blockedOutlook.message, "Outlook folders need the Mail.ReadWrite grant. This mailbox stays on IMAP until then.");
const grantMenu = organizeUi.organizeMenu(
  dragMessage,
  [{ id: "INBOX", name: "Inbox" }, { id: "Notes", name: "Notes" }, { id: "INBOX/Work", name: "Work" }],
  { api: false, reason: "scope_missing", accountId: "a1", folders: [] },
  "gmail",
);
assert.deepStrictEqual(grantMenu.move.map((folder) => [folder.id, folder.depth]), [
  ["INBOX/Work", 1],
  ["Notes", 0],
]);
assert.deepStrictEqual(grantMenu.add, []);
assert.deepStrictEqual(grantMenu.remove, []);
assert.strictEqual(
  grantMenu.note,
  "Gmail labels need the gmail.modify grant. This mailbox stays on IMAP until then.",
);
const gmailMenu = organizeUi.organizeMenu(dragMessage, [{ id: "INBOX", name: "Inbox" }], {
  api: true,
  accountId: "a1",
  source: "gmail",
  folders: [
    { id: "L1", name: "Work", editable: true },
    { id: "L2", name: "Work/Travel", editable: true },
    { id: "INBOX", name: "INBOX", editable: false },
  ],
}, "gmail");
assert.deepStrictEqual(gmailMenu.add.map((folder) => [folder.id, folder.depth, folder.label]), [
  ["L1", 0, "Work"],
  ["L2", 1, "Travel"],
]);
assert.strictEqual(gmailMenu.remove.length, 2);
assert.strictEqual(gmailMenu.outlook.length, 0);
assert.strictEqual(gmailMenu.note, "");
const outlookMenu = organizeUi.organizeMenu(dragMessage, [], {
  api: true,
  accountId: "a1",
  source: "graph",
  folders: [
    { id: "in", name: "Inbox", parentId: "root", editable: false },
    { id: "c1", name: "Receipts", parentId: "in", editable: true },
  ],
}, "outlook");
assert.deepStrictEqual(outlookMenu.outlook.map((folder) => [folder.id, folder.depth, folder.label]), [
  ["in", 0, "Inbox"],
  ["c1", 1, "Receipts"],
]);
assert.strictEqual(outlookMenu.add.length, 0);
assert.strictEqual(organizeUi.organizeMenu(dragMessage, [{ id: "Notes", name: "Notes" }], {
  api: false,
  reason: "error",
  message: "Outlook did not return a folder list.",
  accountId: "a1",
}, "outlook").note, "Outlook did not return a folder list.");
assert.strictEqual(organizeUi.organizeMenu(null, [], null, "gmail").note, "Choose a message first.");
assert.ok(appJs.includes("contextmenu"));
assert.ok(appJs.includes("application/x-morrow-message"));
assert.ok(appJs.includes("dropKind"));
assert.ok(css.includes(".organize-menu") && css.includes(".drop-target"));
assert.ok(parity.includes("right-click"));
assert.ok(parity.includes("Dragging a message row"));
assert.ok(parity.includes("Multi-select"));
assert.ok(parity.includes("one message"));
assert.ok(independentDoc.includes("Right-click"));
assert.ok(independentDoc.includes("Drag a message row"));
const folderChrome = loadFunctions(appJs, [
  "folderDelimiter",
  "nestRows",
  "imapParent",
  "folderTree",
  "providerParent",
  "providerLabelText",
  "providerLabelTree",
  "joinedPath",
  "moveNodesFromFolders",
  "descendantIds",
  "moveTargetFlags",
  "messageTargetFlags",
  "filterMoveNodes",
  "showMoveRoot",
  "visibleMoveNodes",
  "movePathPreview",
  "movePreviewLine",
  "moveRequestAfterConfirm",
  "relocatedFolderId",
  "moveMenuItem",
  "imapFolderMenu",
  "folderActionMenu",
  "isStarredFolder",
  "isVirtualMailbox",
  "folderCanNest",
  "nestDropPlan",
  "actionConfirm",
  "confirmsBefore",
]);
const travelMenu = folderChrome.folderActionMenu({ id: "Label_9", name: "Work/Travel", editable: true }, "gmail");
assert.deepStrictEqual(travelMenu.items.map((item) => item.id), ["rename", "move", "delete", "create"]);
assert.deepStrictEqual(travelMenu.items.map((item) => item.label), ["Rename", "Move…", "Delete", "Add label"]);
assert.strictEqual(travelMenu.items[1].disabled, false);
assert.strictEqual(travelMenu.note, "");
const systemMenu = folderChrome.folderActionMenu({ id: "INBOX", name: "Inbox", editable: false }, "gmail");
assert.deepStrictEqual(systemMenu.items.map((item) => item.id), ["move", "create"]);
assert.strictEqual(systemMenu.items[0].disabled, true);
assert.match(systemMenu.items[0].reason, /cannot be moved/);
assert.match(systemMenu.note, /cannot be renamed or deleted/);
const outlookSystem = folderChrome.folderActionMenu({ id: "in", name: "Inbox", editable: false }, "outlook");
assert.strictEqual(outlookSystem.items[0].disabled, true);
assert.match(outlookSystem.items[0].reason, /Outlook folder cannot be moved/);
const inboxMenu = folderChrome.imapFolderMenu({ id: "INBOX", name: "Inbox", wellKnownName: "inbox", type: "system" });
assert.strictEqual(inboxMenu.items[0].disabled, true);
assert.match(inboxMenu.items[0].reason, /cannot be moved/);
const notesMenu = folderChrome.imapFolderMenu({ id: "Notes", name: "Notes", type: "user" });
assert.strictEqual(notesMenu.items[0].disabled, false);
assert.strictEqual(notesMenu.items[0].label, "Move…");
const outlookMenuRow = folderChrome.folderActionMenu({ id: "f1", name: "Receipts", editable: true }, "outlook");
assert.strictEqual(outlookMenuRow.items.find((item) => item.id === "create").label, "Add folder");
const gmailFolders = [
  { id: "L1", name: "Work", editable: true },
  { id: "L2", name: "Work/Travel", editable: true },
  { id: "L3", name: "Work/Travel/Hotels", editable: true },
  { id: "L4", name: "Personal", editable: true },
  { id: "INBOX", name: "INBOX", editable: false },
];
const gmailNodes = folderChrome.moveNodesFromFolders("gmail", gmailFolders, "/");
const travelFlags = folderChrome.moveTargetFlags(gmailNodes, "L2", "gmail", "/");
const travelById = Object.fromEntries(travelFlags.nodes.map((node) => [node.id, node]));
assert.strictEqual(travelById.L2.disabled, true);
assert.match(travelById.L2.reason, /itself/);
assert.strictEqual(travelById.L3.disabled, true);
assert.match(travelById.L3.reason, /sub-label/);
assert.strictEqual(travelById.L1.disabled, true);
assert.match(travelById.L1.reason, /already there/);
assert.strictEqual(travelById.L4.disabled, false);
assert.strictEqual(travelFlags.root.disabled, false);
const workFlags = folderChrome.moveTargetFlags(gmailNodes, "L1", "gmail", "/");
assert.strictEqual(folderChrome.folderCanNest("imap", { id: "INBOX", name: "Inbox", wellKnownName: "inbox", type: "system" }).ok, false);
assert.strictEqual(folderChrome.folderCanNest("imap", { id: "Notes", name: "Notes", type: "user" }).ok, true);
assert.strictEqual(folderChrome.folderCanNest("gmail", { id: "L4", name: "Personal", editable: true }).ok, true);
assert.strictEqual(folderChrome.folderCanNest("gmail", { id: "INBOX", name: "INBOX", editable: false }).ok, false);
assert.strictEqual(folderChrome.folderCanNest("local", { id: "x", name: "x" }).ok, false);
assert.strictEqual(folderChrome.folderCanNest("imap", { id: "__morrow_starred__", name: "Starred", type: "virtual" }).ok, false);
const nestSource = { kind: "gmail", accountId: "a1", folderId: "L2" };
const nestUnder = folderChrome.nestDropPlan(nestSource, { kind: "gmail", accountId: "a1", id: "L4" }, travelFlags);
assert.strictEqual(nestUnder.ok, true);
assert.strictEqual(nestUnder.channel, "mail:moveProviderFolder");
assert.strictEqual(nestUnder.params.destinationId, "L4");
const unnest = folderChrome.nestDropPlan(nestSource, { kind: "gmail", accountId: "a1", id: "", isRoot: true }, travelFlags);
assert.strictEqual(unnest.ok, true);
assert.strictEqual(unnest.params.destinationId, "");
assert.strictEqual(folderChrome.nestDropPlan(nestSource, { kind: "gmail", accountId: "a1", id: "L2" }, travelFlags).ok, false);
assert.strictEqual(folderChrome.nestDropPlan(nestSource, { kind: "gmail", accountId: "a1", id: "L3" }, travelFlags).ok, false);
assert.strictEqual(folderChrome.nestDropPlan(nestSource, { kind: "imap", accountId: "a1", id: "Notes" }, travelFlags).ok, false);
assert.strictEqual(folderChrome.nestDropPlan(nestSource, { kind: "gmail", accountId: "a2", id: "L4" }, travelFlags).ok, false);
assert.strictEqual(folderChrome.nestDropPlan(
  { kind: "gmail", accountId: "a1", folderId: "L1" },
  { kind: "gmail", accountId: "a1", isRoot: true },
  workFlags,
).ok, false);
assert.strictEqual(workFlags.root.disabled, true);
assert.strictEqual(workFlags.nodes.find((node) => node.id === "L2").disabled, true);
assert.strictEqual(workFlags.nodes.find((node) => node.id === "L4").disabled, false);
const hotelMatches = folderChrome.filterMoveNodes(gmailNodes, "HoTeL");
assert.deepStrictEqual(hotelMatches.map((node) => node.id), ["L1", "L2", "L3"]);
assert.strictEqual(hotelMatches.find((node) => node.id === "L3").match, true);
assert.strictEqual(hotelMatches.find((node) => node.id === "L1").match, false);
assert.strictEqual(folderChrome.showMoveRoot("hotel"), false);
assert.strictEqual(folderChrome.showMoveRoot("top"), true);
assert.strictEqual(folderChrome.showMoveRoot(""), true);
const collapsed = folderChrome.visibleMoveNodes(gmailNodes, [], false).map((node) => node.id);
assert.deepStrictEqual(collapsed, ["L1", "L4", "INBOX"]);
const travelNode = gmailNodes.find((node) => node.id === "L2");
const personalNode = gmailNodes.find((node) => node.id === "L4");
assert.strictEqual(folderChrome.movePathPreview(travelNode, personalNode, "gmail", "/"), "Personal/Travel");
assert.strictEqual(folderChrome.movePathPreview(travelNode, { isRoot: true }, "gmail", "/"), "Travel");
assert.strictEqual(folderChrome.movePreviewLine({
  purpose: "relocate",
  kind: "gmail",
  delimiter: "/",
  source: travelNode,
}, personalNode), "New path: Personal/Travel");
assert.match(folderChrome.movePreviewLine({
  purpose: "relocate",
  kind: "gmail",
  source: travelNode,
}, travelById.L2), /itself/);
assert.strictEqual(folderChrome.movePreviewLine({
  purpose: "message",
  emails: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
}, { path: "Sent" }), "Move 3 messages to “Sent”.");
assert.strictEqual(folderChrome.movePreviewLine({
  purpose: "message",
}, { path: "Sent" }), "Move the message to “Sent”.");
const imapNodes = folderChrome.moveNodesFromFolders("imap", [
  { id: "INBOX", name: "Inbox", wellKnownName: "inbox" },
  { id: "Work", name: "Work" },
  { id: "Work/Travel", name: "Travel" },
  { id: "Work/Travel/Hotels", name: "Hotels" },
  { id: "Personal", name: "Personal" },
], "/");
const imapFlags = folderChrome.moveTargetFlags(imapNodes, "Work/Travel", "imap", "/");
const imapById = Object.fromEntries(imapFlags.nodes.map((node) => [node.id, node]));
assert.strictEqual(imapById["Work/Travel"].disabled, true);
assert.strictEqual(imapById["Work/Travel/Hotels"].disabled, true);
assert.strictEqual(imapById.Work.disabled, true);
assert.strictEqual(imapById.Personal.disabled, false);
assert.strictEqual(imapFlags.root.disabled, false);
assert.strictEqual(folderChrome.movePathPreview(
  { id: "Work.Travel", name: "Travel", label: "Travel" },
  { id: "Archive" },
  "imap",
  ".",
), "Archive.Travel");
assert.strictEqual(folderChrome.moveRequestAfterConfirm("mail:moveProviderFolder", { ok: false, name: "" }, {
  folderId: "L2",
  destinationId: "L4",
}), null);
assert.strictEqual(folderChrome.moveRequestAfterConfirm("mail:moveFolder", null, { folderId: "Work" }), null);
assert.deepStrictEqual(folderChrome.moveRequestAfterConfirm("mail:moveProviderFolder", { ok: true }, {
  accountId: "a1",
  folderId: "L2",
  destinationId: "L4",
}), { accountId: "a1", folderId: "L2", destinationId: "L4" });
assert.strictEqual(folderChrome.relocatedFolderId("Work/Travel", [
  { from: "Work", to: "Personal/Work" },
  { from: "Work/Travel", to: "Personal/Work/Travel" },
]), "Personal/Work/Travel");
assert.strictEqual(folderChrome.relocatedFolderId("INBOX", [{ from: "Work", to: "Personal/Work" }]), "INBOX");
const commitMove = functionSource(appJs, "commitFolderMove");
assert.ok(commitMove.indexOf("moveRequestAfterConfirm") < commitMove.indexOf('call("mail:moveProviderFolder"'));
assert.ok(commitMove.indexOf("moveRequestAfterConfirm") < commitMove.indexOf('call("mail:moveFolder"'));
assert.ok(commitMove.indexOf("if (!request) return") < commitMove.indexOf('call("mail:moveProviderFolder"'));
assert.ok(commitMove.indexOf("if (!request) return") < commitMove.indexOf('call("mail:moveFolder"'));
const renameCopy = folderChrome.actionConfirm("rename", { provider: "gmail", name: "Work/Travel" });
assert.strictEqual(renameCopy.title, "Rename label");
assert.strictEqual(renameCopy.confirm, "Confirm");
assert.strictEqual(renameCopy.cancel, "Cancel");
assert.strictEqual(renameCopy.needsName, true);
assert.strictEqual(renameCopy.name, "Work/Travel");
assert.match(renameCopy.body, /Work\/Travel/);
assert.match(renameCopy.body, /Gmail/);
const deleteCopy = folderChrome.actionConfirm("delete", { provider: "outlook", name: "Receipts" });
assert.strictEqual(deleteCopy.title, "Delete folder");
assert.match(deleteCopy.body, /Receipts/);
assert.match(deleteCopy.body, /including the messages/);
assert.strictEqual(deleteCopy.confirm, "Confirm");
const gmailDelete = folderChrome.actionConfirm("delete", { provider: "gmail", name: "Work/Travel" });
assert.match(gmailDelete.body, /removes the label/);
assert.match(gmailDelete.body, /stay in the mailbox/);
const labelMoveCopy = folderChrome.actionConfirm("move-label", {
  provider: "gmail",
  name: "Work/Travel",
  destination: "Personal",
});
assert.strictEqual(labelMoveCopy.title, "Move label");
assert.strictEqual(labelMoveCopy.confirm, "Confirm");
assert.strictEqual(labelMoveCopy.cancel, "Cancel");
assert.strictEqual(labelMoveCopy.needsName, false);
assert.match(labelMoveCopy.body, /Work\/Travel/);
assert.match(labelMoveCopy.body, /Personal/);
assert.match(labelMoveCopy.body, /Nested labels/);
const outlookFolderMove = folderChrome.actionConfirm("move-label", {
  provider: "outlook",
  name: "Receipts",
  destination: "(Top level / root)",
});
assert.strictEqual(outlookFolderMove.title, "Move folder");
assert.match(outlookFolderMove.body, /Receipts/);
assert.match(outlookFolderMove.body, /Top level/);
assert.match(outlookFolderMove.body, /Outlook/);
const imapFolderMove = folderChrome.actionConfirm("move-label", {
  provider: "imap",
  name: "Work/Travel",
  destination: "Archive",
});
assert.match(imapFolderMove.body, /Work\/Travel/);
assert.match(imapFolderMove.body, /Archive/);
assert.match(imapFolderMove.body, /mail server/);
const moveCopy = folderChrome.actionConfirm("move", { subject: "Travel plans", target: "Notes", channel: "imap" });
assert.strictEqual(moveCopy.title, "Move message");
assert.match(moveCopy.body, /Travel plans/);
assert.match(moveCopy.body, /Notes/);
assert.match(moveCopy.body, /into that folder/);
assert.strictEqual(moveCopy.confirm, "Confirm");
const outlookMoveCopy = folderChrome.actionConfirm("move", {
  subject: "Travel plans",
  target: "Receipts",
  channel: "mail:moveProviderMessage",
});
assert.match(outlookMoveCopy.body, /Outlook/);
assert.match(outlookMoveCopy.body, /Receipts/);
assert.strictEqual(folderChrome.actionConfirm("label", { name: "Travel" }), null);
assert.strictEqual(folderChrome.confirmsBefore("mail:moveToFolder"), true);
assert.strictEqual(folderChrome.confirmsBefore("mail:moveProviderMessage"), true);
assert.strictEqual(folderChrome.confirmsBefore("mail:renameProviderFolder"), true);
assert.strictEqual(folderChrome.confirmsBefore("mail:deleteProviderFolder"), true);
assert.strictEqual(folderChrome.confirmsBefore("mail:moveProviderFolder"), true);
assert.strictEqual(folderChrome.confirmsBefore("mail:moveFolder"), true);
assert.strictEqual(folderChrome.confirmsBefore("mail:modifyMessageLabels"), false);
assert.strictEqual(folderChrome.confirmsBefore("mail:createProviderFolder"), false);
const selection = loadFunctions(appJs, [
  "filteredEmails",
  "providerCopy",
  "messageDragPayload",
  "organizeDrop",
  "usesThread",
  "selectionIds",
  "listClickSelection",
  "toggleSelectionId",
  "selectAllVisible",
  "clearListSelection",
  "pruneSelection",
  "selectionShortcut",
  "modifierBlocksDrag",
  "selectionDragPayload",
  "dragMessagesFrom",
  "coalesceProviderCalls",
  "bulkMoveCalls",
  "bulkMoveFailure",
  "bulkRemovalCalls",
  "conversationRemoval",
  "bulkFlagCalls",
  "bulkLabelCalls",
  "bulkNeedsConfirm",
  "bulkConfirmCopy",
  "confirmedCalls",
  "labelRemovesFromView",
  "bulkBlockedByPause",
  "selectionPaused",
  "collectBulkOutcome",
  "callCount",
  "bulkDropAction",
]);
const visibleIds = ["a", "b", "c", "d"];
let selectedClick = selection.listClickSelection(["a", "c"], "a", visibleIds, "b", {});
assert.deepStrictEqual(selectedClick, { ids: [], anchor: "" });
assert.deepStrictEqual(selection.listClickSelection([], "", visibleIds, "b", {}), { ids: [], anchor: "" });
selectedClick = selection.listClickSelection(["b"], "b", visibleIds, "d", { meta: true });
assert.deepStrictEqual(selectedClick.ids, ["b", "d"]);
assert.strictEqual(selectedClick.anchor, "d");
selectedClick = selection.listClickSelection(["b"], "b", visibleIds, "d", { shift: true });
assert.deepStrictEqual(selectedClick, { ids: ["b", "c", "d"], anchor: "b" });
selectedClick = selection.listClickSelection(["b", "c", "d"], "b", visibleIds, "c", { ctrl: true });
assert.deepStrictEqual(selectedClick.ids, ["b", "d"]);
selectedClick = selection.listClickSelection(["a"], "a", visibleIds, "c", { shift: true, meta: true });
assert.deepStrictEqual(selectedClick.ids, ["a", "b", "c"]);
assert.deepStrictEqual(selection.listClickSelection(["a"], "a", visibleIds, "missing", {}), { ids: ["a"], anchor: "a" });
assert.deepStrictEqual(selection.toggleSelectionId(["a"], "b").ids, ["a", "b"]);
assert.deepStrictEqual(selection.toggleSelectionId(["a", "b"], "a").ids, ["b"]);
const loaded = [
  { id: "a", subject: "Alpha trip", from: "Ada", snippet: "notes" },
  { id: "b", subject: "Beta", from: "Grace", snippet: "lab" },
];
const filtered = selection.filteredEmails(loaded, "alp");
const allVisible = selection.selectAllVisible(filtered.map((email) => email.id));
assert.deepStrictEqual(allVisible.ids, ["a"]);
assert.ok(!allVisible.ids.includes("b"));
assert.ok(!allVisible.ids.includes("remote-only"));
assert.ok(!functionSource(appJs, "selectAllVisible").includes("mail:search"));
assert.deepStrictEqual(selection.clearListSelection(["a", "b"]), { ids: [], anchor: "" });
assert.deepStrictEqual(selection.pruneSelection(["a", "gone"], ["a", "b"], "gone"), { ids: ["a"], anchor: "a" });
assert.strictEqual(selection.selectionShortcut({ key: "Escape" }, false), "clear");
assert.strictEqual(selection.selectionShortcut({ key: "a", meta: true }, false), "all");
assert.strictEqual(selection.selectionShortcut({ key: "a", ctrl: true }, false), "all");
assert.strictEqual(selection.selectionShortcut({ key: "a", ctrl: true, shift: true }, false), "");
assert.strictEqual(selection.selectionShortcut({ key: "a", meta: true }, true), "");
assert.strictEqual(selection.selectionShortcut({ key: "Escape" }, true), "");
assert.strictEqual(selection.modifierBlocksDrag(null), false);
assert.strictEqual(selection.modifierBlocksDrag({}), false);
assert.strictEqual(selection.modifierBlocksDrag({ altKey: true }), false);
assert.strictEqual(selection.modifierBlocksDrag({ shiftKey: true }), true);
assert.strictEqual(selection.modifierBlocksDrag({ metaKey: true }), true);
assert.strictEqual(selection.modifierBlocksDrag({ ctrlKey: true }), true);
assert.ok(functionSource(appJs, "onMessageDragStart").includes("modifierBlocksDrag"));
assert.ok(functionSource(appJs, "onMessageDragStart").includes("is-mail-drag"));
assert.ok(functionSource(appJs, "onMessageDragStart").includes("setOffsetDragGhost"));
assert.ok(functionSource(appJs, "listClickSelection").includes("clearListSelection"));
assert.ok(functionSource(appJs, "paintSelectionBar").includes("has-selection"));
const hotspot = extractFunction(appJs, "dragGhostHotspot")();
assert.ok(hotspot.y < hotspot.offset && hotspot.offset >= 28);
assert.ok(appJs.includes("application/x-morrow-folder"));
assert.ok(functionSource(appJs, "onFolderDrop").includes("dropFolderNest"));
assert.ok(functionSource(appJs, "onFolderDrop").includes("dropOrganized"));
assert.ok(functionSource(appJs, "onFolderDrop").includes("applyBulkMove"));
const pageBusy = functionSource(appJs, "setPageBusy");
assert.ok(pageBusy.includes("page-busy") && pageBusy.includes("aria-busy"));
assert.ok(!pageBusy.includes("document.body") && !pageBusy.includes("showModal"));
assert.ok(functionSource(appJs, "setAgentBusy").includes("syncAgentPageBusy"));
assert.ok(functionSource(appJs, "loadAgent").includes("agentLoadOverlay"));
assert.ok(css.includes(".drag-ghost") && css.includes(".folder-root") && css.includes(".page-busy"));
assert.ok(css.includes("#agent-panel.primary-space") && css.includes("position: relative"));
assert.ok(functionSource(appJs, "onMessagePointerDown").includes("modifierBlocksDrag"));
assert.ok(functionSource(appJs, "clearMailDragChrome").includes("is-mail-drag"));
const dragRows = [
  { id: "m1", accountId: "a1", folderId: "INBOX" },
  { id: "m2", accountId: "a1", folderId: "INBOX" },
];
const dragged = selection.selectionDragPayload(dragRows);
assert.strictEqual(dragged.id, "m1");
assert.deepStrictEqual(dragged.messages.map((row) => row.id), ["m1", "m2"]);
assert.deepStrictEqual(
  selection.dragMessagesFrom(JSON.stringify(dragged), null).map((row) => row.id),
  ["m1", "m2"],
);
assert.deepStrictEqual(selection.dragMessagesFrom("", dragged).map((row) => row.id), ["m1", "m2"]);
const moveTarget = { kind: "imap", id: "Notes", accountId: "a1" };
const singleMove = selection.organizeDrop(moveTarget, dragRows[0]);
const bulkMove = selection.bulkMoveCalls(dragRows, moveTarget);
assert.strictEqual(bulkMove.length, 1);
assert.strictEqual(bulkMove[0].channel, singleMove.channel);
assert.strictEqual(bulkMove[0].channel, "mail:moveToFolder");
assert.strictEqual(bulkMove[0].params.targetFolderId, singleMove.params.targetFolderId);
assert.deepStrictEqual(bulkMove[0].params.items.map((item) => item.emailId), ["m1", "m2"]);
assert.deepStrictEqual(bulkMove[0].params.items[0].folderId, singleMove.params.folderId);
const oneMove = selection.bulkMoveCalls([dragRows[0]], moveTarget);
assert.deepStrictEqual(oneMove[0].params, singleMove.params);
assert.strictEqual(oneMove[0].channel, "mail:moveToFolder");
const skippedSame = selection.bulkMoveCalls([
  dragRows[0],
  { id: "m2", accountId: "a1", folderId: "Notes" },
], moveTarget);
assert.deepStrictEqual(skippedSame[0].params, singleMove.params);
assert.strictEqual(selection.bulkMoveFailure([], moveTarget), "Choose a message first.");
assert.strictEqual(selection.bulkMoveCalls(dragRows, moveTarget).length > 0 ? selection.bulkMoveFailure(dragRows, moveTarget) : "x", "");
const cancelledMove = selection.confirmedCalls("move", { ok: false, name: "" }, bulkMove, {});
assert.deepStrictEqual(cancelledMove, []);
const acceptedMove = selection.confirmedCalls("move", { ok: true, name: "" }, bulkMove, {});
assert.strictEqual(acceptedMove.length, 1);
assert.strictEqual(acceptedMove[0].channel, "mail:moveToFolder");
const moveCopyBulk = selection.bulkConfirmCopy("move", 2, { target: "Notes" });
assert.strictEqual(moveCopyBulk.confirm, "Move");
assert.strictEqual(moveCopyBulk.cancel, "Cancel");
assert.match(moveCopyBulk.body, /2/);
assert.match(moveCopyBulk.body, /Notes/);
const archiveCalls = selection.bulkRemovalCalls(dragRows, "archive", false);
assert.strictEqual(archiveCalls[0].channel, "mail:archiveBatch");
assert.deepStrictEqual(archiveCalls[0].params.items.map((item) => item.emailId), ["m1", "m2"]);
assert.deepStrictEqual(selection.confirmedCalls("archive", { ok: false, name: "" }, archiveCalls, {}), []);
assert.strictEqual(selection.confirmedCalls("archive", { ok: true, name: "" }, archiveCalls, {}).length, 1);
const trashCopy = selection.bulkConfirmCopy("trash", 2, {});
assert.match(trashCopy.body, /2/);
assert.match(trashCopy.body, /Trash/);
const alone = selection.bulkRemovalCalls([dragRows[0]], "trash", false);
assert.strictEqual(alone[0].channel, "mail:delete");
assert.strictEqual(alone[0].params.emailId, "m1");
const threaded = selection.bulkRemovalCalls([
  { id: "m1", accountId: "a1", threadId: "t1", members: [{ id: "m1" }, { id: "m9" }] },
  { id: "m2", accountId: "a1", threadId: "t1", members: [{ id: "m2" }, { id: "m9" }] },
], "archive", true);
assert.strictEqual(threaded.length, 1);
assert.strictEqual(threaded[0].channel, "mail:threadArchive");
assert.strictEqual(threaded[0].params.threadId, "t1");
const selectionState = {
  prefs: { conversation: true },
  emails: [
    { id: "account-one-mail", accountId: "a1", threadId: "shared-thread" },
    { id: "account-two-mail", accountId: "a2", threadId: "shared-thread" },
  ],
  email: { id: "account-two-mail", accountId: "a2", threadId: "shared-thread" },
  thread: [{ id: "another-account-two-mail", accountId: "a2", threadId: "shared-thread" }],
};
const selectionMembers = new Function("state", `${functionSource(appJs, "withSelectionMembers")}; return withSelectionMembers;`)(selectionState);
const crossAccountRemoval = selection.bulkRemovalCalls([selectionMembers(selectionState.emails[0])], "trash", true);
assert.strictEqual(crossAccountRemoval[0].channel, "mail:delete", "a thread in another mailbox must not expand the selection");
selectionState.emails.push({ id: "another-account-one-mail", accountId: "a1", threadId: "shared-thread" });
assert.strictEqual(selection.bulkRemovalCalls([selectionMembers(selectionState.emails[0])], "trash", true)[0].channel, "mail:threadTrash");
const messageUnit = selection.conversationRemoval(
  { id: "m1", threadId: "t1" },
  false,
  [{ id: "m1" }, { id: "m9" }],
);
assert.strictEqual(messageUnit.unit, "message");
assert.strictEqual(messageUnit.channelArchive, "mail:archive");
assert.strictEqual(messageUnit.channelTrash, "mail:delete");
const threadUnit = selection.conversationRemoval(
  { id: "m1", threadId: "t1" },
  true,
  [{ id: "m1" }, { id: "m9" }],
);
assert.strictEqual(threadUnit.unit, "thread");
assert.strictEqual(threadUnit.channelTrash, "mail:threadTrash");
const loneThread = selection.conversationRemoval({ id: "m1", threadId: "t1" }, true, [{ id: "m1" }]);
assert.strictEqual(loneThread.unit, "message");
const readCalls = selection.bulkFlagCalls(dragRows, "read");
assert.strictEqual(readCalls[0].channel, "mail:markReadBatch");
assert.strictEqual(readCalls[0].params.isRead, true);
assert.strictEqual(selection.bulkFlagCalls(dragRows, "unread")[0].params.isRead, false);
assert.strictEqual(selection.bulkFlagCalls(dragRows, "star")[0].channel, "mail:toggleStarBatch");
assert.strictEqual(selection.bulkFlagCalls(dragRows, "star")[0].params.isStarred, true);
const labelCalls = selection.bulkLabelCalls(dragRows, "Label_9", "add");
assert.strictEqual(labelCalls.length, 2);
assert.strictEqual(labelCalls[0].channel, "mail:modifyMessageLabels");
assert.deepStrictEqual(labelCalls[0].params.addLabelIds, ["Label_9"]);
assert.deepStrictEqual(labelCalls[0].params.removeLabelIds, []);
assert.deepStrictEqual(selection.bulkLabelCalls(dragRows, "Label_9", "remove")[0].params.removeLabelIds, ["Label_9"]);
assert.strictEqual(selection.bulkNeedsConfirm("add-label", {}), false);
assert.strictEqual(selection.confirmedCalls("add-label", { ok: false }, labelCalls, {}).length, 2);
assert.strictEqual(selection.bulkNeedsConfirm("remove-label", { removesFromView: false }), false);
assert.strictEqual(selection.bulkNeedsConfirm("remove-label", { removesFromView: true }), true);
assert.deepStrictEqual(
  selection.confirmedCalls("remove-label", { ok: false, name: "" }, labelCalls, { removesFromView: true }),
  [],
);
assert.strictEqual(selection.labelRemovesFromView("Label_9", "Label_9"), true);
assert.strictEqual(selection.labelRemovesFromView("INBOX", "Label_9"), false);
const removeCopy = selection.bulkConfirmCopy("remove-label", 2, { label: "Travel" });
assert.match(removeCopy.body, /2/);
assert.match(removeCopy.body, /Travel/);
assert.strictEqual(selection.bulkDropAction({ kind: "gmail", id: "Label_9" }), "add-label");
assert.strictEqual(selection.bulkDropAction({ kind: "imap", id: "Notes" }), "move");
assert.strictEqual(selection.bulkDropAction({ kind: "outlook", id: "folder-1" }), "move");
const gmailDrop = selection.bulkMoveCalls(dragRows, { kind: "gmail", id: "Label_9", api: true });
assert.strictEqual(gmailDrop.length, 2);
assert.strictEqual(gmailDrop[0].channel, "mail:modifyMessageLabels");
assert.deepStrictEqual(gmailDrop[0].params, selection.organizeDrop({ kind: "gmail", id: "Label_9", api: true }, dragRows[0]).params);
assert.strictEqual(selection.bulkBlockedByPause({ state: "paused", accountId: "other" }, "a1"), false);
assert.strictEqual(selection.bulkBlockedByPause({ state: "paused", accountId: "a1" }, "a1"), true);
assert.strictEqual(selection.selectionPaused({ state: "paused" }, dragRows), true);
assert.strictEqual(selection.selectionPaused({ state: "syncing", accountId: "a1" }, dragRows), false);
let outcome = selection.collectBulkOutcome(null, { opIds: ["op-1"] }, null);
assert.deepStrictEqual(outcome.opIds, ["op-1"]);
assert.strictEqual(outcome.paused, false);
outcome = selection.collectBulkOutcome(outcome, null, new Error("Paused for rate limit"));
assert.strictEqual(outcome.paused, true);
assert.strictEqual(outcome.error, "Paused for rate limit");
assert.deepStrictEqual(outcome.opIds, ["op-1"]);
assert.strictEqual(selection.callCount(bulkMove), 2);
assert.strictEqual(selection.callCount(oneMove), 1);
assert.ok(html.includes('id="selection-bar"'));
assert.ok(html.includes('id="select-visible"'));
assert.ok(appJs.includes("mail:archiveBatch"));
assert.ok(appJs.includes("mail:deleteBatch"));
assert.ok(appJs.includes("mail:markReadBatch"));
assert.ok(appJs.includes("mail:toggleStarBatch"));
assert.ok(preload.includes("mail:archiveBatch"));
assert.ok(preload.includes("mail:deleteBatch"));
assert.ok(preload.includes("mail:markReadBatch"));
assert.ok(preload.includes("mail:toggleStarBatch"));
const starUi = loadFunctions(appJs, [
  "filteredEmails",
  "isStarredFolder",
  "isVirtualMailbox",
  "storableFolders",
  "visibleList",
  "messageDragPayload",
  "providerCopy",
  "organizeDrop",
]);
assert.strictEqual(starUi.isStarredFolder("__morrow_starred__"), true);
assert.strictEqual(starUi.isStarredFolder("INBOX"), false);
assert.strictEqual(starUi.isVirtualMailbox({ id: "__morrow_starred__", type: "virtual" }), true);
assert.strictEqual(starUi.isVirtualMailbox({ id: "INBOX", wellKnownName: "inbox" }), false);
assert.deepStrictEqual(starUi.storableFolders([
  { id: "INBOX", name: "Inbox" },
  { id: "__morrow_starred__", name: "Starred", type: "virtual" },
]).map((folder) => folder.id), ["INBOX"]);
const starRows = [
  { id: "a", subject: "Hello", from: "Ada", snippet: "x", isStarred: true },
  { id: "b", subject: "Other", from: "Bea", snippet: "y", isStarred: false },
];
assert.deepStrictEqual(starUi.visibleList(starRows, "", "INBOX").map((row) => row.id), ["a", "b"]);
assert.deepStrictEqual(starUi.visibleList(starRows, "", "__morrow_starred__").map((row) => row.id), ["a"]);
assert.deepStrictEqual(starUi.visibleList(starRows, "other", "__morrow_starred__"), []);
assert.ok(functionSource(appJs, "renderList").includes("shownEmails()"));
const refusedStarDrop = starUi.organizeDrop(
  { kind: "imap", id: "__morrow_starred__", accountId: "a1" },
  { id: "m1", accountId: "a1", folderId: "INBOX" },
);
assert.strictEqual(refusedStarDrop.ok, false);
assert.match(refusedStarDrop.message, /Starred is a filter/);
const toggleStarSource = functionSource(appJs, "toggleStar");
assert.ok(toggleStarSource.indexOf("paintStars") < toggleStarSource.indexOf("await call"));
assert.ok(toggleStarSource.includes("paintStars([email], previous, true)"));
assert.ok(appJs.includes('const STARRED_FOLDER_ID = "__morrow_starred__"'));
assert.ok(appJs.includes("starIcon(starredOn)"));
assert.ok(appJs.includes("Still finishing the last change."));
assert.ok(css.includes("--star:"));
assert.ok(css.includes('#reader .reader-actions button[data-action="star"].is-starred'));
assert.ok(engineSrc.includes("STARRED_FOLDER_ID"));
assert.ok(engineSrc.includes('"\\\\Flagged"'));
assert.ok(css.includes(".row-check"));
assert.ok(css.includes("#messages.has-selection .row-check"));
assert.ok(css.includes("body.is-mail-drag"));
assert.ok(css.includes("cursor: grabbing"));
assert.ok(!/button\.message\[draggable="true"\]\s*\{[^}]*cursor:\s*grab/.test(css));
assert.ok(css.includes(".selection-bar"));
assert.ok(!parity.includes("Multi-select stays a follow-up"));
assert.ok(!parity.includes("Multi-select is a follow-up"));
assert.ok(parity.includes("Select all"));
assert.ok(parity.includes("mail:threadArchive"));
assert.ok(!independentDoc.includes("Multi-select is not in this slice"));
assert.ok(appJs.includes('confirmRelocation("mail:moveToFolder"'));
assert.ok(appJs.includes('confirmRelocation("mail:moveProviderMessage"'));
assert.ok(appJs.includes('confirmsBefore("mail:renameProviderFolder")'));
assert.ok(appJs.includes('confirmsBefore("mail:deleteProviderFolder")'));
assert.ok(appJs.includes('confirmsBefore("mail:moveProviderFolder")') || appJs.includes('channel === "mail:moveProviderFolder"'));
assert.ok(appJs.includes("moveRequestAfterConfirm"));
assert.ok(appJs.includes("Move…"));
assert.ok(html.includes('id="move-picker"'));
assert.ok(html.includes('id="move-picker-filter"'));
assert.ok(css.includes("#move-picker-tree"));
assert.ok(css.includes(".move-node"));
assert.ok(!appJs.includes('confirmsBefore("mail:modifyMessageLabels")'));
assert.ok(!appJs.includes("state.providerRename"));
assert.ok(!appJs.includes('rename.textContent = "Rename"'));
assert.ok(appJs.includes("openFolderMenu"));
assert.ok(appJs.includes("focusProviderCreate"));
assert.ok(html.includes('id="confirm"'));
assert.ok(html.includes('id="confirm-ok">Confirm'));
assert.ok(html.includes('id="confirm-cancel">Cancel'));
assert.ok(css.includes("#confirm-body"));
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
assert.deepStrictEqual(
  providerUi.grantApiOutcome({ api: true }, "Mail API connected.", "fallback"),
  { ok: true, message: "Mail API connected." },
);
assert.deepStrictEqual(
  providerUi.grantApiOutcome(
    { api: false, message: "Microsoft did not return the Mail.ReadWrite grant. This mailbox stays on IMAP until then." },
    "Mail API connected.",
    "fallback",
  ),
  {
    ok: false,
    message: "Microsoft did not return the Mail.ReadWrite grant. This mailbox stays on IMAP until then.",
  },
);
assert.strictEqual(
  providerUi.grantApiOutcome({ api: false }, "Mail API connected.", providerUi.providerCopy("scope_missing", "outlook")).ok,
  false,
);
assert.match(
  providerUi.grantApiOutcome({ api: false }, "Mail API connected.", providerUi.providerCopy("scope_missing", "outlook")).message,
  /Mail\.ReadWrite/,
);
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
  "Enable calendar and mailbox features. Google uses one consent; Microsoft uses a separate feature consent after mail sign-in.",
);
assert.strictEqual(providerUi.calendarCopy("oauth_not_ready"), "Google Desktop OAuth is not configured, so calendar stays offline.");
assert.strictEqual(providerUi.calendarCopy("no_account"), "Connect a Google or Microsoft mailbox. Calendar does not keep events of its own.");
assert.strictEqual(
  providerUi.calendarCopy("needs_auth", "ada@example.com"),
  "Enable calendar and mailbox features for ada@example.com. Google uses one consent; Microsoft uses a separate feature consent after mail sign-in.",
);
assert.deepStrictEqual(providerUi.calendarConnection(null, null), {
  connected: false,
  canGrant: false,
  reason: "Connect a Google or Microsoft mailbox first.",
  label: "Enable mailbox features",
});
assert.deepStrictEqual(providerUi.calendarConnection({
  accounts: [{ id: "a", calendar: true }],
}, { id: "a", platform: "imap", profile: "outlook" }, null), {
  connected: true,
  canGrant: true,
  reason: "",
  label: "Refresh calendar",
});
assert.strictEqual(providerUi.calendarConnection({
  accounts: [{ id: "a", calendar: false, calendarReason: "needs_auth" }],
}, { id: "a", platform: "imap", profile: "outlook" }).label, "Enable mailbox features");
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
assert.strictEqual(providerUi.vacationProvider({ imapSmtpProfile: "gmail" }), "google");
assert.strictEqual(providerUi.vacationProvider({ profile: "outlook" }), "microsoft");
assert.strictEqual(providerUi.vacationProvider({ imapSmtpProfile: "custom" }), "imap");
assert.strictEqual(providerUi.vacationLink("https://mail.yahoo.com/"), "https://mail.yahoo.com/");
assert.strictEqual(providerUi.vacationLink("https://evil.example/settings"), "");
assert.strictEqual(providerUi.vacationDraft({ provider: "imap", mode: "always", audience: "contacts", message: "Hi", restrictToDomain: false }).error, "IMAP vacation replies go to every sender.");
assert.strictEqual(providerUi.vacationDraft({ provider: "google", mode: "always", audience: "all", message: "  ", subject: "Away", restrictToDomain: false }).error, "Enter a reply message.");
const vacationSaved = providerUi.vacationDraft({
  provider: "microsoft",
  mode: "scheduled",
  audience: "none",
  message: "Inside",
  externalMessage: "",
  subject: "",
  start: "2090-10-01T00:00:00.000Z",
  end: "2090-10-02T00:00:00.000Z",
  restrictToDomain: false,
});
assert.strictEqual(vacationSaved.error, "");
assert.strictEqual(vacationSaved.audience, "none");
assert.strictEqual(providerUi.vacationView(null).showForm, false);
assert.strictEqual(providerUi.vacationView({
  provider: "google",
  supported: true,
  requiresReconnect: true,
  canWrite: false,
  detail: "Automatic replies need the gmail.settings.basic grant. The existing mailbox stays connected.",
}).showGrant, true);
assert.strictEqual(providerUi.vacationView({
  provider: "imap",
  supported: true,
  canWrite: false,
  settings: { mode: "always" },
  scheduleWarning: "",
}).canDisable, true);
assert.match(providerUi.vacationConfirm("save", "ada@example.com", { provider: "imap", mode: "always" }).body, /Your mail server will send these automatic replies/);
assert.strictEqual(providerUi.vacationConfirm("disable", "ada@example.com", { provider: "google" }).needsName, false);
const oooReview = providerUi.vacationConfirm("save", "ada@example.com", { provider: "imap", mode: "scheduled", start: "2090-03-10T10:30:00.000Z", end: "2090-03-11T12:00:00.000Z", message: "Away today" }).body;
assert.match(oooReview, /2090-03-10 00:00 UTC/);
assert.match(oooReview, /2090-03-12 00:00 UTC \(exclusive\)/);
assert.match(oooReview, /All senders.*[\s\S]*Away today/);
assert.match(providerUi.vacationConfirm("disable", "ada@example.com", { provider: "google" }).body, /New automatic replies will stop/);
assert.doesNotMatch(providerUi.vacationConfirm("disable", "ada@example.com", { provider: "google" }).body, /continue while Morrow/);

for (const channel of [
  "mail:oauthStatus",
  "mail:grantOrganize",
  "mail:grantVacation",
  "mail:vacationGet",
  "mail:vacationPut",
  "mail:listProviderFolders",
  "mail:createProviderFolder",
  "mail:renameProviderFolder",
  "mail:deleteProviderFolder",
  "mail:moveProviderFolder",
  "mail:moveFolder",
  "mail:modifyMessageLabels",
  "mail:moveProviderMessage",
  "mail:listInboxRules",
  "mail:saveInboxRule",
  "mail:deleteInboxRule",
  "mail:grantRules",
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
  "mail:grantVacation",
  "mail:vacationGet",
  "mail:vacationPut",
  "mail:listProviderFolders",
  "mail:createProviderFolder",
  "mail:renameProviderFolder",
  "mail:deleteProviderFolder",
  "mail:moveProviderFolder",
  "mail:moveFolder",
  "mail:modifyMessageLabels",
  "mail:moveProviderMessage",
  "mail:listInboxRules",
  "mail:saveInboxRule",
  "mail:deleteInboxRule",
  "mail:grantRules",
  "calendar:status",
  "calendar:connect",
  "calendar:list",
  "calendar:createEvent",
]) {
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(html.includes('id="rail-calendar"') && html.includes('id="calendar-panel"'));
assert.ok(html.includes('id="calendar-grant"') && html.includes("Enable mailbox features"));
assert.ok(html.includes('id="settings-ooo"') && html.includes("Allow Out of Office settings"));
assert.ok(appJs.includes("mail:vacationGet") && appJs.includes("mail:vacationPut") && appJs.includes("mail:grantVacation"));
assert.ok(appJs.includes("morrow-vacation") && appJs.includes("will not replace a different active Sieve script"));
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
assert.strictEqual(gmailApi.normalizeGmailLabel({ id: "Label_2", name: "Work/Travel", type: "user" }).name, "Work/Travel");
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
assert.strictEqual(oauthConfig.normalizePurpose("vacation"), "vacation");
assert.strictEqual(oauthConfig.normalizePurpose("out-of-office"), "vacation");
assert.strictEqual(oauthConfig.scopesFor("google", "vacation"), oauthConfig.VACATION_SCOPES.google);
assert.strictEqual(oauthConfig.scopesFor("microsoft", "ooo"), oauthConfig.VACATION_SCOPES.microsoft);
assert.ok(!oauthConfig.VACATION_SCOPES.google.includes("gmail.modify"));
assert.ok(!oauthConfig.VACATION_SCOPES.google.includes("mail.google.com"));
assert.ok(!oauthConfig.VACATION_SCOPES.microsoft.includes("Mail.ReadWrite"));
assert.ok(!oauthConfig.VACATION_SCOPES.microsoft.includes("outlook.office"));
assert.strictEqual(oauthConfig.redirectPath("google", "vacation"), "/api/oauth/google/callback");
assert.strictEqual(oauthConfig.redirectPath("microsoft", "vacation"), "/api/oauth/microsoft/callback");
assert.strictEqual(oauthConfig.profileUrl("google", "vacation"), "https://openidconnect.googleapis.com/v1/userinfo");
assert.strictEqual(oauthConfig.hasMarker(`https://graph.microsoft.com/${oauthConfig.MARKERS.vacation.microsoft}`, "microsoft", "vacation"), true);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.SCOPES.google, "google", "vacation"), false);
assert.strictEqual(oauthConfig.hasMarker("Mail.Read", "microsoft", "organize"), false);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.ORGANIZE_SCOPES.microsoft, "outlook", "organize"), true);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.ORGANIZE_SCOPES.google, "gmail", "organize"), true);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.SCOPES.google, "google", "organize"), false);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.CALENDAR_SCOPES.google, "google", "calendar"), true);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.CALENDAR_SCOPES.microsoft, "microsoft", "calendar"), true);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.SCOPES.google, "google", "imap"), true);
assert.strictEqual(
  oauthConfig.hasMarker("offline_access,USER.READ,mail.readwrite,Mail.Send", "microsoft", "organize"),
  true,
);
assert.strictEqual(
  oauthConfig.hasMarker(
    "https%3A%2F%2Fgraph.microsoft.com%2Fmail.readwrite%20https%3A%2F%2Fgraph.microsoft.com%2Fuser.read",
    "outlook",
    "organize",
  ),
  true,
);
assert.strictEqual(
  oauthConfig.hasMarker(
    "https://graph.microsoft.com/Mail.ReadWrite,https://graph.microsoft.com/User.Read",
    "microsoft",
    "organize",
  ),
  true,
);
assert.strictEqual(
  oauthConfig.hasMarker("00000003-0000-0000-c000-000000000000/Mail.ReadWrite", "microsoft", "organize"),
  true,
);
assert.strictEqual(oauthConfig.hasMarker("MAIL.READWRITE", "outlook", "organize"), true);
assert.strictEqual(
  oauthConfig.hasMarker("https://graph.microsoft.com/Mail.Read,https://graph.microsoft.com/Mail.Send", "microsoft", "organize"),
  false,
);
assert.strictEqual(oauthConfig.hasMarker("https://graph.microsoft.com/Mail.ReadWrite.All", "microsoft", "organize"), false);
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
  delete process.env.MORROW_AI_API_KEY;
  delete process.env.XAI_API_KEY;
  const os = require("os");
  process.env.MORROW_AI_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-ai-"));
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
  const secondRemoved = brain.answer("emailBrain:removeSkill", [{ skillId: "meeting-prep" }]);
  assert.strictEqual(secondRemoved.data.library.length, 2);
  assert.ok(secondRemoved.data.library.every((row) => row.runMode === "on_demand" && row.schedule === "disabled"));
  brain.answer("emailBrain:installSkill", [{ skillId: "meeting-prep" }]);
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
  process.env.MORROW_AI_API_KEY = "sk-test";
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
    const chatFile = path.join(process.env.MORROW_AI_CONFIG_DIR, "agent-chat.json");
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
    for (const channel of ["emailBrain:setSkillAutoExecute", "emailBrain:previewRuleMatches"]) {
      const refused = brain.answer(channel, [{ skillId: "morning-brief", enabled: true }]);
      assert.strictEqual(refused.data.accepted, false);
      assert.match(refused.data.error, /only when you ask/i);
    }
    assert.strictEqual(agent.cronMatches("0 8 * * 1", new Date(2026, 9, 19, 8, 0, 0)), true);
    assert.strictEqual(agent.cronMatches("0 8 * * 1", new Date(2026, 9, 19, 9, 0, 0)), false);
    assert.strictEqual(agent.cronMatches("0 8 */2 * *", new Date(2026, 9, 19, 8)), true);
    assert.strictEqual(agent.cronMatches("0 8 */2 * *", new Date(2026, 9, 20, 8)), false);
    assert.strictEqual(agent.cronMatches("0 8 * */2 *", new Date(2026, 0, 1, 8)), true);
    assert.strictEqual(agent.cronMatches("0 8 * */2 *", new Date(2026, 1, 1, 8)), false);
    assert.strictEqual(agent.cronMatches("0 8 */2 * 1", new Date(2026, 9, 21, 8)), false);
    assert.strictEqual(agent.cronMatches("0 8 20 * 1", new Date(2026, 9, 19, 8)), true);
    const nextMonday = agent.nextCron("0 8 * * 1-5", new Date(2026, 9, 17, 9, 0, 0));
    assert.strictEqual(nextMonday.getDay(), 1);
    assert.strictEqual(nextMonday.getHours(), 8);
    assert.strictEqual(nextMonday.getDate(), 19);
    assert.strictEqual(brain.answer("emailBrain:setSkillSchedule", [{ skillId: "morning-brief", kind: "interval", everyMinutes: 0 }]).success, false);
    assert.strictEqual(brain.answer("emailBrain:setSkillSchedule", [{ skillId: "nope", kind: "interval", everyMinutes: 15 }]).success, false);
    assert.strictEqual(brain.answer("emailBrain:setSkillSchedule", [{ skillId: "morning-brief", kind: "cron", cron: "not cron" }]).success, false);
    assert.strictEqual(brain.answer("emailBrain:setSkillSchedule", [{ skillId: "brief-this-person", kind: "interval", everyMinutes: 30 }]).success, false);
    const interval = brain.answer("emailBrain:setSkillSchedule", [{ skillId: "morning-brief", kind: "interval", everyMinutes: 15 }]);
    assert.strictEqual(interval.success, true);
    assert.strictEqual(interval.data.schedule.kind, "interval");
    assert.strictEqual(interval.data.schedule.paused, false);
    const scheduledRow = brain.answer("emailBrain:getSkills", []).data.find((row) => row.id === "morning-brief");
    assert.strictEqual(scheduledRow.schedule, "interval");
    assert.strictEqual(scheduledRow.runMode, "scheduled");
    assert.strictEqual(scheduledRow.everyMinutes, 15);
    const edited = brain.answer("emailBrain:setSkillSchedule", [{ skillId: "morning-brief", kind: "cron", cron: "0 8 * * 1-5" }]);
    assert.strictEqual(edited.success, true);
    assert.strictEqual(edited.data.schedule.cron, "0 8 * * 1-5");
    const scheduleFile = path.join(process.env.MORROW_AI_CONFIG_DIR, "agent.json");
    const scheduleDisk = JSON.parse(fs.readFileSync(scheduleFile, "utf8"));
    assert.ok(scheduleDisk.schedules.some((row) => row.skillId === "morning-brief" && row.cron === "0 8 * * 1-5"));
    const paused = brain.answer("emailBrain:setSkillSchedule", [{ skillId: "morning-brief", paused: true }]);
    assert.strictEqual(paused.success, true);
    assert.strictEqual(paused.data.schedule.paused, true);
    assert.strictEqual(paused.data.schedule.cron, "0 8 * * 1-5");
    const pausedRow = brain.answer("emailBrain:getSkills", []).data.find((row) => row.id === "morning-brief");
    assert.strictEqual(pausedRow.schedule, "paused");
    assert.strictEqual(agent.pumpDueSkills(new Date(Date.parse(paused.data.schedule.nextRunAt) + 1000)).queued, 0);
    const resumed = brain.answer("emailBrain:setSkillSchedule", [{ skillId: "morning-brief", paused: false }]);
    assert.strictEqual(resumed.data.schedule.paused, false);
    const fetchesBefore = seenBodies.length;
    const dueAt = new Date(Date.parse(resumed.data.schedule.nextRunAt) + 1000);
    const started = Date.now();
    const pumped = agent.pumpDueSkills(dueAt);
    assert.strictEqual(pumped.queued, 1);
    assert.ok(Date.now() - started < 200);
    assert.strictEqual(seenBodies.length, fetchesBefore);
    assert.strictEqual(agent.pumpDueSkills(dueAt).queued, 0);
    assert.ok(!functionSource(agentSrc, "pumpDueSkills").includes("await"));
    for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(seenBodies.length > fetchesBefore);
    const afterFire = brain.answer("emailBrain:getSkills", []).data.find((row) => row.id === "morning-brief");
    assert.ok(afterFire.lastRunAt);
    assert.strictEqual(afterFire.lastError, "");
    assert.ok(sent.some((row) => row.channel === "emailBrain:scheduleFired" && row.payload && row.payload.skillId === "morning-brief" && row.payload.accepted === true));
    brain.answer("emailBrain:removeSkill", [{ skillId: "morning-brief" }]);
    const removedSchedule = JSON.parse(fs.readFileSync(scheduleFile, "utf8"));
    assert.ok(!removedSchedule.schedules.some((row) => row.skillId === "morning-brief"));
    const restored = brain.answer("emailBrain:installSkill", [{ skillId: "morning-brief" }]);
    assert.ok(restored.data.skills.some((row) => row.id === "morning-brief" && row.schedule === "disabled"));
  } finally {
    db.hasAccounts = hadAccounts;
    db.recentInbox = hadInbox;
    db.recentInWellKnown = hadSent;
    fs.rmSync(path.join(process.env.MORROW_AI_CONFIG_DIR, "brain.json"), { force: true });
    global.fetch = originalFetch;
    delete process.env.MORROW_AI_API_KEY;
  }
  const blockedChat = await agent.answer("nativeAgent:chat", [{ text: "Hello from the sidebar" }]);
  assert.strictEqual(blockedChat.data.intent, "chat");
  assert.strictEqual(blockedChat.data.turn.error, true);
  assert.match(blockedChat.data.turn.text, /API key/);
  const keptChat = agent.answer("nativeAgent:chatHistory", []);
  assert.ok(keptChat.data.turns.some((turn) => turn.text === "Hello from the sidebar"));
  assert.strictEqual(keptChat.data.memory.notes, "Prefer short replies.");
  assert.strictEqual((await agent.answer("nativeAgent:chat", [{ text: "  " }])).success, false);
  assert.ok(!fs.existsSync(path.join(process.env.MORROW_AI_CONFIG_DIR, "brain.json")));
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
  assert.ok(fs.existsSync(path.join(process.env.MORROW_AI_CONFIG_DIR, "brain.json")));
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
  const ipc = createIpc(path.join(os.tmpdir(), "morrow-studio-ipc.log"));
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

async function checkComposeMailbox() {
  const state = {
    accounts: [
      { id: "sidebar", email: "sidebar@example.invalid", platform: "imap" },
      { id: "source", email: "source@example.invalid", platform: "imap" },
    ],
    accountId: "sidebar",
    composeMeta: { accountId: "source" },
    composeQuote: { text: "Quoted original" },
    prefs: { undoSend: 0 },
  };
  const fields = Object.fromEntries(Object.entries({
    "compose-to": "recipient@example.invalid", "compose-cc": "", "compose-bcc": "",
    "compose-title": "Reply", "compose-subject": "Reply", "compose-body": "Thanks", "schedule-preset": "1h", "schedule-at": "",
  }).map(([id, value]) => [id, { value }]));
  const calls = [];
  const call = async (channel, payload) => { calls.push({ channel, payload }); return {draftId:"saved"}; };
  const syncNames = ["selectedAccount", "composeAccount", "isLive", "composePayload", "composeHasRecipient", "outgoingBody", "toHtml"];
  const asyncNames = ["saveDraft", "scheduleMail", "sendMail"];
  const methods = new Function("state", "$", "call", "showStatus", "scheduleAt", "loadScheduled", "sendDelayMs", "hideUndoSend", "deliverMail", `
    const composeOperation = async work => { await work(); return true; };
    const composeSnapshot = () => "fixture";
    const setComposeStatus = () => {};
    const sendTimer = null;
    ${syncNames.map((name) => functionSource(appJs, name)).join("\n")}
    ${asyncNames.map((name) => "async " + functionSource(appJs, name)).join("\n")}
    return { saveDraft, scheduleMail, sendMail };
  `)(state, (id) => fields[id], call, () => {}, () => new Date("2090-01-01T00:00:00Z"), async () => {}, () => 0, () => {},
    (payload) => call("mail:send", payload));
  for (const kind of ["reply", "all", "forward"]) {
    const seed = compose.composeSeed({ ...engineMail, accountId: "source" }, kind, "source@example.invalid");
    assert.strictEqual(seed.accountId, "source");
    state.composeMeta = { accountId: seed.accountId };
    await methods.saveDraft();
    await methods.scheduleMail();
    // Each action below represents a fresh composition with the same source.
    state.composeQueued = false;
    await methods.sendMail();
  }
  assert.strictEqual(calls.length, 9);
  assert.deepStrictEqual(calls.slice(0, 3).map((row) => row.channel), ["mail:upsertDraft", "mail:scheduleSend", "mail:send"]);
  assert.ok(calls.every(({ payload }) => payload.accountId === "source" && payload.fromAddress === "source@example.invalid"));
  assert.ok(calls.every(({ payload }) => payload.body.includes("Quoted original")));
  state.accounts = state.accounts.filter((account) => account.id !== "source");
  await methods.saveDraft();
  await methods.scheduleMail();
  await methods.sendMail();
  assert.strictEqual(calls.length, 9, "a removed reply account must not fall back to the sidebar mailbox");
}

async function checkTidy() {
  const os = require("os");
  const prev = {
    MORROW_USER_DATA: process.env.MORROW_USER_DATA,
    MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR,
    MORROW_AI_CONFIG_DIR: process.env.MORROW_AI_CONFIG_DIR,
    MORROW_MAIL_SECRETS: process.env.MORROW_MAIL_SECRETS,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-sync-window-"));
  process.env.MORROW_USER_DATA = dir;
  process.env.MORROW_MAIL_DIR = dir;
  process.env.MORROW_AI_CONFIG_DIR = dir;
  process.env.MORROW_MAIL_SECRETS = "memory";
  let savedRemote = null;
  try {
    const { answer: settingsAnswer } = require("../host/settings");
    assert.strictEqual(settingsAnswer("morrow:configGetShowOneClickTidy", []), undefined);
    assert.strictEqual(settingsAnswer("morrow:configSetShowOneClickTidy", [true]), undefined);
    const engine = require("../host/mail/engine");
    const db = require("../host/mail/db");
    const { createIpc } = require("../host/ipc");
    await engine.init();
    assert.strictEqual(engine.answer("mail:tidyInbox", []), undefined);
    assert.strictEqual(engine.answer("morrow:configGetShowOneClickTidyEffective", []), undefined);
    const ipc = createIpc(path.join(dir, "ipc.log"));
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
    assert.strictEqual(engine.answer("mail:tidyInbox", [{ accountId: "imap-test" }]), undefined);

    process.env.MORROW_PAGE_DELAY_MS = "0";
    const remote = require("../host/mail/remote");
    const secrets = require("../host/mail/secrets");
    savedRemote = {
      withClient: remote.withClient,
      searchUids: remote.searchUids,
      fetchMessages: remote.fetchMessages,
      listFolderRecords: remote.listFolderRecords,
      findText: remote.findText,
      renameBox: remote.renameBox,
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
    assert.strictEqual(inbox.sync_horizon_days, 180);
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
    assert.strictEqual(db.folderByPath("imap-ol", "INBOX").sync_horizon_days, 180);

    db.insertAccount({
      id: "imap-old",
      email: "old@example.com",
      username: "old@example.com",
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
    secrets.setPassword("imap-old", "pw");
    const recentUids = Array.from({ length: 40 }, (_item, index) => 80 + index);
    remote.searchUids = async () => ({ uids: recentUids.slice(), validity: 9, exists: 40, unseen: 0 });
    remote.fetchMessages = async (_client, _folder, page) => ({ validity: 9, messages: page.map(header) });
    await engine.syncAccountById("imap-old", { onlyPath: "INBOX" });
    const kept = db.messageByUid("imap-old", "INBOX", 119, 9);
    assert.ok(kept);
    assert.strictEqual(db.countInFolder("imap-old", "INBOX"), 40);
    assert.strictEqual(db.folderByPath("imap-old", "INBOX").sync_horizon_days, 180);
    db.applyFolderSync("imap-old", "INBOX", {
      messages: [],
      keepOthers: true,
      validity: 9,
      windowDone: true,
      horizonDays: null,
    });
    assert.strictEqual(db.folderByPath("imap-old", "INBOX").window_done, 1);
    assert.strictEqual(db.folderByPath("imap-old", "INBOX").sync_horizon_days, null);
    assert.strictEqual(db.countInFolder("imap-old", "INBOX"), 40);
    const paused = Object.assign(new Error("slow down"), { status: 429, retryAfterMs: 60000 });
    remote.searchUids = async () => { throw paused; };
    await engine.syncAccountById("imap-old", { onlyPath: "INBOX" });
    assert.strictEqual(db.messageByUid("imap-old", "INBOX", 119, 9).id, kept.id);
    assert.strictEqual(db.countInFolder("imap-old", "INBOX"), 40);
    const oldGate = engine.syncGates.get("imap-old");
    assert.ok(oldGate && oldGate.until > Date.now());
    engine.syncGates.delete("imap-old");
    const caught = [];
    const widened = Array.from({ length: 80 }, (_item, index) => 40 + index);
    remote.searchUids = async () => ({ uids: widened.slice(), validity: 9, exists: 80, unseen: 0 });
    remote.fetchMessages = async (_client, _folder, page) => {
      caught.push(page.slice());
      return { validity: 9, messages: page.map(header) };
    };
    await engine.syncAccountById("imap-old", { onlyPath: "INBOX" });
    assert.deepStrictEqual(caught, [Array.from({ length: 40 }, (_item, index) => 79 - index)]);
    assert.strictEqual(db.countInFolder("imap-old", "INBOX"), 80);
    assert.strictEqual(db.messageByUid("imap-old", "INBOX", 119, 9).id, kept.id);
    assert.ok(db.messageByUid("imap-old", "INBOX", 40, 9));
    assert.strictEqual(db.folderByPath("imap-old", "INBOX").window_done, 1);
    assert.strictEqual(db.folderByPath("imap-old", "INBOX").sync_horizon_days, 180);
    caught.length = 0;
    await engine.syncAccountById("imap-old", { onlyPath: "INBOX" });
    assert.deepStrictEqual(caught, []);

    const initSqlJs = require("sql.js");
    const wasmDir = path.dirname(require.resolve("sql.js"));
    const SQL = await initSqlJs({ locateFile: (name) => path.join(wasmDir, name) });
    const legacy = new SQL.Database();
    legacy.run(`CREATE TABLE folders (
      account_id TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      well_known TEXT,
      uid_validity INTEGER,
      unread INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER,
      uid_cursor INTEGER NOT NULL DEFAULT 0,
      window_done INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, path)
    )`);
    legacy.run(
      "INSERT INTO folders (account_id, path, name, well_known, uid_validity, uid_cursor, window_done) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["legacy", "INBOX", "Inbox", "inbox", 4, 42, 1]
    );
    legacy.run(`CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      uid INTEGER NOT NULL,
      uid_validity INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      rfc_message_id TEXT,
      in_reply_to TEXT,
      subject TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      from_addr TEXT NOT NULL DEFAULT '',
      to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      bcc_json TEXT NOT NULL DEFAULT '[]',
      date_iso TEXT NOT NULL,
      list_sort_ts INTEGER NOT NULL,
      unread INTEGER NOT NULL DEFAULT 0,
      starred INTEGER NOT NULL DEFAULT 0,
      is_draft INTEGER NOT NULL DEFAULT 0,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      html_body TEXT,
      text_body TEXT,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      body_complete INTEGER NOT NULL DEFAULT 0
    )`);
    legacy.run(
      `INSERT INTO messages (
        id, account_id, folder_path, uid, uid_validity, thread_id, subject, snippet, from_addr,
        date_iso, list_sort_ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["m-legacy", "legacy", "INBOX", 5, 4, "thr-legacy", "Keep me", "still here", "Ada <ada@example.com>", "2026-08-01T00:00:00.000Z", 1785542400000]
    );
    const legacyPath = path.join(dir, "legacy.sqlite");
    fs.writeFileSync(legacyPath, Buffer.from(legacy.export()));
    legacy.close();
    const liveFile = db.file();
    await db.open(legacyPath);
    const legacyFolder = db.folderByPath("legacy", "INBOX");
    assert.strictEqual(legacyFolder.window_done, 1);
    assert.strictEqual(legacyFolder.uid_cursor, 42);
    assert.strictEqual(legacyFolder.sync_horizon_days, null);
    assert.strictEqual(db.messageByUid("legacy", "INBOX", 5, 4).subject, "Keep me");
    await db.open(liveFile);
    assert.ok(db.accountById("imap-test"));
    assert.strictEqual(db.folderByPath("imap-test", "INBOX").window_done, 1);

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
    assert.strictEqual(engine.syncPolicy.syncDays, 180);
    assert.deepStrictEqual(engine.syncPolicy.refreshPages, [20, 30, 30]);
    assert.strictEqual(engine.syncPolicy.headerBatch, 100);
    assert.strictEqual(engine.syncPolicy.outlookBatch, 50);
    assert.strictEqual(engine.syncPolicy.pollMs, 45000);
    assert.strictEqual(engine.syncPolicy.rateLimitMs, 30000);
    assert.strictEqual(engine.syncPolicy.stormMs, 15 * 60 * 1000);
    assert.strictEqual(engine.syncPolicy.idleRenewMs, 25 * 60 * 1000);
    assert.strictEqual(engine.syncPolicy.idleSafetyPollMs, 5 * 60 * 1000);
    assert.ok(engine.syncPolicy.idleSafetyPollMs > engine.syncPolicy.pollMs);
    assert.strictEqual(engine.syncPolicy.idleBackoffCapMs, 3 * 60 * 1000);
    const pushed = engine.answer("mail:listAccounts").data.find((row) => row.id === "imap-test");
    assert.strictEqual(pushed.push, "polling");

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

    const now = Date.now();
    db.insertMessage({
      id: "m-fts-body",
      accountId: "imap-test",
      folderPath: "INBOX",
      uid: 9001,
      uidValidity: 7,
      threadId: "thr-fts",
      subject: "Weekly notes",
      snippet: "see below",
      from: "Grace Hopper <grace@example.com>",
      date: new Date(now).toISOString(),
      listSortTs: now,
      unread: true,
      textBody: "The quartz oscilloscope arrived.",
      bodyComplete: true,
    });
    db.insertMessage({
      id: "m-fts-html",
      accountId: "imap-test",
      folderPath: "INBOX",
      uid: 9002,
      uidValidity: 7,
      threadId: "thr-fts-html",
      subject: "Html only",
      snippet: "preview line",
      from: "Ada <ada@example.com>",
      date: new Date(now + 1).toISOString(),
      listSortTs: now + 1,
      unread: true,
      htmlBody: "<script>notindexedtoken</script><p>Visible <b>kaleidoscope</b> markup</p>",
      bodyComplete: true,
    });
    db.insertMessage({
      id: "m-fts-snippet",
      accountId: "imap-test",
      folderPath: "INBOX",
      uid: 9003,
      uidValidity: 7,
      threadId: "thr-fts-snippet",
      subject: "Header only",
      snippet: "snippetonlyword in the preview",
      from: "Charles <charles@example.com>",
      date: new Date(now + 2).toISOString(),
      listSortTs: now + 2,
      unread: true,
      bodyComplete: false,
    });
    db.insertMessage({
      id: "m-fts-rank-body",
      accountId: "imap-test",
      folderPath: "INBOX",
      uid: 9004,
      uidValidity: 7,
      threadId: "thr-fts-rank-body",
      subject: "Ordinary note",
      snippet: "later",
      from: "Bea <bea@example.com>",
      date: new Date(now + 3).toISOString(),
      listSortTs: now + 50,
      unread: true,
      textBody: "A quartz lantern sits in the body.",
      bodyComplete: true,
    });
    db.insertMessage({
      id: "m-fts-rank-subject",
      accountId: "imap-test",
      folderPath: "INBOX",
      uid: 9005,
      uidValidity: 7,
      threadId: "thr-fts-rank-subject",
      subject: "Quartz lantern status",
      snippet: "earlier",
      from: "Cee <cee@example.com>",
      date: new Date(now).toISOString(),
      listSortTs: now,
      unread: true,
      textBody: "Nothing special here.",
      bodyComplete: true,
    });
    db.insertAccount({
      id: "imap-other",
      email: "other@example.com",
      username: "other@example.com",
      profile: "custom",
      imapHost: "imap.example.test",
      imapPort: 993,
      imapTls: true,
      smtpHost: "smtp.example.test",
      smtpPort: 465,
      smtpTls: true,
      delimiter: "/",
      createdAt: now,
    });
    db.insertMessage({
      id: "m-fts-other",
      accountId: "imap-other",
      folderPath: "INBOX",
      uid: 3,
      uidValidity: 1,
      threadId: "thr-other",
      subject: "Other mailbox",
      snippet: "hidden",
      from: "Other <other@example.com>",
      date: new Date(now).toISOString(),
      listSortTs: now,
      unread: true,
      textBody: "oscilloscope belongs to the other account",
      bodyComplete: true,
    });
    const bodyHit = engine.answer("mail:searchLocal", [{ query: "OSCILLOSCOPE", limit: 10 }]);
    assert.strictEqual(bodyHit.success, true);
    assert.ok(bodyHit.data.some((row) => row.id === "m-fts-body"));
    assert.ok(bodyHit.data.some((row) => row.id === "m-fts-other"));
    const prefixed = engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "oscill", limit: 10 }]);
    assert.deepStrictEqual(prefixed.data.map((row) => row.id), ["m-fts-body"]);
    const infix = engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "scope", limit: 10 }]);
    assert.deepStrictEqual(infix.data, []);
    const fromHit = engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "hopper", limit: 10 }]);
    assert.deepStrictEqual(fromHit.data.map((row) => row.id), ["m-fts-body"]);
    const subjectHit = engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "weekly", limit: 10 }]);
    assert.deepStrictEqual(subjectHit.data.map((row) => row.id), ["m-fts-body"]);
    const snippetNotBody = engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "below", limit: 10 }]);
    assert.deepStrictEqual(snippetNotBody.data, []);
    const htmlHit = engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "kaleidoscope", limit: 10 }]);
    assert.deepStrictEqual(htmlHit.data.map((row) => row.id), ["m-fts-html"]);
    const scriptSkip = engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "notindexedtoken", limit: 10 }]);
    assert.deepStrictEqual(scriptSkip.data, []);
    const snippetHit = engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "snippetonlyword", limit: 10 }]);
    assert.deepStrictEqual(snippetHit.data.map((row) => row.id), ["m-fts-snippet"]);
    const ranked = engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "quartz lantern", limit: 10 }]);
    assert.deepStrictEqual(ranked.data.map((row) => row.id), ["m-fts-rank-subject", "m-fts-rank-body"]);
    db.insertMessage({
      id: "m-fts-cafe",
      accountId: "imap-test",
      folderPath: "INBOX",
      uid: 9006,
      uidValidity: 7,
      threadId: "thr-cafe",
      subject: "Café menu",
      snippet: "drinks",
      from: "Ada <ada@example.com>",
      date: new Date(now).toISOString(),
      listSortTs: now,
      unread: false,
      textBody: "Coffee.",
      bodyComplete: true,
    });
    const folded = engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "cafe", limit: 10 }]);
    assert.deepStrictEqual(folded.data.map((row) => row.id), ["m-fts-cafe"]);
    assert.deepStrictEqual(engine.answer("mail:searchLocal", [{ query: "   ", limit: 10 }]).data, []);
    assert.deepStrictEqual(engine.answer("mail:searchLocal", [{ query: "...", limit: 10 }]).data, []);
    db.updateMessage("m-fts-body", { unread: 0 });
    assert.deepStrictEqual(
      engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "oscilloscope", limit: 10 }]).data.map((row) => row.id),
      ["m-fts-body"]
    );
    db.applyFolderSync("imap-test", "INBOX", {
      messages: [{
        uid: 9001,
        threadId: "thr-fts",
        subject: "Weekly notes",
        snippet: "see below",
        from: "Grace Hopper <grace@example.com>",
        date: new Date(now).toISOString(),
        listSortTs: now,
        textBody: "The prism replaced the old instrument.",
        bodyComplete: true,
      }],
      validity: 7,
      keepOthers: true,
    });
    assert.deepStrictEqual(engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "oscilloscope", limit: 10 }]).data, []);
    const synced = engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "weekly prism", limit: 10 }]);
    assert.deepStrictEqual(synced.data.map((row) => row.id), ["m-fts-body"]);
    assert.deepStrictEqual(engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "weekly kaleidoscope", limit: 10 }]).data, []);
    db.updateMessage("m-fts-snippet", { text_body: "fullbodyword arrived", html_body: null });
    assert.deepStrictEqual(engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "snippetonlyword", limit: 10 }]).data, []);
    assert.deepStrictEqual(
      engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "fullbodyword", limit: 10 }]).data.map((row) => row.id),
      ["m-fts-snippet"]
    );
    db.deleteMessage("m-fts-body");
    assert.deepStrictEqual(engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "prism", limit: 10 }]).data, []);
    db.insertMessage({
      id: "m-fts-gone",
      accountId: "imap-test",
      folderPath: "LocalIndex",
      uid: 4,
      uidValidity: 1,
      threadId: "thr-fts-gone",
      subject: "Drop me",
      snippet: "soon",
      from: "Ada <ada@example.com>",
      date: new Date(now).toISOString(),
      listSortTs: now,
      unread: true,
      textBody: "vanishword stays until sync drops it",
      bodyComplete: true,
    });
    assert.deepStrictEqual(
      engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "vanishword", limit: 10 }]).data.map((row) => row.id),
      ["m-fts-gone"]
    );
    db.applyFolderSync("imap-test", "LocalIndex", {
      messages: [],
      uids: [],
      validity: 1,
      keepOthers: false,
    });
    assert.deepStrictEqual(engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "vanishword", limit: 10 }]).data, []);
    db.deleteMessage("m-fts-html");
    assert.deepStrictEqual(engine.answer("mail:searchLocal", [{ accountId: "imap-test", query: "kaleidoscope", limit: 10 }]).data, []);
    db.removeAccount("imap-other");
    assert.deepStrictEqual(engine.answer("mail:searchLocal", [{ query: "oscilloscope", limit: 10 }]).data, []);

    function seedMoveAccount(id, email, delimiter, folders) {
      db.insertAccount({
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
        delimiter,
        createdAt: Date.now(),
      });
      secrets.setPassword(id, "pw");
      db.replaceFolders(id, folders, delimiter);
    }
    function stampFolder(accountId, folderPath, messageId) {
      db.applyFolderSync(accountId, folderPath, {
        messages: [],
        keepOthers: true,
        validity: 4,
        uidCursor: 12,
        windowDone: true,
        horizonDays: 180,
      });
      db.insertMessage({
        id: messageId,
        accountId,
        folderPath,
        uid: 8,
        uidValidity: 4,
        threadId: messageId,
        subject: messageId,
        snippet: "cached",
        from: "Ada <ada@example.com>",
        date: "2026-08-01T00:00:00.000Z",
        listSortTs: 1785542400000,
        unread: true,
        bodyComplete: true,
      });
    }
    const slashTree = [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Work", name: "Work", wellKnown: null },
      { path: "Work/Travel", name: "Travel", wellKnown: null },
      { path: "Work/Travel/Hotels", name: "Hotels", wellKnown: null },
      { path: "Personal", name: "Personal", wellKnown: null },
    ];
    const planned = db.planImapPathMove(slashTree, "Work", "Personal", "/");
    assert.strictEqual(planned.ok, true);
    assert.deepStrictEqual(planned.renames.map((step) => [step.from, step.to]), [
      ["Work", "Personal/Work"],
      ["Work/Travel", "Personal/Work/Travel"],
      ["Work/Travel/Hotels", "Personal/Work/Travel/Hotels"],
    ]);
    assert.strictEqual(db.planImapPathMove(slashTree, "Work", "Work/Travel", "/").code, "invalid");
    assert.strictEqual(db.planImapPathMove(slashTree, "Work/Travel", "Work", "/").code, "invalid");
    assert.strictEqual(db.planImapPathMove(slashTree, "INBOX", "Personal", "/").code, "invalid");
    assert.strictEqual(db.planImapPathMove(slashTree.concat([
      { path: "Personal/Work", name: "Work", wellKnown: null },
    ]), "Work", "Personal", "/").code, "collision");
    const dotPlan = db.planImapPathMove([
      { path: "Work", name: "Work" },
      { path: "Work.Travel", name: "Travel" },
      { path: "Archive", name: "Archive" },
    ], "Work", "Archive", ".");
    assert.strictEqual(dotPlan.ok, true);
    assert.deepStrictEqual(dotPlan.renames.map((step) => step.to), ["Archive.Work", "Archive.Work.Travel"]);

    seedMoveAccount("imap-clash", "clash@example.com", "/", slashTree.concat([
      { path: "Personal/Work", name: "Work", wellKnown: null },
    ]));
    stampFolder("imap-clash", "Work", "m-clash");
    const renames = [];
    remote.renameBox = async (_client, from, to) => { renames.push([from, to]); };
    remote.withClient = async (_account, _password, fn) => fn({});
    const clashMove = await engine.answer("mail:moveFolder", [{
      accountId: "imap-clash",
      folderId: "Work",
      destinationId: "Personal",
    }]);
    assert.strictEqual(clashMove.success, false);
    assert.strictEqual(clashMove.error.code, "collision");
    assert.deepStrictEqual(renames, []);
    assert.strictEqual(db.messageById("m-clash").folder_path, "Work");
    const inboxMove = await engine.answer("mail:moveFolder", [{
      accountId: "imap-clash",
      folderId: "INBOX",
      destinationId: "Personal",
    }]);
    assert.strictEqual(inboxMove.success, false);
    assert.strictEqual(inboxMove.error.code, "invalid");
    assert.deepStrictEqual(renames, []);

    seedMoveAccount("imap-miss", "miss@example.com", "/", [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Work", name: "Work", wellKnown: null },
      { path: "Personal", name: "Personal", wellKnown: null },
    ]);
    stampFolder("imap-miss", "Work", "m-miss");
    remote.listFolderRecords = async () => ({
      folders: [
        { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
        { path: "Personal", name: "Personal", wellKnown: null },
      ],
      delimiter: "/",
    });
    const missedMove = await engine.answer("mail:moveFolder", [{
      accountId: "imap-miss",
      folderId: "Work",
      destinationId: "Personal",
    }]);
    assert.strictEqual(missedMove.success, false);
    assert.strictEqual(missedMove.error.code, "partial");
    assert.deepStrictEqual(renames, [["Work", "Personal/Work"]]);
    assert.strictEqual(db.folderByPath("imap-miss", "Work").sync_horizon_days, 180);
    assert.strictEqual(db.folderByPath("imap-miss", "Work").uid_cursor, 12);
    assert.strictEqual(db.messageById("m-miss").folder_path, "Work");
    assert.strictEqual(db.folderByPath("imap-miss", "Personal/Work"), null);

    seedMoveAccount("imap-kids", "kids@example.com", "/", slashTree);
    stampFolder("imap-kids", "Work", "m-kids-work");
    stampFolder("imap-kids", "Work/Travel/Hotels", "m-kids-hotels");
    renames.length = 0;
    remote.listFolderRecords = async () => ({
      folders: [
        { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
        { path: "Personal", name: "Personal", wellKnown: null },
        { path: "Personal/Work", name: "Work", wellKnown: null },
        { path: "Work/Travel", name: "Travel", wellKnown: null },
        { path: "Work/Travel/Hotels", name: "Hotels", wellKnown: null },
      ],
      delimiter: "/",
    });
    const kidsMove = await engine.answer("mail:moveFolder", [{
      accountId: "imap-kids",
      folderId: "Work",
      destinationId: "Personal",
    }]);
    assert.strictEqual(kidsMove.success, true);
    assert.match(kidsMove.data.warning, /Work\/Travel/);
    assert.strictEqual(db.messageById("m-kids-work").folder_path, "Personal/Work");
    assert.strictEqual(db.messageById("m-kids-hotels").folder_path, "Work/Travel/Hotels");
    assert.strictEqual(db.folderByPath("imap-kids", "Personal/Work").sync_horizon_days, 180);
    assert.strictEqual(db.folderByPath("imap-kids", "Personal/Work").uid_cursor, 12);
    assert.strictEqual(db.folderByPath("imap-kids", "Personal/Work").window_done, 1);
    assert.strictEqual(db.folderByPath("imap-kids", "Work/Travel/Hotels").sync_horizon_days, 180);

    seedMoveAccount("imap-move", "move@example.com", "/", slashTree);
    stampFolder("imap-move", "Work", "m-move-work");
    stampFolder("imap-move", "Work/Travel", "m-move-travel");
    stampFolder("imap-move", "Work/Travel/Hotels", "m-move-hotels");
    renames.length = 0;
    remote.listFolderRecords = async () => ({
      folders: [
        { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
        { path: "Personal", name: "Personal", wellKnown: null },
        { path: "Personal/Work", name: "Work", wellKnown: null },
        { path: "Personal/Work/Travel", name: "Travel", wellKnown: null },
        { path: "Personal/Work/Travel/Hotels", name: "Hotels", wellKnown: null },
      ],
      delimiter: "/",
    });
    const fullMove = await engine.answer("mail:moveFolder", [{
      accountId: "imap-move",
      folderId: "Work",
      destinationId: "Personal",
    }]);
    assert.strictEqual(fullMove.success, true);
    assert.strictEqual(fullMove.data.warning, "");
    assert.strictEqual(fullMove.data.id, "Personal/Work");
    assert.deepStrictEqual(renames, [["Work", "Personal/Work"]]);
    assert.strictEqual(db.messageById("m-move-work").folder_path, "Personal/Work");
    assert.strictEqual(db.messageById("m-move-travel").folder_path, "Personal/Work/Travel");
    assert.strictEqual(db.messageById("m-move-hotels").folder_path, "Personal/Work/Travel/Hotels");
    assert.strictEqual(db.countInFolder("imap-move", "Work"), 0);
    const movedWork = db.folderByPath("imap-move", "Personal/Work");
    assert.strictEqual(movedWork.sync_horizon_days, 180);
    assert.strictEqual(movedWork.uid_cursor, 12);
    assert.strictEqual(movedWork.window_done, 1);
    assert.strictEqual(movedWork.uid_validity, 4);
    assert.strictEqual(db.folderByPath("imap-move", "Personal/Work/Travel/Hotels").sync_horizon_days, 180);
    assert.strictEqual(db.messageByUid("imap-move", "Personal/Work/Travel", 8, 4).id, "m-move-travel");

    seedMoveAccount("imap-dot", "dot@example.com", ".", [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Work", name: "Work", wellKnown: null },
      { path: "Work.Travel", name: "Travel", wellKnown: null },
      { path: "Archive", name: "Archive", wellKnown: null },
    ]);
    stampFolder("imap-dot", "Work", "m-dot-work");
    stampFolder("imap-dot", "Work.Travel", "m-dot");
    const dotRewrite = db.rewriteFolderPaths("imap-dot", dotPlan.renames);
    assert.deepStrictEqual(dotRewrite.moved.map((step) => step.to), ["Archive.Work.Travel", "Archive.Work"]);
    assert.deepStrictEqual(dotRewrite.skipped, []);
    assert.strictEqual(db.messageById("m-dot").folder_path, "Archive.Work.Travel");
    assert.strictEqual(db.folderByPath("imap-dot", "Archive.Work.Travel").sync_horizon_days, 180);
    assert.strictEqual(db.folderByPath("imap-dot", "Archive.Work").uid_cursor, 12);
    assert.strictEqual(db.folderByPath("imap-dot", "Work"), null);
    await checkSignaturesAndSchedule(engine, db);
  } finally {
    if (savedRemote) {
      const remote = require("../host/mail/remote");
      remote.withClient = savedRemote.withClient;
      remote.searchUids = savedRemote.searchUids;
      remote.fetchMessages = savedRemote.fetchMessages;
      remote.listFolderRecords = savedRemote.listFolderRecords;
      remote.findText = savedRemote.findText;
      remote.renameBox = savedRemote.renameBox;
    }
    delete process.env.MORROW_PAGE_DELAY_MS;
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
  const seenFolders = [];
  const nested = await gmailApi.listMailFolders("token", async (url) => {
    const href = String(url);
    seenFolders.push(href);
    if (href.includes("/childFolders")) {
      return jsonResponse({
        value: [{
          id: "child-1",
          displayName: "Receipts",
          parentFolderId: "folder-1",
          childFolderCount: 0,
        }],
      });
    }
    return jsonResponse({
      value: [{
        id: "folder-1",
        displayName: "Projects",
        parentFolderId: "root",
        childFolderCount: 1,
      }],
    });
  });
  assert.ok(seenFolders.some((href) => href.includes("/mailFolders/folder-1/childFolders")));
  assert.ok(nested.some((folder) => folder.id === "child-1" && folder.parentId === "folder-1" && folder.name === "Receipts"));
  const flatSeen = [];
  const flat = await gmailApi.listMailFolders("token", async (url) => {
    flatSeen.push(String(url));
    return jsonResponse({ value: [{ id: "folder-1", displayName: "Projects", childFolderCount: 0 }] });
  });
  assert.strictEqual(flatSeen.length, 1);
  assert.ok(!flatSeen[0].includes("/childFolders"));
  assert.strictEqual(flat.length, 1);
  const createdChild = await gmailApi.createMailFolder("token", "Receipts", "folder-1", async (url, init) => {
    assert.ok(String(url).includes("/mailFolders/folder-1/childFolders"));
    assert.strictEqual(init.method, "POST");
    assert.strictEqual(JSON.parse(init.body).displayName, "Receipts");
    return jsonResponse({ id: "child-1", displayName: "Receipts", parentFolderId: "folder-1" });
  });
  assert.strictEqual(createdChild.id, "child-1");
  assert.strictEqual(createdChild.parentId, "folder-1");
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
    "MORROW_GOOGLE_OAUTH_JSON",
    "MORROW_GOOGLE_OAUTH_FILE",
    "MORROW_GOOGLE_OAUTH_JSON",
    "MORROW_GOOGLE_OAUTH_FILE",
    "GOOGLE_DESKTOP_OAUTH_JSON",
    "MORROW_MAIL_SECRETS",
  ];
  const prev = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = global.fetch;
  for (const key of envKeys) delete process.env[key];
  process.env.MORROW_MAIL_SECRETS = "memory";
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
    const gmailTree = [
      { id: "L1", name: "Work", type: "user", editable: true },
      { id: "L2", name: "Work/Travel", type: "user", editable: true },
      { id: "L3", name: "Work/Travel/Hotels", type: "user", editable: true },
      { id: "L4", name: "Personal", type: "user", editable: true },
      { id: "INBOX", name: "INBOX", type: "system", editable: false },
    ];
    const movedPlan = gmailApi.planGmailLabelMove(gmailTree, "L1", "L4");
    assert.strictEqual(movedPlan.ok, true);
    assert.deepStrictEqual(movedPlan.renames, [
      { id: "L3", from: "Work/Travel/Hotels", to: "Personal/Work/Travel/Hotels" },
      { id: "L2", from: "Work/Travel", to: "Personal/Work/Travel" },
      { id: "L1", from: "Work", to: "Personal/Work" },
    ]);
    const nestedPlan = gmailApi.planGmailLabelMove(gmailTree, "L2", "L4");
    assert.strictEqual(nestedPlan.ok, true);
    assert.deepStrictEqual(nestedPlan.renames.map((step) => step.to), [
      "Personal/Travel/Hotels",
      "Personal/Travel",
    ]);
    const nameClash = gmailApi.planGmailLabelMove(gmailTree.concat([
      { id: "Lx", name: "Personal/Work/Travel", type: "user", editable: true },
    ]), "L1", "L4");
    assert.strictEqual(nameClash.ok, false);
    assert.strictEqual(nameClash.code, "collision");
    assert.match(nameClash.message, /Personal\/Work\/Travel/);
    assert.match(nameClash.message, /not started/);
    assert.strictEqual(gmailApi.planGmailLabelMove(gmailTree, "L1", "L3").code, "invalid");
    assert.strictEqual(gmailApi.planGmailLabelMove(gmailTree, "L1", "L2").code, "invalid");
    assert.strictEqual(gmailApi.planGmailLabelMove(gmailTree, "L2", "L1").code, "invalid");
    assert.strictEqual(gmailApi.planGmailLabelMove(gmailTree, "L1", "").code, "invalid");
    assert.strictEqual(gmailApi.planGmailLabelMove(gmailTree, "INBOX", "L4").code, "invalid");
    const gmailList = {
      labels: gmailTree.map((label) => ({ id: label.id, name: label.name, type: label.type })),
    };
    let gmailPatches = 0;
    await assert.rejects(
      () => gmailApi.moveLabel("token", "INBOX", "L4", async (_url, init) => {
        if (init && init.method === "PATCH") gmailPatches += 1;
        return jsonResponse(gmailList);
      }),
      (error) => error && error.code === "invalid",
    );
    assert.strictEqual(gmailPatches, 0);
    gmailPatches = 0;
    await assert.rejects(
      () => gmailApi.moveLabel("token", "L1", "L4", async (_url, init) => {
        if (init && init.method === "PATCH") gmailPatches += 1;
        return jsonResponse({
          labels: gmailList.labels.concat([{ id: "Lx", name: "Personal/Work", type: "user" }]),
        });
      }),
      (error) => error && error.code === "collision" && /Personal\/Work/.test(error.message),
    );
    assert.strictEqual(gmailPatches, 0);
    const patchNames = [];
    await assert.rejects(
      () => gmailApi.moveLabel("token", "L1", "L4", async (url, init) => {
        if (!init || init.method !== "PATCH") return jsonResponse(gmailList);
        const body = JSON.parse(init.body);
        patchNames.push(body.name);
        if (String(url).endsWith("/L3")) return jsonResponse({}, 500);
        return jsonResponse({ id: "ok", name: body.name, type: "user" });
      }),
      (error) => {
        assert.strictEqual(error.code, "partial");
        assert.match(error.message, /Partly renamed/);
        assert.match(error.message, /Work\/Travel\/Hotels/);
        assert.match(error.message, /only partly renamed/);
        assert.ok(error.failed.some((step) => step.from === "Work/Travel/Hotels"));
        assert.ok(error.moved.some((step) => step.to === "Personal/Work"));
        return true;
      },
    );
    assert.deepStrictEqual(patchNames, [
      "Personal/Work/Travel/Hotels",
      "Personal/Work/Travel",
      "Personal/Work",
    ]);
    const applied = [];
    const renamed = await gmailApi.moveLabel("token", "L2", "L4", async (url, init) => {
      if (!init || init.method !== "PATCH") return jsonResponse(gmailList);
      const body = JSON.parse(init.body);
      applied.push({ id: decodeURIComponent(String(url).split("/labels/").pop()), name: body.name });
      return jsonResponse({ id: applied.at(-1).id, name: body.name, type: "user" });
    });
    assert.deepStrictEqual(applied, [
      { id: "L3", name: "Personal/Travel/Hotels" },
      { id: "L2", name: "Personal/Travel" },
    ]);
    assert.strictEqual(renamed.name, "Personal/Travel");
    const graphTree = [
      { id: "in", name: "Inbox", type: "system", editable: false, wellKnown: "inbox", parentId: "" },
      { id: "work", name: "Work", type: "user", editable: true, parentId: "" },
      { id: "rec", name: "Receipts", type: "user", editable: true, parentId: "work" },
      { id: "tax", name: "Taxes", type: "user", editable: true, parentId: "rec" },
      { id: "dup", name: "receipts", type: "user", editable: true, parentId: "" },
    ];
    assert.strictEqual(gmailApi.planGraphFolderMove(graphTree, "rec", "").code, "collision");
    assert.strictEqual(gmailApi.planGraphFolderMove(graphTree, "rec", "tax").code, "invalid");
    assert.strictEqual(gmailApi.planGraphFolderMove(graphTree, "rec", "work").code, "invalid");
    assert.strictEqual(gmailApi.planGraphFolderMove(graphTree, "in", "work").code, "invalid");
    const rootPlan = gmailApi.planGraphFolderMove(graphTree.filter((row) => row.id !== "dup"), "rec", "");
    assert.strictEqual(rootPlan.ok, true);
    assert.strictEqual(rootPlan.destinationId, "msgfolderroot");
    assert.ok(gmailApi.graphFolderMoveUrl("rec").endsWith("/mailFolders/rec/move"));
    let graphMoves = 0;
    await assert.rejects(
      () => gmailApi.moveMailFolder("token", "in", "work", async (url) => {
        if (String(url).includes("/move")) graphMoves += 1;
        return jsonResponse({
          value: [
            { id: "in", displayName: "Inbox", wellKnownName: "inbox", parentFolderId: "msgfolderroot" },
            { id: "work", displayName: "Work", parentFolderId: "msgfolderroot", childFolderCount: 0 },
          ],
        });
      }),
      (error) => error && error.code === "invalid",
    );
    assert.strictEqual(graphMoves, 0);
    const graphBodies = [];
    const graphMoved = await gmailApi.moveMailFolder("token", "rec", "", async (url, init) => {
      const href = String(url);
      if (href.includes("/childFolders")) return jsonResponse({ value: [] });
      if (href.endsWith("/move")) {
        graphBodies.push(JSON.parse(init.body));
        assert.strictEqual(init.method, "POST");
        return jsonResponse({ id: "rec", displayName: "Receipts", parentFolderId: "msgfolderroot" });
      }
      return jsonResponse({
        value: [
          { id: "work", displayName: "Work", parentFolderId: "msgfolderroot", childFolderCount: 1 },
          { id: "rec", displayName: "Receipts", parentFolderId: "work", childFolderCount: 0 },
        ],
      });
    });
    assert.deepStrictEqual(graphBodies, [{ destinationId: "msgfolderroot" }]);
    assert.strictEqual(graphMoved.id, "rec");
    assert.strictEqual(graphMoved.parentId, "msgfolderroot");
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
    const gmailLabels = [
      { id: "Label_9", name: "Travel", type: "user" },
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "Label_blank", type: "user" },
    ];
    const graphFolders = [
      { id: "folder-1", displayName: "Projects", parentFolderId: "msgfolderroot", childFolderCount: 0 },
    ];
    const gmailPatchFail = new Set();
    const providerCalls = [];
    let gmailVacation = {
      enableAutoReply: false,
      responseSubject: "Away",
      responseBodyPlainText: "Back soon",
      restrictToContacts: false,
      restrictToDomain: false,
    };
    let graphVacation = {
      status: "disabled",
      internalReplyMessage: "Inside",
      externalReplyMessage: "Outside",
      externalAudience: "all",
    };
    let gmailVacationReads = 0;
    let gmailVacationFlip = false;
    let gmailVacationFail = false;
    function route(url, init) {
      const href = String(url);
      const method = (init && init.method) || "GET";
      calls.push({ href, method });
      if (href === "https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation") {
        if (method === "GET") {
          gmailVacationReads += 1;
          if (gmailVacationFlip && gmailVacationReads % 2 === 0) {
            return jsonResponse({ ...gmailVacation, responseSubject: "Changed" });
          }
          return jsonResponse(gmailVacation);
        }
        if (method === "PUT") {
          if (gmailVacationFail) return jsonResponse({}, 500);
          gmailVacation = JSON.parse(init.body);
          return jsonResponse(gmailVacation);
        }
      }
      if (href === "https://graph.microsoft.com/v1.0/me/mailboxSettings/automaticRepliesSetting" && method === "GET") {
        return jsonResponse(graphVacation);
      }
      if (href === "https://graph.microsoft.com/v1.0/me/mailboxSettings" && method === "PATCH") {
        const body = JSON.parse(init.body);
        assert.deepStrictEqual(Object.keys(body), ["automaticRepliesSetting"]);
        graphVacation = { ...graphVacation, ...body.automaticRepliesSetting };
        return jsonResponse({ automaticRepliesSetting: graphVacation });
      }
      if (href.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/labels") && method === "GET" && !href.includes("/labels/")) {
        return jsonResponse({ labels: gmailLabels.map((label) => ({ ...label })) });
      }
      if (method === "PATCH" && href.includes("/gmail/v1/users/me/labels/")) {
        const id = decodeURIComponent(href.split("/labels/").pop().split("?")[0]);
        const body = JSON.parse(init.body);
        providerCalls.push({ kind: "gmail-patch", id, name: body.name });
        if (gmailPatchFail.has(id)) return jsonResponse({}, 500);
        const row = gmailLabels.find((label) => label.id === id);
        if (row) row.name = body.name;
        return jsonResponse({ id, name: body.name, type: "user" });
      }
      if (href.includes("rfc822msgid")) return jsonResponse({ messages: [{ id: "msg-1" }] });
      if (method === "POST" && href.includes("/messages/msg-1/modify")) return jsonResponse({});
      if (href.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders") && method === "GET") {
        if (href.includes("/childFolders")) return jsonResponse({ value: [] });
        return jsonResponse({ value: graphFolders.map((folder) => ({ ...folder })) });
      }
      if (method === "POST" && href.includes("/mailFolders/") && href.endsWith("/move")) {
        const id = decodeURIComponent(href.split("/mailFolders/")[1].split("/move")[0]);
        const body = JSON.parse(init.body);
        providerCalls.push({ kind: "graph-move", id, destinationId: body.destinationId });
        const row = graphFolders.find((folder) => folder.id === id);
        return jsonResponse({
          id,
          displayName: row ? row.displayName : id,
          parentFolderId: body.destinationId,
          childFolderCount: 0,
        });
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
    process.env.MORROW_GOOGLE_OAUTH_JSON = JSON.stringify({
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
    gmailLabels.splice(0, gmailLabels.length,
      { id: "L1", name: "Work", type: "user" },
      { id: "L2", name: "Work/Travel", type: "user" },
      { id: "L3", name: "Work/Travel/Hotels", type: "user" },
      { id: "L4", name: "Personal", type: "user" },
      { id: "Lx", name: "Personal/Work", type: "user" },
      { id: "INBOX", name: "INBOX", type: "system" },
    );
    const blockedMove = await engine.answer("mail:moveProviderFolder", [{
      accountId: "gmail-live",
      folderId: "L1",
      destinationId: "L4",
    }]);
    assert.strictEqual(blockedMove.success, false);
    assert.strictEqual(blockedMove.error.code, "collision");
    assert.match(blockedMove.error.message, /Personal\/Work/);
    assert.strictEqual(providerCalls.filter((call) => call.kind === "gmail-patch").length, 0);
    gmailLabels.splice(gmailLabels.findIndex((label) => label.id === "Lx"), 1);
    gmailPatchFail.add("L3");
    const partialMove = await engine.answer("mail:moveProviderFolder", [{
      accountId: "gmail-live",
      folderId: "L1",
      destinationId: "L4",
    }]);
    assert.strictEqual(partialMove.success, false);
    assert.strictEqual(partialMove.error.code, "partial");
    assert.match(partialMove.error.message, /Work\/Travel\/Hotels/);
    assert.match(partialMove.error.message, /Partly renamed/);
    assert.ok(providerCalls.some((call) => call.kind === "gmail-patch" && call.name === "Personal/Work/Travel/Hotels"));
    gmailPatchFail.clear();
    gmailLabels.splice(0, gmailLabels.length,
      { id: "L1", name: "Work", type: "user" },
      { id: "L2", name: "Work/Travel", type: "user" },
      { id: "L3", name: "Work/Travel/Hotels", type: "user" },
      { id: "L4", name: "Personal", type: "user" },
      { id: "INBOX", name: "INBOX", type: "system" },
    );
    providerCalls.length = 0;
    const providerMoved = await engine.answer("mail:moveProviderFolder", [{
      accountId: "gmail-live",
      folderId: "L1",
      destinationId: "L4",
    }]);
    assert.strictEqual(providerMoved.success, true);
    assert.strictEqual(providerMoved.data.name, "Personal/Work");
    assert.deepStrictEqual(providerCalls.filter((call) => call.kind === "gmail-patch").map((call) => call.name), [
      "Personal/Work/Travel/Hotels",
      "Personal/Work/Travel",
      "Personal/Work",
    ]);
    const lockedMove = await engine.answer("mail:moveProviderFolder", [{
      accountId: "gmail-live",
      folderId: "INBOX",
      destinationId: "L4",
    }]);
    assert.strictEqual(lockedMove.success, false);
    assert.strictEqual(lockedMove.error.code, "invalid");
    assert.strictEqual(providerCalls.filter((call) => call.kind === "gmail-patch" && call.id === "INBOX").length, 0);

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
    graphFolders.splice(0, graphFolders.length,
      { id: "inbox-id", displayName: "Inbox", wellKnownName: "inbox", parentFolderId: "msgfolderroot", childFolderCount: 0 },
      { id: "work-id", displayName: "Work", parentFolderId: "msgfolderroot", childFolderCount: 1 },
      { id: "rec-id", displayName: "Receipts", parentFolderId: "work-id", childFolderCount: 0 },
      { id: "dup-id", displayName: "receipts", parentFolderId: "msgfolderroot", childFolderCount: 0 },
    );
    const graphClash = await engine.answer("mail:moveProviderFolder", [{
      accountId: "outlook-live",
      folderId: "rec-id",
      destinationId: "",
    }]);
    assert.strictEqual(graphClash.success, false);
    assert.strictEqual(graphClash.error.code, "collision");
    assert.strictEqual(providerCalls.filter((call) => call.kind === "graph-move").length, 0);
    graphFolders.splice(graphFolders.findIndex((folder) => folder.id === "dup-id"), 1);
    const graphMovedFolder = await engine.answer("mail:moveProviderFolder", [{
      accountId: "outlook-live",
      folderId: "rec-id",
      destinationId: "",
    }]);
    assert.strictEqual(graphMovedFolder.success, true);
    assert.deepStrictEqual(providerCalls.filter((call) => call.kind === "graph-move"), [
      { kind: "graph-move", id: "rec-id", destinationId: "msgfolderroot" },
    ]);
    const graphLocked = await engine.answer("mail:moveProviderFolder", [{
      accountId: "outlook-live",
      folderId: "inbox-id",
      destinationId: "work-id",
    }]);
    assert.strictEqual(graphLocked.success, false);
    assert.strictEqual(graphLocked.error.code, "invalid");
    assert.strictEqual(providerCalls.filter((call) => call.kind === "graph-move").length, 1);
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
    liveAccount({
      id: "outlook-grant",
      email: "leo.grant@example.com",
      profile: "outlook",
      authKind: "oauth2",
    });
    const mailboxSecret = JSON.stringify({
      provider: "microsoft",
      purpose: "imap",
      refreshToken: "refresh-imap-grant",
      accessToken: "access-imap-grant",
      expiresAt: Date.now() + 10 * 60 * 1000,
      grantedScopes: oauthConfig.SCOPES.microsoft,
      requestedScopes: oauthConfig.SCOPES.microsoft,
    });
    secrets.setPassword("outlook-grant", mailboxSecret);
    const omitted = await oauthMod.exchange(
      "microsoft",
      { clientId: oauthConfig.MICROSOFT_CLIENT_ID, clientSecret: "" },
      "code",
      "http://localhost:1/api/oauth/microsoft/callback",
      "verifier",
      oauthConfig.ORGANIZE_SCOPES.microsoft,
      async () => jsonResponse({
        access_token: "opaque-organize",
        refresh_token: "refresh-omit",
        expires_in: 3600,
      }),
    );
    assert.strictEqual(omitted.grantedScopes, oauthConfig.ORGANIZE_SCOPES.microsoft);
    const encoded = await oauthMod.exchange(
      "microsoft",
      { clientId: oauthConfig.MICROSOFT_CLIENT_ID, clientSecret: "" },
      "code",
      "http://localhost:1/api/oauth/microsoft/callback",
      "verifier",
      oauthConfig.ORGANIZE_SCOPES.microsoft,
      async () => jsonResponse({
        access_token: fakeJwt({ scp: "Mail.ReadWrite User.Read Mail.Send" }),
        refresh_token: "refresh-encoded",
        expires_in: 3600,
        scope: "https%3A%2F%2Fgraph.microsoft.com%2Fmail.readwrite",
      }),
    );
    assert.strictEqual(oauthConfig.hasMarker(encoded.grantedScopes, "microsoft", "organize"), true);
    const originalSignIn = oauthMod.signIn;
    let browser = null;
    const signedGrant = (grantedScopes) => ({
      provider: "microsoft",
      purpose: "organize",
      email: "leo.grant@example.com",
      refreshToken: "refresh-organize-grant",
      accessToken: "access-organize-grant",
      expiresAt: Date.now() + 10 * 60 * 1000,
      requestedScopes: oauthConfig.ORGANIZE_SCOPES.microsoft,
      grantedScopes,
      complete(outcome) { browser = outcome; },
    });
    try {
      oauthMod.signIn = async () => signedGrant(
        "https%3A%2F%2Fgraph.microsoft.com%2Fuser.read%20https%3A%2F%2Fgraph.microsoft.com%2Fmail.send",
      );
      const missing = await sidecar.answer("mail:grantOrganize", [{ accountId: "outlook-grant" }]);
      assert.strictEqual(missing.success, false);
      assert.strictEqual(missing.error.code, "scope_missing");
      assert.match(missing.error.message, /Mail\.ReadWrite/);
      assert.strictEqual(browser && browser.ok, false);
      assert.strictEqual(secrets.getPassword("outlook-grant:bundle"), null);
      assert.strictEqual(secrets.getPassword("outlook-grant"), mailboxSecret);
      const stillImap = await sidecar.answer("mail:listProviderFolders", [{ accountId: "outlook-grant" }]);
      assert.strictEqual(stillImap.success, true);
      assert.strictEqual(stillImap.data.api, false);
      assert.strictEqual(stillImap.data.reason, "scope_missing");

      browser = null;
      oauthMod.signIn = async () => signedGrant("offline_access,USER.READ,mail.readwrite,Mail.Send");
      const granted = await sidecar.answer("mail:grantOrganize", [{ accountId: "outlook-grant" }]);
      assert.strictEqual(granted.success, true);
      assert.strictEqual(granted.data.api, true);
      assert.strictEqual(browser && browser.ok, true);
      const saved = JSON.parse(secrets.getPassword("outlook-grant:bundle"));
      assert.match(saved.grantedScopes, /mail\.readwrite/i);
      assert.strictEqual(secrets.getPassword("outlook-grant"), mailboxSecret);
      assert.strictEqual(sidecar.gateAccount(db.accountById("outlook-grant"), "organize").ok, true);
      const folders = await sidecar.answer("mail:listProviderFolders", [{ accountId: "outlook-grant" }]);
      assert.strictEqual(folders.data.api, true);
      assert.strictEqual(folders.data.source, "graph");
      assert.ok(calls.some((call) => String(call.href).includes("/me/mailFolders") && call.method === "GET"));

      browser = null;
      oauthMod.signIn = async () => signedGrant(oauthConfig.ORGANIZE_SCOPES.microsoft);
      const storedRequest = await sidecar.answer("mail:grantOrganize", [{ accountId: "outlook-grant" }]);
      assert.strictEqual(storedRequest.success, true);
      assert.strictEqual(storedRequest.data.api, true);
      const requestedBlob = JSON.parse(secrets.getPassword("outlook-grant:bundle"));
      assert.strictEqual(browser, null, "saved organize access must be reused without another consent");
      assert.strictEqual(oauthConfig.hasMarker(requestedBlob.grantedScopes, "microsoft", "organize"), true);
      assert.strictEqual(secrets.getPassword("outlook-grant"), mailboxSecret);
    } finally {
      oauthMod.signIn = originalSignIn;
    }
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
    assert.ok(db.accountById("oauth-draft"));
    assert.ok(db.accountById("oauth-draft").auth_error);
    assert.ok(db.accountById("named-oauth"));
    assert.ok(db.accountById("outlook-live"));
    secrets.setPassword("gmail-live", "imap-secret");
    const beforeVacation = calls.length;
    const locked = await engine.answer("mail:vacationGet", [{ accountId: "gmail-live" }]);
    assert.strictEqual(locked.success, true);
    assert.strictEqual(locked.data.requiresReconnect, true);
    assert.strictEqual(locked.data.canWrite, false);
    assert.match(locked.data.detail, /gmail.settings.basic/);
    assert.strictEqual(calls.length, beforeVacation);
    const unconfirmed = await engine.answer("mail:vacationPut", [{
      accountId: "gmail-live",
      action: "save",
      confirmed: false,
      mode: "always",
      subject: "Away",
      message: "Back soon",
      externalMessage: "",
      audience: "all",
      restrictToDomain: false,
      revision: "a".repeat(64),
    }]);
    assert.strictEqual(unconfirmed.success, false);
    assert.strictEqual(calls.length, beforeVacation);
    const keptMailbox = secrets.getPassword("gmail-live");
    const wrongPerson = sidecar.rememberVacation(db.accountById("gmail-live"), {
      provider: "google",
      email: "other@example.com",
      refreshToken: "vacation-new",
      grantedScopes: oauthConfig.VACATION_SCOPES.google,
      accessToken: "vacation-access",
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    assert.strictEqual(wrongPerson.success, false);
    assert.strictEqual(wrongPerson.error.code, "account_mismatch");
    assert.strictEqual(secrets.getPassword("gmail-live:vacation"), null);
    assert.strictEqual(secrets.getPassword("gmail-live"), keptMailbox);
    const partialGrant = sidecar.rememberVacation(db.accountById("gmail-live"), {
      provider: "google",
      email: "ada.live@example.com",
      refreshToken: "vacation-new",
      grantedScopes: "openid email",
      accessToken: "vacation-access",
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    assert.strictEqual(partialGrant.success, false);
    assert.strictEqual(partialGrant.error.code, "partial");
    assert.strictEqual(secrets.getPassword("gmail-live:vacation"), null);
    assert.strictEqual(secrets.getPassword("gmail-live"), keptMailbox);
    const granted = sidecar.rememberVacation(db.accountById("gmail-live"), {
      provider: "google",
      email: "ada.live@example.com",
      refreshToken: "vacation-refresh",
      grantedScopes: oauthConfig.VACATION_SCOPES.google,
      requestedScopes: oauthConfig.VACATION_SCOPES.google,
      accessToken: "vacation-access",
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    assert.strictEqual(granted.success, true);
    assert.ok(!JSON.stringify(granted).includes("vacation-refresh"));
    assert.strictEqual(secrets.getPassword("gmail-live"), keptMailbox);
    const loaded = await engine.answer("mail:vacationGet", [{ accountId: "gmail-live" }]);
    assert.strictEqual(loaded.success, true);
    assert.strictEqual(loaded.data.canWrite, true);
    assert.strictEqual(loaded.data.settings.subject, "Away");
    assert.strictEqual(loaded.data.settings.mode, "disabled");
    const quietAfterLoad = calls.length;
    const noConfirm = await engine.answer("mail:vacationPut", [{
      accountId: "gmail-live",
      action: "save",
      confirmed: false,
      revision: loaded.data.revision,
      mode: "always",
      subject: "Away",
      message: "Back soon",
      externalMessage: "",
      audience: "all",
      restrictToDomain: false,
      start: "",
      end: "",
    }]);
    assert.strictEqual(noConfirm.success, false);
    assert.strictEqual(noConfirm.error.code, "invalid");
    assert.strictEqual(calls.length, quietAfterLoad);
    const stale = await engine.answer("mail:vacationPut", [{
      accountId: "gmail-live",
      confirmed: true,
      action: "save",
      revision: "b".repeat(64),
      mode: "always",
      subject: "Away",
      message: "Back soon",
      externalMessage: "",
      audience: "all",
      restrictToDomain: false,
      start: "",
      end: "",
    }]);
    assert.strictEqual(stale.success, false);
    assert.strictEqual(stale.error.code, "conflict");
    assert.strictEqual(calls.filter((call) => call.method === "PUT" && call.href.includes("/settings/vacation")).length, 0);
    gmailVacationFlip = true;
    gmailVacationReads = 0;
    const raced = await engine.answer("mail:vacationPut", [{
      accountId: "gmail-live",
      confirmed: true,
      action: "save",
      revision: loaded.data.revision,
      mode: "always",
      subject: "Away",
      message: "Back soon",
      externalMessage: "",
      audience: "all",
      restrictToDomain: false,
      start: "",
      end: "",
    }]);
    assert.strictEqual(raced.success, false);
    assert.strictEqual(raced.error.code, "conflict");
    assert.strictEqual(calls.filter((call) => call.method === "PUT" && call.href.includes("/settings/vacation")).length, 0);
    gmailVacationFlip = false;
    const current = await engine.answer("mail:vacationGet", [{ accountId: "gmail-live" }]);
    const enabled = await engine.answer("mail:vacationPut", [{
      accountId: "gmail-live",
      confirmed: true,
      action: "save",
      revision: current.data.revision,
      mode: "always",
      subject: "Away",
      message: "Back soon",
      externalMessage: "",
      audience: "contacts",
      restrictToDomain: false,
      start: "",
      end: "",
    }]);
    assert.strictEqual(enabled.success, true);
    assert.strictEqual(enabled.data.settings.mode, "always");
    assert.strictEqual(enabled.data.settings.audience, "contacts");
    assert.strictEqual(gmailVacation.responseBodyPlainText, "Back soon");
    const putsBeforeFail = calls.filter((call) => call.method === "PUT" && call.href.includes("/settings/vacation")).length;
    gmailVacationFail = true;
    const failedWrite = await engine.answer("mail:vacationPut", [{
      accountId: "gmail-live",
      confirmed: true,
      action: "disable",
      revision: enabled.data.revision,
    }]);
    assert.strictEqual(failedWrite.success, false);
    assert.match(failedWrite.error.message, /will not retry automatically/);
    assert.doesNotMatch(failedWrite.error.message, /500|responseBody/);
    assert.strictEqual(calls.filter((call) => call.method === "PUT" && call.href.includes("/settings/vacation")).length, putsBeforeFail + 1);
    assert.strictEqual(gmailVacation.enableAutoReply, true);
    gmailVacationFail = false;
    const freshVacation = await engine.answer("mail:vacationGet", [{ accountId: "gmail-live" }]);
    const disabled = await engine.answer("mail:vacationPut", [{
      accountId: "gmail-live",
      confirmed: true,
      action: "disable",
      revision: freshVacation.data.revision,
    }]);
    assert.strictEqual(disabled.success, true);
    assert.strictEqual(disabled.data.settings.mode, "disabled");
    assert.strictEqual(gmailVacation.enableAutoReply, false);
    assert.strictEqual(gmailVacation.responseSubject, "Away");
    assert.strictEqual(gmailVacation.responseBodyPlainText, "Back soon");
    secrets.setPassword("outlook-live:vacation", JSON.stringify({
      provider: "microsoft",
      purpose: "vacation",
      refreshToken: "vacation-ms",
      accessToken: "access-ms-vacation",
      expiresAt: Date.now() + 10 * 60 * 1000,
      grantedScopes: oauthConfig.VACATION_SCOPES.microsoft,
      requestedScopes: oauthConfig.VACATION_SCOPES.microsoft,
    }));
    const outlookLoaded = await engine.answer("mail:vacationGet", [{ accountId: "outlook-live" }]);
    assert.strictEqual(outlookLoaded.data.provider, "microsoft");
    assert.strictEqual(outlookLoaded.data.settings.message, "Inside");
    const vacationOauth = require("../host/mail/oauth");
    const originalAccessTokenFor = vacationOauth.accessTokenFor;
    const beforeRefresh = secrets.getPassword("outlook-live:vacation");
    try {
      vacationOauth.accessTokenFor = async (_account, raw) => {
        const blob = JSON.parse(raw);
        return { token: blob.accessToken, store: JSON.stringify({ ...blob, refreshToken: blob.accessToken }) };
      };
      const refreshed = await engine.answer("mail:vacationGet", [{ accountId: "outlook-live" }]);
      assert.strictEqual(refreshed.success, true, "the request's own refresh must not be treated as a reconnect");
      vacationOauth.accessTokenFor = async (_account, raw) => {
        // A new consent arrives while the old token refresh is in flight.
        secrets.setPassword("outlook-live:vacation", beforeRefresh);
        return { token: JSON.parse(raw).accessToken, store: raw };
      };
      const reconnected = await engine.answer("mail:vacationGet", [{ accountId: "outlook-live" }]);
      assert.strictEqual(reconnected.success, false);
      assert.strictEqual(reconnected.error.code, "conflict");
      assert.strictEqual(secrets.getPassword("outlook-live:vacation"), beforeRefresh);
    } finally {
      vacationOauth.accessTokenFor = originalAccessTokenFor;
      secrets.setPassword("outlook-live:vacation", beforeRefresh);
    }
    const outlookSaved = await engine.answer("mail:vacationPut", [{
      accountId: "outlook-live",
      confirmed: true,
      action: "save",
      revision: outlookLoaded.data.revision,
      mode: "always",
      subject: "",
      message: "Inside <safe>",
      externalMessage: "Outside",
      audience: "all",
      restrictToDomain: false,
      start: "",
      end: "",
    }]);
    assert.strictEqual(outlookSaved.success, true);
    assert.ok(graphVacation.internalReplyMessage.includes("&lt;safe&gt;"));
    assert.ok(!JSON.stringify(outlookSaved).includes("vacation-ms"));
    secrets.setPassword("imap-test", "pw");
    const sieve = require("../host/mail/sieve-vacation");
    const originalSieve = sieve.manageSieve;
    try {
      sieve.manageSieve = async () => {
        throw new Error("SECRET-SOCKET connect ECONNREFUSED");
      };
      const unreachable = await engine.answer("mail:vacationGet", [{ accountId: "imap-test" }]);
      assert.strictEqual(unreachable.success, true);
      assert.strictEqual(unreachable.data.supported, false);
      assert.match(unreachable.data.detail, /will not send local automatic replies/);
      assert.doesNotMatch(unreachable.data.detail, /SECRET|ECONNREFUSED/);
      const unreachablePut = await engine.answer("mail:vacationPut", [{
        accountId: "imap-test",
        confirmed: true,
        action: "disable",
        revision: "c".repeat(64),
      }]);
      assert.strictEqual(unreachablePut.success, false);
      assert.match(unreachablePut.error.message, /will not retry automatically/);
      assert.doesNotMatch(unreachablePut.error.message, /SECRET|ECONNREFUSED/);
      const sieveState = { extensions: ["vacation", "date", "relational"], active: "", script: "" };
      sieve.manageSieve = async (mail, operation) => {
        assert.strictEqual(mail.imapHost, "imap.example.test");
        assert.strictEqual(mail.password, "pw");
        if (operation.action === "read") return { extensions: sieveState.extensions.slice(), active: sieveState.active, script: sieveState.script };
        if (operation.action === "disable") {
          if (sieveState.active === "morrow-vacation") sieveState.active = "";
          sieveState.script = "";
          return { extensions: sieveState.extensions.slice(), active: sieveState.active, script: "" };
        }
        if (sieveState.active && sieveState.active !== "morrow-vacation") {
          const error = new Error("This IMAP server already has an active Sieve script. Morrow will not replace it.");
          error.safe = true;
          error.status = 409;
          throw error;
        }
        sieveState.script = operation.script;
        sieveState.active = "morrow-vacation";
        return { extensions: sieveState.extensions.slice(), active: sieveState.active, script: sieveState.script };
      };
      const imapLoaded = await engine.answer("mail:vacationGet", [{ accountId: "imap-test" }]);
      assert.strictEqual(imapLoaded.data.transport, "sieve");
      assert.strictEqual(imapLoaded.data.settings.mode, "disabled");
      const imapSaved = await engine.answer("mail:vacationPut", [{
        accountId: "imap-test",
        confirmed: true,
        action: "save",
        revision: imapLoaded.data.revision,
        mode: "always",
        subject: "Away",
        message: "Hello",
        externalMessage: "",
        audience: "all",
        restrictToDomain: false,
        start: "",
        end: "",
      }]);
      assert.strictEqual(imapSaved.success, true);
      assert.match(sieveState.script, /vacation :days 1 :subject "Away" "Hello";/);
      assert.doesNotMatch(sieveState.script, /date/);
      sieveState.active = "";
      const inactiveScript = await engine.answer("mail:vacationGet", [{ accountId: "imap-test" }]);
      assert.strictEqual(inactiveScript.data.settings.mode, "disabled");
      assert.strictEqual(inactiveScript.data.settings.message, "Hello");
      sieveState.active = "other-filters";
      const blockedScript = await engine.answer("mail:vacationPut", [{
        accountId: "imap-test",
        confirmed: true,
        action: "save",
        revision: imapSaved.data.revision,
        mode: "always",
        subject: "Away",
        message: "Hello",
        externalMessage: "",
        audience: "all",
        restrictToDomain: false,
        start: "",
        end: "",
      }]);
      assert.strictEqual(blockedScript.success, false);
      assert.match(blockedScript.error.message, /will not replace/);
      assert.strictEqual(sieveState.active, "other-filters");
    } finally {
      sieve.manageSieve = originalSieve;
    }
    const removed = await engine.answer("mail:removeAccount", [{ accountId: "gmail-live" }]);
    assert.strictEqual(removed.success, true);
    assert.strictEqual(secrets.getPassword("gmail-live"), null);
    assert.strictEqual(secrets.getPassword("gmail-live:organize"), null);
    assert.strictEqual(secrets.getPassword("gmail-live:calendar"), null);
    assert.strictEqual(secrets.getPassword("gmail-live:vacation"), null);
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
    "MORROW_GOOGLE_OAUTH_JSON",
    "MORROW_GOOGLE_OAUTH_FILE",
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
    process.env.MORROW_GOOGLE_OAUTH_JSON = JSON.stringify({
      installed: {
        client_id: "morrow-primary.apps.googleusercontent.com",
        client_secret: "morrow-primary-secret",
      },
    });
    assert.strictEqual(oauth.loadGoogleClient().clientId, "morrow-primary.apps.googleusercontent.com");
    for (const key of keys) delete process.env[key];
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-gclient-"));
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
  const keys = ["MORROW_AI_CONFIG_DIR", "MORROW_AI_API_KEY", "MORROW_AI_BASE_URL", "MORROW_AI_MODEL", "XAI_API_KEY"];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-ai-"));
  const originalFetch = global.fetch;
  try {
    process.env.MORROW_AI_CONFIG_DIR = dir;
    for (const key of keys.slice(1)) delete process.env[key];
    const empty = publicConfig();
    assert.strictEqual(empty.hasKey, false);
    assert.strictEqual(empty.keyHint, "");
    assert.ok(!Object.prototype.hasOwnProperty.call(empty, "apiKey"));
    const missing = await listModels({ baseUrl: "https://api.x.ai/v1", apiKey: "" });
    assert.deepStrictEqual(missing, { ok: false, message: "Add an API key in Morrow Mail → AI Setup." });
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
    process.env.MORROW_AI_API_KEY = "sk-env-override-zz";
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

async function checkPackagedPublicFeed(secret) {
  const Module = require("module");
  const feeds = [];
  const events = {};
  const handlers = {};
  let checks = 0;
  const fakeApp = { isPackaged: true };
  const fakeAuto = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    setFeedURL(feed) {
      feeds.push({ ...feed });
    },
    on(name, fn) {
      events[name] = fn;
    },
    checkForUpdates() {
      checks += 1;
      if (events["checking-for-update"]) events["checking-for-update"]();
      return Promise.resolve(null);
    },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return { app: fakeApp, ipcMain: { handle(name, fn) { handlers[name] = fn; } } };
    }
    if (request === "electron-updater") return { autoUpdater: fakeAuto };
    return originalLoad.call(this, request, parent, isMain);
  };
  const updaterPath = require.resolve("../host/updater");
  delete require.cache[updaterPath];
  for (const name of ["electron", "electron-updater"]) {
    try {
      delete require.cache[require.resolve(name)];
    } catch {
      // optional dependency during the feed test
    }
  }
  try {
    const updater = require("../host/updater");
    updater.registerIpc();
    const open = await handlers["host:updateCheck"]();
    assert.strictEqual(checks, 1);
    assert.strictEqual(fakeAuto.allowPrerelease, true);
    assert.strictEqual(fakeAuto.autoDownload, true);
    assert.strictEqual(open.enabled, true);
    assert.strictEqual(open.needsToken, false);
    assert.strictEqual(open.error, null);
    assert.deepStrictEqual(feeds[0], {
      provider: "github",
      owner: "Coke1120",
      repo: "Morrow-Mail",
      private: false,
    });
    process.env.GH_TOKEN = secret;
    const authed = await handlers["host:updateCheck"]();
    assert.strictEqual(checks, 2);
    assert.strictEqual(authed.needsToken, false);
    assert.deepStrictEqual(feeds[1], feeds[0], "environment tokens must not select the private provider");
    events.error(new Error("401 Bad credentials " + secret));
    const rejected = updater.snapshot();
    assert.strictEqual(rejected.needsToken, false);
    assert.match(rejected.error, /No GitHub token is required/);
    assert.ok(!rejected.error.includes(secret));
    delete process.env.GH_TOKEN;
    events.error(new Error("403 Forbidden"));
    const blocked = updater.snapshot();
    assert.strictEqual(blocked.needsToken, false);
    assert.match(blocked.error, /public GitHub update request was blocked/);
    events.error(Object.assign(new Error("API rate limit exceeded"), {statusCode:403}));
    assert.strictEqual(updater.snapshot().needsToken, false);
    assert.match(updater.snapshot().error, /limiting update requests/);
    events.error(new Error("404 missing latest-mac.yml"));
    const missingFile = updater.snapshot();
    assert.strictEqual(missingFile.needsToken, false);
    assert.match(missingFile.error, /404 missing latest-mac.yml/);
    const again = await handlers["host:updateCheck"]();
    assert.strictEqual(checks, 3);
    assert.strictEqual(again.needsToken, false);
    assert.strictEqual(again.error, null);
    assert.ok(!Object.prototype.hasOwnProperty.call(feeds[feeds.length - 1], "token"));
    fakeApp.isPackaged = false;
    const dev = updater.init();
    assert.strictEqual(dev.enabled, false);
    assert.strictEqual(dev.needsToken, false);
  } finally {
    delete process.env.GH_TOKEN;
    Module._load = originalLoad;
    delete require.cache[updaterPath];
  }
}

async function checkUpdateAuth() {
  const os = require("os");
  const auth = require("../host/update-auth");
  const prev = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    MORROW_USER_DATA: process.env.MORROW_USER_DATA,
    MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR,
    MORROW_AI_CONFIG_DIR: process.env.MORROW_AI_CONFIG_DIR,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-update-"));
  const secret = "ghp_supersecretvalue1234567890";
  try {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    process.env.MORROW_USER_DATA = dir;
    process.env.MORROW_MAIL_DIR = dir;
    process.env.MORROW_AI_CONFIG_DIR = dir;
    const openFeed = { provider: "github", owner: "Coke1120", repo: "Morrow-Mail", private: false };
    assert.deepStrictEqual(auth.githubFeed(), openFeed);
    fs.writeFileSync(path.join(dir, "github-update.json"), JSON.stringify({token:secret}));
    process.env.GH_TOKEN = secret;
    process.env.GITHUB_TOKEN = secret;
    assert.deepStrictEqual(auth.githubFeed(secret), openFeed);
    // Exercise the dependency's real provider factory, not just our config shape.
    const {createClient} = require("electron-updater/out/providerFactory");
    const provider = createClient(auth.githubFeed(secret), {allowPrerelease:true}, {executor:{},platform:"win32"});
    assert.strictEqual(provider.constructor.name, "GitHubProvider");
    for (const status of [401,403,429]) {
      const explained = auth.explainUpdateError(Object.assign(new Error("HTTP " + status), {statusCode:status}));
      assert.match(explained, /[Nn]o GitHub token|do not require a GitHub token/);
    }
    assert.match(auth.explainUpdateError(new Error("403 API rate limit exceeded")), /limiting update requests/);
    assert.match(auth.explainUpdateError(new Error("429 Too Many Requests")), /limiting update requests/);
    assert.match(auth.explainUpdateError(new Error("net::ERR_INTERNET_DISCONNECTED")), /ERR_INTERNET_DISCONNECTED/);
    const notFound = auth.explainUpdateError(new Error('404 missing latest.yml ' + secret));
    assert.match(notFound, /404 missing latest.yml/);
    assert.ok(!notFound.includes(secret));
    assert.ok(!notFound.includes("required"));
    assert.strictEqual(auth.explainUpdateError(new Error("Could not reach the mail server.")), "Could not reach the mail server.");
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    await checkPackagedPublicFeed(secret);
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

    let repeatTarget = "";
    let repeatPage = null;
    const repeated = await oauthMod.signIn("microsoft", "imap", {
      timeoutMs: 5000,
      openBrowser: (url) => {
        repeatTarget = callbackFrom(url);
        repeatPage = hitLoopback(repeatTarget);
        return Promise.resolve();
      },
    });
    const invalidTarget = new URL(repeatTarget);
    invalidTarget.searchParams.set("state", "not-the-state");
    const invalid = await hitLoopback(invalidTarget.toString());
    assert.strictEqual(invalid.status, 400);
    assert.match(invalid.body, /Invalid OAuth callback/);
    assert.doesNotMatch(invalid.body, /<h1>Connected<\/h1>/);
    const duplicatePage = hitLoopback(repeatTarget);
    await new Promise((resolve) => setTimeout(resolve, 30));
    repeated.complete({ ok: true });
    const [repeatBody, duplicateBody] = await Promise.all([repeatPage, duplicatePage]);
    assert.strictEqual(repeatBody.status, 200);
    assert.match(repeatBody.body, /<h1>Connected<\/h1>/);
    assert.match(repeatBody.body, /Return to Morrow Mail/);
    assert.strictEqual(duplicateBody.status, 200);
    assert.match(duplicateBody.body, /<h1>Connected<\/h1>/);
    assert.match(duplicateBody.body, /Return to Morrow Mail/);
    assert.doesNotMatch(duplicateBody.body, /no longer waiting/);
    assert.doesNotMatch(duplicateBody.body, /Sign-in not finished/);

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

async function checkInboxRules() {
  const os = require("os");
  const rules = require("../host/mail/inbox-rules");
  const ruleUi = loadFunctions(appJs, ["inboxRuleSummary", "inboxRuleFormMode", "readInboxRuleForm"]);
  assert.deepStrictEqual(ruleUi.inboxRuleFormMode("gmail"), {
    backend: "gmail",
    name: false,
    enabled: false,
    star: true,
    label: true,
    stop: false,
  });
  assert.strictEqual(ruleUi.inboxRuleFormMode("microsoft").star, false);
  assert.strictEqual(ruleUi.inboxRuleFormMode("imap").stop, true);
  const uiDraft = ruleUi.readInboxRuleForm({
    name: " News ",
    from: " news@ ",
    attachment: "yes",
    markRead: true,
    star: true,
    stopProcessing: false,
  }, "microsoft");
  assert.strictEqual(uiDraft.name, "News");
  assert.strictEqual(uiDraft.actions.star, false);
  assert.strictEqual(uiDraft.match.hasAttachment, true);
  assert.strictEqual(uiDraft.actions.stopProcessing, false);
  assert.strictEqual(
    ruleUi.inboxRuleSummary({ name: "News", enabled: false, match: { from: "news@" }, actions: { archive: true } }),
    "Off. News — From news@ → Archive",
  );
  assert.strictEqual(rules.backendFor({ profile: "gmail", auth_kind: "oauth2" }), "gmail");
  assert.strictEqual(rules.backendFor({ profile: "outlook", auth_kind: "password" }), "imap");
  assert.strictEqual(rules.backendFor({ profile: "fastmail", authKind: "oauth2" }), "imap");
  const gmailBody = rules.toGmailFilter({
    match: { from: "news@letter.test", subject: "Digest", hasAttachment: false },
    actions: { markRead: true, star: true, archive: true, addLabelIds: ["Label_9"] },
  });
  assert.deepStrictEqual(gmailBody.criteria, {
    excludeChats: true,
    from: "news@letter.test",
    subject: "Digest",
    hasAttachment: false,
  });
  assert.deepStrictEqual(gmailBody.action.addLabelIds, ["STARRED", "Label_9"]);
  assert.deepStrictEqual(gmailBody.action.removeLabelIds, ["UNREAD", "INBOX"]);
  assert.ok(!Object.prototype.hasOwnProperty.call(gmailBody.action, "forward"));
  assert.throws(
    () => rules.normalizeDraft({ match: { from: "a@b.c" }, actions: { trash: true, archive: true } }, "gmail"),
    /Trash cannot/,
  );
  assert.throws(
    () => rules.normalizeDraft({ name: "Stars", match: { from: "a@b.c" }, actions: { star: true } }, "microsoft"),
    /cannot star/,
  );
  assert.throws(
    () => rules.normalizeDraft({ match: { from: "a@b.c" }, actions: { markRead: true } }, "imap"),
    /name/i,
  );
  assert.throws(
    () => rules.normalizeDraft({ name: "Bad", match: { from: "a\nb" }, actions: { markRead: true } }, "imap"),
    /From/,
  );
  const hidden = rules.fromGmailFilter({
    id: "f-forward",
    criteria: { from: "a@b.c" },
    action: { forward: "secret@example.com", addLabelIds: ["STARRED"] },
  });
  assert.strictEqual(hidden.editable, false);
  assert.strictEqual(hidden.unsupported, "forward");
  assert.ok(!JSON.stringify(hidden).includes("secret@example.com"));
  const graphBody = rules.toGraphRule({
    name: "Newsletters",
    match: { from: "news@", text: "unsubscribe" },
    actions: { archive: true, markRead: true },
  }, 2, "archive-id");
  assert.strictEqual(graphBody.displayName, "Newsletters");
  assert.strictEqual(graphBody.sequence, 2);
  assert.strictEqual(graphBody.actions.moveToFolder, "archive-id");
  assert.strictEqual(graphBody.actions.markAsRead, true);
  assert.strictEqual(graphBody.actions.delete, false);
  assert.deepStrictEqual(graphBody.conditions.senderContains, ["news@"]);
  assert.deepStrictEqual(graphBody.conditions.bodyContains, ["unsubscribe"]);
  assert.ok(!graphBody.actions.forwardTo);
  const graphHidden = rules.fromGraphRule({
    id: "fwd",
    displayName: "Fwd",
    sequence: 1,
    isEnabled: true,
    conditions: { subjectContains: ["hi"] },
    actions: { forwardTo: [{ emailAddress: { address: "secret@example.com" } }], stopProcessingRules: true },
  }, "");
  assert.strictEqual(graphHidden.editable, false);
  assert.ok(!JSON.stringify(graphHidden).includes("secret@example.com"));
  const editableGraph = {
    id: "first-rule", displayName: "First", sequence: 1,
    conditions: { subjectContains: ["news"] }, actions: { markAsRead: true },
  };
  for (const extra of [{ exceptions: { senderContains: ["keep-unread"] } }, { isReadOnly: true }]) {
    const protectedRule = { ...editableGraph, ...extra };
    assert.strictEqual(rules.fromGraphRule(protectedRule, "").editable, false);
    const methods = [];
    await assert.rejects(rules.saveGraph("", {
      id: protectedRule.id, name: "Edited", match: { subject: "news" }, actions: { markRead: true },
    }, "", async (_url, init) => {
      methods.push(init.method || "GET");
      return jsonResponse(protectedRule);
    }), /does not rewrite/);
    assert.deepStrictEqual(methods, ["GET"]);
  }
  let replacementSequence;
  const editedGraph = await rules.saveGraph("", {
    id: editableGraph.id, name: "Edited", match: { subject: "news" }, actions: { markRead: true },
  }, "", async (url, init) => {
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      replacementSequence = body.sequence;
      return jsonResponse({ ...body, id: "replacement-rule" });
    }
    if (init.method === "DELETE") return jsonResponse({});
    if (String(url).endsWith("/first-rule")) return jsonResponse(editableGraph);
    return jsonResponse({ value: [editableGraph, { ...editableGraph, id: "last-rule", sequence: 9 }] });
  });
  assert.strictEqual(replacementSequence, 1);
  assert.strictEqual(editedGraph.id, "replacement-rule");
  for (const addLabelIds of [["Label_1", "Label_2"], ["STARRED", "SPAM"], ["STARRED", "UNREAD"]]) {
    assert.strictEqual(rules.fromGmailFilter({
      id: "custom-labels", criteria: { from: "news@" }, action: { addLabelIds },
    }).editable, false);
  }
  const seenGraph = [];
  const listedGraph = await rules.listGraph("token", "archive-id", async (url) => {
    seenGraph.push(String(url));
    return jsonResponse({
      value: [{
        id: "rule-1",
        displayName: "Newsletters",
        sequence: 1,
        isEnabled: true,
        conditions: { senderContains: ["news@"] },
        actions: { moveToFolder: "archive-id", markAsRead: true, stopProcessingRules: true },
      }],
      "@odata.nextLink": "https://evil.example/steal",
    });
  });
  assert.strictEqual(seenGraph.length, 1);
  assert.ok(seenGraph[0].includes("/mailFolders/inbox/messageRules"));
  assert.strictEqual(listedGraph[0].actions.archive, true);
  assert.strictEqual(listedGraph[0].actions.moveToId, "");
  assert.strictEqual(listedGraph[0].editable, true);
  await assert.rejects(
    () => rules.saveGmail("token", {
      id: "old-id",
      match: { from: "a@b.c" },
      actions: { markRead: true },
    }, async (url, init) => {
      const method = (init && init.method) || "GET";
      if (method === "GET") {
        return jsonResponse({ id: "old-id", criteria: { from: "a@b.c" }, action: { removeLabelIds: ["UNREAD"] } });
      }
      if (method === "POST") {
        const body = JSON.parse(init.body);
        return jsonResponse({ id: "new-id", criteria: body.criteria, action: body.action });
      }
      return jsonResponse({ error: "no" }, 500);
    }),
    (error) => error && error.code === "partial" && !String(error.message).includes("Bearer"),
  );
  const plan = rules.planImap([
    {
      id: "a",
      enabled: true,
      sinceUid: 10,
      position: 1,
      match: { from: "news@" },
      actions: { archive: true, markRead: true, stopProcessing: true },
    },
    {
      id: "b",
      enabled: true,
      sinceUid: 10,
      position: 2,
      match: { from: "news@" },
      actions: { star: true, stopProcessing: true },
    },
    {
      id: "off",
      enabled: false,
      sinceUid: 0,
      position: 0,
      match: { from: "news@" },
      actions: { trash: true },
    },
  ], [
    { uid: 10, from: "news@letter.test", subject: "Old" },
    { uid: 11, from: "News <news@letter.test>", subject: "Digest", hasAttachments: false },
    { uid: 12, from: "news@letter.test", subject: "File", hasAttachments: true },
  ]);
  assert.deepStrictEqual(plan.map((step) => step.uid), [11, 12]);
  assert.ok(plan.every((step) => step.ruleId === "a" && step.markRead === true && step.archive === true));
  const both = rules.planImap([
    {
      id: "a",
      enabled: true,
      sinceUid: 0,
      position: 1,
      match: { subject: "Hi" },
      actions: { markRead: true, stopProcessing: false },
    },
    {
      id: "b",
      enabled: true,
      sinceUid: 0,
      position: 2,
      match: { subject: "Hi" },
      actions: { star: true, stopProcessing: true },
    },
  ], [{ uid: 3, subject: "Hi" }]);
  assert.deepStrictEqual(both.map((step) => step.ruleId), ["a", "b"]);
  assert.strictEqual(rules.matches({ match: { hasAttachment: false } }, { hasAttachments: true }), false);
  assert.strictEqual(rules.matches({ match: { text: "Unsub" } }, { subject: "Weekly", snippet: "please unsubscribe" }), true);
  let ruleAttempts = 0;
  await assert.rejects(rules.runImapPlan({
    account: { id: "rules-imap", profile: "custom", auth_kind: "password" },
    folder: { path: "INBOX", well_known: "inbox" },
    rules: [{ id: "read", enabled: true, match: { subject: "Hi" }, actions: { markRead: true } }],
    messages: [{ uid: 1, subject: "Hi" }, { uid: 2, subject: "Hi" }],
    remote: { async changeFlags() { ruleAttempts += 1; throw Object.assign(new Error("Rate limit"), { status: 429 }); } },
  }), (error) => error.status === 429);
  assert.strictEqual(ruleAttempts, 1, "throttling must stop the rule batch and reach the sync pause handler");

  const db = require("../host/mail/db");
  const sidecar = require("../host/mail/sidecar");
  const secrets = require("../host/mail/secrets");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-rules-"));
  const prevFetch = global.fetch;
  const prevJson = process.env.GOOGLE_DESKTOP_OAUTH_JSON;
  const prevSecrets = process.env.MORROW_MAIL_SECRETS;
  process.env.MORROW_MAIL_SECRETS = "memory";
  delete process.env.GOOGLE_DESKTOP_OAUTH_JSON;
  const calls = [];
  const remote = {
    async changeFlags(_client, folder, uid, add) {
      calls.push({ op: "flags", folder, uid, add });
    },
    async moveUid(_client, folder, uid, dest) {
      calls.push({ op: "move", folder, uid, dest });
      return { uid: 9, uidValidity: 8 };
    },
  };
  try {
    db.close();
    await db.open(path.join(dir, "mail.sqlite"));
    const accountId = "rules-imap";
    db.insertAccount({
      id: accountId,
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
      authKind: "password",
    });
    db.replaceFolders(accountId, [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Archive", name: "Archive", wellKnown: "archive" },
      { path: "Trash", name: "Trash", wellKnown: "deleteditems" },
      { path: "News", name: "News", wellKnown: null },
    ], "/");
    db.applyFolderSync(accountId, "INBOX", {
      messages: [],
      validity: 5,
      uidCursor: 40,
      windowDone: true,
      horizonDays: 180,
    });
    global.fetch = async () => {
      throw new Error("IMAP rules must not call a provider");
    };
    const saved = await sidecar.answer("mail:saveInboxRule", [{
      accountId,
      rule: {
        name: "Newsletters",
        enabled: true,
        match: { from: "news@" },
        actions: { archive: true, markRead: true, stopProcessing: true },
      },
    }]);
    assert.strictEqual(saved.success, true);
    assert.strictEqual(saved.data.sinceUid, 40);
    assert.strictEqual(saved.data.actions.archive, true);
    const rejected = await sidecar.answer("mail:saveInboxRule", [{
      accountId,
      rule: { name: "Empty", actions: { markRead: true } },
    }]);
    assert.strictEqual(rejected.success, false);
    assert.strictEqual(rejected.error.code, "invalid");
    const edited = await sidecar.answer("mail:saveInboxRule", [{
      accountId,
      rule: {
        id: saved.data.id,
        name: "Newsletters",
        enabled: true,
        match: { from: "news@", subject: "Digest" },
        actions: { archive: true, markRead: true, stopProcessing: true },
      },
    }]);
    assert.strictEqual(edited.success, true);
    assert.strictEqual(edited.data.sinceUid, 40);
    assert.strictEqual(edited.data.match.subject, "Digest");
    const skipped = await rules.runImapPlan({
      account: db.accountById(accountId),
      folder: db.folderByPath(accountId, "INBOX"),
      messages: [{ uid: 99, from: "news@letter.test", subject: "Digest" }],
      rules: [{
        id: "missing-dest",
        enabled: true,
        sinceUid: 0,
        position: 1,
        match: { from: "news@" },
        actions: { moveToId: "Missing", stopProcessing: true },
      }],
      remote,
      db,
      client: {},
      validity: 5,
    });
    assert.strictEqual(skipped.failed, 1);
    assert.strictEqual(skipped.applied, 0);
    assert.deepStrictEqual(calls, []);
    db.insertMessage({
      id: "m-news",
      accountId,
      folderPath: "INBOX",
      uid: 41,
      uidValidity: 5,
      threadId: "t-news",
      subject: "Digest",
      snippet: "unsubscribe",
      from: "News <news@letter.test>",
      to: ["ada@example.com"],
      date: new Date().toISOString(),
      listSortTs: Date.now(),
      unread: true,
      bodyComplete: true,
    });
    const applied = await rules.runImapPlan({
      client: {},
      remote,
      db,
      account: db.accountById(accountId),
      folder: db.folderByPath(accountId, "INBOX"),
      messages: [{ uid: 41, from: "News <news@letter.test>", to: ["ada@example.com"], subject: "Digest", snippet: "unsubscribe" }],
      validity: 5,
    });
    assert.strictEqual(applied.applied, 1);
    assert.strictEqual(applied.failed, 0);
    assert.deepStrictEqual(calls, [
      { op: "flags", folder: "INBOX", uid: 41, add: ["\\Seen"] },
      { op: "move", folder: "INBOX", uid: 41, dest: "Archive" },
    ]);
    const moved = db.messageById("m-news");
    assert.strictEqual(moved.folder_path, "Archive");
    assert.strictEqual(moved.uid, 9);
    assert.strictEqual(moved.unread, 0);
    const gmailAccount = { id: "g", profile: "gmail", auth_kind: "oauth2" };
    const gmailRun = await rules.runImapPlan({
      account: gmailAccount,
      folder: { path: "INBOX", well_known: "inbox" },
      messages: [{ uid: 5, from: "news@letter.test", subject: "Digest" }],
      rules: [{
        id: "local",
        enabled: true,
        sinceUid: 0,
        position: 1,
        match: { from: "news@" },
        actions: { markRead: true, stopProcessing: true },
      }],
      remote,
      db,
      client: {},
      validity: 1,
    });
    assert.strictEqual(gmailRun.applied, 0);
    assert.strictEqual(calls.length, 2);
    db.resetInboxRuleWatermarks(accountId);
    assert.strictEqual(db.inboxRuleById(accountId, saved.data.id).sinceUid, 0);
    const removed = await sidecar.answer("mail:deleteInboxRule", [{ accountId, ruleId: saved.data.id }]);
    assert.strictEqual(removed.success, true);
    assert.strictEqual(db.listInboxRules(accountId).length, 0);
    const listed = await sidecar.answer("mail:listInboxRules", [{ accountId }]);
    assert.strictEqual(listed.data.api, true);
    assert.strictEqual(listed.data.backend, "imap");
    assert.ok(listed.data.destinations.some((folder) => folder.id === "News"));
    assert.ok(!listed.data.destinations.some((folder) => folder.wellKnown === "inbox"));

    db.insertAccount({
      id: "rules-gmail",
      email: "ada.gmail@example.com",
      username: "ada.gmail@example.com",
      profile: "gmail",
      imapHost: "imap.gmail.com",
      imapPort: 993,
      imapTls: true,
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpTls: true,
      delimiter: "/",
      createdAt: Date.now(),
      authKind: "oauth2",
    });
    let providerCalls = 0;
    global.fetch = async () => {
      providerCalls += 1;
      throw new Error("missing grant must not call Gmail");
    };
    const needsGrant = await sidecar.answer("mail:listInboxRules", [{ accountId: "rules-gmail" }]);
    assert.strictEqual(needsGrant.success, true);
    assert.strictEqual(needsGrant.data.api, false);
    assert.strictEqual(needsGrant.data.backend, "gmail");
    assert.strictEqual(needsGrant.data.reason, "scope_missing");
    assert.ok(needsGrant.data.message.includes("gmail.settings.basic"));
    assert.strictEqual(providerCalls, 0);

    process.env.GOOGLE_DESKTOP_OAUTH_JSON = JSON.stringify({
      installed: {
        client_id: "inbox-rules.apps.googleusercontent.com",
        client_secret: "inbox-rules-secret",
      },
    });
    secrets.setPassword("rules-gmail:rules", JSON.stringify({
      provider: "google",
      purpose: "rules",
      refreshToken: "refresh-rules",
      accessToken: "access-rules",
      expiresAt: Date.now() + 10 * 60 * 1000,
      grantedScopes: oauthConfig.RULES_SCOPES.google,
      requestedScopes: oauthConfig.RULES_SCOPES.google,
    }));
    db.insertAccount({
      id: "rules-ms",
      email: "ada.outlook@example.com",
      username: "ada.outlook@example.com",
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
    secrets.setPassword("rules-ms:rules", JSON.stringify({
      provider: "microsoft",
      purpose: "rules",
      refreshToken: "refresh-rules",
      accessToken: "access-rules",
      expiresAt: Date.now() + 10 * 60 * 1000,
      grantedScopes: oauthConfig.RULES_SCOPES.microsoft,
      requestedScopes: oauthConfig.RULES_SCOPES.microsoft,
    }));
    const hits = [];
    let graphRulePosts = 0;
    global.fetch = async (url, init) => {
      const href = String(url);
      const method = (init && init.method) || "GET";
      const body = init && init.body ? JSON.parse(init.body) : null;
      hits.push({ href, method, body, authorization: init && init.headers && init.headers.authorization });
      if (href.includes("evil.example")) throw new Error("followed a foreign next link");
      if (href.includes("/users/me/labels")) {
        return jsonResponse({
          labels: [
            { id: "Label_9", name: "News", type: "user" },
            { id: "INBOX", name: "INBOX", type: "system" },
          ],
        });
      }
      if (href.includes("/settings/filters")) {
        if (method === "POST") return jsonResponse({ id: "filter-1", criteria: body.criteria, action: body.action });
        if (method === "DELETE") return jsonResponse({}, 204);
        return jsonResponse({ filter: [] });
      }
      if (href.includes("/mailFolders") && !href.includes("messageRules")) {
        return jsonResponse({
          value: [
            { id: "archive-id", displayName: "Archive", wellKnownName: "archive", childFolderCount: 0 },
            { id: "news-id", displayName: "News", childFolderCount: 0 },
          ],
        });
      }
      if (href.includes("messageRules")) {
        if (method === "GET" && href.endsWith("/rule-1")) {
          return jsonResponse({
            id: "rule-1",
            displayName: "Newsletters",
            sequence: 1,
            isEnabled: true,
            conditions: { senderContains: ["news@"] },
            actions: { moveToFolder: "archive-id", markAsRead: true, stopProcessingRules: true },
          });
        }
        if (method === "POST") {
          graphRulePosts += 1;
          return jsonResponse({
            id: graphRulePosts === 1 ? "rule-1" : "rule-2",
            displayName: body.displayName,
            sequence: body.sequence,
            isEnabled: body.isEnabled,
            conditions: body.conditions,
            actions: body.actions,
          });
        }
        if (method === "DELETE") return jsonResponse({}, 204);
        return jsonResponse({
          value: [],
          "@odata.nextLink": "https://evil.example/steal",
        });
      }
      return jsonResponse({}, 404);
    };
    const gmailList = await sidecar.answer("mail:listInboxRules", [{ accountId: "rules-gmail" }]);
    assert.strictEqual(gmailList.success, true);
    assert.strictEqual(gmailList.data.api, true);
    assert.strictEqual(gmailList.data.backend, "gmail");
    assert.ok(gmailList.data.destinations.some((label) => label.id === "Label_9"));
    assert.ok(!gmailList.data.destinations.some((label) => label.id === "INBOX"));
    assert.ok(hits.some((hit) => hit.href.includes("/settings/filters") && hit.authorization === "Bearer access-rules"));
    const gmailSaved = await sidecar.answer("mail:saveInboxRule", [{
      accountId: "rules-gmail",
      rule: {
        match: { from: "news@letter.test" },
        actions: { archive: true, addLabelIds: ["Label_9"] },
      },
    }]);
    assert.strictEqual(gmailSaved.success, true);
    assert.strictEqual(gmailSaved.data.id, "filter-1");
    assert.ok(gmailSaved.data.actions.archive);
    assert.deepStrictEqual(gmailSaved.data.actions.addLabelIds, ["Label_9"]);
    const gmailPost = hits.find((hit) => hit.method === "POST" && hit.href.includes("/settings/filters"));
    assert.ok(gmailPost);
    assert.ok(!gmailPost.body.action.forward);
    assert.ok(gmailPost.body.action.removeLabelIds.includes("INBOX"));
    const msSaved = await sidecar.answer("mail:saveInboxRule", [{
      accountId: "rules-ms",
      rule: {
        name: "Newsletters",
        match: { from: "news@" },
        actions: { archive: true, markRead: true, stopProcessing: true },
      },
    }]);
    assert.strictEqual(msSaved.success, true);
    assert.strictEqual(msSaved.data.actions.archive, true);
    assert.strictEqual(msSaved.data.actions.moveToId, "");
    const msPost = hits.find((hit) => hit.method === "POST" && hit.href.includes("messageRules"));
    assert.strictEqual(msPost.body.actions.moveToFolder, "archive-id");
    assert.strictEqual(msPost.body.actions.markAsRead, true);
    assert.ok(!msPost.body.actions.forwardTo);
    assert.ok(!hits.some((hit) => hit.href.includes("evil.example")));
    const msEdited = await sidecar.answer("mail:saveInboxRule", [{
      accountId: "rules-ms",
      rule: {
        id: "rule-1",
        name: "Newsletters",
        match: { from: "news@", subject: "Digest" },
        actions: { archive: true, markRead: true },
      },
    }]);
    assert.strictEqual(msEdited.success, true);
    assert.ok(hits.some((hit) => hit.method === "DELETE" && hit.href.endsWith("/rule-1")));
    const msDeleted = await sidecar.answer("mail:deleteInboxRule", [{ accountId: "rules-ms", ruleId: "rule-1" }]);
    assert.strictEqual(msDeleted.success, true);
    const packed = JSON.stringify({ gmailList, gmailSaved, msSaved, msEdited, msDeleted });
    assert.ok(!packed.includes("access-rules"));
    assert.ok(!packed.includes("refresh-rules"));
    assert.ok(!packed.includes("inbox-rules-secret"));
    assert.ok(fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8").includes("runImapPlan"));
    assert.ok(html.includes('id="inbox-rules-open"') && html.includes("Inbox rules"));
    assert.ok(html.includes('id="brain-tab-rules"') && appJs.includes("Grant Gmail filters"));
    assert.ok(oauthDoc.includes("https://www.googleapis.com/auth/gmail.settings.basic"));
    assert.ok(oauthDoc.includes("MailboxSettings.ReadWrite"));
    assert.strictEqual(oauthConfig.normalizePurpose("filters"), "rules");
    assert.ok(!oauthConfig.RULES_SCOPES.microsoft.includes("outlook.office"));
    assert.ok(!oauthConfig.RULES_SCOPES.google.includes("https://mail.google.com/"));
    assert.strictEqual(
      oauthConfig.profileUrl("google", "rules"),
      "https://openidconnect.googleapis.com/v1/userinfo",
    );
    assert.strictEqual(oauthConfig.redirectPath("microsoft", "rules"), "/api/oauth/microsoft/callback");
    assert.strictEqual(oauthConfig.hasMarker(oauthConfig.RULES_SCOPES.google, "gmail", "rules"), true);
    assert.strictEqual(oauthConfig.hasMarker(oauthConfig.RULES_SCOPES.microsoft, "outlook", "rules"), true);
    assert.strictEqual(oauthConfig.scopesFor("google", "rules"), oauthConfig.RULES_SCOPES.google);
    const rulesAuth = new URL(oauthConfig.authorizeUrl("microsoft", "rules", {
      clientId: oauthConfig.MICROSOFT_CLIENT_ID,
      state: "state",
      challenge: "challenge",
      redirectUri: "http://localhost:1/api/oauth/microsoft/callback",
    }));
    assert.strictEqual(rulesAuth.searchParams.get("prompt"), "consent");
    assert.strictEqual(rulesAuth.searchParams.get("scope"), oauthConfig.RULES_SCOPES.microsoft);
  } finally {
    global.fetch = prevFetch;
    if (prevJson === undefined) delete process.env.GOOGLE_DESKTOP_OAUTH_JSON;
    else process.env.GOOGLE_DESKTOP_OAUTH_JSON = prevJson;
    if (prevSecrets === undefined) delete process.env.MORROW_MAIL_SECRETS;
    else process.env.MORROW_MAIL_SECRETS = prevSecrets;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

checkGoogleOauthAlias();
require("./check-bake-google-oauth").run();
require("./check-win-secrets").run();
require("./check-bot-client").run();

checkUpdateAuth().then(() => checkAiDraft()).then(() => checkComposeMailbox()).then(() => checkTidy()).then(() => checkProviderApi()).then(() => checkInboxRules()).then(() => require("./check-mail-calendar-consent").run()).then(() => require("./check-account-recovery").run()).then(() => require("./check-mail-serialization").run()).then(() => require("./check-star").run()).then(() => require("./check-vacation").run()).then(() => checkOauthSession()).then(() => checkAiModels()).then(() => require("./check-idle").run()).then(() => require("./check-bot-bridge").run()).then(() => require("./check-ux-workflows").run()).then(() => require("./check-operation-receipts").run()).then(() => require("./check-compose-recovery").run()).then(() => require("./check-dialog-feedback").run()).then(() => require("./check-search-scope").run()).then(() => require("./check-rules-context").run()).then(() => require("./check-scheduled-management").run()).then(() => require("./check-ux-remainder").run()).then(() => {
  console.log("ui-path-ok");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
