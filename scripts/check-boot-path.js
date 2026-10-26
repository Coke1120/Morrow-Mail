const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");

const syntax = [
  "host/main.js",
  "host/chatgpt-auth.js",
  "host/chatgpt-store.js",
  "host/chatgpt-responses.js",
  "host/chatgpt-errors.js",
  "host/ai-context.js",
  "host/ai-consent.js",
  "scripts/check-ai-consent.js",
  "host/ai-setup.js",
  "host/setup-preload.js",
  "renderer/chatgpt-settings.js",
  "renderer/ai-provider-indicator.js",
  "host/window-state.js",
  "host/asar.js",
  "host/ipc.js",
  "host/ipc-diagnostics.js",
  "scripts/check-ipc-diagnostics.js",
  "scripts/check-bot-provider-metadata.js",
  "host/mail/engine.js",
  "host/mail/attachment-cache.js",
  "host/mail/attachment-requests.js",
  "scripts/check-attachment-transfers.js",
  "host/mail/overnight.js",
  "host/mail/body-progress.js",
  "host/mail/background-jobs.js",
  "host/mail/text-encoding.js",
  "host/mail/actions.js",
  "host/mail/gmail-mail-api.js",
  "host/mail/gmail-policy.js",
  "scripts/check-gmail-mail-api.js",
  "host/mail/idle.js",
  "shared/sync-retry.js",
  "shared/primary-mailboxes.js",
  "shared/display-format.js",
  "shared/changelog.js",
  "scripts/check-changelog.js",
  "host/mail/remote.js",
  "scripts/check-imap-client-errors.js",
  "host/mail/discovery.js",
  "host/mail/zip-bytes.js",
  "host/mail/oauth.js",
  "host/mail/oauth-config.js",
  "scripts/check-mail-calendar-consent.js",
  "scripts/check-oauth-graph-regressions.js",
  "scripts/check-mail-reader.js",
  "scripts/check-mail-review-regressions.js",
  "scripts/check-confirmed-identity.js",
  "scripts/check-move-calendar-patches.js",
  "scripts/check-draft-scheduled-recovery.js",
  "scripts/check-draft-partial-delivery.js",
  "scripts/check-draft-revisions.js",
  "scripts/check-account-calendar-attachments.js",
  "scripts/check-account-liveness.js",
  "scripts/check-reconnect-calendar-preservation.js",
  "host/mail/delivery-receipt.js",
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
  "host/brain-persona.js",
  "scripts/check-brain-persona.js",
  "scripts/check-brain-profile-layout.js",
  "host/agent.js",
  "host/compose-window.js",
  "host/reader-window.js",
  "host/reader-window-state.js",
  "host/translate.js",
  "host/translate-window.js",
  "shared/translate-lang.js",
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
  "host/bot/probe.js",
  "host/bot/manage.js",
  "host/bot/catalog.js",
  "host/bot/prompt.js",
  "host/bot/send.js",
  "scripts/morrow-bot-call.js",
  "scripts/windows-icon.js",
  "scripts/check-bot-bridge.js",
  "scripts/check-bot-send-authorization.js",
  "scripts/check-cli-capabilities.js",
  "renderer/preload.js",
  "renderer/app.js",
  "renderer/pdf-preview.js",
  "scripts/bundle-pdf.js",
  "renderer/features-catalog.js",
  "scripts/check-ui-editor-feedback.js",
  "scripts/check-calendar-keyboard-followup.js",
  "scripts/check-body-sync-status.js",
  "scripts/check-ai-settings-ownership.js",
  "renderer/motion-ui.js",
  "scripts/check-vacation.js",
  "scripts/check-sync-retry.js",
  "scripts/check-background-folders.js",
  "scripts/check-overnight-bodies.js",
  "scripts/bake-google-desktop-oauth.js",
  "scripts/check-bake-google-oauth.js",
];
for (const file of syntax) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

// Isolate provider fixtures from the legacy suite's mutable host mocks.
for (const name of ["check-attachment-transfers.js", "check-gmail-cache.js", "check-gmail-engine.js", "check-gmail-mail-api-ui.js"]) {
  const fixture = spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: "inherit", timeout: 30000 });
  assert.strictEqual(fixture.status, 0, name + " failed");
}

const uiEditorFeedback = spawnSync(process.execPath, [path.join(__dirname, "check-ui-editor-feedback.js")], { stdio: "inherit", timeout: 15000 });
if (uiEditorFeedback.status !== 0) process.exit(uiEditorFeedback.status || 1);
const calendarKeyboardFollowup = spawnSync(process.execPath, [path.join(__dirname, "check-calendar-keyboard-followup.js")], { stdio: "inherit", timeout: 15000 });
if (calendarKeyboardFollowup.status !== 0) process.exit(calendarKeyboardFollowup.status || 1);
const bodySyncStatus = spawnSync(process.execPath, [path.join(__dirname, "check-body-sync-status.js")], { stdio: "inherit", timeout: 15000 });
if (bodySyncStatus.status !== 0) process.exit(bodySyncStatus.status || 1);

for (const file of ["check-brain-persona.js", "check-signed-update-manifest.js", "check-update-installer.js", "check-update-launcher.js", "check-update-publisher.js", "check-update-quiescence.js", "check-update-macos.js", "check-update-windows.js", "check-update-schedule.js", "check-release-preflight.js", "check-release-publication.js", "check-changelog.js", "check-mail-discovery.js"]) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: "inherit" });
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
assert.ok(main.includes('accelerator: "CommandOrControl+N"'));
assert.ok(main.includes('accelerator: "CommandOrControl+,"'));
assert.ok(main.includes('role: "reload"'));
assert.ok(main.includes('accelerator: "CommandOrControl+0"'));
assert.ok(main.includes('accelerator: "CommandOrControl+Plus"'));
assert.ok(main.includes('accelerator: "CommandOrControl+="'));
assert.ok(main.includes('accelerator: "CommandOrControl+-"'));
assert.ok(!main.includes("CommandOrControl+R"));
assert.ok(!main.includes("CommandOrControl+Shift+R"));
assert.ok(!main.includes("CommandOrControl+Shift+F"));

const pkg = require("../package.json");
assert.ok(pkg.build.files.includes("renderer/**/*"));
assert.strictEqual(pkg.build.detectUpdateChannel, false);
assert.strictEqual(pkg.build.win.signAndEditExecutable, false);
assert.strictEqual(pkg.build.afterPack, "./scripts/windows-icon.js");
assert.ok(pkg.build.extraResources.some((item) => item.from === "build/icon.png" && item.to === "icon.png"));
assert.strictEqual(pkg.build.nsis.installerIcon, "build/icon.ico");
assert.strictEqual(pkg.build.nsis.uninstallerIcon, "build/icon.ico");
assert.strictEqual(pkg.build.nsis.artifactName, "Morrow-Mail-Setup.${ext}");
assert.strictEqual(pkg.build.portable.artifactName, "Morrow-Mail.${ext}");
assert.strictEqual(pkg.build.mac.artifactName, "Morrow-Mail-${arch}-mac.${ext}");
const windowsIcon = fs.readFileSync(path.join(root, "scripts/windows-icon.js"), "utf8");
assert.ok(windowsIcon.includes('path.join(__dirname, "..", "build", "icon.ico")'));
assert.ok(windowsIcon.includes("ProductName") && windowsIcon.includes("ignoreCert: true"));
assert.ok(!windowsIcon.includes("signtool") && !windowsIcon.includes("generateExecutableWithSign"));
const { windowsFileVersion } = require("./windows-icon");
assert.deepStrictEqual(windowsFileVersion("0.2.4"), [0, 2, 4, 0]);
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
    releaseType: "release",
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
assert.strictEqual(accountLabel({ label: "Leo Ho", name: "Provider", email: "howailok1120@hotmail.com" }), "Leo Ho · howailok1120@hotmail.com");
assert.strictEqual(accountLabel({ label: "  ", name: "Provider", email: "howailok1120@hotmail.com" }), "Provider · howailok1120@hotmail.com");
assert.strictEqual(accountLabel({ label: "", name: "", email: "howailoklineage@gmail.com" }), "howailoklineage@gmail.com");
assert.strictEqual(accountLabel({ label: "howailoklineage@gmail.com", name: "Gmail", email: "howailoklineage@gmail.com" }), "howailoklineage@gmail.com");
assert.strictEqual(accountLabel({ label: "Desk", email: "howailoklineage@gmail.com" }), "Desk · howailoklineage@gmail.com");
global.morrowMailboxRoles = require("../shared/mailbox-roles");
global.morrowPrimaryMailboxes = require("../shared/primary-mailboxes");
const mailListUi = loadFunctions(appJs, ["foldersOf", "allInboxUnread", "mailListRequest"]);
const allInboxUnread = mailListUi.allInboxUnread;
const mailListRequest = mailListUi.mailListRequest;
assert.strictEqual(allInboxUnread([{ unreadCount: 2 }, { unreadCount: 3 }]), 5);
assert.strictEqual(allInboxUnread([{ unreadCount: 0 }, { unreadCount: -1 }, {}]), 0);
assert.strictEqual(allInboxUnread(null), 0);
assert.strictEqual(allInboxUnread([
  {
    unreadCount: 9,
    platform: "imap",
    imapSmtpProfile: "gmail",
    folders: { primary: [
      { id: "[Gmail]/All Mail", wellKnownName: "all", unreadCount: 4 },
      { id: "INBOX", wellKnownName: "inbox", unreadCount: 9 },
    ] },
  },
  {
    unreadCount: 2,
    platform: "imap",
    profile: "outlook",
    folders: { primary: [
      { id: "INBOX", wellKnownName: "inbox", unreadCount: 2 },
      { id: "Everything", wellKnownName: "all", unreadCount: 8 },
    ] },
  },
  {
    unreadCount: 7,
    profile: "gmail",
    folders: { primary: [{ id: "INBOX", wellKnownName: "inbox", unreadCount: 7 }] },
  },
]), 13);
assert.strictEqual(allInboxUnread([{
  unreadCount: 9,
  profile: "gmail",
  folders: { primary: [
    { id: "[Gmail]/All Mail", wellKnownName: "all", unreadCount: 0 },
    { id: "INBOX", wellKnownName: "inbox", unreadCount: 9 },
  ] },
}]), 0);
assert.deepStrictEqual(
  mailListRequest({ allInbox: true, fromNetwork: true, accountId: "a", folderId: "INBOX", limit: 200, offset: 0 }),
  { channel: "mail:listFromCache", params: { folderKey: "primary", limit: 200, offset: 0 } },
);
assert.deepStrictEqual(
  mailListRequest({ accountId: "beta", folderId: "inbox", fromNetwork: true, limit: 200, offset: 40 }),
  { channel: "mail:listFromNetwork", params: { accountId: "beta", folderId: "inbox", limit: 200, offset: 40 } },
);
assert.strictEqual(mailListRequest({ query: "rent", searchAccountId: "", allInbox: true }).channel, "mail:searchLocal");
assert.deepStrictEqual(
  mailListRequest({ allInbox: true, unreadOnly: true, fromNetwork: true, limit: 200, offset: 200 }),
  { channel: "mail:listFromCache", params: { folderKey: "primary", filterUnread: true, limit: 200, offset: 200 } },
);
const mixedPrimaryAccounts = [
  {
    id: "g",
    platform: "imap",
    imapSmtpProfile: "gmail",
    folders: { primary: [
      { id: "INBOX", wellKnownName: "inbox" },
      { id: "[Gmail]/All Mail", wellKnownName: "all" },
    ] },
  },
  {
    id: "o",
    platform: "imap",
    profile: "outlook",
    folders: { primary: [
      { id: "INBOX", wellKnownName: "inbox" },
      { id: "Everything", wellKnownName: "all" },
    ] },
  },
  {
    id: "g-missing",
    platform: "gmail",
    folders: { primary: [
      { id: "INBOX", wellKnownName: "inbox" },
      { id: "[Gmail]/Sent Mail", wellKnownName: "sentitems" },
    ] },
  },
  {
    id: "g-path",
    profile: "gmail",
    folders: { primary: [
      { id: "[Gmail]/All Mail", name: "[Gmail]/All Mail" },
      { id: "INBOX", wellKnownName: "inbox" },
    ] },
  },
];
const mixedPrimaryRequest = mailListRequest({
  allInbox: true,
  accounts: mixedPrimaryAccounts,
  fromNetwork: true,
  limit: 200,
  offset: 0,
});
assert.strictEqual(mixedPrimaryRequest.channel, "mail:listFromCache");
assert.strictEqual(mixedPrimaryRequest.params.folderKey, "primary");
assert.notStrictEqual(mixedPrimaryRequest.params.folderKey, "inbox");
assert.deepStrictEqual(mixedPrimaryRequest.params.mailboxes, [
  { accountId: "g", path: "[Gmail]/All Mail", role: "all" },
  { accountId: "o", path: "INBOX", role: "inbox" },
  { accountId: "g-missing", path: "INBOX", role: "inbox" },
  { accountId: "g-path", path: "[Gmail]/All Mail", role: "all" },
]);
assert.ok(!mixedPrimaryRequest.params.mailboxes.every((row) => row.role === "inbox"), "mixed All Account Mail request is still inbox-only");
assert.deepStrictEqual(
  global.morrowPrimaryMailboxes.primaryMailboxes(mixedPrimaryAccounts, (account) => [
    ...((account.folders && account.folders.primary) || []),
    ...((account.folders && account.folders.more) || []),
  ]),
  mixedPrimaryRequest.params.mailboxes,
);
assert.deepStrictEqual(
  global.morrowPrimaryMailboxes.primaryMailboxes([{
    id: "google-mail",
    imapSmtpProfile: "gmail",
    folders: { primary: [
      { id: "[Google Mail]/All Mail" },
      { id: "INBOX", wellKnownName: "inbox" },
    ] },
  }], (account) => account.folders.primary),
  [{ accountId: "google-mail", path: "[Google Mail]/All Mail", role: "all" }],
);
assert.deepStrictEqual(
  global.morrowPrimaryMailboxes.primaryMailboxes([{
    id: "both",
    profile: "gmail",
    folders: { primary: [
      { id: "[Gmail]/All Mail", name: "All Mail" },
      { id: "Everything", wellKnownName: "all" },
    ] },
  }], (account) => account.folders.primary)[0].path,
  "Everything",
);
assert.strictEqual(mailListRequest({ allInbox: true, unreadOnly: false, limit: 200, offset: 0 }).params.filterUnread, undefined);
assert.strictEqual(mailListRequest({ allInbox: false, unreadOnly: true, accountId: "a", folderId: "INBOX", limit: 200, offset: 0 }).params.filterUnread, undefined);
const allAccountMailLabel = extractFunction(appJs, "allAccountMailLabel");
const allAccountMailTitle = extractFunction(appJs, "allAccountMailTitle");
const allAccountMailMatches = extractFunction(appJs, "allAccountMailMatches");
const allAccountUnreadChip = extractFunction(appJs, "allAccountUnreadChip");
const allAccountMailChoice = extractFunction(appJs, "allAccountMailChoice");
const allAccountMailEmptyCopy = extractFunction(appJs, "allAccountMailEmptyCopy");
const allAccountMailSyncCopy = extractFunction(appJs, "allAccountMailSyncCopy");
assert.strictEqual(allAccountMailLabel(), "All Account Mail");
assert.strictEqual(allAccountMailTitle(false), "All Account Mail");
assert.strictEqual(allAccountMailTitle(true), "All Account Mail · Unread");
assert.strictEqual(allAccountMailMatches(""), true);
assert.strictEqual(allAccountMailMatches("  Account "), true);
assert.strictEqual(allAccountMailMatches("inbox"), false);
assert.strictEqual(allAccountMailMatches("unread"), false);
assert.deepStrictEqual(allAccountUnreadChip(204, false), {
  text: "Unread 204",
  pressed: false,
  label: "Unread, 204. Show only unread messages in All Account Mail.",
});
assert.deepStrictEqual(allAccountUnreadChip(0, true), {
  text: "Unread",
  pressed: true,
  label: "Unread. Showing unread messages in All Account Mail. Show every message.",
});
assert.strictEqual(allAccountUnreadChip(-3, false).text, "Unread");
assert.strictEqual(allAccountUnreadChip(1.9, false).text, "Unread 1");
assert.deepStrictEqual(allAccountMailChoice({ allInbox: false, unreadOnly: false }, "mail"), { allInbox: true, unreadOnly: false });
assert.deepStrictEqual(allAccountMailChoice({ allInbox: true, unreadOnly: true }, "mail"), { allInbox: true, unreadOnly: false });
assert.deepStrictEqual(allAccountMailChoice({ allInbox: false, unreadOnly: false }, "unread"), { allInbox: true, unreadOnly: true });
assert.deepStrictEqual(allAccountMailChoice({ allInbox: true, unreadOnly: false }, "unread"), { allInbox: true, unreadOnly: true });
assert.deepStrictEqual(allAccountMailChoice({ allInbox: true, unreadOnly: true }, "unread"), { allInbox: true, unreadOnly: false });
assert.deepStrictEqual(allAccountMailChoice(null, "unread"), { allInbox: true, unreadOnly: true });
assert.strictEqual(allAccountMailEmptyCopy(false), "No downloaded messages in All Account Mail. Open Gmail All Mail, or Inbox for another account, and use Sync to download recent mail.");
assert.strictEqual(allAccountMailEmptyCopy(true), "No unread messages in All Account Mail.");
assert.strictEqual(allAccountMailSyncCopy(), "All Account Mail shows mail already downloaded. Open Gmail All Mail, or Inbox for another account, to sync that account.");
assert.ok(functionSource(appJs, "mailListRequest").includes('folderKey: "primary"'));
assert.ok(!functionSource(appJs, "mailListRequest").includes('folderKey: "inbox"'));
assert.ok(functionSource(appJs, "loadList").includes("accounts: state.accounts"), "All Account Mail list does not pass connected accounts");
assert.ok(!appJs.includes("All Inbox"), "sidebar still says All Inbox");
const allAccountRow = functionSource(appJs, "allAccountMailRow");
assert.ok(allAccountRow.includes("all-account-unread") && allAccountRow.includes('data-testid", "all-account-unread"'), "All Account Mail is missing the unread chip");
assert.ok(allAccountRow.includes('"unread"') && functionSource(appJs, "selectAllInbox").includes("allInboxUnreadOnly"), "unread chip does not toggle the unified filter");
assert.ok(functionSource(appJs, "selectFolder").includes("allInboxUnreadOnly = false"), "leaving All Account Mail keeps the unread filter");
assert.ok(functionSource(appJs, "loadList").includes("unreadOnly: state.allInbox && state.allInboxUnreadOnly"), "All Account Mail unread filter is not sent to the cache");
assert.deepStrictEqual(mailListRequest({ query: "rent", searchAccountId: "a" }).params, { query: "rent", limit: 100, accountId: "a" });
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
const quotingAt = css.indexOf("#compose[open].is-quoting {");
assert.ok(quotingAt >= 0, "quoting compose keeps a layout rule");
const quotingRule = css.slice(quotingAt, css.indexOf("}", quotingAt));
assert.match(quotingRule, /height:\s*max-content/, "quoting dialog sizes to its content");
assert.match(quotingRule, /max-height:\s*calc\(100vh - 32px\)/, "quoting dialog keeps a viewport ceiling");
assert.ok(!/(^|[^-])height:\s*calc\(100vh - 32px\)/.test(quotingRule), "quoting dialog does not force the viewport height");
assert.match(css, /#about-dialog,\s*#confirm,\s*#compose-close-review,\s*#quit-scheduled,\s*#bot-secret,\s*#move-picker,\s*#changelog\s*\{[^}]*height:\s*max-content/, "compact dialogs hug their content");
assert.match(css, /#about-dialog,\s*#confirm,\s*#compose-close-review,\s*#quit-scheduled,\s*#bot-secret,\s*#move-picker,\s*#changelog\s*\{[^}]*bottom:\s*auto/, "compact dialogs do not stretch between block insets");
assert.match(css, /#about-dialog,\s*#confirm,\s*#compose-close-review,\s*#quit-scheduled,\s*#bot-secret,\s*#move-picker,\s*#changelog\s*\{[^}]*margin:\s*auto/, "compact dialogs stay centered without a transform");
assert.match(css, /#about-dialog,\s*#confirm,\s*#compose-close-review,\s*#quit-scheduled,\s*#bot-secret,\s*#move-picker,\s*#changelog\s*\{[^}]*translate:\s*0 -50%/, "compact dialogs center with translate, not transform");
assert.ok(!css.includes("min(820px"), "quoting dialog no longer stops at 820px");
assert.ok(css.includes('#compose[data-quote-collapsed="true"] .compose-quote-body'), "collapse hides the quote body");
assert.ok(css.includes("#193c34") && css.includes("#102822") && css.includes("#b9d5ad") && css.includes("[data-theme=\"dark\"]"), "shell css missing logo green tokens");
assert.ok(!css.includes("#410c42") && !css.includes("#572658") && !css.includes("#7c3aed"), "shell css still uses the plum palette");
assert.ok(appJs.includes("applyShellTheme(document.documentElement"), "shell does not paint theme or accent");
assert.ok(css.includes(".thread") && css.includes(".attachments"), "shell css missing thread or attachment styles");
const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
assert.ok(html.includes('id="connect-yahoo"') && html.includes(">Yahoo Mail<"), "Yahoo Mail is a provider button beside Google and Microsoft");
assert.ok(html.includes('id="password-hint"') && appJs.includes("Generate app password"), "Yahoo password hint names Generate app password");
assert.ok(appJs.includes("mail:discoverMail") && preload.includes('"mail:discoverMail"'), "discovery IPC is registered");
assert.ok(fs.readFileSync(path.join(root, "host/mail/remote.js"), "utf8").includes('loginMethod = "LOGIN"'), "Yahoo IMAP uses the LOGIN command");
assert.strictEqual(pkg.name, "morrow-mail");
assert.strictEqual(pkg.version, "0.2.40");
const composeHost = require("../host/compose-window");
assert.deepEqual(composeHost.CHANNELS, ["compose:open", "compose:pullSeed", "compose:allowClose", "compose:setTitle"]);
assert.strictEqual(composeHost.composeWindowTitle({ title: "  Reply  " }), "Reply — Morrow Mail");
assert.strictEqual(composeHost.composeWindowTitle({}), "New message — Morrow Mail");
assert.strictEqual(composeHost.composeWindowTitle({ title: "x".repeat(200) }).slice(0, 180), "x".repeat(180));
assert.deepEqual(composeHost.sanitizeComposeSeed(null), {});
assert.throws(() => composeHost.sanitizeComposeSeed("nope"), /Compose could not be opened/);
assert.throws(() => composeHost.sanitizeComposeSeed({ body: "x".repeat(composeHost.MAX_SEED_CHARS) }), /too large/);
const composePlaced = composeHost.composeWindowBounds({ x: 10, y: 20, width: 800, height: 600 }, 1);
assert.strictEqual(composePlaced.x, 10 + 48 + 28);
assert.strictEqual(composePlaced.y, 20 + 48 + 28);
assert.strictEqual(composePlaced.width, 1040);
assert.strictEqual(composePlaced.minHeight, 560);
const composeUnplaced = composeHost.composeWindowBounds(null, 0);
assert.strictEqual(composeUnplaced.x, undefined);
assert.ok(main.includes('require("./compose-window")'));
assert.ok(main.includes("composeWindows.CHANNELS"));
assert.ok(main.indexOf("createComposeHost") < main.lastIndexOf("attachIpc(preloadFile)"));
assert.ok(preload.includes('"compose:open"') && preload.includes('"compose:pullSeed"') && preload.includes('"compose:allowClose"') && preload.includes('"compose:setTitle"') && preload.includes('"compose:requestClose"'));
assert.ok(functionSource(appJs, "presentCompose").includes("openComposeWindow"));
assert.ok(functionSource(appJs, "presentCompose").includes("openCompose(seed"));
assert.ok(functionSource(appJs, "bootComposeWindow").includes("compose:requestClose"));
assert.ok(functionSource(appJs, "bootComposeWindow").includes("openCompose(seed"));
assert.ok(!functionSource(appJs, "bootComposeWindow").includes("presentCompose"));
assert.ok(!functionSource(appJs, "bootComposeWindow").includes("mail:emailsUpdated"));
assert.ok(!functionSource(appJs, "bootComposeWindow").includes("watchNetwork"));
assert.ok(!functionSource(appJs, "bootComposeWindow").includes("reportUpdateReady"));
assert.ok(functionSource(appJs, "boot").includes("isComposeWindow"));
assert.ok(functionSource(appJs, "boot").includes("bootComposeWindow"));
assert.ok(functionSource(appJs, "requestComposeWindowClose").includes("allowComposeClose"));
assert.ok(functionSource(appJs, "requestComposeWindowClose").includes("hideUndoSend"));
assert.ok(functionSource(appJs, "deliverMail").includes("allowComposeClose"));
assert.ok(functionSource(appJs, "editScheduledMail").includes("schedulePreset"));
assert.ok(functionSource(appJs, "editScheduledMail").includes("openComposeWindow"));
assert.ok(appJs.includes("presentCompose(newMailSeed())"));
assert.ok(html.includes("compose-role.js"));
assert.ok(css.includes('html[data-window="compose"]'));
assert.ok(fs.existsSync(path.join(root, "docs/adr/2026-10-21-compose-window.md")));
const senderHistory = require("../shared/sender-history");
assert.deepEqual(senderHistory.parseSenderAddresses("Ada Lovelace <Ada@Example.com>"), ["Ada@Example.com"]);
assert.deepEqual(senderHistory.parseSenderAddresses("Ada@Example.com"), ["Ada@Example.com"]);
assert.deepEqual(senderHistory.parseSenderAddresses("Ada@Lovelace"), []);
assert.strictEqual(senderHistory.isAddrSpec('"ada"@example.com'), false);
assert.strictEqual(senderHistory.isAddrSpec("ada @example.com"), false);
assert.strictEqual(senderHistory.isAddrSpec("ada@example"), false);
assert.strictEqual(senderHistory.isAddrSpec("Ada@Example.com"), true);
assert.strictEqual(senderHistory.isAddrSpec("o'hara@example.com"), false);
assert.strictEqual(senderHistory.gmailFromQuery("Ada@Example.com"), 'from:"ada@example.com"');
assert.strictEqual(senderHistory.graphFromFilter("Ada@Example.com"), "from/emailAddress/address eq 'ada@example.com'");
assert.strictEqual(senderHistory.imapFromNeedle("Ada@Example.com"), "from:ada@example.com");
assert.strictEqual(senderHistory.gmailFromQuery("o'hara@example.com"), "");
const senderMerged = senderHistory.pageSenderHistory({
  preferAccountId: "a",
  accounts: [
    { accountId: "a", order: 0, exhausted: true, hits: [
      { id: "a1", subject: "older", date: "2026-10-01T00:00:00Z", listSortTs: Date.parse("2026-10-01T00:00:00Z"), messageId: "<a1@t>" },
      { id: "a2", subject: "newer", date: "2026-10-20T00:00:00Z", listSortTs: Date.parse("2026-10-20T00:00:00Z"), messageId: "<a2@t>" },
    ] },
    { accountId: "b", order: 1, exhausted: true, hits: [
      { id: "b1", subject: "mid", date: "2026-10-10T00:00:00Z", listSortTs: Date.parse("2026-10-10T00:00:00Z"), messageId: "<b1@t>" },
    ] },
  ],
});
assert.deepEqual(senderMerged.rows.map((row) => row.id), ["a2", "b1", "a1"]);
const senderMany = [];
for (let senderIndex = 0; senderIndex < 60; senderIndex += 1) {
  senderMany.push({ id: "m" + senderIndex, listSortTs: 1000 - senderIndex, messageId: "<m" + senderIndex + "@t>", subject: "s" });
}
const senderCapped = senderHistory.pageSenderHistory({
  accounts: [{ accountId: "a", order: 0, exhausted: true, hits: senderMany }],
});
assert.strictEqual(senderCapped.rows.length, 50);
assert.strictEqual(senderCapped.rows[0].id, "m0");
const senderPrefer = senderHistory.pageSenderHistory({
  preferAccountId: "b",
  accounts: [
    { accountId: "a", order: 0, exhausted: true, hits: [{ id: "lose", listSortTs: 2, messageId: "<same@t>" }] },
    { accountId: "b", order: 1, exhausted: true, hits: [{ id: "win", listSortTs: 2, messageId: "<same@t>" }] },
  ],
});
assert.strictEqual(senderPrefer.rows.length, 1);
assert.strictEqual(senderPrefer.rows[0].id, "win");
assert.ok(senderPrefer.resume.seenIds.includes("lose"));
const senderOrdered = senderHistory.pageSenderHistory({
  accounts: [
    { accountId: "b", order: 1, exhausted: true, hits: [{ id: "later", listSortTs: 2, messageId: "<same@t>" }] },
    { accountId: "a", order: 0, exhausted: true, hits: [{ id: "earlier", listSortTs: 2, messageId: "<Same@t>" }] },
  ],
});
assert.strictEqual(senderOrdered.rows[0].id, "earlier");
assert.ok(senderOrdered.resume.seenIds.includes("later"));
const senderBlanks = senderHistory.pageSenderHistory({
  accounts: [{ accountId: "a", order: 0, exhausted: true, hits: [
    { id: "e1", listSortTs: 2, messageId: "" },
    { id: "e2", listSortTs: 1, messageId: "" },
  ] }],
});
assert.strictEqual(senderBlanks.rows.length, 2);
const senderCurrent = senderHistory.pageSenderHistory({
  currentId: "local",
  currentMessageId: "<Open@T>",
  accounts: [{ accountId: "a", order: 0, exhausted: true, hits: [
    { id: "other", listSortTs: 3, messageId: "<open@t>" },
    { id: "local", listSortTs: 2, messageId: "<nope@t>" },
  ] }],
});
assert.strictEqual(senderCurrent.rows.find((row) => row.id === "other").current, true);
assert.strictEqual(senderCurrent.rows.find((row) => row.id === "local").current, true);
const senderFirstHits = [];
for (let senderIndex = 0; senderIndex < 51; senderIndex += 1) {
  senderFirstHits.push({ id: "h" + senderIndex, listSortTs: 1000 - senderIndex, messageId: "<h" + senderIndex + "@t>" });
}
const senderFirstPage = senderHistory.pageSenderHistory({
  accounts: [{ accountId: "a", order: 0, exhausted: true, hits: senderFirstHits }],
});
assert.strictEqual(senderFirstPage.rows.length, 50);
assert.ok(!senderFirstPage.resume.seenIds.includes("h50"));
const senderSecond = senderHistory.pageSenderHistory({
  accounts: [{ accountId: "a", order: 0, exhausted: true, hits: [] }],
  resume: senderFirstPage.resume,
});
assert.strictEqual(senderSecond.rows[0].id, "h50");
const senderPartial = senderHistory.pageSenderHistory({
  accounts: [
    { accountId: "a", order: 0, status: "error", message: "Mailbox refused", exhausted: false, hits: [] },
    { accountId: "b", order: 1, status: "ok", exhausted: true, hits: [{ id: "b-row", listSortTs: 1, messageId: "<b@t>" }] },
  ],
});
assert.strictEqual(senderPartial.rows.length, 1);
assert.strictEqual(senderPartial.rows[0].id, "b-row");
assert.strictEqual(senderPartial.accounts[0].status, "error");
assert.strictEqual(senderPartial.accounts[0].message, "Mailbox refused");
const senderUnavailable = senderHistory.pageSenderHistory({
  accounts: [{ accountId: "a", order: 0, status: "unavailable", message: "Unavailable", exhausted: true, hits: [] }],
});
assert.strictEqual(senderUnavailable.accounts[0].status, "unavailable");
assert.deepEqual(senderUnavailable.rows, []);
const readerHost = require("../host/reader-window");
assert.deepEqual(readerHost.CHANNELS, ["reader:open", "reader:pullSeed"]);
assert.strictEqual(readerHost.readerWindowTitle("  Hello  "), "Hello — Morrow Mail");
assert.strictEqual(readerHost.readerWindowTitle(""), "Message — Morrow Mail");
assert.strictEqual(readerHost.readerWindowTitle("x".repeat(200)).slice(0, 180), "x".repeat(180));
assert.throws(() => readerHost.sanitizeReaderSeed(null), /That message could not be opened/);
assert.throws(() => readerHost.sanitizeReaderSeed({ accountId: "a", messageId: "" }), /That message could not be opened/);
assert.throws(() => readerHost.sanitizeReaderSeed({ accountId: "a", messageId: "bad\n" }), /That message could not be opened/);
assert.throws(() => readerHost.sanitizeReaderSeed({ accountId: "a", messageId: "m".repeat(201) }), /That message could not be opened/);
assert.deepEqual(readerHost.sanitizeReaderSeed({ accountId: "a", messageId: "m", extra: "no" }), { accountId: "a", messageId: "m" });
const readerPlaced = readerHost.readerWindowBounds({ x: 0, y: 0 }, 1);
assert.strictEqual(readerPlaced.x, 48 + 28);
assert.strictEqual(readerPlaced.y, 48 + 28);
assert.strictEqual(readerPlaced.width, 960);
assert.strictEqual(readerPlaced.height, 760);
assert.strictEqual(readerPlaced.minHeight, 480);
assert.strictEqual(readerPlaced.originShift, 28);
assert.strictEqual(readerHost.readerWindowBounds(null, 1).x, undefined);
const readerDisplay = { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
const readerSaved = { x: 120, y: 80, width: 1000, height: 700 };
const readerFirst = readerHost.readerWindowBounds({ x: 10, y: 20 }, 0, readerSaved, [readerDisplay]);
assert.strictEqual(readerFirst.x, 120);
assert.strictEqual(readerFirst.y, 80);
assert.strictEqual(readerFirst.width, 1000);
assert.strictEqual(readerFirst.height, 700);
assert.strictEqual(readerFirst.originShift, 0);
const readerNudged = readerHost.readerWindowBounds({ x: 10, y: 20 }, 1, readerSaved, [readerDisplay]);
assert.strictEqual(readerNudged.x, 148);
assert.strictEqual(readerNudged.y, 108);
assert.strictEqual(readerNudged.width, 1000);
assert.strictEqual(readerNudged.originShift, 28);
const readerWrapped = readerHost.readerWindowBounds({ x: 0, y: 0 }, 6, readerSaved, [readerDisplay]);
assert.strictEqual(readerWrapped.x, 120);
assert.strictEqual(readerWrapped.originShift, 0);
const readerBrowser = readerHost.readerBrowserBounds(readerNudged);
assert.strictEqual(readerBrowser.x, 148);
assert.strictEqual(readerBrowser.originShift, undefined);
assert.strictEqual(readerBrowser.minWidth, 640);
assert.deepStrictEqual(
  readerHost.canonicalReaderBounds({ x: 148, y: 108, width: 1000, height: 700 }, 28),
  { x: 120, y: 80, width: 1000, height: 700 },
);
assert.strictEqual(readerHost.canonicalReaderBounds({ x: 1 }, 0), null);
const readerFresh = readerHost.readerWindowBounds({ x: 10, y: 20 }, 0, { x: null, y: null, width: null, height: null }, [readerDisplay]);
assert.strictEqual(readerFresh.x, 58);
assert.strictEqual(readerFresh.y, 68);
assert.strictEqual(readerFresh.width, 960);
assert.strictEqual(readerFresh.height, 760);
const readerOff = readerHost.readerWindowBounds({ x: 10, y: 20 }, 0, { x: -4000, y: -4000, width: 800, height: 600 }, [readerDisplay]);
assert.strictEqual(readerOff.x, 58);
assert.strictEqual(readerOff.y, 68);
assert.strictEqual(readerOff.width, 800);
assert.strictEqual(readerOff.height, 600);
const readerTiny = readerHost.readerWindowBounds({ x: 0, y: 0 }, 0, { x: 40, y: 50, width: 10, height: 10 }, [readerDisplay]);
assert.strictEqual(readerTiny.width, 960);
assert.strictEqual(readerTiny.height, 760);
assert.strictEqual(readerTiny.x, 40);
assert.strictEqual(readerTiny.y, 50);
const readerHeadless = readerHost.readerWindowBounds({ x: 5, y: 6 }, 1, readerSaved, []);
assert.strictEqual(readerHeadless.x, 5 + 48 + 28);
assert.strictEqual(readerHeadless.y, 6 + 48 + 28);
assert.strictEqual(readerHeadless.width, 1000);
const readerState = require("../host/reader-window-state");
{
  const os = require("os");
  const prevData = process.env.MORROW_USER_DATA;
  const readerDir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-reader-window-"));
  process.env.MORROW_USER_DATA = readerDir;
  try {
    assert.deepStrictEqual(readerState.read(), { x: null, y: null, width: null, height: null });
    const sized = readerState.update({ width: 1000, height: 700 });
    assert.strictEqual(sized.x, null);
    assert.strictEqual(sized.width, 1000);
    const moved = readerState.update({ x: 30, y: 40 });
    assert.strictEqual(moved.x, 30);
    assert.strictEqual(moved.y, 40);
    assert.strictEqual(moved.width, 1000);
    assert.strictEqual(moved.height, 700);
    assert.deepStrictEqual(readerState.read(), moved);
    assert.strictEqual(readerState.update({ width: 10, height: 10 }).width, null);
    assert.strictEqual(readerState.read().x, 30);
    fs.writeFileSync(path.join(readerDir, "reader-window-state.json"), "{");
    assert.deepStrictEqual(readerState.read(), { x: null, y: null, width: null, height: null });
    readerState.update({ x: 80, y: 90, width: 1100, height: 720 });
    assert.ok(fs.existsSync(path.join(readerDir, "reader-window-state.json")));
    assert.ok(!fs.existsSync(path.join(readerDir, "window-state.json")));
    const placedFromFile = readerHost.readerWindowBounds({ x: 0, y: 0 }, 1, readerState.read(), [readerDisplay]);
    assert.strictEqual(placedFromFile.x, 108);
    assert.strictEqual(placedFromFile.y, 118);
    assert.strictEqual(placedFromFile.width, 1100);
    assert.strictEqual(placedFromFile.height, 720);
  } finally {
    if (prevData === undefined) delete process.env.MORROW_USER_DATA;
    else process.env.MORROW_USER_DATA = prevData;
    fs.rmSync(readerDir, { recursive: true, force: true });
  }
}
assert.ok(fs.readFileSync(path.join(root, "host/reader-window.js"), "utf8").includes('win.on("resize"'));
assert.ok(fs.readFileSync(path.join(root, "host/reader-window.js"), "utf8").includes('win.on("move"'));
assert.ok(fs.readFileSync(path.join(root, "host/reader-window.js"), "utf8").includes('win.on("close"'));
assert.ok(fs.readFileSync(path.join(root, "host/reader-window.js"), "utf8").includes("canonicalReaderBounds"));
assert.ok(fs.readFileSync(path.join(root, "host/reader-window-state.js"), "utf8").includes("reader-window-state.json"));
assert.ok(!fs.readFileSync(path.join(root, "host/reader-window.js"), "utf8").includes("window-state.json"));
const senderEngineSrc = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
assert.ok(senderEngineSrc.includes('case "mail:searchSender"'));
assert.ok(!functionSource(senderEngineSrc, "searchRemote").includes("searchSender"));
const senderSearchAt = senderEngineSrc.indexOf('case "mail:search":');
const senderSearchNext = senderEngineSrc.indexOf('case "mail:searchSender":');
assert.ok(senderSearchAt >= 0 && senderSearchNext > senderSearchAt);
const senderSearchCase = senderEngineSrc.slice(senderSearchAt, senderSearchNext);
assert.ok(senderSearchCase.includes("searchRemote"));
assert.ok(!senderSearchCase.includes("searchSender"));
assert.ok(main.includes('require("./reader-window")'));
assert.ok(main.includes("readerWindows.CHANNELS"));
assert.ok(main.indexOf("createReaderHost") < main.lastIndexOf("attachIpc(preloadFile)"));
assert.ok(preload.includes('"reader:open"') && preload.includes('"reader:pullSeed"') && preload.includes('"mail:searchSender"'));
assert.strictEqual(pkg.version, "0.2.40");
assert.ok(functionSource(appJs, "boot").includes("bootReaderWindow"));
const readerBoot = functionSource(appJs, "bootReaderWindow");
assert.ok(!readerBoot.includes("mail:setOnline"));
assert.ok(!readerBoot.includes("mail:emailsUpdated"));
assert.ok(!readerBoot.includes("host:updateGetState"));
assert.ok(html.includes('id="sender-history"'));
assert.ok(html.includes("sender-history.js"));
assert.ok(css.includes('html[data-window="reader"]'));
assert.ok(css.includes('html[data-window="translate"]'));
assert.ok(css.includes(".translate-columns"));
assert.ok(fs.readFileSync(path.join(root, "renderer/compose-role.js"), "utf8").includes('dataset.window = "translate"'));
const translateHost = require("../host/translate-window");
assert.deepEqual(translateHost.CHANNELS, ["translate:open", "translate:pullSeed", "translate:report"]);
assert.strictEqual(translateHost.translateWindowTitle("Quarterly update", "Traditional Chinese (繁體中文)"), "Quarterly update — Traditional Chinese (繁體中文) — Morrow Mail");
assert.strictEqual(translateHost.translateWindowTitle("", ""), "Translation — Morrow Mail");
assert.strictEqual(translateHost.translateWindowTitle("", "English"), "Translation — English — Morrow Mail");
assert.strictEqual(translateHost.translateWindowTitle("x".repeat(200), "English").slice(0, 180), "x".repeat(180));
assert.throws(() => translateHost.sanitizeTranslateSeed(null), /could not be opened/);
assert.throws(() => translateHost.sanitizeTranslateSeed({ reqId: "t", original: "  " }), /could not be opened/);
const cleanSeed = translateHost.sanitizeTranslateSeed({
  reqId: "tr-1",
  subject: "Hello",
  language: "Traditional Chinese (繁體中文)",
  original: "Line\nTAIL\u0000",
  nodeIds: ["n0", "n0"],
});
assert.strictEqual(cleanSeed.original, "Line\nTAIL");
assert.deepEqual(cleanSeed.nodeIds, ["n0"]);
const translatePlaced = translateHost.translateWindowBounds({ x: 0, y: 0 }, 1);
assert.strictEqual(translatePlaced.x, 48 + 28);
assert.strictEqual(translatePlaced.y, 48 + 28);
assert.strictEqual(translatePlaced.width, 1100);
assert.strictEqual(translatePlaced.minWidth, 760);
assert.strictEqual(translatePlaced.minHeight, 480);
const translateRecord = {
  reqId: "t",
  subject: "Hello",
  language: "Traditional Chinese (繁體中文)",
  original: "Original body",
  nodeIds: ["n0"],
  texts: {},
  translated: "",
  error: "",
  pending: true,
  current: 0,
  total: 1,
  seq: 1,
};
assert.strictEqual(translateHost.publicSnapshot(translateRecord).pending, true);
assert.strictEqual(translateHost.publicSnapshot(translateRecord).original, "Original body");
assert.strictEqual(translateHost.publicSnapshot(translateRecord).translated, "");
translateHost.applyTranslateEvent(translateRecord, { reqId: "t", type: "node", nodeId: "n0", translatedText: "譯文", status: "success" });
assert.strictEqual(translateRecord.translated, "譯文");
assert.strictEqual(translateRecord.pending, true);
translateHost.applyTranslateEvent(translateRecord, { reqId: "t", type: "error", message: "Add an API key in Morrow Mail → AI Setup." });
assert.strictEqual(translateRecord.pending, false);
assert.strictEqual(translateRecord.error, "Add an API key in Morrow Mail → AI Setup.");
assert.strictEqual(translateRecord.original, "Original body");
assert.ok(main.includes('require("./translate-window")'));
assert.ok(main.includes("translateWindows.CHANNELS"));
assert.ok(main.indexOf("createTranslateHost") < main.lastIndexOf("attachIpc(preloadFile)"));
assert.ok(preload.includes('"translate:open"') && preload.includes('"translate:pullSeed"') && preload.includes('"translate:report"') && preload.includes('"translate:update"'));
assert.ok(!fs.readFileSync(path.join(root, "host/translate.js"), "utf8").includes("slice(0, 2000)"));
assert.ok(functionSource(appJs, "startTranslate").indexOf("openTranslationWindow") < functionSource(appJs, "startTranslate").indexOf("mail:translateStart"));
assert.ok(functionSource(appJs, "renderActions").includes("renderTranslate"));
assert.ok(functionSource(appJs, "boot").includes("bootTranslateWindow"));
assert.ok(!appJs.includes('"translate-lang"'));
assert.ok(!appJs.includes("'translate-lang'"));
assert.ok(html.includes('id="pref-translate-language"'));
assert.ok(html.includes("Traditional Chinese"));
assert.ok(html.includes("繁體中文"));
assert.ok(fs.readFileSync(path.join(root, "renderer/compose-role.js"), "utf8").includes('dataset.window = "reader"'));
assert.ok(functionSource(appJs, "onReaderContext").includes("sender-address"));
assert.ok(!functionSource(appJs, "onReaderContext").includes("isReaderWindow"));
const readerRender = functionSource(appJs, "renderReader");
assert.ok(readerRender.includes("renderActions(pane, email)"));
assert.ok(readerRender.includes("renderSuggestions(pane, email)"));
assert.ok(readerRender.includes("appendReaderClose(pane)"));
assert.ok(readerRender.includes("if (!isReaderWindow()) renderThread(pane, email)"));
assert.ok(!readerRender.includes("renderReaderWindowBar"));
assert.ok(!appJs.includes("reader-window-bar"));
assert.ok(functionSource(appJs, "readerCloseButton").includes("window.close()"));
assert.ok(!functionSource(appJs, "readerCloseButton").includes("confirm"));
assert.ok(!functionSource(appJs, "readerCloseButton").includes("discard"));
const readerShortcuts = loadFunctions(appJs, ["readerWindowShortcut"]);
assert.strictEqual(readerShortcuts.readerWindowShortcut("reply"), true);
assert.strictEqual(readerShortcuts.readerWindowShortcut("reply-all"), true);
assert.strictEqual(readerShortcuts.readerWindowShortcut("forward"), true);
assert.strictEqual(readerShortcuts.readerWindowShortcut("delete"), true);
assert.strictEqual(readerShortcuts.readerWindowShortcut("search"), false);
assert.strictEqual(readerShortcuts.readerWindowShortcut("new-mail"), false);
assert.strictEqual(readerShortcuts.readerWindowShortcut("settings"), false);
const readerShortcutSrc = functionSource(appJs, "onMailShortcut");
assert.ok(!/if\s*\(\s*isReaderWindow\(\)\s*\)\s*return\s*;/.test(readerShortcutSrc));
assert.ok(readerShortcutSrc.includes("readerWindowShortcut(action)"));
assert.ok(functionSource(appJs, "bootReaderWindow").includes('api.on("mail:translate:event"'));
assert.ok(functionSource(appJs, "bootReaderWindow").includes("loadSnoozed"));
assert.ok(functionSource(appJs, "bootReaderWindow").includes("loadProviderFolders"));
const readerCss = css.slice(css.indexOf('html[data-window="reader"] #reader'));
assert.ok(readerCss.startsWith('html[data-window="reader"] #reader'));
assert.ok(readerCss.slice(0, 280).includes("border-radius: 0"));
assert.ok(readerCss.slice(0, 280).includes("box-shadow: none"));
const senderRemoteSrc = fs.readFileSync(path.join(root, "host/mail/remote.js"), "utf8");
assert.ok(senderRemoteSrc.includes("async function findFrom"));
assert.ok(!functionSource(senderRemoteSrc, "findText").includes("beforeUid"));
assert.strictEqual(typeof require("../host/mail/remote").findFrom, "function");
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
const aboutSummary = html.match(/id="about-summary">([^<]+)</);
assert.ok(aboutSummary, "About dialog needs a product summary");
assert.match(aboutSummary[1], /open-source Electron mail client/);
assert.match(aboutSummary[1], /IMAP or OAuth/);
assert.match(aboutSummary[1], /GitHub Releases/);
assert.match(aboutSummary[1], /MIT License/);
assert.ok(!/SwiftUI|WinUI|native app/i.test(aboutSummary[1]));
const copyright = "Copyright (c) 2026 Leo Ho / HWL-HK";
assert.ok(html.includes(`id="about-copyright" class="hint">${copyright}</p>`));
assert.ok(main.includes(`copyright: "${copyright}"`));
assert.ok(main.includes("height: 420"));
assert.strictEqual(pkg.build.copyright, copyright);
assert.ok(fs.readFileSync(path.join(root, "LICENSE"), "utf8").includes(copyright));
assert.ok(!fs.readFileSync(path.join(root, "LICENSE"), "utf8").includes("Coke1120"));
assert.ok(css.includes("#about-summary"));
assert.ok(css.includes(".about-links"));
assert.ok(html.includes('class="about-links"') && html.includes('aria-label="Morrow Mail links"'));
assert.ok(html.includes('href="https://hwl-hk.com/en/morrow-mail/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>'));
assert.ok(html.includes('href="https://hwl-hk.com/en/morrow-mail/terms" target="_blank" rel="noreferrer">Terms of Service</a>'));
assert.ok(html.includes('href="https://github.com/Coke1120/Morrow-Mail/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT License</a>'));
assert.ok(html.includes('href="https://github.com/Coke1120/Morrow-Mail" target="_blank" rel="noreferrer">GitHub</a>'));
assert.ok(html.includes('aria-label="Support"'));
assert.ok(html.includes('href="https://github.com/sponsors/Coke1120" target="_blank" rel="noreferrer">GitHub Sponsors</a>'));
assert.ok(html.includes('href="https://buymeacoffee.com/coke1120" target="_blank" rel="noreferrer">Buy Me a Coffee</a>'));
{
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.ok(readme.includes("https://hwl-hk.com/en/morrow-mail"));
  assert.ok(readme.includes(copyright));
  assert.ok(readme.includes("## Screenshots"));
  assert.ok(readme.includes("(docs/images/01-mailbox.png)"));
  assert.ok(readme.includes("(docs/images/02-reader.png)"));
  assert.ok(readme.includes("(docs/images/03-about.png)"));
  assert.ok(!readme.includes("-raw.png"));
  for (const name of ["01-mailbox.png", "02-reader.png", "03-about.png"]) {
    const bytes = fs.readFileSync(path.join(root, "docs/images", name));
    assert.ok(bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), name);
  }
  assert.ok(readme.includes("https://github.com/sponsors/Coke1120"));
  assert.ok(readme.includes("https://buymeacoffee.com/coke1120"));
  assert.ok(readme.includes("Support: [GitHub Sponsors](https://github.com/sponsors/Coke1120)"));
}
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
assert.ok(html.includes('id="folder-filter"') && html.includes("Filter folders and labels"), "mailbox list has no folder filter");
assert.ok(css.includes(".all-account-mail") && css.includes("button.all-account-unread") && css.includes("button.all-account-unread[aria-pressed=\"true\"]"), "All Account Mail unread chip styling missing");
assert.ok(css.includes(".folder-filter") && css.includes(".folder-indent"), "folder filter or indent layout missing");
assert.match(css, /#folders \{\s*flex: 1 1 auto;\s*min-width: 0;\s*overflow-x: hidden;\s*overflow-y: auto;/, "folder list still scrolls horizontally");
const messageRowSrc = functionSource(appJs, "messageRow");
const rowOrder = ['"star"', '"read"', '"reply"', '"reply-all"', '"forward"', '"delete"'];
let rowAt = -1;
for (const token of rowOrder) {
  const next = messageRowSrc.indexOf("rowAction(" + token);
  assert.ok(next > rowAt, "row action order missing " + token);
  rowAt = next;
}
assert.ok(messageRowSrc.includes("toggleStar(row.mailMessage)"), "row star does not use toggleStar");
assert.ok(messageRowSrc.includes('replyFromList(row.mailMessage, "forward")'), "row forward does not open forward compose");
assert.ok(messageRowSrc.includes("starIcon(starred, 16)"), "row star does not use the shared star icon");
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

const threadStrip = loadFunctions(appJs, [
  "threadCalendarTime",
  "threadRelativeTime",
  "threadSnippetLine",
  "threadEarlierLabel",
  "threadEarlierAnnouncement",
  "threadListLabel",
  "threadStripPlan",
]);
const threadNow = new Date("2026-10-22T12:00:00Z");
assert.strictEqual(threadStrip.threadRelativeTime("2026-10-22T11:59:40Z", threadNow), "just now");
assert.strictEqual(threadStrip.threadRelativeTime("2026-10-22T11:59:00Z", threadNow), "1 minute ago");
assert.strictEqual(threadStrip.threadRelativeTime("2026-10-22T11:30:00Z", threadNow), "30 minutes ago");
assert.strictEqual(threadStrip.threadRelativeTime("2026-10-22T10:00:00Z", threadNow), "2 hours ago");
assert.strictEqual(threadStrip.threadRelativeTime("2026-10-22T11:00:00Z", threadNow), "1 hour ago");
assert.strictEqual(threadStrip.threadRelativeTime("2026-10-21T12:00:00Z", threadNow), "yesterday");
assert.strictEqual(threadStrip.threadRelativeTime("2026-10-18T12:00:00Z", threadNow), "4 days ago");
assert.strictEqual(threadStrip.threadRelativeTime("", threadNow), "");
assert.ok(threadStrip.threadRelativeTime("2026-09-01T12:00:00Z", threadNow));
assert.ok(!threadStrip.threadRelativeTime("2026-09-01T12:00:00Z", threadNow).includes("ago"));
assert.ok(!String(threadStrip.threadRelativeTime("2026-10-23T12:00:00Z", threadNow)).includes("ago"));
assert.strictEqual(threadStrip.threadSnippetLine({ snippet: "  hello\nthere  ", subject: "RE: Secret" }), "hello there");
assert.strictEqual(threadStrip.threadSnippetLine({ snippet: "", subject: "RE: Secret" }), "");
assert.strictEqual(threadStrip.threadSnippetLine(null), "");
assert.strictEqual(threadStrip.threadEarlierLabel(18), "Earlier in this conversation (18)");
assert.strictEqual(threadStrip.threadEarlierLabel(1), "Earlier in this conversation (1)");
assert.strictEqual(threadStrip.threadEarlierAnnouncement(6, false), "6 earlier messages collapsed");
assert.strictEqual(threadStrip.threadEarlierAnnouncement(1, true), "Showing 1 earlier message");
assert.strictEqual(threadStrip.threadListLabel(20, 18, false), "20 messages in this conversation, 18 earlier messages collapsed");
assert.strictEqual(threadStrip.threadListLabel(20, 18, true), "20 messages in this conversation");
function threadStripRow(id, date) {
  return { id, date, subject: "RE: Same subject", snippet: "Snippet " + id };
}
const threadStripRows = ["a", "b", "c", "d", "e"].map((id, index) => threadStripRow(id, "2026-10-1" + index));
assert.deepStrictEqual(threadStrip.threadStripPlan(threadStripRows, "e", false).visibleIds, ["d", "e"]);
assert.strictEqual(threadStrip.threadStripPlan(threadStripRows, "e", false).count, 3);
assert.strictEqual(threadStrip.threadStripPlan(threadStripRows, "e", false).showControl, true);
assert.deepStrictEqual(threadStrip.threadStripPlan(threadStripRows, "b", false).visibleIds, ["b", "d", "e"]);
assert.strictEqual(threadStrip.threadStripPlan(threadStripRows, "b", false).count, 2);
assert.deepStrictEqual(threadStrip.threadStripPlan(threadStripRows, "b", true).visibleIds, ["a", "b", "c", "d", "e"]);
assert.strictEqual(threadStrip.threadStripPlan(threadStripRows, "b", true).count, 2);
assert.strictEqual(threadStrip.threadStripPlan(threadStripRows, "b", true).expanded, true);
const threadStripPair = threadStrip.threadStripPlan([threadStripRow("a", "1"), threadStripRow("b", "2")], "b", false);
assert.strictEqual(threadStripPair.showControl, false);
assert.deepStrictEqual(threadStripPair.visibleIds, ["a", "b"]);
const threadStripOldest = threadStrip.threadStripPlan([
  threadStripRow("a", "1"),
  threadStripRow("b", "2"),
  threadStripRow("c", "3"),
], "a", false);
assert.strictEqual(threadStripOldest.showControl, false);
assert.deepStrictEqual(threadStripOldest.visibleIds, ["a", "b", "c"]);
assert.deepStrictEqual(threadStrip.threadStripPlan([
  threadStripRow("b", "2"),
  threadStripRow("a", "1"),
  threadStripRow("c", "3"),
], "c", false).visibleIds, ["b", "c"]);
const threadRowSource = functionSource(appJs, "threadMessageButton");
assert.ok(!threadRowSource.includes("subject"), "conversation rows repeat the subject");
assert.ok(threadRowSource.includes("openMessage(member.id)"));
assert.ok(threadRowSource.includes("threadSnippetLine"));
assert.ok(threadRowSource.includes("threadRelativeTime"));
assert.ok(functionSource(appJs, "buildThreadStrip").includes('aria-expanded'));
assert.ok(functionSource(appJs, "buildThreadStrip").includes("thread-earlier"));
assert.ok(functionSource(appJs, "toggleThreadEarlier").includes("paintThreadStrip(true)"));
assert.ok(css.includes("button.thread-earlier"));
assert.ok(css.includes(".thread-snippet"));

const paneWidth = extractFunction(appJs, "paneWidth");
assert.strictEqual(paneWidth(200, -80, 140, 400), 140);
assert.strictEqual(paneWidth(200, 300, 140, 400), 400);
assert.strictEqual(paneWidth(200, 20, 140, 400), 220);

const folderIcon = extractFunction(appJs, "folderIcon");
assert.strictEqual(folderIcon("all"), "📨");
assert.strictEqual(folderIcon("inbox"), "📥");
assert.strictEqual(folderIcon("starred"), "⭐");
assert.strictEqual(folderIcon("unread"), "✉️");
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
      { id: "in", wellKnownName: "inbox", chip: true },
      { id: "sent", wellKnownName: "sentitems", chip: true },
      { id: "drafts", wellKnownName: "drafts", chip: true },
      { id: "arch", wellKnownName: "archive" },
    ],
    more: [],
  },
};
const outlookAccount = {
  platform: "outlook",
  folders: {
    primary: [
      { id: "in", wellKnownName: "inbox", chip: true },
      { id: "drafts", wellKnownName: "drafts", chip: true },
      { id: "sent", wellKnownName: "sentitems", chip: true },
    ],
    more: [],
  },
};
assert.deepStrictEqual(chipFolders(gmailAccount).map((folder) => folder.wellKnownName), ["inbox", "sentitems", "drafts"]);
assert.deepStrictEqual(chipFolders(outlookAccount).map((folder) => folder.wellKnownName), ["inbox", "drafts", "sentitems"]);
assert.deepStrictEqual(chipFolders(null), []);
assert.deepStrictEqual(chipFolders({ folders: { primary: [], more: [{ id: "in", wellKnownName: "inbox", chip: true }] } }).map((folder) => folder.id), ["in"]);
assert.deepStrictEqual(chipFolders({ folders: { primary: [{ id: "x", wellKnownName: "archive" }] } }), []);
assert.deepStrictEqual(chipFolders({
  folders: {
    primary: [
      { id: "in", wellKnownName: "inbox", chip: true },
      { id: "sent", wellKnownName: "sentitems", chip: true },
      { id: "star", wellKnownName: "starred", chip: false, type: "virtual" },
      { id: "drafts", wellKnownName: "drafts", chip: true },
      { id: "un", wellKnownName: "unread", chip: true, type: "virtual" },
    ],
  },
}).map((folder) => folder.wellKnownName), ["inbox", "sentitems", "drafts", "unread"]);
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
assert.ok(html.includes("img-src 'self' data: blob: https: http:"));
assert.ok(html.includes("frame-src blob: data:") && html.includes("object-src blob: data:"));
assert.ok(html.includes("script-src 'self'") && html.includes("default-src 'none'"));
assert.ok(html.includes("style-src 'self'"));
assert.ok(html.includes("connect-src 'self'"), "PDF preview cannot load local font and CMap files");
assert.ok(!html.includes("unsafe-eval") && !html.includes("unsafe-inline") && !html.includes("unsafe-hashes"));
assert.ok(!html.includes("img-src *"));
assert.ok(html.includes('id="attachment-preview"') && html.includes('id="attachment-preview-pages"'));
assert.ok(!html.includes("attachment-preview-frame"), "PDF preview still embeds the Chromium viewer");
assert.ok(css.includes(".attachment-preview-page") && css.includes("#attachment-preview-stage.is-pdf"));
assert.ok(css.includes("#attachment-preview-stage.is-pdf::-webkit-scrollbar { width: 12px;"));
const pdfPreviewSrc = fs.readFileSync(path.join(root, "renderer/pdf-preview.js"), "utf8");
const pdfPreviewBitmap = extractFunction(pdfPreviewSrc, "pdfPreviewBitmap");
const a4Width = 595 * 96 / 72;
const a4Height = 842 * 96 / 72;
const fitted = pdfPreviewBitmap(a4Width, a4Height, 880, 1);
assert.strictEqual(fitted.bitmapWidth, 880);
assert.ok(Math.abs(fitted.bitmapHeight / fitted.bitmapWidth - 842 / 595) < 0.02);
const sharp = pdfPreviewBitmap(a4Width, a4Height, 880, 3);
assert.strictEqual(sharp.bitmapWidth, 1760);
assert.ok(sharp.bitmapHeight > fitted.bitmapHeight);
const capped = pdfPreviewBitmap(100, 100, 10000, 2);
assert.ok(capped.bitmapWidth <= 4096 && capped.bitmapHeight <= 4096);
assert.strictEqual(pdfPreviewBitmap(0, 0, 0, Number.NaN).bitmapWidth, 1);
assert.ok(pdfPreviewSrc.includes("disableFontFace: true") && pdfPreviewSrc.includes("isEvalSupported: false"));
assert.ok(pdfPreviewSrc.includes("vendor/pdfjs/cmaps/") && pdfPreviewSrc.includes("vendor/pdfjs/standard_fonts/"));
assert.ok(pdfPreviewSrc.includes("pdfjsWorker"));
assert.ok(fs.existsSync(path.join(root, "renderer/pdf-preview.bundle.js")), "PDF preview bundle was not built");
assert.ok(fs.readFileSync(path.join(root, "renderer/pdf-preview.bundle.js"), "utf8").includes("morrowPdf"));
assert.ok(fs.existsSync(path.join(root, "renderer/vendor/pdfjs/cmaps/Adobe-CNS1-UCS2.bcmap")));
assert.ok(fs.existsSync(path.join(root, "renderer/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf")));
const pdfPreviewError = extractFunction(appJs, "pdfPreviewError");
assert.strictEqual(pdfPreviewError({ name: "PasswordException" }), "This PDF is password-protected. Save or Open it instead.");
assert.strictEqual(pdfPreviewError(new Error("nope")), "This PDF could not be previewed. Save or Open it instead.");
assert.strictEqual(pdfPreviewError({ name: "AbortError" }), "");
assert.ok(functionSource(appJs, "loadPdfPreview").includes("./pdf-preview.bundle.js"));
assert.ok(functionSource(appJs, "clearAttachmentPreview").includes("attachmentPreviewAbort"));
assert.ok(!appJs.includes("attachment-preview-frame"));
const attachmentPreviewKind = extractFunction(appJs, "attachmentPreviewKind");
assert.strictEqual(attachmentPreviewKind({ mimeType: "image/png", filename: "a.png" }), "image");
assert.strictEqual(attachmentPreviewKind({ mimeType: "image/jpeg", filename: "a.jpg" }), "image");
assert.strictEqual(attachmentPreviewKind({ mimeType: "application/pdf", filename: "a.pdf" }), "pdf");
assert.strictEqual(attachmentPreviewKind({ mimeType: "application/octet-stream", filename: "scan.PDF" }), "pdf");
assert.strictEqual(attachmentPreviewKind({ filename: "photo.jpeg" }), "image");
assert.strictEqual(attachmentPreviewKind({ mimeType: "text/plain", filename: "notes.pdf" }), "");
assert.strictEqual(attachmentPreviewKind({ mimeType: "image/svg+xml", filename: "mark.svg" }), "");
assert.strictEqual(attachmentPreviewKind({ mimeType: "application/zip", filename: "files.zip" }), "");
const attachmentBytes = extractFunction(appJs, "attachmentBytes");
assert.deepStrictEqual(Array.from(attachmentBytes(null)), []);
assert.deepStrictEqual(Array.from(attachmentBytes(Uint8Array.from([1, 2]))), [1, 2]);
assert.deepStrictEqual(Array.from(attachmentBytes({ type: "Buffer", data: [9, 8] })), [9, 8]);
const attachmentUi = functionSource(appJs, "renderAttachments");
assert.ok(attachmentUi.includes("attachment-card"), "attachments stay in a card");
assert.ok(attachmentUi.includes("Save as ZIP") && attachmentUi.includes("saveAttachmentsZip"));
assert.ok(functionSource(appJs, "saveAttachmentsZip").includes("mail:downloadAttachmentsZip"));
assert.ok(attachmentUi.includes("Preview") && attachmentUi.includes("mail:fetchAttachmentBytes") === false);
assert.ok(functionSource(appJs, "previewAttachment").includes("mail:fetchAttachmentBytes"));
assert.ok(attachmentUi.includes("mail:downloadAttachment") && attachmentUi.includes("mail:openAttachmentExternally"));
assert.strictEqual((appJs.match(/function readerIcon\(/g) || []).length, 1, "toolbar readerIcon stays the only readerIcon");
assert.ok(appJs.includes("function attachmentIcon("), "attachment glyphs use attachmentIcon");
assert.ok(functionSource(appJs, "readerIcon").includes("READER_ICON[name]"));
assert.ok(attachmentUi.includes('attachmentIcon("paperclip")') && attachmentUi.includes('attachmentIcon("download")'));
assert.equal(attachmentUi.includes("readerIcon("), false);
{
  const mapStart = appJs.indexOf("const READER_ICON = {");
  const readerIconMap = appJs.slice(mapStart, appJs.indexOf("\n};", mapStart) + 3);
  const iconDom = {
    createElementNS(_ns, tag) {
      return {
        tag,
        attrs: {},
        children: [],
        setAttribute(key, value) { this.attrs[key] = String(value); },
        appendChild(child) { this.children.push(child); return child; },
      };
    },
  };
  const drawn = new Function("document", `${readerIconMap}\n${functionSource(appJs, "readerIcon")}\n${functionSource(appJs, "attachmentIcon")}\nreturn { READER_ICON, readerIcon, attachmentIcon };`)(iconDom);
  for (const name of ["reply", "reply-all", "forward", "archive", "trash", "move", "organize"]) {
    const node = drawn.readerIcon(name);
    assert.ok(node && node.children[0], name);
    assert.strictEqual(node.children[0].attrs.d, drawn.READER_ICON[name], name);
  }
  assert.strictEqual(drawn.readerIcon("paperclip"), null);
  assert.strictEqual(drawn.readerIcon("download"), null);
  const paperclip = drawn.attachmentIcon("paperclip");
  const download = drawn.attachmentIcon("download");
  assert.strictEqual(paperclip.children[0].attrs.d, "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48");
  assert.strictEqual(download.children[0].attrs.d, "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4");
  assert.strictEqual(download.children[1].attrs.points, "7 10 12 15 17 10");
}
const readerUi = functionSource(appJs, "renderReader");
assert.ok(readerUi.indexOf("renderAttachments") < readerUi.indexOf("renderBody"), "attachments stay above the body");
const zipBytes = require("../host/mail/zip-bytes");
assert.strictEqual(zipBytes.zipDownloadName(""), "attachments.zip");
assert.strictEqual(zipBytes.zipDownloadName("   "), "attachments.zip");
assert.strictEqual(zipBytes.zipDownloadName(".."), "attachments.zip");
assert.strictEqual(zipBytes.zipDownloadName("Q3 / report: final"), "Q3 report final.zip");
assert.ok(zipBytes.zipDownloadName("a".repeat(200)).length <= 84);
const packed = zipBytes.zipFiles([
  { name: "../notes.txt", data: Buffer.from("hello") },
  { name: "notes.txt", data: Buffer.from("second") },
  { name: "résumé.png", data: Buffer.from([0, 255, 10, 13, 127]) },
  { name: "", data: Buffer.from("") },
]);
const entries = zipBytes.unzipFiles(packed);
assert.deepStrictEqual(entries.map((entry) => entry.name), ["notes.txt", "notes-2.txt", "résumé.png", "attachment"]);
assert.strictEqual(entries[0].data.toString(), "hello");
assert.strictEqual(entries[1].data.toString(), "second");
assert.deepStrictEqual(Array.from(entries[2].data), [0, 255, 10, 13, 127]);
assert.strictEqual(entries[3].data.length, 0);
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
assert.ok(html.includes('id="status-chip"') && html.includes('aria-controls="status"'), "status chip is missing");
assert.ok(css.includes("#notice.collapsed") && css.includes("#status-chip"), "status chip styles are missing");
assert.ok(appJs.includes("STATUS_SUCCESS_DWELL_MS") && appJs.includes("STATUS_ERROR_DWELL_MS") && appJs.includes("function wireStatusNotice("), "status collapse lifecycle is missing");
assert.ok(css.includes("--folders") && css.includes("--list") && css.includes(".split") && css.includes(".folder-icon") && css.includes(".reader-actions"));

const bodyNodes = extractFunction(appJs, "bodyNodes");
assert.deepStrictEqual(bodyNodes("One\n\nTwo"), [
  { node_id: "n0", text: "One" },
  { node_id: "n1", text: "Two" },
]);
assert.deepStrictEqual(bodyNodes("  "), []);
assert.deepStrictEqual(bodyNodes("Line"), [{ node_id: "n0", text: "Line" }]);
const translateFns = loadFunctions(appJs, ["plainFromMailHtml", "translateSource", "translateNodes"]);
const quoted = translateFns.translateSource({
  textBody: "Latest",
  htmlBody: "<p>Latest</p><blockquote>History tail</blockquote>",
});
assert.ok(quoted.includes("History tail"));
assert.ok(quoted.includes("Latest"));
const longThread = "line\n".repeat(3000) + "TAIL";
const longNodes = translateFns.translateNodes(longThread);
assert.strictEqual(longNodes.length, 1);
assert.ok(longNodes[0].text.length > 2000);
assert.ok(longNodes[0].text.endsWith("TAIL"));

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
const domainPack = {
  ...pack,
  signatureByDomainPerAccount: { "gmail-ada": { "hkbscl.com": "s2", "gmail.com": "missing", "mail.hkbscl.com": "s1" } },
};
assert.strictEqual(chosenSignatureId(domainPack, "gmail-ada", "hkbscl.com"), "s2");
assert.strictEqual(chosenSignatureId(domainPack, "gmail-ada", "gmail.com"), "s1");
assert.strictEqual(chosenSignatureId(domainPack, "gmail-ada", "mail.hkbscl.com"), "s1");
assert.strictEqual(chosenSignatureId(domainPack, "gmail-ada"), "s1");
assert.strictEqual(chosenSignatureId(domainPack, "other", "hkbscl.com"), "s2");
const signatureDomainField = extractFunction(appJs, "signatureDomainField");
assert.strictEqual(signatureDomainField(domainPack, "gmail-ada", "s2"), "hkbscl.com");
assert.strictEqual(signatureDomainField(domainPack, "gmail-ada", "s1"), "mail.hkbscl.com");
assert.strictEqual(signatureDomainField(domainPack, "other", "s2"), "");
assert.strictEqual(signaturePlain(pack.signatures[0]), "Thanks,\nAda");
assert.strictEqual(signaturePlain(pack.signatures[1]), "— Ada");
assert.strictEqual(applySignature("Hello", "", "— Ada"), "Hello\n\n— Ada");
assert.strictEqual(applySignature("Hello\n\n— Ada", "— Ada", "Thanks,\nAda"), "Hello\n\nThanks,\nAda");
assert.strictEqual(applySignature("— Ada", "— Ada", ""), "");
assert.strictEqual(applySignature("Hello\n\n— Ada\n\nps", "— Ada", "Thanks"), "Hello\n\n— Ada\n\nps\n\nThanks");
const signatureSwap = loadFunctions(appJs, [
  "toHtml", "signatureMarkup", "signatureRows", "chosenSignatureId", "signaturePlain", "applySignature",
  "signatureUntouched", "replaceSignature", "commitPickerSignature", "applyFromSignature",
]);
const replaceSignature = signatureSwap.replaceSignature;
const commitPickerSignature = signatureSwap.commitPickerSignature;
const applyFromSignature = signatureSwap.applyFromSignature;
const swapped = replaceSignature("Hello\n\n— Ada", "— Ada", "Thanks,\nAda");
assert.strictEqual(swapped.applied, true);
assert.strictEqual(swapped.body, "Hello\n\nThanks,\nAda");
const dirty = replaceSignature("Hello\n\n— Ada\n\nps", "— Ada", "Thanks");
assert.strictEqual(dirty.applied, false);
assert.strictEqual(dirty.body, "Hello\n\n— Ada\n\nps");
const clearedPick = commitPickerSignature("Hello\n\n— Ada", "— Ada", "");
assert.strictEqual(clearedPick.body, "Hello");
assert.strictEqual(clearedPick.previous, "— Ada");
const afterClear = replaceSignature(clearedPick.body, clearedPick.previous, "Thanks");
assert.strictEqual(afterClear.applied, false);
assert.strictEqual(afterClear.body, "Hello");
const fromDomain = applyFromSignature({
  follows: true, body: "Hello\n\n— Ada", previous: "— Ada", pack: domainPack,
  accountId: "gmail-ada", policyDomain: "gmail.com", rows: domainPack.signatures,
});
assert.strictEqual(fromDomain.applied, true);
assert.strictEqual(fromDomain.pickerId, "s1");
assert.strictEqual(fromDomain.body, "Hello\n\nThanks,\nAda");
assert.strictEqual(fromDomain.previous, "Thanks,\nAda");
assert.strictEqual(fromDomain.html, "<p>Thanks,<br>Ada</p>");
const textPick = applyFromSignature({
  follows: true, body: "", previous: "", pack: domainPack,
  accountId: "gmail-ada", policyDomain: "hkbscl.com", rows: domainPack.signatures,
});
assert.strictEqual(textPick.applied, true);
assert.strictEqual(textPick.pickerId, "s2");
assert.strictEqual(textPick.html, "— Ada");
const coloredRow = { id: "s3", name: "Color", html: '<p><font color="#c0392b"><span style="background-color:#fff3a0">Ada</span></font></p>' };
assert.strictEqual(signatureSwap.signatureMarkup(coloredRow), coloredRow.html);
assert.strictEqual(signatureSwap.signatureMarkup({ text: "Thanks,\nAda" }), "Thanks,<br>Ada");
assert.strictEqual(signatureSwap.signatureMarkup({ html: "  <p>Hi</p>  ", text: "nope" }), "<p>Hi</p>");
assert.strictEqual(signatureSwap.signatureMarkup(null), "");
const draftBody = applyFromSignature({
  follows: false, body: "Draft", previous: "", pack: domainPack,
  accountId: "gmail-ada", policyDomain: "hkbscl.com", rows: domainPack.signatures,
});
assert.strictEqual(draftBody.applied, false);
assert.strictEqual(draftBody.body, "Draft");
assert.strictEqual(draftBody.pickerId, null);
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
assert.deepStrictEqual(signatureDraft({ name: "Work", body: "Hi", domains: ["@HKBSCL.com", " Gmail.com "] }), {
  name: "Work",
  text: "Hi",
  isDefault: false,
  domains: ["@HKBSCL.com", " Gmail.com "],
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
assert.ok(html.includes('id="signature-html" type="checkbox" checked') && html.includes('id="signature-default"') && html.includes('id="signatures-open"'));
assert.ok(html.includes('id="signature-editor"') && html.includes('id="signature-format"') && html.includes('class="compose-editor"'));
assert.ok(html.includes('data-command="foreColor"') && html.includes('data-command="hiliteColor"'));
assert.ok(html.split('aria-label="Text color"').length - 1 >= 2);
assert.ok(html.split('aria-label="Highlight"').length - 1 >= 2);
assert.ok(functionSource(appJs, "clearSignatureForm").includes('signature-html").checked = true'));
assert.ok(functionSource(appJs, "wireComposeFormat").includes('$("signature-format")'));
assert.ok(functionSource(appJs, "wireComposeFormat").includes('$("signature-editor")') && functionSource(appJs, "wireComposeFormat").includes('$("compose-editor")'));
assert.ok(functionSource(appJs, "bindRichEditor").includes("sanitizeComposeHtml"));
assert.ok(functionSource(appJs, "revealEditorStyles").includes("background-color"));
assert.ok(css.includes(".compose-color") && css.includes("#signature-form .compose-editor") && css.includes("#signature-form textarea"));
assert.ok(html.includes('id="signature-domains"') && html.includes('id="brain-compose-bcc"'));
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
assert.strictEqual(idle.attention, false);
assert.strictEqual(updateView({ enabled: false }, "0.1.0").status, "Updater is off until the app is packaged.");
const failed = updateView({ error: "network", downloaded: true }, "");
assert.strictEqual(failed.status, "Update failed.");
assert.strictEqual(failed.error, "network");
assert.strictEqual(failed.install, false);
assert.strictEqual(failed.attention, false, "a failed check stays quiet even if a download flag is still set");
assert.strictEqual(updateView({ downloaded: true, version: "0.2.0" }, "0.1.0").status, "Update 0.2.0 ready.");
assert.strictEqual(updateView({ downloaded: true, version: "0.2.0" }, "0.1.0").install, true);
assert.strictEqual(updateView({ downloaded: true, version: "0.2.0" }, "0.1.0").attention, true);
assert.strictEqual(updateView({ downloaded: true }, "").status, "Update ready.");
const downloading = updateView({ downloading: true, progress: 42.2 }, "");
assert.strictEqual(downloading.status, "Downloading 42%…");
assert.strictEqual(downloading.busy, true);
assert.strictEqual(downloading.install, false);
assert.strictEqual(downloading.attention, true);
assert.strictEqual(updateView({ checking: true }, "").status, "Checking for updates…");
assert.strictEqual(updateView({ checking: true }, "").busy, true);
assert.strictEqual(updateView({ checking: true }, "").attention, false);
assert.strictEqual(updateView({ checking: true, available: true }, "").attention, true);
const installing = updateView({ installing: true, downloaded: true, version: "0.2.0" }, "");
assert.strictEqual(installing.status, "Installing…");
assert.strictEqual(installing.install, false);
assert.strictEqual(installing.busy, true);
assert.strictEqual(installing.attention, true);
assert.strictEqual(updateView({ available: true, version: "0.2.0" }, "").status, "Update 0.2.0 available.");
assert.strictEqual(updateView({ available: true }, "").status, "Update available.");
assert.strictEqual(updateView({ available: true }, "").attention, true);
assert.strictEqual(updateView({ manualRequired: true }, "").attention, true);
assert.strictEqual(updateView({ lastCheckedAt: "2026-10-18T08:00:00Z" }, "").attention, false);
const needsToken = updateView({
  needsToken: true,
  available: true,
  error: "404 releases.atom",
}, "0.1.0");
assert.strictEqual(needsToken.status, "Update failed.");
assert.ok(!needsToken.status.includes("available"));
assert.ok(!needsToken.status.includes("Private"));
assert.strictEqual(needsToken.attention, false);
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
assert.strictEqual(prefs.length, 15);
const prefKinds = new Set();
for (const [id, getChannel, setChannel, kind] of prefs) {
  assert.ok(html.includes('id="' + id + '"'), `settings control missing ${id}`);
  assert.ok(registered.has(getChannel), `preload does not register ${getChannel}`);
  assert.ok(registered.has(setChannel), `preload does not register ${setChannel}`);
  assert.ok(used.has(getChannel) && used.has(setChannel), `renderer does not call ${setChannel}`);
  assert.ok(settingsSrc.includes('"' + getChannel + '"'), `settings store missing ${getChannel}`);
  assert.ok(settingsSrc.includes('"' + setChannel + '"'), `settings store missing ${setChannel}`);
  assert.ok(kind === "select" || kind === "text" || kind === "bool" || kind === "seconds" || kind === "days");
  prefKinds.add(kind);
}
assert.ok(prefKinds.has("select") && prefKinds.has("text") && prefKinds.has("bool") && prefKinds.has("seconds"));
const settingsHtml = html.slice(html.indexOf('id="settings"'), html.indexOf("</dialog>", html.indexOf('id="settings"')));
assert.ok(settingsHtml.includes("<select") && settingsHtml.includes('type="checkbox"') && settingsHtml.includes('type="number"'));
assert.ok(settingsHtml.includes('id="ai-base"') && settingsHtml.includes('id="ai-model"') && settingsHtml.includes('id="ai-key"'));
assert.ok(settingsHtml.includes('type="password"') && settingsHtml.includes('id="ai-model"') && settingsHtml.includes('id="ai-model-select"'));
assert.ok(settingsHtml.includes('id="ai-model-chooser"') && !settingsHtml.includes("<datalist") && !settingsHtml.includes('list="ai-model-list"'));
assert.match(settingsHtml, /id="pref-accent-help"/);
assert.match(settingsHtml, /Theme sets the light or dark shell/);
assert.ok(html.includes('src="../shared/display-format.js"'), "renderer does not load the display format helper");
assert.ok(settingsHtml.includes('id="pref-time-format"') && settingsHtml.includes('id="pref-date-format"'));
assert.ok(settingsHtml.includes(">System<") && settingsHtml.includes(">12-hour<") && settingsHtml.includes(">24-hour<"));
assert.ok(settingsHtml.includes("22/10/2026") && settingsHtml.includes("22 October 2026"));
assert.ok(settingsHtml.includes("10/22/2026") && settingsHtml.includes("2026-10-22") && settingsHtml.includes("22 Oct 2026"));
assert.ok(settingsHtml.indexOf('id="pref-accent"') < settingsHtml.indexOf('id="pref-time-format"'));
assert.ok(settingsHtml.indexOf('id="pref-time-format"') < settingsHtml.indexOf('id="pref-date-format"'));
assert.ok(functionSource(appJs, "listWhen").includes("displayStamp"));
assert.ok(functionSource(appJs, "threadCalendarTime").includes('displayStamp(date, "list"'));
assert.ok(functionSource(appJs, "threadAbsoluteTime").includes("shownWhen"));
assert.ok(functionSource(appJs, "clockLabel").includes("displayStamp"));
assert.ok(functionSource(appJs, "takePref").includes("morrow:configGetTimeFormat"));
assert.ok(functionSource(appJs, "paintPrefs").includes("repaintClockSurfaces"));
assert.ok(!html.includes("hkbscl"));
assert.ok(html.includes("@example.com = colleague@example.com, team@example.org"));
assert.ok(html.includes("ada@example.org = example.com"));
assert.ok(html.includes("example.com, example.org"));
assert.ok(!fs.readFileSync(path.join(root, "docs/BRAIN_AGENT.md"), "utf8").includes("hkbscl"));
assert.ok(functionSource(appJs, "chooseFetchedModel").includes("paintAiDirty"));
assert.ok(functionSource(appJs, "chooseFetchedModel").includes('new Event("input"'));
assert.ok(functionSource(appJs, "fetchAiModels").includes("applyFetchedModels"));
assert.ok(functionSource(appJs, "fetchAiModels").includes("host:aiListModels"));
assert.ok(!appJs.includes("ai-model-list"));
assert.ok(settingsHtml.includes("Save AI") && settingsHtml.includes("Fetch models") && settingsHtml.includes("Test connection"));
assert.ok(settingsHtml.includes("Test connection sends a short model request") && settingsHtml.includes("Fetch models only reads the selected provider"));
// #158: remote-image privacy, visible fold loading, and field-level errors.
assert.match(settingsHtml, /id="pref-images"[^>]*aria-describedby="pref-images-help"/);
const remoteImagesHelp = settingsHtml.slice(settingsHtml.indexOf('id="pref-images-help"')).split("</p>")[0];
assert.match(remoteImagesHelp, /tracking|report when/i);
assert.ok(css.includes(".fold-loading") && css.includes(".fold-loading-spin"));
assert.ok(functionSource(appJs, "loadSettingsFold").includes("setSettingsFoldLoading"));
const fieldErrorSource = functionSource(appJs, "setFieldError");
assert.ok(fieldErrorSource.includes("aria-invalid") && fieldErrorSource.includes("aria-describedby"));
for (const statusName of ["setAiStatus", "setOooStatus", "setBotStatus"]) {
  assert.ok(functionSource(appJs, statusName).includes("setFieldError"), `${statusName} must attach field errors`);
}
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
checkDisplayFormats();

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
    assert.strictEqual(answer("morrow:configGetTranslateTargetLanguage", []), "zh-Hant");
    fs.writeFileSync(file, JSON.stringify({ accent: "#7C3AED" }));
    assert.strictEqual(answer("morrow:configGetAccent", []), "#193C34");
    fs.unlinkSync(file);
    assert.strictEqual(answer("morrow:configGetConversationViewEnabled", []), true);
    assert.strictEqual(answer("morrow:configGetAutoLoadRemoteImages", []), true);
    assert.strictEqual(answer("morrow:configGetUndoSendDelaySeconds", []), 30);
    assert.strictEqual(answer("morrow:configGetSnoozeEffective", []), false);
    assert.strictEqual(answer("morrow:configGetSyncHorizonDays", []), 0);
    assert.strictEqual(answer("morrow:configGetCompactMessageList", []), true);
    assert.strictEqual(answer("morrow:configGetAiWriteAutoOpenOnReply", []), true);
    assert.strictEqual(answer("morrow:configGetShowFolderChips", []), true);
    assert.strictEqual(answer("morrow:configGetSidebarGmailFoldersExpanded", []), true);
    assert.strictEqual(answer("morrow:configGetSidebarOutlookFoldersExpanded", []), false);
    assert.deepStrictEqual(answer("morrow:configGetSidebarCollapsedFolders", []), {});
    assert.strictEqual(answer("morrow:configGetComposeQuoteWidth", []), 420);
    assert.strictEqual(answer("morrow:configGetDefaultScheduleDelayMinutes", []), 0);
    assert.strictEqual(answer("morrow:configGetTimeFormat", []), "system");
    assert.strictEqual(answer("morrow:configGetDateFormat", []), "system");
    assert.deepStrictEqual(answer("morrow:configGetLayoutPanes", []), { folders: 260, list: 360, reading: 0 });
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(answer("config:setTheme", ["dark"]), "dark");
    assert.strictEqual(answer("morrow:configSetAccent", ["#112233"]), "#112233");
    assert.strictEqual(answer("morrow:configSetConversationViewEnabled", [false]), false);
    assert.strictEqual(answer("morrow:configSetAutoLoadRemoteImages", [true]), true);
    assert.strictEqual(answer("morrow:configSetUndoSendDelaySeconds", [0]), 0);
    assert.strictEqual(answer("morrow:configSetSnoozeEffective", [false]), false);
    assert.strictEqual(answer("morrow:configSetAiWriteAutoOpenOnReply", [false]), false);
    assert.strictEqual(answer("morrow:configGetAiWriteAutoOpenOnReply", []), false);
    assert.strictEqual(answer("morrow:configSetAiWriteAutoOpenOnReply", [true]), true);
    assert.strictEqual(answer("morrow:configSetShowFolderChips", [false]), false);
    assert.strictEqual(answer("morrow:configSetSidebarGmailFoldersExpanded", [false]), false);
    assert.strictEqual(answer("morrow:configSetSidebarOutlookFoldersExpanded", [true]), true);
    assert.deepStrictEqual(answer("morrow:configSetSidebarCollapsedFolders", [{
      leo: ["AriesCPA.com", "AriesCPA.com", "  "],
      "  ": ["Nope"],
    }]), { leo: ["AriesCPA.com"] });
    assert.strictEqual(answer("morrow:configSetComposeQuoteWidth", [560]), 560);
    assert.strictEqual(answer("morrow:configSetDefaultScheduleDelayMinutes", [90]), 90);
    assert.strictEqual(answer("morrow:configSetTimeFormat", [" 24h "]), "24h");
    assert.strictEqual(answer("morrow:configSetDateFormat", ["  d mmm yyyy  "]), "d mmm yyyy");
    assert.deepStrictEqual(answer("morrow:configSetLayoutPanes", [{ folders: 300, list: 480, reading: 640 }]), { folders: 300, list: 480, reading: 640 });
    assert.strictEqual(answer("morrow:configSetTranslateTargetLanguage", ["en"]), "en");
    assert.strictEqual(answer("morrow:configGetTranslateTargetLanguage", []), "en");
    assert.strictEqual(answer("morrow:configSetTranslateTargetLanguage", ["Chinese"]), "zh-Hant");
    assert.strictEqual(answer("morrow:configSetTranslateTargetLanguage", ["zh-Hans"]), "zh-Hant");
    assert.strictEqual(answer("morrow:configSetTranslateTargetLanguage", ["zh-TW"]), "zh-Hant");
    assert.strictEqual(answer("morrow:configSetTranslateTargetLanguage", ["Simplified Chinese"]), "zh-Hant");
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
    assert.strictEqual(answer("morrow:configGetDefaultScheduleDelayMinutes", []), 90);
    assert.deepStrictEqual(answer("morrow:configGetLayoutPanes", []), { folders: 300, list: 480, reading: 640 });
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
        collapsed: answer("morrow:configGetSidebarCollapsedFolders", []),
        quoteWidth: answer("morrow:configGetComposeQuoteWidth", []),
        timeFormat: answer("morrow:configGetTimeFormat", []),
        dateFormat: answer("morrow:configGetDateFormat", []),
        translateTargetLanguage: answer("morrow:configGetTranslateTargetLanguage", []),
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
      collapsed: { leo: ["AriesCPA.com"] },
      quoteWidth: 560,
      timeFormat: "24h",
      dateFormat: "d mmm yyyy",
      translateTargetLanguage: "zh-Hant",
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
    assert.throws(() => answer("morrow:configSetDefaultScheduleDelayMinutes", [10081]), /0 to 10080/);
    assert.strictEqual(answer("morrow:configGetDefaultScheduleDelayMinutes", []), 90);
    assert.throws(() => answer("morrow:configSetLayoutPanes", [{ folders: 10, list: 480, reading: 640 }]), /folder, list, and reading/);
    assert.deepStrictEqual(answer("morrow:configGetLayoutPanes", []), { folders: 300, list: 480, reading: 640 });
    assert.throws(() => answer("morrow:configSetSidebarCollapsedFolders", ["nope"]), /folder ids/);
    assert.deepStrictEqual(answer("morrow:configGetSidebarCollapsedFolders", []), { leo: ["AriesCPA.com"] });
    assert.throws(() => answer("morrow:configSetTimeFormat", ["12H"]), /Time format/);
    assert.strictEqual(answer("morrow:configGetTimeFormat", []), "24h");
    assert.throws(() => answer("morrow:configSetDateFormat", ["dd-mm-yyyy"]), /Date format/);
    assert.throws(() => answer("morrow:configSetDateFormat", ["DD/MM/YYYY"]), /Date format/);
    assert.strictEqual(answer("morrow:configGetDateFormat", []), "d mmm yyyy");
    assert.throws(() => answer("morrow:configSetTranslateTargetLanguage", ["Klingon"]), /translation language/i);
    assert.strictEqual(answer("morrow:configGetTranslateTargetLanguage", []), "zh-Hant");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.timeFormat = "12H";
    stored.dateFormat = "yyyy-mm-dd";
    fs.writeFileSync(file, JSON.stringify(stored));
    assert.strictEqual(answer("morrow:configGetTimeFormat", []), "system");
    assert.strictEqual(answer("morrow:configGetDateFormat", []), "yyyy-mm-dd");
    fs.writeFileSync(file, "{");
    assert.strictEqual(answer("config:getTheme", []), "light");
    assert.strictEqual(answer("morrow:configGetTimeFormat", []), "system");
    assert.strictEqual(answer("morrow:configGetDateFormat", []), "system");
    assert.strictEqual(answer("morrow:configGetComposeQuoteWidth", []), 420);
    assert.strictEqual(answer("morrow:configGetDefaultScheduleDelayMinutes", []), 0);
    assert.deepStrictEqual(answer("morrow:configGetLayoutPanes", []), { folders: 260, list: 360, reading: 0 });
    assert.deepStrictEqual(answer("morrow:configGetSidebarCollapsedFolders", []), {});
    assert.strictEqual(answer("morrow:configGetTranslateTargetLanguage", []), "zh-Hant");
    assert.strictEqual(answer("config:setTheme", ["dark"]), "dark");
    assert.strictEqual(answer("config:getTheme", []), "dark");
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function checkDisplayFormats() {
  const display = require("../shared/display-format");
  const afternoon = new Date(2026, 9, 22, 15, 4, 7);
  const morning = new Date(2026, 9, 5, 9, 5, 0);
  const en = { locale: "en-US" };
  const gb = { locale: "en-GB" };
  const prefs = (timeFormat, dateFormat) => ({ timeFormat, dateFormat });
  assert.strictEqual(display.castTimeFormat("12H", false), null);
  assert.strictEqual(display.castTimeFormat("12H", true), "system");
  assert.strictEqual(display.castTimeFormat(" 24h ", false), "24h");
  assert.strictEqual(display.castTimeFormat(12, true), "system");
  assert.strictEqual(display.castDateFormat("dd-mm-yyyy", false), null);
  assert.strictEqual(display.castDateFormat("DD/MM/YYYY", false), null);
  assert.strictEqual(display.castDateFormat("  d mmm yyyy  ", false), "d mmm yyyy");
  assert.strictEqual(display.castDateFormat(null, true), "system");
  assert.deepStrictEqual(display.TIME_FORMATS, ["system", "12h", "24h"]);
  assert.deepStrictEqual(display.DATE_FORMATS, ["system", "dd/mm/yyyy", "dd/mmmm/yyyy", "mm/dd/yyyy", "yyyy-mm-dd", "d mmm yyyy"]);
  assert.strictEqual(display.formatDate(afternoon, prefs("system", "dd/mm/yyyy"), en), "22/10/2026");
  assert.strictEqual(display.formatDate(afternoon, prefs("system", "dd/mmmm/yyyy"), en), "22 October 2026");
  assert.strictEqual(display.formatDate(afternoon, prefs("system", "mm/dd/yyyy"), en), "10/22/2026");
  assert.strictEqual(display.formatDate(afternoon, prefs("system", "yyyy-mm-dd"), en), "2026-10-22");
  assert.strictEqual(display.formatDate(afternoon, prefs("system", "d mmm yyyy"), en), "22 Oct 2026");
  assert.strictEqual(display.formatDate(morning, prefs("system", "dd/mm/yyyy"), en), "05/10/2026");
  assert.strictEqual(display.formatDate(morning, prefs("system", "dd/mmmm/yyyy"), en), "05 October 2026");
  assert.strictEqual(display.formatDate(morning, prefs("system", "mm/dd/yyyy"), en), "10/05/2026");
  assert.strictEqual(display.formatDate(morning, prefs("system", "yyyy-mm-dd"), en), "2026-10-05");
  assert.strictEqual(display.formatDate(morning, prefs("system", "d mmm yyyy"), en), "5 Oct 2026");
  assert.strictEqual(display.formatDate(afternoon, prefs("system", "system"), en), afternoon.toLocaleDateString("en-US"));
  assert.strictEqual(display.formatDate(afternoon, prefs("system", "system"), gb), afternoon.toLocaleDateString("en-GB"));
  assert.strictEqual(display.formatTime(afternoon, prefs("12h", "system"), en), "3:04 PM");
  assert.strictEqual(display.formatTime(morning, prefs("12h", "system"), en), "9:05 AM");
  assert.strictEqual(display.formatTime(afternoon, prefs("24h", "system"), en), "15:04");
  assert.strictEqual(display.formatTime(morning, prefs("24h", "system"), en), "09:05");
  assert.strictEqual(display.formatTime(afternoon, prefs("12h", "system"), gb), "3:04 pm");
  assert.strictEqual(display.formatTime(morning, prefs("12h", "system"), gb), "9:05 am");
  assert.strictEqual(display.formatTime(afternoon, prefs("24h", "system"), gb), "15:04");
  assert.strictEqual(
    display.formatTime(afternoon, prefs("system", "system"), gb),
    afternoon.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" }),
  );
  assert.strictEqual(
    display.formatTime(afternoon, prefs("system", "system"), en),
    afternoon.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
  );
  assert.strictEqual(display.formatDateTime(afternoon, prefs("24h", "yyyy-mm-dd"), en), "2026-10-22, 15:04");
  assert.strictEqual(display.formatDateTime(afternoon, prefs("12h", "d mmm yyyy"), en), "22 Oct 2026, 3:04 PM");
  assert.strictEqual(
    display.formatDateTime(afternoon, prefs("system", "system"), en),
    afternoon.toLocaleString("en-US"),
  );
  assert.ok(!display.formatDateTime(afternoon, prefs("24h", "yyyy-mm-dd"), en).includes(":07"));
  const sameDay = new Date(2026, 9, 22, 8, 0, 0);
  assert.strictEqual(display.formatListWhen(afternoon, sameDay, prefs("12h", "yyyy-mm-dd"), en), "3:04 PM");
  assert.strictEqual(display.formatListWhen(morning, afternoon, prefs("system", "dd/mm/yyyy"), en), "05/10/2026");
  assert.strictEqual(
    display.formatListWhen(new Date(2026, 0, 2, 15, 4), afternoon, prefs("system", "system"), en),
    new Date(2026, 0, 2, 15, 4).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  );
  assert.strictEqual(
    display.formatListWhen(new Date(2025, 0, 2, 15, 4), afternoon, prefs("system", "system"), en),
    new Date(2025, 0, 2, 15, 4).toLocaleDateString("en-US"),
  );
  assert.strictEqual(display.formatMonthLabel(afternoon, prefs("system", "system"), en), "October 2026");
  assert.strictEqual(display.formatMonthLabel(afternoon, prefs("system", "dd/mmmm/yyyy"), en), "October 2026");
  assert.strictEqual(display.formatMonthLabel(afternoon, prefs("system", "d mmm yyyy"), en), "Oct 2026");
  assert.strictEqual(display.formatMonthLabel(afternoon, prefs("system", "yyyy-mm-dd"), en), "2026-10");
  assert.strictEqual(display.formatMonthLabel(afternoon, prefs("system", "dd/mm/yyyy"), en), "10/2026");
  assert.strictEqual(display.formatMonthLabel(afternoon, prefs("system", "mm/dd/yyyy"), en), "10/2026");
  const weekdays = display.weekdayLabels(en);
  assert.strictEqual(weekdays.length, 7);
  assert.strictEqual(weekdays[0], "Sun");
  assert.deepStrictEqual(display.weekdayLabels({ locale: "en-US", narrow: true })[0], "S");
  assert.strictEqual(display.formatTime(new Date("nope"), prefs("12h", "system"), en), "");
  assert.strictEqual(display.formatDate(null, prefs("system", "yyyy-mm-dd"), en), "");
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
assert.ok(html.includes('id="rail-about"') && html.includes('id="about-update-install"') && html.includes('id="update-attention"'));
assert.ok(html.includes('id="rail-folders"') && html.includes('id="provider-panel"'));
assert.ok(html.includes("Check for updates") && html.includes("Restart and install"));
assert.ok(html.includes('id="settings"') && html.includes('id="prefs"') && html.includes("AI Setup"));
assert.ok(css.includes("#about-version") && css.includes("#prefs") && css.includes("#settings-status") && css.includes(".update-attention"));

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
assert.ok(engineSrc.includes('case "mail:downloadAttachment"'));
assert.ok(engineSrc.includes('case "mail:downloadAttachmentsZip"') && engineSrc.includes("zipFiles"));
assert.ok(engineSrc.includes('case "mail:fetchAttachmentBytes"'));
assert.ok(!engineSrc.includes("INBOX_LIMIT") && !engineSrc.includes("OTHER_LIMIT"));
assert.ok(engineSrc.includes("const REFRESH_PAGES = [20, 30, 30]"));
assert.ok(engineSrc.includes('require("../settings")'));
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
assert.ok(independentDoc.includes("compose window"));
assert.ok(parityDoc.includes("compose window"));
assert.ok(!independentDoc.includes("then the compose dialog"));
assert.ok(!parityDoc.includes("same compose dialog"));
assert.ok(!independentDoc.includes("85% of the window width"));
assert.ok(!parityDoc.includes("85% of the window width"));
assert.ok(fs.readFileSync(path.join(root, "docs/BRAIN_AGENT.md"), "utf8").includes("Drafts open in a compose window."));
assert.ok(fs.readFileSync(path.join(root, "docs/adr/2026-10-21-macos-close-hides.md"), "utf8").includes("compose window"));
assert.ok(independentDoc.includes("All Account Mail"));
assert.ok(parityDoc.includes("All Account Mail"));
assert.ok(independentDoc.includes("Unread chip"));
assert.ok(parityDoc.includes("filters this view to unread messages in those primary folders"));
assert.ok(independentDoc.includes("Gmail uses All Mail"));
assert.ok(parityDoc.includes("Gmail uses All Mail"));
assert.ok(!parityDoc.includes("filters this view to unread Inbox messages"));
assert.ok(!independentDoc.includes("All Inbox") && !parityDoc.includes("All Inbox"));
assert.ok(independentDoc.includes("All removes the date bound"));
assert.ok(independentDoc.includes("already downloaded"));
assert.ok(independentDoc.includes("last 180 days"));
assert.ok(independentDoc.includes("advertises IDLE"));
assert.ok(parityDoc.includes("Push: on"));
assert.ok(parityDoc.includes("Push: polling"));
assert.ok(parityDoc.includes("about every 25 minutes"));
assert.ok(!independentDoc.includes("last 30 days"));
assert.ok(parityDoc.includes("All by default, or 365 days, or 180 days"));
assert.ok(parityDoc.includes("Shortening the horizon keeps mail already stored."));
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
assert.ok(html.includes('id="rail-shortcuts"') && html.includes('id="features-panel"'));
assert.ok(!html.includes('id="shortcuts-panel"'));
assert.ok(html.indexOf('id="rail-shortcuts"') < html.indexOf('id="rail-log"'));
assert.ok(html.indexOf('id="rail-log"') < html.indexOf('id="rail-about"'));
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
assert.ok(engineSrc.includes('case "mail:restoreScheduled"'));
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
for (const channel of ["mail:scheduleSend", "mail:listScheduled", "mail:cancelScheduled", "mail:restoreScheduled"]) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(appJs.includes("No scheduled mail or delivery records on this computer."));
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
assert.ok(!functionSource(appJs, "requestComposeClose").includes("saveDraft"));
assert.ok(!functionSource(appJs, "requestComposeClose").includes("draft-close-save"));
assert.ok(html.includes('id="draft-close-discard"') && html.includes('id="draft-close-keep"'));
assert.ok(!html.includes('id="draft-close-save"'));
assert.ok(html.includes('id="compose-editor"') && html.includes('aria-label="Bold"') && html.includes('aria-label="Underline"'));
assert.ok(html.includes('aria-label="Italic"') && html.includes('aria-label="Bulleted list"') && html.includes('aria-label="Numbered list"'));
assert.ok(css.includes("min(85vw, calc(100vw - 24px))"));
const htmlCompose = loadFunctions(appJs, ["joinComposeHtml", "plainFromComposeHtml", "splitComposeSignature", "blankComposeHtml"]);
assert.strictEqual(htmlCompose.joinComposeHtml("<p>Hi</p>", "Quoted"), "<p>Hi</p><br><br>Quoted");
assert.strictEqual(htmlCompose.joinComposeHtml("", "Quoted"), "Quoted");
assert.strictEqual(htmlCompose.joinComposeHtml("<p>Hi</p>", ""), "<p>Hi</p>");
assert.strictEqual(htmlCompose.plainFromComposeHtml("<p>Hi <strong>there</strong></p><ul><li>One</li></ul>"), "Hi there\nOne");
assert.ok(!htmlCompose.plainFromComposeHtml("<script>alert(1)</script><p>Safe</p>").includes("alert"));
assert.strictEqual(htmlCompose.blankComposeHtml("<br>"), true);
assert.strictEqual(htmlCompose.blankComposeHtml("<div><br></div>"), true);
assert.strictEqual(htmlCompose.blankComposeHtml("<p>Hi</p>"), false);
assert.deepStrictEqual(htmlCompose.splitComposeSignature("Hello\n\nAda", "Ada"), { message: "Hello", signature: "Ada" });
assert.deepStrictEqual(htmlCompose.splitComposeSignature("Hello\n\nAda\n\nps", "Ada"), { message: "Hello\n\nAda\n\nps", signature: "" });
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
const readerActions = functionSource(appJs, "renderActions");
assert.ok(readerActions.includes('readerButton("suggest", "Suggest"'));
assert.ok(readerActions.includes("reply, replyAll, suggest, forward"));
assert.equal(functionSource(appJs, "renderSuggestions").includes("loadSuggestions"), false);
assert.equal(functionSource(appJs, "renderReader").includes("loadSuggestions"), false);
assert.equal(functionSource(appJs, "renderReader").includes("requestReplySuggestions"), false);
assert.equal(functionSource(appJs, "openMessage").includes("replySuggestions"), false);
assert.ok(functionSource(appJs, "requestReplySuggestions").includes("loadSuggestions(email)"));
assert.ok(functionSource(appJs, "loadSuggestions").includes("aiDraftWrite:replySuggestions"));
assert.ok(appJs.includes("No reply suggestions."));
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
  "replyThreadEmail",
  "defaultAiMode",
  "replyThreadPrompt",
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
assert.strictEqual(ai.draftBlockReason("custom", "", "", { subject: "Hi" }), "");
assert.strictEqual(ai.draftBlockReason("reply", "", "", null), "Reply from thread needs the original message.");
assert.strictEqual(ai.draftBlockReason("reply", "", "", { subject: "Hi" }), "");
assert.strictEqual(ai.draftBase("reply", "Hello"), "");
const replySource = { subject: "Notes", from: "Ada" };
assert.strictEqual(ai.replyThreadEmail({ kind: "reply", quoteEmail: replySource }), replySource);
assert.strictEqual(ai.replyThreadEmail({ kind: "forward", quoteEmail: replySource }), null);
assert.strictEqual(ai.replyThreadEmail({ kind: "reply", quote: "  " }), null);
assert.strictEqual(ai.replyThreadEmail({ kind: "all", quote: "See you", subject: "Re: Notes" }).subject, "Notes");
assert.strictEqual(ai.defaultAiMode({ kind: "reply", quoteEmail: replySource }), "reply");
assert.strictEqual(ai.defaultAiMode({ kind: "forward", quoteEmail: replySource }), "rewrite");
assert.strictEqual(ai.defaultAiMode({}), "rewrite");
assert.strictEqual(ai.replyThreadPrompt("  keep it warm  "), "keep it warm");
assert.match(ai.replyThreadPrompt(""), /comprehensive reply/);
assert.strictEqual(ai.draftInstruction("reply", "keep it warm", "Hello", "Re: Hi", { subject: "Hi", from: "Ada", textBody: "See you" }).user_prompt, "keep it warm");
assert.match(ai.draftInstruction("reply", "", "Hello", "Re: Hi", { subject: "Hi", from: "Ada", textBody: "The brass gears mesh." }).user_prompt, /comprehensive reply/);
assert.match(ai.draftInstruction("reply", "", "", "Re: Hi", { subject: "Hi", from: "Ada", textBody: "The brass gears mesh." }).email.text_body, /brass gears/);
assert.strictEqual(ai.shownDraft({ pending: true, text: "Hello", base: "", previous: "Old\n\nSig", signatureTail: "Sig" }), "Hello\n\nSig");
assert.strictEqual(ai.shownDraft({ pending: true, text: "", base: "", previous: "Old\n\nSig", signatureTail: "Sig" }), "Old\n\nSig");
assert.strictEqual(ai.draftInstruction("custom", "", "", "Re: Hi", { subject: "Hi", from: "Ada", textBody: "See you" }).user_prompt, "Write a reply.");
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
assert.strictEqual(suggestMail.text_body, "longer"); // Prefer MIME plain text for AI/quotes.
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
assert.ok(html.includes('id="compose-ai-open"') && html.includes('aria-label="Write with AI"') && html.includes('id="compose-ai-popover"'));
assert.ok(html.includes("Reply from thread") && html.includes('id="compose-schedule-tools"'));
assert.ok(!html.includes('id="compose-ai-tools"') && !html.includes("compose-tools-grid"));
assert.ok(appJs.includes("function openComposeAi(") && appJs.includes("function replyThreadEmail("));
assert.ok(appJs.includes("cancel.hidden = false"));
assert.ok(!appJs.includes("compose-ai-tools"));
assert.ok(css.includes(".compose-ai-popover") && css.includes("#compose-ai-open") && css.includes(".ai-write.open"));
assert.ok(html.includes('id="compose-attach"') && html.includes('id="compose-file"') && html.includes("multiple") && html.includes('id="compose-attachments"'));
assert.ok(html.includes('id="compose-suggestions"') && html.includes('id="compose-suggest-list"') && html.includes('id="compose-preview-files"'));
assert.ok(html.includes("Attach files") && html.includes("Suggested replies"));
assert.ok(appJs.includes("mail:uploadAttachment") && preload.includes("mail:uploadAttachment"));
assert.ok(engineSrc.includes("resolveAttachments") && engineSrc.includes("Could not read"));
assert.ok(settingsSrc.includes("aiWriteAutoOpenOnReply: true"));
const attachUi = loadFunctions(appJs, [
  "composeFileMeta",
  "composeAttachmentList",
  "attachmentPayload",
  "attachmentKey",
  "attachmentLimitCopy",
  "attachmentCapCopy",
  "fileSize",
  "reviewComposeFiles",
  "composeDragFiles",
  "outgoingBody",
  "previewDraft",
  "replySuggestionSource",
  "splitComposeSignature",
  "suggestedReplyBody",
]);
const localFile = { id: "blob-1", storageUrl: "local:blob-1", filename: "notes.txt", mimeType: "text/plain", size: 12 };
assert.deepStrictEqual(attachUi.composeAttachmentList([localFile, { filename: "remote.txt" }, localFile]), [localFile]);
assert.deepStrictEqual(attachUi.attachmentPayload([localFile]), [{
  storageUrl: "local:blob-1",
  filename: "notes.txt",
  mimeType: "text/plain",
  size: 12,
  id: "blob-1",
}]);
assert.strictEqual(attachUi.attachmentKey([localFile, { storageUrl: "imap:1" }]), "local:blob-1");
const cap = 25 * 1024 * 1024;
assert.strictEqual(attachUi.reviewComposeFiles([], [{ name: "empty.txt", size: 0 }], "gmail").errors[0], "empty.txt is empty.");
assert.match(attachUi.reviewComposeFiles([], [{ name: "big.bin", size: cap + 1 }], "gmail").errors[0], /big\.bin is 25\.0 MB\. Gmail rejects messages larger than 25 MB\./);
assert.match(attachUi.reviewComposeFiles(
  [{ storageUrl: "local:a", filename: "a.txt", size: cap - 10 }],
  [{ name: "b.txt", size: 20 }],
  "outlook",
).errors[0], /together\. Outlook rejects/);
assert.deepStrictEqual(attachUi.reviewComposeFiles([], [{ name: "ok.txt", size: 4 }, { name: "ok.txt", size: 4 }], "").accepted, [
  { index: 0, filename: "ok.txt", size: 4 },
  { index: 1, filename: "ok.txt", size: 4 },
]);
assert.strictEqual(attachUi.composeDragFiles(null), null);
assert.strictEqual(attachUi.composeDragFiles({ types: ["text/plain"], files: [{ name: "note.txt" }] }), null);
assert.deepStrictEqual(attachUi.composeDragFiles({ types: ["Files"], files: [] }), []);
assert.deepStrictEqual(attachUi.composeDragFiles({ types: ["text/plain", "Files"], files: [{ name: "a.txt" }, { name: "b.txt" }] }).map((file) => file.name), ["a.txt", "b.txt"]);
assert.ok(functionSource(appJs, "onComposeDrop").includes("addComposeFiles"));
assert.ok(functionSource(appJs, "wireComposeFileDrop").includes('addEventListener("drop"'));
assert.ok(css.includes("#compose-editor.drop-target"));
assert.ok(parityDoc.includes("Dropping files on the message field") && independentDoc.includes("Dropping files on the message field"));
const preview = attachUi.previewDraft({ to: "ada@example.com", subject: "Notes", body: "See file" }, "", null, [localFile]);
assert.deepStrictEqual(preview.attachments, [{ filename: "notes.txt", size: 12 }]);
assert.strictEqual(preview.kind, "send");
assert.strictEqual(attachUi.replySuggestionSource({ kind: "forward", quoteEmail: { subject: "Hi" } }), null);
assert.strictEqual(attachUi.replySuggestionSource({ kind: "reply", quoteEmail: { subject: "Hi" } }).subject, "Hi");
assert.strictEqual(attachUi.suggestedReplyBody("Hello\n\nThanks, Ada", "Thanks, Ada", "I can review it."), "I can review it.\n\nThanks, Ada");
assert.ok(parityDoc.includes("mail:uploadAttachment") && parityDoc.includes("That preference defaults to on."));
assert.ok(independentDoc.includes("AI write on reply defaults to on"));
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
assert.ok(html.includes('class="brain-summary"') && html.includes('id="brain-persona-hint"') && html.includes("Refresh distills the living profile."));
assert.ok(css.includes(".brain-summary") && css.includes(".brain-meta[hidden]"));
{
  const profileStart = html.indexOf('id="brain-profile"');
  const profileEnd = html.indexOf('id="brain-categories"');
  const profileHtml = html.slice(profileStart, profileEnd);
  assert.ok(profileHtml.indexOf('class="brain-summary"') < profileHtml.indexOf('id="brain-meta"'));
  assert.ok(profileHtml.indexOf('id="brain-meta"') < profileHtml.indexOf('id="brain-status"'));
  assert.ok(profileHtml.indexOf('id="brain-status"') < profileHtml.indexOf('id="brain-refresh"'));
  assert.ok(profileHtml.indexOf('id="brain-refresh"') < profileHtml.indexOf('id="brain-rebuild"'));
  assert.ok(profileHtml.indexOf('id="brain-rebuild"') < profileHtml.indexOf('id="brain-sections"'));
  assert.ok(profileHtml.indexOf('id="brain-sections"') < profileHtml.indexOf('id="brain-rule-form"'));
  assert.ok(!profileHtml.slice(profileHtml.indexOf('id="brain-rule-form"')).includes("brain-refresh"));
  assert.ok(!profileHtml.slice(profileHtml.indexOf('id="brain-rule-form"')).includes("brain-rebuild"));
}
assert.ok(html.includes(">Profile<") && html.includes(">Categories<") && html.includes(">Skills<"));
assert.ok(html.includes(">Brain<") && html.includes(">Add<") && html.includes("Writing rule"));
assert.ok(html.includes('id="brain-category-list"') && html.includes('id="brain-category-name"') && html.includes('id="brain-category-description"'));
assert.ok(html.includes('id="brain-category-collapse"') && html.includes('id="brain-category-save"') && html.includes('id="brain-category-ai"'));
assert.ok(html.includes('id="brain-skills"') && html.includes('id="brain-home-skills"') && html.includes('id="brain-library-skills"') && html.includes('id="brain-skill-status"'));
assert.ok(html.includes('id="brain-skill-dialog"') && html.includes('id="brain-skill-dialog-title"') && html.includes('id="settings-tab-compose"') && html.includes('id="settings-compose"'));
assert.ok(html.includes('id="brain-skill-new"') && html.includes('id="agent-skill-new"') && html.includes('id="custom-skill-form"'));
assert.ok(html.includes('id="custom-skill-name"') && html.includes('id="custom-skill-instruction"') && html.includes('id="custom-skill-save"'));
assert.ok(appJs.includes("emailBrain:saveCustomSkill") && appJs.includes("emailBrain:deleteCustomSkill"));
assert.ok(functionSource(appJs, "paintBrainSkillDialog").includes("setCustomSkillEditor"));
assert.ok(html.includes("Compose defaults live in") && html.includes('id="brain-open-compose-settings"'));
const brainProfileHtml = html.slice(html.indexOf('id="brain-profile"'), html.indexOf('id="brain-categories"'));
assert.ok(!brainProfileHtml.includes('id="brain-compose-form"') && !brainProfileHtml.includes("<summary>Compose defaults and aliases</summary>"), "compose form leaves Brain profile");
assert.ok(brainProfileHtml.includes('id="brain-open-compose-settings"'));
const composePanelHtml = html.slice(html.indexOf('id="settings-compose"'), html.indexOf('id="settings-ooo"'));
assert.ok(composePanelHtml.includes('id="brain-compose-form"') && composePanelHtml.includes('id="brain-compose-bcc"') && composePanelHtml.includes('id="brain-compose-from"') && composePanelHtml.includes('id="brain-compose-aliases"'));
assert.ok(html.indexOf('id="settings-tab-mailbox"') < html.indexOf('id="settings-tab-compose"') && html.indexOf('id="settings-tab-compose"') < html.indexOf('id="settings-tab-ai"'));
assert.ok(!functionSource(appJs, "paintBrainSkillList").includes("appendSkillSchedule"), "Brain skill cards do not inline the schedule editor");
assert.ok(functionSource(appJs, "paintBrainSkillDialog").includes("appendSkillSchedule"));
assert.ok(functionSource(appJs, "paintBrainSkillList").includes('textContent = "Manage"') && functionSource(appJs, "paintBrainSkillList").includes("brain-skill-chip"));
assert.ok(appJs.includes('revealSettingsFold("compose")') && appJs.includes("Loading compose defaults"));
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
  "skillStatusChip",
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
assert.deepStrictEqual(agentUi.skillStatusChip({ schedule: "disabled", runMode: "on_demand" }, "run"), { label: "On demand", tone: "demand" });
assert.deepStrictEqual(agentUi.skillStatusChip({ schedule: "paused", paused: true, kind: "interval", everyMinutes: 30 }, "run"), { label: "Paused", tone: "paused" });
assert.deepStrictEqual(agentUi.skillStatusChip({ schedule: "interval", kind: "interval", everyMinutes: 30 }, "run"), { label: "Every 30 min", tone: "scheduled" });
assert.deepStrictEqual(agentUi.skillStatusChip({ schedule: "cron", kind: "cron", cron: "0 8 * * 1-5" }, "run"), { label: "Cron", tone: "scheduled" });
assert.deepStrictEqual(agentUi.skillStatusChip({ schedule: "disabled" }, "install"), { label: "Not installed", tone: "library" });
assert.strictEqual(agentUi.scheduleFormValue({ kind: "off" }).action, "delete");
assert.strictEqual(agentUi.scheduleFormValue({ kind: "interval", everyMinutes: 15 }).everyMinutes, 15);
assert.strictEqual(agentUi.scheduleFormValue({ kind: "interval", everyMinutes: 0 }).error.includes("10080"), true);
assert.strictEqual(agentUi.scheduleFormValue({ kind: "cron", cron: "  0   8 * * 1-5  " }).cron, "0 8 * * 1-5");
assert.ok(agentUi.scheduleFormValue({ kind: "cron", cron: "   " }).error);
const draftUi = loadFunctions(appJs, ["customSkillDraft"]);
assert.strictEqual(draftUi.customSkillDraft({ name: "  ", instruction: "Hi" }).error, "A skill needs a name.");
assert.strictEqual(draftUi.customSkillDraft({ name: "Desk", instruction: "  " }).error, "A skill needs an instruction.");
assert.strictEqual(draftUi.customSkillDraft({ name: "n".repeat(81), instruction: "Hi" }).error.includes("80"), true);
assert.strictEqual(draftUi.customSkillDraft({ name: "Desk", description: "d".repeat(241), instruction: "Hi" }).error.includes("240"), true);
assert.strictEqual(draftUi.customSkillDraft({ name: "Desk", instruction: "i".repeat(4001) }).error.includes("4000"), true);
const draftedSkill = draftUi.customSkillDraft({
  skillId: " user:abc ",
  name: " Desk ",
  description: " Overnight ",
  instruction: " Summarize.\n",
  calendar: true,
  person: false,
  moves: true,
});
assert.strictEqual(draftedSkill.name, "Desk");
assert.strictEqual(draftedSkill.description, "Overnight");
assert.strictEqual(draftedSkill.instruction, "Summarize.");
assert.strictEqual(draftedSkill.calendar, true);
assert.strictEqual(draftedSkill.person, false);
assert.strictEqual(draftedSkill.moves, true);
assert.strictEqual(draftedSkill.skillId, "user:abc");
assert.ok(!draftUi.customSkillDraft({ name: "Desk", instruction: "Hi" }).skillId);
assert.ok(appJs.includes("emailBrain:setSkillSchedule") && appJs.includes("emailBrain:deleteSkillSchedule"));
assert.ok(appJs.includes("emailBrain:scheduleFired") && appJs.includes('textContent = paused ? "Resume" : "Pause"'));
assert.ok(appJs.includes('textContent = "Save schedule"'));
assert.ok(main.includes("startSkillScheduler"));
const requestUi = loadFunctions(appJs, [
  "skillIdOf",
  "isLive",
  "agentContact",
  "agentContextCopy",
  "agentMessageContext",
  "agentReadIntent",
  "agentTodoActionNames",
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
assert.strictEqual(requestUi.skillRequest({ id: "user:1", person: true }, { contact: "ada@example.com" }).contactEmail, "ada@example.com");
assert.ok(!requestUi.skillRequest({ id: "user:1" }, { contact: "ada@example.com" }).contactEmail);
assert.match(requestUi.agentContextCopy(null), /No message is open/);
assert.match(requestUi.agentContextCopy({ id: "m1", from: "Ada", subject: "Hi" }), /Ada — Hi/);
assert.strictEqual(requestUi.agentMessageContext(null), null);
assert.strictEqual(requestUi.agentMessageContext({ summary: "No mail" }), null);
assert.deepStrictEqual(requestUi.agentMessageContext({ messageId: " m1 ", accountId: "acct" }), {
  messageId: "m1",
  accountId: "acct",
});
assert.strictEqual(requestUi.agentReadIntent({ summary: "No mail" }), "skip");
assert.strictEqual(requestUi.agentReadIntent({ messageId: "m1", unread: false }), "already");
assert.strictEqual(requestUi.agentReadIntent({ messageId: "m1", unread: true }), "mark");
assert.deepStrictEqual(requestUi.agentTodoActionNames({ summary: "Note" }), []);
assert.deepStrictEqual(requestUi.agentTodoActionNames({ messageId: "m1" }), [
  "Open", "Reply", "Reply All", "Mark as read", "Mark todo done", "Dismiss",
]);
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
assert.ok(html.includes('id="agent-peek"') && !html.includes('id="agent-open"') && !html.includes('id="agent-mail"'));
assert.ok(!functionSource(appJs, "peekMessage").includes("showMail"));
assert.ok(functionSource(appJs, "openPeekInMail").includes("showMail"));
assert.ok(!appJs.includes("Done and Dismiss only update this local Agent list. They do not archive, delete, or reply."));
assert.ok(appJs.includes("Mark todo done and Dismiss only update this local Agent list. They do not archive, delete, mark read, or reply."));
assert.ok(appJs.includes('agentActionButton("open", "Open"') && appJs.includes('agentActionButton("reply", "Reply"'));
assert.ok(appJs.includes('agentActionButton("reply-all", "Reply All"') && appJs.includes('agentActionButton("read", "Mark as read"'));
assert.ok(appJs.includes('agentActionButton("done", "Mark todo done"') && appJs.includes('agentActionButton("dismiss", "Dismiss"'));
assert.ok(functionSource(appJs, "replyToAgentItem").includes("presentCompose"));
assert.ok(functionSource(appJs, "presentCompose").includes("openComposeWindow"));
assert.ok(preload.includes('"compose:open"') && preload.includes("compose:requestClose"));
assert.ok(html.includes("compose-role.js") && css.includes('html[data-window="compose"]') && css.includes("button.agent-action"));
assert.ok(main.includes("createComposeHost") && !ipcSrc.includes("host:openComposeWindow"));
assert.ok(!appJs.includes("host:openComposeWindow") && !html.includes("surface.js"));
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
assert.ok(appJs.includes('["shell", "calendar-panel", "agent-panel", "brain", "provider-panel", "log-panel", "features-panel"]') && appJs.includes("nativeAgent:home:todosCached"));
assert.ok(!appJs.includes('["shell", "calendar-panel", "agent-panel", "brain", "provider-panel", "log-panel", "shortcuts-panel"]'));
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
assert.ok(brainDoc.includes("custom-skills.json") && brainDoc.includes("emailBrain:saveCustomSkill") && brainDoc.includes("emailBrain:deleteCustomSkill"));
assert.ok(parity.includes("emailBrain:saveCustomSkill") && parity.includes("custom-skills.json"));
assert.ok(independentDoc.includes("emailBrain:saveCustomSkill") && independentDoc.includes("custom-skills.json"));
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
assert.ok(parity.includes("Settings → Compose") && parity.includes("Manage opens a dialog"));
assert.ok(independentDoc.includes("Settings → Compose") && independentDoc.includes("Manage opens a dialog"));
assert.ok(brainDoc.includes("Settings → **Compose**") || brainDoc.includes("Settings → Compose"));
assert.ok(parity.includes("config:setTheme") && parity.includes("morrow:configSetSnoozeEffective"));
assert.ok(!parity.includes("the list is read-only"));
assert.ok(!parity.includes("full Brain category/skills UI"));
assert.ok(parity.includes("mail:upsertSignature") && parity.includes("defaultSignaturePerAccount"));
assert.ok(parity.includes("Opening the dialog checks HTML") && parity.includes("text color and highlight when compose inserts it"));
assert.ok(independentDoc.includes("Opening Signatures checks HTML"));
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
  "providerColumns",
  "providerFilterReveal",
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
  "isAllMailFolder",
  "imapParent",
  "folderTree",
  "providerParent",
  "providerLabelText",
  "providerLabelTree",
  "messageDragPayload",
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
global.morrowMailboxRoles = require("../shared/mailbox-roles");
const folderCollapse = require("../shared/folder-collapse");
assert.strictEqual(global.morrowMailboxRoles.allMailLabel({ path: "[Gmail]/All Mail", name: "[Gmail]/All Mail" }), "All Mail");
assert.strictEqual(global.morrowMailboxRoles.allMailLabel({ path: "[Gmail]/All Mail", name: "All Mail", wellKnownName: "all" }), "All Mail");
assert.strictEqual(global.morrowMailboxRoles.allMailLabel({ path: "[Gmail]/All Mail", name: "Tous les messages", well_known: "all" }), "Tous les messages");
assert.strictEqual(global.morrowMailboxRoles.allMailLabel({ path: "Everything", name: "Everything", well_known: "all" }), "Everything");
assert.strictEqual(organizeUi.isAllMailFolder({ id: "[Gmail]/All Mail", name: "All Mail" }), true);
assert.strictEqual(organizeUi.isAllMailFolder({ id: "All Mail", name: "All Mail" }), false);
assert.deepStrictEqual(organizeUi.folderTree([
  { id: "[Gmail]/All Mail", name: "All Mail", wellKnownName: "all" },
  { id: "INBOX", name: "Inbox", wellKnownName: "inbox" },
  { id: "[Gmail]", name: "[Gmail]" },
  { id: "[Gmail]/Sent Mail", name: "Sent Mail" },
  { id: "All Mail", name: "All Mail" },
]).map((folder) => [folder.id, folder.depth, folder.parentId]), [
  ["[Gmail]/All Mail", 0, ""],
  ["INBOX", 0, ""],
  ["[Gmail]", 0, ""],
  ["[Gmail]/Sent Mail", 1, "[Gmail]"],
  ["All Mail", 0, ""],
]);
const ariesTree = [
  { id: "AriesCPA.com", parentId: "", unreadCount: 84, depth: 0 },
  { id: "AriesCPA.com/1 Internal", parentId: "AriesCPA.com", unreadCount: 1, depth: 1 },
  { id: "AriesCPA.com/AsiaBs", parentId: "AriesCPA.com", unreadCount: 2, depth: 1 },
  { id: "AriesCPA.com/AsiaBs/Q1", parentId: "AriesCPA.com/AsiaBs", unreadCount: 3, depth: 2 },
  { id: "AriesCPA.com/1 Archive", parentId: "AriesCPA.com", unreadCount: 0, depth: 1 },
  { id: "INBOX", parentId: "", unreadCount: 4, depth: 0 },
];
const ariesOpen = folderCollapse.visibleRows(ariesTree, {}, "leo");
assert.strictEqual(ariesOpen.length, 6);
assert.strictEqual(ariesOpen[0].hasChild, true);
assert.strictEqual(ariesOpen[0].expanded, true);
assert.strictEqual(ariesOpen[0].unreadCount, 84);
const ariesShut = folderCollapse.visibleRows(ariesTree, { leo: ["AriesCPA.com"] }, "leo");
assert.deepStrictEqual(ariesShut.map((folder) => folder.id), ["AriesCPA.com", "INBOX"]);
assert.strictEqual(ariesShut[0].expanded, false);
assert.strictEqual(ariesShut[0].unreadCount, 84);
assert.deepStrictEqual(folderCollapse.visibleRows(ariesTree, { leo: ["AriesCPA.com/AsiaBs"] }, "leo").map((folder) => folder.id), [
  "AriesCPA.com",
  "AriesCPA.com/1 Internal",
  "AriesCPA.com/AsiaBs",
  "AriesCPA.com/1 Archive",
  "INBOX",
]);
const sidebarFilter = loadFunctions(appJs, ["chipLabel", "filterSidebarTree", "sidebarRowsFor"]);
const filterTree = [
  { id: "AriesCPA.com", name: "AriesCPA.com", parentId: "", depth: 0 },
  { id: "AriesCPA.com/1 Internal", name: "1 Internal", parentId: "AriesCPA.com", depth: 1 },
  { id: "AriesCPA.com/AsiaBs", name: "AsiaBs", parentId: "AriesCPA.com", depth: 1 },
  { id: "AriesCPA.com/AsiaBs/Q1", name: "Q1", parentId: "AriesCPA.com/AsiaBs", depth: 2 },
  { id: "INBOX", name: "INBOX", parentId: "", depth: 0 },
  { id: "HKBSCL.com", name: "HKBSCL.com", parentId: "", depth: 0 },
];
assert.deepStrictEqual(sidebarFilter.filterSidebarTree(filterTree, "  ").map((folder) => folder.id), filterTree.map((folder) => folder.id));
assert.deepStrictEqual(sidebarFilter.filterSidebarTree(filterTree, "asia").map((folder) => folder.id), [
  "AriesCPA.com",
  "AriesCPA.com/AsiaBs",
]);
assert.deepStrictEqual(sidebarFilter.filterSidebarTree(filterTree, "ASIA").map((folder) => [folder.id, folder.filterMatch]), [
  ["AriesCPA.com", false],
  ["AriesCPA.com/AsiaBs", true],
]);
assert.deepStrictEqual(sidebarFilter.filterSidebarTree(filterTree, "q1").map((folder) => folder.id), [
  "AriesCPA.com",
  "AriesCPA.com/AsiaBs",
  "AriesCPA.com/AsiaBs/Q1",
]);
assert.deepStrictEqual(sidebarFilter.filterSidebarTree(filterTree, "nomatch"), []);
assert.ok(sidebarFilter.filterSidebarTree(filterTree, "inbox").some((folder) => folder.id === "INBOX" && folder.filterMatch === true));
assert.deepStrictEqual(sidebarFilter.sidebarRowsFor(filterTree, "leo", { leo: ["AriesCPA.com"] }, "q1", folderCollapse).map((folder) => [folder.id, folder.hasChild, folder.expanded, folder.filtering]), [
  ["AriesCPA.com", true, true, true],
  ["AriesCPA.com/AsiaBs", true, true, true],
  ["AriesCPA.com/AsiaBs/Q1", false, false, true],
]);
assert.deepStrictEqual(sidebarFilter.sidebarRowsFor(filterTree, "leo", { leo: ["AriesCPA.com"] }, "", folderCollapse).map((folder) => folder.id), [
  "AriesCPA.com",
  "INBOX",
  "HKBSCL.com",
]);
assert.deepStrictEqual(sidebarFilter.sidebarRowsFor(filterTree, "leo", {}, "Aries", null).map((folder) => folder.id), [
  "AriesCPA.com",
]);
assert.deepStrictEqual(folderCollapse.toggle(folderCollapse.toggle({}, "leo", "AriesCPA.com"), "leo", "AriesCPA.com"), {});
assert.deepStrictEqual(folderCollapse.collapseIds({ leo: ["AriesCPA.com"] }, "leo", ["AriesCPA.com", "AriesCPA.com/AsiaBs"]), {
  leo: ["AriesCPA.com", "AriesCPA.com/AsiaBs"],
});
assert.deepStrictEqual(folderCollapse.collapseIds({}, "leo", []), {});
assert.deepStrictEqual(folderCollapse.collapseIds({}, "", ["INBOX"]), {});
const treeRows = [
  { id: "account:leo", parentId: "", hasChild: true, expanded: true },
  { id: "folder:leo:INBOX", parentId: "account:leo", hasChild: false, expanded: false },
  { id: "folder:leo:A", parentId: "account:leo", hasChild: true, expanded: true },
  { id: "folder:leo:A/1", parentId: "folder:leo:A", hasChild: false, expanded: false },
  { id: "folder:leo:B", parentId: "account:leo", hasChild: true, expanded: false },
];
const treeKey = folderCollapse.folderTreeKey;
assert.deepStrictEqual(treeKey(treeRows, 2, "ArrowDown"), { type: "move", index: 3 });
assert.deepStrictEqual(treeKey(treeRows, 2, "ArrowUp"), { type: "move", index: 1 });
assert.deepStrictEqual(treeKey(treeRows, 0, "ArrowUp"), { type: "none" });
assert.deepStrictEqual(treeKey(treeRows, 4, "ArrowDown"), { type: "none" });
assert.deepStrictEqual(treeKey(treeRows, 2, "ArrowLeft"), { type: "collapse", index: 2, id: "folder:leo:A" });
assert.deepStrictEqual(treeKey(treeRows, 4, "ArrowLeft"), { type: "move", index: 0 });
assert.deepStrictEqual(treeKey(treeRows, 1, "ArrowLeft"), { type: "move", index: 0 });
assert.deepStrictEqual(treeKey(treeRows, 0, "ArrowLeft"), { type: "collapse", index: 0, id: "account:leo" });
assert.deepStrictEqual(treeKey([{ id: "account:leo", parentId: "", hasChild: true, expanded: false }], 0, "ArrowLeft"), {
  type: "parent", index: 0, id: "account:leo",
});
assert.deepStrictEqual(treeKey(treeRows, 4, "ArrowRight"), { type: "expand", index: 4, id: "folder:leo:B" });
assert.deepStrictEqual(treeKey(treeRows, 2, "ArrowRight"), { type: "move", index: 3 });
assert.deepStrictEqual(treeKey(treeRows, 1, "ArrowRight"), { type: "none" });
assert.deepStrictEqual(treeKey(treeRows, 2, "Enter"), { type: "none" });
assert.deepStrictEqual(treeKey([], 0, "ArrowDown"), { type: "none" });
const lockedTree = [
  { id: "A", parentId: "", hasChild: true, expanded: true, collapsible: false },
  { id: "A/1", parentId: "A", hasChild: false, expanded: false },
];
assert.deepStrictEqual(treeKey(lockedTree, 0, "ArrowLeft"), { type: "parent", index: 0, id: "A" });
assert.deepStrictEqual(treeKey(lockedTree, 0, "ArrowRight"), { type: "move", index: 1 });
assert.deepStrictEqual(treeKey([{ id: "L1", parentId: "", hasChild: true, expanded: true }], 0, "ArrowLeft"), {
  type: "collapse", index: 0, id: "L1",
});
assert.deepStrictEqual(treeKey([{ id: "L1", parentId: "", hasChild: true, expanded: true }], 0, "ArrowRight"), {
  type: "child", index: 0, id: "L1",
});
assert.deepStrictEqual(treeKey([{ id: "L1", parentId: "", hasChild: true, expanded: false }], 0, "ArrowRight"), {
  type: "expand", index: 0, id: "L1",
});
assert.deepStrictEqual(treeKey([{ id: "L1", parentId: "", hasChild: true, expanded: false }], 0, "ArrowLeft"), {
  type: "parent", index: 0, id: "L1",
});
assert.ok(html.includes('id="folder-collapse-all"') && html.includes("Collapse All"));
assert.ok(css.includes(".folder-collapse-all") && css.includes("#folders [data-nav-key]:focus-visible"));
assert.ok(functionSource(appJs, "onFolderNavKey").includes("folderTreeKey"));
assert.ok(functionSource(appJs, "onProviderColumnKey").includes("folderTreeKey"));
assert.ok(functionSource(appJs, "onProviderColumnKey").includes("shellBlocked"));
assert.ok(functionSource(appJs, "folderNavNode").includes("shellBlocked"));
assert.ok(functionSource(appJs, "collapseAllFolders").includes("collapseIds"));
assert.ok(parity.includes("Collapse All"));
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
const labelPicker = loadFunctions(appJs, [
  "messageLabelKeys",
  "appliedEditableLabels",
  "labelCheckedState",
  "labelChangeForMessages",
  "filterEditableLabels",
  "labelEditCalls",
  "labelApplyConfirm",
]);
const editableLabels = [
  { id: "L1", name: "Work", label: "Work", editable: true },
  { id: "L2", name: "Work/Travel", label: "Travel", editable: true, depth: 1 },
];
assert.deepStrictEqual(labelPicker.messageLabelKeys({ folderId: "Work", folders: ["Work"] }), ["Work", "Work"]);
assert.deepStrictEqual(labelPicker.appliedEditableLabels({ id: "m1", folderId: "Work", folders: ["Work"] }, editableLabels), ["L1"]);
assert.deepStrictEqual(labelPicker.appliedEditableLabels({ id: "m1", labelIds: ["L2"], folderId: "Work" }, editableLabels), ["L2"]);
assert.deepStrictEqual(labelPicker.appliedEditableLabels({ id: "m1", labelIds: [], folderId: "Work" }, editableLabels), []);
assert.deepStrictEqual(labelPicker.appliedEditableLabels({ id: "m1", folderId: "work/travel" }, editableLabels), ["L2"]);
assert.deepStrictEqual(labelPicker.appliedEditableLabels({ id: "m1", folderId: "Travel" }, editableLabels), []);
const labelMessages = [
  { id: "m1", accountId: "a", labelIds: ["L1"] },
  { id: "m2", accountId: "a", labelIds: ["L1", "L2"] },
];
const labelMarks = labelPicker.labelCheckedState(labelMessages, editableLabels);
assert.strictEqual(labelMarks.get("L1"), "on");
assert.strictEqual(labelMarks.get("L2"), "mixed");
assert.deepStrictEqual(labelPicker.labelChangeForMessages(labelMessages, editableLabels, labelMarks, new Map(labelMarks)), []);
const labelNext = new Map(labelMarks);
labelNext.set("L1", "off");
labelNext.set("L2", "on");
const labelPlans = labelPicker.labelChangeForMessages(labelMessages, editableLabels, labelMarks, labelNext);
assert.deepStrictEqual(labelPlans.map((plan) => [plan.email.id, plan.addLabelIds, plan.removeLabelIds]), [
  ["m1", ["L2"], ["L1"]],
  ["m2", [], ["L1"]],
]);
assert.deepStrictEqual(labelPicker.filterEditableLabels(editableLabels, "  ").map((row) => row.id), ["L1", "L2"]);
assert.deepStrictEqual(labelPicker.filterEditableLabels(editableLabels, "trav").map((row) => row.id), ["L2"]);
assert.deepStrictEqual(labelPicker.filterEditableLabels(editableLabels, "nomatch"), []);
assert.deepStrictEqual(labelPicker.labelEditCalls(labelPlans), [
  {
    channel: "mail:modifyMessageLabels",
    params: { accountId: "a", emailId: "m1", addLabelIds: ["L2"], removeLabelIds: ["L1"] },
  },
  {
    channel: "mail:modifyMessageLabels",
    params: { accountId: "a", emailId: "m2", addLabelIds: [], removeLabelIds: ["L1"] },
  },
]);
const labelCopy = labelPicker.labelApplyConfirm(labelPlans, editableLabels, "2 messages from Desk.");
assert.strictEqual(labelCopy.title, "Labels");
assert.strictEqual(labelCopy.confirm, "Apply");
assert.match(labelCopy.body, /Add “Work\/Travel”/);
assert.match(labelCopy.body, /Remove “Work”/);
assert.match(labelCopy.body, /2 messages from Desk/);
assert.ok(!appJs.includes("function labelSelect("));
assert.ok(!appJs.includes("selection-add-label"));
assert.ok(!appJs.includes("selection-remove-label"));
assert.ok(appJs.includes('id="selection-labels"') || appJs.includes("selection-labels"));
assert.ok(functionSource(appJs, "renderActions").includes("besideStar.append(star)"));
assert.ok(functionSource(appJs, "renderActions").includes("renderTranslate(besideStar, email)"));
assert.ok(!functionSource(appJs, "renderReader").includes("renderTranslate("));
assert.ok(functionSource(appJs, "renderActions").includes('dataset.action = "snooze"'));
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
assert.ok(parity.includes("morrow:configSetSidebarCollapsedFolders"));
assert.ok(parity.includes("[Gmail]/All Mail"));
assert.ok(appJs.includes("folder-twist"));
assert.ok(appJs.includes("morrow:configGetSidebarCollapsedFolders"));
assert.ok(css.includes("button.folder-twist"));
assert.ok(html.includes("shared/mailbox-roles.js"));
assert.ok(html.includes("shared/primary-mailboxes.js"));
assert.ok(html.indexOf('src="../shared/mailbox-roles.js"') < html.indexOf('src="../shared/primary-mailboxes.js"'));
assert.ok(html.indexOf('src="../shared/primary-mailboxes.js"') < html.indexOf('src="./app.js"'));
assert.ok(html.includes("shared/folder-collapse.js"));
assert.ok(independentDoc.includes("Right-click"));
assert.ok(independentDoc.includes("Drag a message row"));
const folderChrome = loadFunctions(appJs, [
  "folderDelimiter",
  "nestRows",
  "isAllMailFolder",
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
const unreadNest = folderChrome.folderCanNest("imap", {
  name: "Unread",
  type: "virtual",
  filterCopy: "Unread is a filter, not a folder.",
});
assert.strictEqual(unreadNest.ok, false);
assert.match(unreadNest.reason, /Unread/);
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
const shortcuts = loadFunctions(appJs, [
  "shortcutPlatform",
  "shortcutMod",
  "shortcutChord",
  "shortcutNote",
  "shortcutCatalog",
  "mailShortcut",
]);
assert.strictEqual(shortcuts.shortcutPlatform("MacIntel"), "mac");
assert.strictEqual(shortcuts.shortcutPlatform("Linux x86_64"), "other");
assert.strictEqual(shortcuts.shortcutPlatform("Win32"), "other");
const macKeys = shortcuts.shortcutCatalog("MacIntel").map((row) => row.keys);
const winKeys = shortcuts.shortcutCatalog("Win32").map((row) => row.keys);
for (const key of ["⌘N", "R", "A", "F", "⌘Enter", "⌘S", "⌘F or /", "⌘,", "Delete or Backspace", "Esc"]) {
  assert.ok(macKeys.includes(key), key);
}
for (const key of ["Ctrl+N", "Ctrl+Enter", "Ctrl+S", "Ctrl+F or /", "Ctrl+,", "Ctrl+0", "Ctrl++ or Ctrl+−"]) {
  assert.ok(winKeys.includes(key), key);
}
assert.ok(!macKeys.some((key) => key === "⌘R" || key === "Ctrl+R" || key.includes("Shift")));
assert.ok(!winKeys.some((key) => key === "Ctrl+R" || key === "⌘R"));
assert.match(shortcuts.shortcutNote("MacIntel"), /⌘R stays View/);
assert.match(shortcuts.shortcutNote("Win32"), /Ctrl\+R stays View/);
assert.match(shortcuts.shortcutNote("Linux x86_64"), /Zoom stays on the View menu/);
assert.strictEqual(shortcuts.shortcutCatalog("Win32").length, 15);
const cli = loadFunctions(appJs, ["cliNote", "cliCatalog"]);
assert.match(cli.cliNote(), /checkout of this repo/);
assert.match(cli.cliNote(), /no morrow command/);
assert.match(cli.cliNote(), /Copy does not run the command/);
const cliRows = cli.cliCatalog();
assert.deepStrictEqual([...new Set(cliRows.map((row) => row.group))], ["Run", "Check", "Package", "Verify", "Bot bridge", "Tailscale Serve"]);
for (const row of cliRows) {
  assert.equal(typeof row.command, "string");
  assert.ok(row.command.length > 0, row.group);
  assert.ok(row.action.length > 0, row.command);
  assert.ok(!/(^|\s)--help(\s|$)/.test(row.command), row.command);
  assert.ok(!/(^|\s)--token(\s|$)/.test(row.command), row.command);
  assert.ok(!/^morrow(\s|$)/.test(row.command), row.command);
}
function squashCliDoc(text) {
  return text.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
}
const cliDocs = squashCliDoc([
  fs.readFileSync(path.join(root, "README.md"), "utf8"),
  fs.readFileSync(path.join(root, "docs/INDEPENDENT_UI.md"), "utf8"),
  fs.readFileSync(path.join(root, "docs/PACKAGING.md"), "utf8"),
  fs.readFileSync(path.join(root, "docs/UPDATER_TEST.md"), "utf8"),
  fs.readFileSync(path.join(root, "docs/BOT_BRIDGE.md"), "utf8"),
  fs.readFileSync(path.join(root, "scripts/morrow-bot-call.js"), "utf8"),
].join("\n"));
for (const row of cliRows) {
  const command = row.command;
  if (cliDocs.includes(command)) continue;
  const npmRun = /^npm run ([^\s]+)$/.exec(command);
  if (npmRun) {
    assert.ok(pkg.scripts[npmRun[1]], command);
    continue;
  }
  const morrowAsar = command.startsWith("MORROW_ASAR=/absolute/path/to/app.asar npm start");
  assert.ok(morrowAsar && cliDocs.includes("MORROW_ASAR=/absolute/path/to/app.asar") && cliDocs.includes("npm start"), command);
}
assert.strictEqual(pkg.scripts.pack, "electron-builder --dir");
assert.strictEqual(pkg.scripts.dist, "electron-builder");
assert.strictEqual(pkg.scripts["dist:mac"], "electron-builder --mac dir zip");
assert.strictEqual(pkg.scripts["dist:win"], "electron-builder --win nsis portable --x64");
assert.strictEqual(pkg.scripts["dist:unsigned"], "CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac dir zip");
assert.strictEqual(pkg.scripts["publish:github"], "electron-builder --publish always");
assert.strictEqual(pkg.scripts["bot:call"], "node scripts/morrow-bot-call.js");
assert.ok(cliRows.some((row) => row.command === "npm install" && row.group === "Run"));
assert.ok(cliRows.some((row) => row.command === "npm start"));
assert.ok(cliRows.some((row) => row.command === "npm run check"));
assert.ok(cliRows.some((row) => row.command.includes("--operation bridge.describe")));
assert.ok(cliRows.some((row) => row.command.includes("--operation mail.send") && row.command.includes("--request-id '<uuid>'")));
assert.ok(cliRows.some((row) => row.command === "tailscale serve status --json"));
assert.doesNotMatch(functionSource(appJs, "paintShortcuts"), /paintCli\(\)/);
const showFeaturesSource = functionSource(appJs, "showFeatures");
assert.match(showFeaturesSource, /paintFeatureCatalog\(\)/);
assert.match(showFeaturesSource, /paintShortcuts\(\)/);
assert.match(showFeaturesSource, /paintCli\(\)/);
assert.match(showFeaturesSource, /showFeaturesTab\("catalog"\)/);
const showPrimarySource = functionSource(appJs, "showPrimary");
assert.match(showPrimarySource, /view === "shortcuts"/);
assert.match(showPrimarySource, /id === "shortcuts-panel"/);
assert.match(showPrimarySource, /"features-panel"/);
assert.match(functionSource(appJs, "onShellKey"), /state\.view !== "mail"/);
assert.ok(html.includes('id="cli-list"') && html.includes('id="cli-note"') && html.includes('id="cli-title"') && html.includes('id="cli-copy-status"'));
assert.ok(html.indexOf('id="shortcuts-list"') < html.indexOf('id="cli-list"'));
assert.ok(html.indexOf('id="cli-list"') < html.indexOf('id="log-panel"'));
assert.ok(html.includes('aria-labelledby="shortcuts-title"') && html.includes('aria-labelledby="cli-title"'));
assert.ok(css.includes(".cli-head") && css.includes(".cli-row") && css.includes(".cli-command"));
assert.ok(css.includes(".features-tabs") && css.includes(".feature-card"));
assert.match(independentDoc, /The CLI tab lists the checkout commands/);
assert.match(parityDoc, /CLI tab for the checkout/);
const railFeatures = html.slice(html.indexOf('id="rail-shortcuts"'), html.indexOf('id="rail-log"'));
assert.ok(railFeatures.includes('aria-label="Features"') && railFeatures.includes('data-label="Features"') && railFeatures.includes('title="Features"'));
assert.ok(railFeatures.includes(">Features</span>") && railFeatures.includes('viewBox="0 0 24 24"') && railFeatures.includes("M7 16h10"));
assert.ok(html.includes('id="features-tabs"') && html.includes('id="features-tab-catalog"') && html.includes('id="features-tab-shortcuts"') && html.includes('id="features-tab-cli"'));
assert.ok(html.includes('id="features-title"') && html.includes('id="features-catalog"') && html.includes('id="features-empty"') && html.includes("No features listed"));
assert.ok(html.indexOf('src="./features-catalog.js"') < html.indexOf('src="./app.js"'));
const featureCatalog = require("../renderer/features-catalog.js");
const featureSeed = [
  ["ai-connection", "ChatGPT or API key", "Agent", "AI settings preserve API keys and custom endpoints, and add Continue with ChatGPT for eligible plans. Browser sign-in uses Morrow Mail's own registered client, automatic loopback and optional one-time paste-back. Cancel, timeout, account selection, reauthorization and sign-out are available. Cancellation permits a fresh retry without waiting for an old discovery response; obsolete attempts cannot change the new one. Save keeps newer edits unsaved, and connection test results apply only to the current settings. Fetch account-specific models before choosing one. AI data permission discloses mail, calendar, drafts, profile and conversation context and the saved destination before an affirmative choice. Existing API and ChatGPT connections start with AI data use off. Saving a key or signing in is not consent. Explicit AI actions need approval; Background profile refresh, page-open triage, compose-open reply suggestions and scheduled skills need separate background opt-in. Destination, model, account and material data-use changes need fresh permission. Cancel / revoke stops queued and active AI requests; data already delivered cannot be recalled. ChatGPT requests set store: false; no retention or training guarantee is made. Plan, app and workspace limits apply; Manage usage opens ChatGPT settings. No automatic billing fallback, provider switching, extra allowance, hosted tools or general proxy. Credentials stay encrypted on this computer; unlocked OS secure storage is required. Native and live sign-in validation remains pending."],
  ["email-brain", "Email Brain", "Agent", "Profile, categories, skills, and inbox rules built from your mail. Skills can draft a reply or propose a move. You still press Send."],
  ["agent-triage", "Agent triage", "Agent", "Files recent inbox mail into your Brain categories and stacks todos. Reply opens a compose window. Done and Dismiss stay on this computer."],
  ["compose-window", "Compose in its own window", "Mail", "New mail, reply, forward, and drafts open in a separate window, so the mailbox stays usable. Closing that window does not send."],
  ["sender-identities", "Sender identities", "Mail", "Settings → Compose previews each exact From address and its Morrow-only display name. Verified Gmail send-as names are the default; local overrides survive refresh. Clear a name for address-only sending or reset to the default. Drafts and scheduled mail retain the selected name and address, including punctuation and Unicode in names. Bot mail.send uses these defaults. Provider sending permissions still apply; Gmail settings and OAuth scopes stay unchanged. Providers or recipient contacts may affect the delivered display."],
  ["signatures", "Signatures", "Mail", "Settings → Signatures shows Saving… and ignores repeated saves in the current editor while it waits. Switching signatures keeps the new editing target."],
  ["mail-keyboard", "Mail list keyboard navigation", "Mail", "On the Mail page, ↑ and ↓ move through messages and Enter opens the highlighted message. Focused buttons and links keep their own keys, including pagination, Sync, and Scheduled. Other pages keep their own focus."],
  ["attachment-downloads", "Attachment downloads", "Mail", "Preview, Open and Save share downloads. Complete files up to 32 MiB can be reused for five minutes while Morrow is open; larger files remain on demand. Save asks for a location first. Attachment transfers show progress and individual Cancel controls; closing Preview keeps another Save or Open running. Downloads allow 64 MiB per file and 128 MiB per ZIP, with existing provider limits. Changed identities stop reuse; reopen legacy Gmail selections. Bot access remains metadata only."],
  ["local-search", "Search on this computer", "Mail", "Toolbar search reads subject, from, and body already synced to this computer."],
  ["schedule-send", "Send later", "Mail", "Schedule send keeps the message on this computer and delivers it while Morrow is open. Quitting with a pending send asks you first. Unchanged source drafts are cleaned up after delivery; later edits stay saved."],
  ["out-of-office", "Out of Office", "Mail", "After you confirm, Settings writes a Gmail vacation reply, a Microsoft automatic reply, or an IMAP sieve script. Morrow does not send those replies itself."],
  ["imap-recovery", "IMAP connection recovery", "Mail", "Connection timeouts during IMAP sync use the usual connection-error and retry status. Inbox push falls back to polling and reconnects with backoff."],
  ["overnight-body-fill", "Full message bodies", "Mail", "Mail → Bodies shows per-mailbox body activity separately from list sync. Message requests and the listed page download as needed. While the app is awake/open, 00:00–07:00 local adds one indexed body after each background folder pass, within Mail & Sync history; trash, spam and drafts are excluded. It yields to mail work and rate limits. Activity has no whole-mailbox total or percentage. IMAP messages can remain incomplete at the 3 MiB source limit; Gmail API handles MIME parts within its response limit; attachment files stay on demand."],
  ["inbox-rules", "Inbox Automation Rules", "Mail", "Gmail filters and Outlook rules save on the provider after you grant access. Other accounts store the rule here and apply it to new Inbox mail."],
  ["multi-account", "Multiple mailboxes", "Accounts", "Connect Google, Microsoft, and IMAP mailboxes. Password reconnects save the matching login type and servers after credentials are saved; failures attempt to restore prior credentials. All Account Mail lists downloaded Gmail All Mail, or Inbox for other accounts. Disconnect invalidates queued sync and pending reconnects; server mail stays. Start a new connection after removal to add it again. Gmail Delete moves to Trash; deleting again keeps mail there. Conversation Trash acts once per Gmail message across label copies, with one membership snapshot for Undo. Verified copies leave their old labels after Trash; unrelated cached mail and unsaved edits stay. Archive removes Inbox membership even from All Mail or a search copy. Gmail draft cleanup moves old remote copies to Trash. Microsoft and other IMAP deletion behavior is unchanged. Google login remains OAuth. New Google connections use Gmail API polling/history with gmail.modify and gmail.settings.basic; Calendar is separate. Existing Google OAuth accounts migrate after review in Accounts. Cached mail and drafts stay; uncertain actions must be resolved first. A narrower request does not revoke older broad grants; Accounts shows actual saved scopes. Gmail API cannot move mail into Sent or Drafts; use Send or Save draft."],
  ["bot-bridge", "Bot bridge", "Accounts", "An optional loopback API lets a bot read cached mail and propose inert drafts for connected, granted mailboxes. A separate send permission allows immediate plain-text mail. Access starts off; CLI explains capabilities, possible provider calls, Tailscale setup, and revocation limits."],
  ["calendar", "Calendar", "Calendar", "Month view for Google Calendar or Microsoft Graph when that account has calendar access. Incomplete Google Calendar reauthorization preserves the working Calendar connection. Create, edit, and delete events. Timed events appear on each local date they overlap. Closing a pending save does not cancel it; confirmed changes refresh the month. Titles over 200 characters and long Google descriptions stay read-only previews; other field edits preserve their complete values. Unchanged titles are kept, including untitled events. Save errors appear in the event dialog and keep your input. Invalid dates are reported before description preview restrictions."],
  ["in-app-updater", "In-app updates", "Updates", "About & updates checks for a release on launch and every hour while Morrow is open. A red ! on that button means an update is ready. Restart and install applies a downloaded update once every compose window is closed."],
  ["ipc-diagnostics", "IPC diagnostics", "Support", "IPC trace records known channels and argument counts, plus renderer levels, line numbers and load codes. Request values, renderer text and URLs are omitted. Other Debug entries may retain account/folder context."],
];
assert.deepStrictEqual(featureCatalog.items.map((row) => [row.id, row.title, row.category, row.blurb]), featureSeed);
const featureUi = loadFunctions(appJs, ["normalizeFeatureCatalog", "groupFeatureCatalog"]);
assert.deepStrictEqual(featureUi.normalizeFeatureCatalog(null), []);
assert.deepStrictEqual(featureUi.normalizeFeatureCatalog(4), []);
assert.deepStrictEqual(featureUi.normalizeFeatureCatalog({ items: [] }), []);
assert.deepStrictEqual(featureUi.normalizeFeatureCatalog([
  null,
  1,
  [],
  { id: "Bad Id", title: "Nope", blurb: "x" },
  { id: "ok-row", title: "  Kept  ", blurb: 12, category: "  Mail  " },
  { id: "ok-row", title: "Second", blurb: "nope" },
  { id: "blank", title: "   ", blurb: "x" },
  { id: "plain", title: "Plain" },
]), [
  { id: "ok-row", title: "Kept", blurb: "", category: "Mail" },
  { id: "plain", title: "Plain", blurb: "", category: "" },
]);
assert.deepStrictEqual(featureUi.groupFeatureCatalog([
  { id: "b", title: "B", blurb: "", category: "Beta" },
  { id: "a", title: "A", blurb: "", category: "Alpha" },
  { id: "b2", title: "B2", blurb: "", category: "Beta" },
]).map((group) => [group.heading, group.items.map((row) => row.id)]), [["Beta", ["b", "b2"]], ["Alpha", ["a"]]]);
assert.deepStrictEqual(featureUi.groupFeatureCatalog([
  { id: "m", title: "M", blurb: "", category: "Mail" },
  { id: "x", title: "X", blurb: "", category: "" },
]).map((group) => [group.heading, group.items.map((row) => row.id)]), [["Mail", ["m"]], ["Other", ["x"]]]);
assert.deepStrictEqual(featureUi.groupFeatureCatalog([
  { id: "o", title: "O", blurb: "", category: "Other" },
  { id: "m", title: "M", blurb: "", category: "Mail" },
  { id: "u", title: "U", blurb: "", category: "" },
]).map((group) => [group.heading, group.items.map((row) => row.id)]), [["Mail", ["m"]], ["Other", ["o", "u"]]]);
assert.deepStrictEqual(featureUi.groupFeatureCatalog([
  { id: "a", title: "A", blurb: "", category: "" },
  { id: "b", title: "B", blurb: "", category: "" },
]), [{ heading: "", items: [
  { id: "a", title: "A", blurb: "", category: "" },
  { id: "b", title: "B", blurb: "", category: "" },
] }]);
assert.deepStrictEqual(featureUi.groupFeatureCatalog(null), []);
assert.deepStrictEqual(featureUi.normalizeFeatureCatalog([null, { title: "missing" }, { id: "ok", title: "Ok", extra: true }]), [
  { id: "ok", title: "Ok", blurb: "", category: "" },
]);
const openMail = { view: "mail", mailOpen: true, typing: false, dialog: false, menu: false, textSelected: false, topDialog: "" };
assert.strictEqual(shortcuts.mailShortcut({ key: "Delete" }, openMail), "delete");
assert.strictEqual(shortcuts.mailShortcut({ key: "Backspace" }, openMail), "delete");
assert.strictEqual(shortcuts.mailShortcut({ key: "Backspace" }, { ...openMail, typing: true }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "Delete" }, { ...openMail, dialog: true }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "Backspace" }, { ...openMail, textSelected: true }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "Delete", metaKey: true }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "r" }, openMail), "reply");
assert.strictEqual(shortcuts.mailShortcut({ key: "R" }, openMail), "reply");
assert.strictEqual(shortcuts.mailShortcut({ key: "a" }, openMail), "reply-all");
assert.strictEqual(shortcuts.mailShortcut({ key: "f" }, openMail), "forward");
assert.strictEqual(shortcuts.mailShortcut({ key: "r", metaKey: true }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "r", ctrlKey: true }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "R", ctrlKey: true, shiftKey: true }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "r", shiftKey: true }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "r" }, { ...openMail, typing: true }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "r" }, { ...openMail, mailOpen: false }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "f" }, { ...openMail, view: "features" }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "f", metaKey: true, shiftKey: true }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "n", metaKey: true }, { ...openMail, typing: true }), "new-mail");
assert.strictEqual(shortcuts.mailShortcut({ key: "n", ctrlKey: true }, openMail), "new-mail");
assert.strictEqual(shortcuts.mailShortcut({ key: "n", ctrlKey: true, shiftKey: true }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: ",", metaKey: true }, { typing: true }), "settings");
assert.strictEqual(shortcuts.mailShortcut({ key: ",", ctrlKey: true }, {}), "settings");
assert.strictEqual(shortcuts.mailShortcut({ key: "Enter", metaKey: true }, { topDialog: "compose" }), "send");
assert.strictEqual(shortcuts.mailShortcut({ key: "Enter", ctrlKey: true }, { topDialog: "compose", typing: true }), "send");
assert.strictEqual(shortcuts.mailShortcut({ key: "Enter", metaKey: true }, { topDialog: "" }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "Enter", metaKey: true }, { topDialog: "compose-preview" }), "send-confirm");
assert.strictEqual(shortcuts.mailShortcut({ key: "s", metaKey: true }, { topDialog: "compose", typing: true }), "save-draft");
assert.strictEqual(shortcuts.mailShortcut({ key: "s", ctrlKey: true }, { topDialog: "settings", typing: true }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "s", metaKey: true }, { typing: true }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "f", metaKey: true }, openMail), "search");
assert.strictEqual(shortcuts.mailShortcut({ key: "f", ctrlKey: true }, { ...openMail, typing: true }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "f", ctrlKey: true }, { ...openMail, dialog: true }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "/" }, openMail), "search");
assert.strictEqual(shortcuts.mailShortcut({ key: "/" }, { ...openMail, typing: true }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "/" }, { ...openMail, dialog: true }), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "Escape" }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "=", metaKey: true }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "+", metaKey: true }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "-", ctrlKey: true }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "0", metaKey: true }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "r", repeat: true }, openMail), "");
assert.strictEqual(shortcuts.mailShortcut({ key: "a", metaKey: true }, openMail), "");
assert.ok(appJs.includes('readerButton("trash", "Delete"'));
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
assert.ok(css.includes(".body-pending") && appJs.includes("Loading message") && functionSource(appJs, "openMessage").includes("bodyComplete"));
assert.ok(functionSource(appJs, "showAgentTab").includes("agentPane") && css.includes('[data-agent-pane="conversation"]'));
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
  "isVirtualMailbox",
  "storableFolders",
  "visibleList",
  "messageDragPayload",
  "providerCopy",
  "organizeDrop",
]);
assert.strictEqual(starUi.isVirtualMailbox({ type: "virtual" }), true);
assert.strictEqual(starUi.isVirtualMailbox("INBOX"), false);
assert.strictEqual(starUi.isVirtualMailbox({ id: "INBOX", wellKnownName: "inbox" }), false);
assert.deepStrictEqual(starUi.storableFolders([
  { id: "INBOX", name: "Inbox" },
  { id: "starred-view", name: "Starred", type: "virtual" },
]).map((folder) => folder.id), ["INBOX"]);
const starRows = [
  { id: "a", subject: "Hello", from: "Ada", snippet: "x", isStarred: true, unread: true },
  { id: "b", subject: "Other", from: "Bea", snippet: "y", isStarred: false, unread: false },
];
assert.deepStrictEqual(starUi.visibleList(starRows, "", { id: "INBOX" }).map((row) => row.id), ["a", "b"]);
assert.deepStrictEqual(starUi.visibleList(starRows, "", { view: { flagged: true } }).map((row) => row.id), ["a"]);
assert.deepStrictEqual(starUi.visibleList(starRows, "other", { view: { flagged: true } }), []);
assert.deepStrictEqual(starUi.visibleList(starRows, "", { view: { unread: true } }).map((row) => row.id), ["a"]);
assert.ok(functionSource(appJs, "renderList").includes("shownEmails()"));
const refusedStarDrop = starUi.organizeDrop(
  {
    kind: "virtual",
    id: "starred-view",
    accountId: "a1",
    dropCopy: "Starred is a filter. Use the star control to flag a message.",
  },
  { id: "m1", accountId: "a1", folderId: "INBOX" },
);
assert.strictEqual(refusedStarDrop.ok, false);
assert.strictEqual(refusedStarDrop.reason, "virtual");
assert.match(refusedStarDrop.message, /Starred is a filter/);
const toggleStarSource = functionSource(appJs, "toggleStar");
assert.ok(toggleStarSource.indexOf("paintStars") < toggleStarSource.indexOf("await call"));
assert.ok(toggleStarSource.includes("paintStars([email], previous, true)"));
assert.ok(!appJs.includes("__morrow_starred__"));
assert.ok(!appJs.includes("__morrow_unread__"));
assert.ok(appJs.includes("starIcon(starredOn)"));
assert.ok(appJs.includes("Still finishing the last change."));
assert.ok(css.includes("--star:"));
assert.ok(css.includes('#reader .reader-actions button[data-action="star"].is-starred'));
assert.ok(engineSrc.includes("STARRED_FOLDER_ID"));
assert.ok(!engineSrc.includes("=== STARRED_FOLDER_ID"));
assert.ok(!engineSrc.includes("!== STARRED_FOLDER_ID"));
assert.ok(!engineSrc.includes("=== UNREAD_FOLDER_ID"));
assert.ok(!engineSrc.includes("!== UNREAD_FOLDER_ID"));
assert.ok(fs.readFileSync(path.join(root, "host/mail/actions.js"), "utf8").includes('"\\\\Flagged"'));
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
assert.ok(html.includes('id="label-picker"'));
assert.ok(html.includes('id="label-picker-filter"'));
assert.ok(html.includes('placeholder="Filter labels"'));
assert.ok(css.includes("#label-picker-list"));
assert.ok(css.includes(".reader-actions .translate"));
assert.ok(css.includes(".reader-star-group"));
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
  "Enable calendar and mailbox features. Google requests Calendar separately from mail; Microsoft connects mail first, then checks feature permissions for the same account.",
);
assert.strictEqual(providerUi.calendarCopy("oauth_not_ready"), "Google Desktop OAuth is not configured, so calendar stays offline.");
assert.strictEqual(providerUi.calendarCopy("no_account"), "Connect a Google or Microsoft mailbox. Calendar does not keep events of its own.");
assert.strictEqual(
  providerUi.calendarCopy("needs_auth", "ada@example.com"),
  "Enable calendar and mailbox features for ada@example.com. Google requests Calendar separately from mail; Microsoft connects mail first, then checks feature permissions for the same account.",
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
assert.strictEqual(providerUi.calendarDraft({
  accountId: "a",
  calendarId: "c",
  title: "Day",
  allDay: true,
  start: "2026-10-03",
  end: "2026-10-03",
}).error, "Pick a start date and a later end date.");
const allDayDraft = providerUi.calendarDraft({
  accountId: "a",
  calendarId: "c",
  title: "Day",
  allDay: true,
  start: "2026-10-03",
  end: "2026-10-04",
  description: " Bring notes ",
});
assert.strictEqual(allDayDraft.error, "");
assert.strictEqual(allDayDraft.allDay, true);
assert.strictEqual(allDayDraft.start, "2026-10-03");
assert.strictEqual(allDayDraft.description, "Bring notes");
const columnTree = [
  { id: "L1", name: "Work", label: "Work", parentId: "" },
  { id: "L2", name: "Travel", label: "Travel", parentId: "L1" },
  { id: "L3", name: "2024", label: "2024", parentId: "L2" },
  { id: "L4", name: "Solo", label: "Solo", parentId: "" },
];
const columnIds = (result) => result.columns.map((column) => column.map((folder) => folder.id));
assert.deepStrictEqual(columnIds(providerUi.providerColumns(columnTree, [], "")), [["L1", "L4"]]);
assert.deepStrictEqual(providerUi.providerColumns(columnTree, [], "").path, []);
const drilled = providerUi.providerColumns(columnTree, ["L1", "L2"], "");
assert.deepStrictEqual(columnIds(drilled), [["L1", "L4"], ["L2"], ["L3"]]);
assert.deepStrictEqual(drilled.path, ["L1", "L2"]);
const found = providerUi.providerColumns(columnTree, ["L1", "L2", "L3"], "2024");
assert.deepStrictEqual(columnIds(found), [["L1"], ["L2"], ["L3"]]);
assert.deepStrictEqual(found.path, ["L1", "L2", "L3"]);
assert.deepStrictEqual(providerUi.providerFilterReveal(columnTree, "2024"), ["L1", "L2", "L3"]);
assert.strictEqual(providerUi.providerFilterReveal(columnTree, ""), null);
assert.deepStrictEqual(providerUi.providerFilterReveal(columnTree, "missing"), []);
const invalidColumn = providerUi.providerColumns(columnTree, ["missing"], "");
assert.deepStrictEqual(invalidColumn.path, []);
assert.deepStrictEqual(columnIds(invalidColumn), [["L1", "L4"]]);
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
  "calendar:updateEvent",
  "calendar:deleteEvent",
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
  "calendar:updateEvent",
  "calendar:deleteEvent",
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
const calendarLoad = appJs.slice(appJs.indexOf("async function loadCalendar"), appJs.indexOf("\nfunction showMail"));
const calendarShow = functionSource(appJs, "showCalendar");
const calendarPrepare = functionSource(appJs, "prepareCalendarLoad");
const calendarBusyLabel = functionSource(appJs, "calendarBusyLabel");
assert.ok(calendarLoad.includes('setPageBusy("calendar-panel"') && calendarPrepare.includes("paintCalendarShell"));
assert.ok(calendarPrepare.includes('setPageBusy("calendar-panel"'));
assert.ok(calendarBusyLabel.includes("Loading…") && calendarBusyLabel.includes("Updating calendar…"));
assert.ok(!calendarLoad.includes('reason: "loading"') && !calendarLoad.includes("Loading calendar"));
assert.ok(!calendarShow.includes("Loading calendar") && !calendarShow.includes("calendar-layout"));
const busyRule = css.slice(css.indexOf(".page-busy {"), css.indexOf(".page-busy {") + 700);
assert.ok(busyRule.includes("pointer-events: none") && busyRule.includes("position: absolute"));
assert.ok(independentDoc.includes("Updating calendar…") && parity.includes("Updating calendar…"));
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
  "Updating calendar…",
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
const senderGraphUrl = decodeURIComponent(gmailApi.graphFromAddressUrl("ada@example.com", 50)).replace(/\+/g, " ");
assert.ok(senderGraphUrl.includes("from/emailAddress/address eq 'ada@example.com'"));
assert.ok(senderGraphUrl.includes("receivedDateTime desc"));
assert.ok(!senderGraphUrl.includes("ConsistencyLevel"));
assert.ok(gmailApi.graphSenderNext("https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc").includes("/v1.0/me/messages"));
assert.strictEqual(gmailApi.graphSenderNext("https://evil.example/v1.0/me/messages"), "");
assert.strictEqual(gmailApi.graphSenderNext("https://graph.microsoft.com/v1.0/me/events"), "");
const oauthConfig = require("../host/mail/oauth-config");
assert.strictEqual(oauthConfig.SCOPES.google, "openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic");
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
  "openid email https://www.googleapis.com/auth/gmail.modify",
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
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.SCOPES.google, "google", "vacation"), true);
assert.strictEqual(oauthConfig.hasMarker("Mail.Read", "microsoft", "organize"), false);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.ORGANIZE_SCOPES.microsoft, "outlook", "organize"), true);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.ORGANIZE_SCOPES.google, "gmail", "organize"), true);
assert.strictEqual(oauthConfig.hasMarker(oauthConfig.SCOPES.google, "google", "organize"), true);
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
assert.strictEqual(googleAuth.searchParams.get("include_granted_scopes"), "false");
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
assert.strictEqual(microsoftCalendar.searchParams.get("prompt"), null);
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
  const replyReq = draft.draftRequest(ai.draftInstruction("reply", "", "", "Re: Notes", {
    subject: "Notes",
    from: "Charles Babbage <charles.babbage@example.com>",
    textBody: "The brass gears mesh once the mill is set.",
  }));
  assert.match(replyReq.system, /comprehensive reply/i);
  assert.match(replyReq.user, /Original email:/);
  assert.match(replyReq.user, /brass gears/);
  assert.match(replyReq.user, /Charles Babbage/);
  const rewriteReq = draft.draftRequest(ai.draftInstruction("rewrite", "shorter", "Hello", "Hi", {
    subject: "Hi",
    from: "Ada",
    snippet: "short only",
    textBody: "full body that should stay out of the short email path",
  }));
  assert.match(rewriteReq.user, /Email:/);
  assert.doesNotMatch(rewriteReq.user, /Original email:/);
  assert.match(rewriteReq.user, /short only/);
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
  {
    const agentFile = path.join(process.env.MORROW_AI_CONFIG_DIR, "agent.json");
    const customFile = agent.customSkillsPath();
    const agentBefore = fs.existsSync(agentFile) ? fs.readFileSync(agentFile, "utf8") : null;
    const catalogBackup = agent.CATALOG.map((row) => Object.assign({}, row));
    assert.strictEqual(path.dirname(customFile), process.env.MORROW_AI_CONFIG_DIR);
    assert.strictEqual(path.basename(customFile), "custom-skills.json");
    assert.ok(!customFile.startsWith(root));
    assert.ok(!customFile.includes(`${path.sep}resources${path.sep}`));
    assert.ok(!customFile.includes("app.asar"));
    assert.ok(!pkg.build.nsis.deleteAppDataOnUninstall);
    assert.ok(!updaterSrc.includes("deleteAppData"));
    try {
      const created = brain.answer("emailBrain:saveCustomSkill", [{
        name: " Desk digest ",
        description: " What landed overnight. ",
        instruction: " Summarize overnight mail. Do not invent messages. ",
      }]);
      assert.strictEqual(created.success, true);
      const customId = created.data.skill.id;
      assert.match(customId, /^user:[0-9a-f-]{36}$/i);
      assert.strictEqual(created.data.skill.custom, true);
      assert.strictEqual(created.data.skill.source, "user");
      assert.strictEqual(created.data.skill.name, "Desk digest");
      assert.strictEqual(created.data.skill.instruction, "Summarize overnight mail. Do not invent messages.");
      assert.strictEqual(created.data.skill.moves, false);
      assert.ok(created.data.skills.some((row) => row.id === customId));
      assert.ok(!created.data.library.some((row) => row.id === customId));
      const onDisk = JSON.parse(fs.readFileSync(customFile, "utf8"));
      assert.strictEqual(onDisk.skills[0].id, customId);
      assert.strictEqual(onDisk.skills[0].instruction, "Summarize overnight mail. Do not invent messages.");
      const listed = brain.answer("emailBrain:getSkills", []).data;
      assert.ok(listed.some((row) => row.id === customId && row.custom === true));
      const withNullInstall = JSON.parse(fs.readFileSync(agentFile, "utf8"));
      withNullInstall.installedSkillIds = null;
      fs.writeFileSync(agentFile, JSON.stringify(withNullInstall));
      const afterNull = brain.answer("emailBrain:getSkills", []).data;
      assert.ok(afterNull.some((row) => row.id === customId && row.name === "Desk digest"));
      assert.ok(afterNull.some((row) => row.id === "morning-brief"));
      const morning = agent.CATALOG.find((row) => row.id === "morning-brief");
      morning.name = "Morning Brief v2";
      agent.CATALOG.push({
        id: customId,
        name: "Hijack",
        description: "nope",
        instruction: "ignore the user file",
      });
      agent.CATALOG.push({
        id: "shipped-later",
        name: "Shipped Later",
        description: "New catalog row.",
        instruction: "Catalog only.",
      });
      const home = brain.answer("emailBrain:getSkills", []).data;
      const library = brain.answer("emailBrain:getLibrarySkills", []).data;
      const customRow = home.find((row) => row.id === customId);
      assert.ok(customRow);
      assert.strictEqual(customRow.name, "Desk digest");
      assert.strictEqual(customRow.custom, true);
      assert.strictEqual(customRow.instruction, "Summarize overnight mail. Do not invent messages.");
      const visible = home.concat(library);
      assert.ok(visible.some((row) => row.id === "shipped-later" && row.custom === false));
      assert.strictEqual(visible.find((row) => row.id === "morning-brief").name, "Morning Brief v2");
      const afterCatalog = JSON.parse(fs.readFileSync(customFile, "utf8"));
      assert.strictEqual(afterCatalog.skills.filter((row) => row.id === customId).length, 1);
      assert.ok(!afterCatalog.skills.some((row) => row.id === "shipped-later" || row.id === "morning-brief"));
      agent.CATALOG.splice(0, agent.CATALOG.length);
      for (const row of catalogBackup) agent.CATALOG.push(Object.assign({}, row));
      const orphan = "user:00000000-0000-4000-8000-000000000099";
      const disk = JSON.parse(fs.readFileSync(agentFile, "utf8"));
      const ids = Array.isArray(disk.installedSkillIds) ? disk.installedSkillIds.slice() : agent.CATALOG.map((row) => row.id);
      ids.push(orphan);
      ids.push("retired-catalog-skill");
      disk.installedSkillIds = ids;
      fs.writeFileSync(agentFile, JSON.stringify(disk));
      const installedAgain = brain.answer("emailBrain:installSkill", [{ skillId: "morning-brief" }]);
      assert.strictEqual(installedAgain.success, true);
      const keptIds = JSON.parse(fs.readFileSync(agentFile, "utf8")).installedSkillIds;
      assert.ok(keptIds.includes(orphan));
      assert.ok(keptIds.includes(customId));
      assert.ok(!keptIds.includes("retired-catalog-skill"));
      const customBeforeSchedule = fs.readFileSync(customFile, "utf8");
      const scheduled = brain.answer("emailBrain:setSkillSchedule", [{ skillId: customId, kind: "interval", everyMinutes: 45 }]);
      assert.strictEqual(scheduled.success, true);
      assert.strictEqual(fs.readFileSync(customFile, "utf8"), customBeforeSchedule);
      assert.ok(JSON.parse(fs.readFileSync(agentFile, "utf8")).schedules.some((row) => row.skillId === customId && row.everyMinutes === 45));
      const brokenId = "user:11111111-1111-4111-8111-111111111111";
      const withBroken = JSON.parse(fs.readFileSync(customFile, "utf8"));
      withBroken.keeper = "stay";
      withBroken.skills.push({ id: brokenId, name: "Broken", instruction: "  ", note: "keep-me" });
      fs.writeFileSync(customFile, JSON.stringify(withBroken));
      const edited = brain.answer("emailBrain:saveCustomSkill", [{
        skillId: customId,
        name: "Desk digest",
        description: "Overnight only.",
        instruction: "Summarize overnight mail in three lines.",
        moves: true,
      }]);
      assert.strictEqual(edited.success, true);
      assert.strictEqual(edited.data.skill.moves, true);
      assert.strictEqual(edited.data.skill.description, "Overnight only.");
      const preserved = JSON.parse(fs.readFileSync(customFile, "utf8"));
      assert.strictEqual(preserved.keeper, "stay");
      assert.strictEqual(preserved.skills.find((row) => row.id === brokenId).note, "keep-me");
      assert.ok(!brain.answer("emailBrain:getSkills", []).data.some((row) => row.id === brokenId));
      assert.strictEqual(brain.answer("emailBrain:saveCustomSkill", [{ name: "X", instruction: "   " }]).success, false);
      assert.strictEqual(brain.answer("emailBrain:saveCustomSkill", [{ name: " ", instruction: "Hello there." }]).success, false);
      assert.strictEqual(brain.answer("emailBrain:saveCustomSkill", [{ skillId: "morning-brief", name: "X", instruction: "Hello there." }]).success, false);
      assert.strictEqual(brain.answer("emailBrain:deleteCustomSkill", [{ skillId: "morning-brief" }]).success, false);
      const blockedRun = await brain.answer("emailBrain:runSkill", [{ skillId: customId }]);
      assert.strictEqual(blockedRun.success, true);
      assert.strictEqual(blockedRun.data.accepted, false);
      assert.match(blockedRun.data.error, /API key/);
      const deleted = brain.answer("emailBrain:deleteCustomSkill", [{ skillId: customId }]);
      assert.strictEqual(deleted.success, true);
      assert.strictEqual(deleted.data.deleted, true);
      const afterDelete = JSON.parse(fs.readFileSync(customFile, "utf8"));
      assert.ok(!afterDelete.skills.some((row) => row.id === customId));
      assert.strictEqual(afterDelete.skills.find((row) => row.id === brokenId).note, "keep-me");
      assert.ok(!brain.answer("emailBrain:getSkills", []).data.some((row) => row.id === customId));
      assert.ok(!brain.answer("emailBrain:getLibrarySkills", []).data.some((row) => row.id === customId));
      assert.ok(!(JSON.parse(fs.readFileSync(agentFile, "utf8")).schedules || []).some((row) => row.skillId === customId));
      assert.strictEqual(brain.answer("emailBrain:deleteCustomSkill", [{ skillId: brokenId }]).success, true);
      const second = brain.answer("emailBrain:saveCustomSkill", [{
        name: "Second",
        description: "Other",
        instruction: "List unread mail.",
      }]);
      assert.strictEqual(second.success, true);
      assert.strictEqual(brain.answer("emailBrain:removeSkill", [{ skillId: second.data.skill.id }]).success, true);
      assert.ok(!JSON.parse(fs.readFileSync(customFile, "utf8")).skills.some((row) => row.id === second.data.skill.id));
      const fillers = [];
      for (let index = 0; index < 40; index += 1) {
        fillers.push({
          id: `user:00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
          name: "Filled",
          description: "",
          instruction: "Keep.",
        });
      }
      fs.writeFileSync(customFile, JSON.stringify({ skills: fillers }));
      const capped = brain.answer("emailBrain:saveCustomSkill", [{ name: "One more", instruction: "No room." }]);
      assert.strictEqual(capped.success, false);
      assert.match(capped.error.message, /40/);
      assert.strictEqual(JSON.parse(fs.readFileSync(customFile, "utf8")).skills.length, 40);
      fs.writeFileSync(customFile, "{");
      const refused = brain.answer("emailBrain:saveCustomSkill", [{ name: "Nope", instruction: "Do a thing." }]);
      assert.strictEqual(refused.success, false);
      assert.match(refused.error.message, /left in place/);
      assert.strictEqual(fs.readFileSync(customFile, "utf8"), "{");
    } finally {
      agent.CATALOG.splice(0, agent.CATALOG.length);
      for (const row of catalogBackup) agent.CATALOG.push(Object.assign({}, row));
      if (agentBefore == null) fs.rmSync(agentFile, { force: true });
      else fs.writeFileSync(agentFile, agentBefore);
      fs.rmSync(customFile, { force: true });
    }
  }
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
  const customDropped = agent.normalizeSkillResult(
    { moves: false, name: "Desk digest" },
    { title: "Desk", summary: "Quiet.", moves: [{ messageId: "m-live", labelName: "FYI", reason: "Bulk" }] },
    { messages: [{ id: "m-live" }] },
  );
  assert.strictEqual(customDropped.moves.length, 0);
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
  const consent = require("../host/ai-consent").getConsent();
  consent.grant({ token: consent.status().token, manual: true, background: true });
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
        moves: body.includes("Organize Inbox") || body.includes('\\"movesAllowed\\":true')
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
    {
      let customRunId = "";
      let personId = "";
      try {
        const customMade = brain.answer("emailBrain:saveCustomSkill", [{
          name: "File the noise",
          description: "Propose filing.",
          instruction: "Propose a folder for bulk mail.",
          moves: true,
          calendar: true,
        }]);
        assert.strictEqual(customMade.success, true);
        customRunId = customMade.data.skill.id;
        const customRun = await brain.answer("emailBrain:runSkill", [{ skillId: customRunId }]);
        assert.strictEqual(customRun.data.accepted, true);
        assert.ok(seenBodies.some((body) => body.includes("Propose a folder for bulk mail.") && body.includes('\\"movesAllowed\\":true')));
        assert.strictEqual(customRun.data.proposals.length, 1);
        assert.strictEqual(customRun.data.proposals[0].status, "pending");
        assert.match(customRun.data.note, /mail only/);
        const quiet = brain.answer("emailBrain:saveCustomSkill", [{
          skillId: customRunId,
          name: "File the noise",
          description: "Propose filing.",
          instruction: "Propose a folder for bulk mail.",
        }]);
        assert.strictEqual(quiet.success, true);
        assert.strictEqual(quiet.data.skill.moves, false);
        const quietRun = await brain.answer("emailBrain:runSkill", [{ skillId: customRunId }]);
        assert.strictEqual(quietRun.data.accepted, true);
        assert.strictEqual((quietRun.data.proposals || []).length, 0);
        assert.ok(seenBodies.some((body) => body.includes('\\"movesAllowed\\":false')));
        const personSkill = brain.answer("emailBrain:saveCustomSkill", [{
          name: "One sender",
          description: "Mail from one person.",
          instruction: "Brief that person from the messages.",
          person: true,
        }]);
        assert.strictEqual(personSkill.success, true);
        personId = personSkill.data.skill.id;
        const personBlocked = await brain.answer("emailBrain:runSkill", [{ skillId: personId }]);
        assert.strictEqual(personBlocked.data.accepted, false);
        assert.match(personBlocked.data.error, /contact email|Select a message/);
      } finally {
        if (customRunId) brain.answer("emailBrain:deleteCustomSkill", [{ skillId: customRunId }]);
        if (personId) brain.answer("emailBrain:deleteCustomSkill", [{ skillId: personId }]);
      }
    }
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
    assert.deepStrictEqual(agent.planChat("What should I handle?", null), { type: "prose" });
    assert.deepStrictEqual(agent.planChat("any email address to me?", null), { type: "clarify", expect: "filter" });
    assert.deepStrictEqual(agent.planChat("What is unread?", null), { type: "list", filter: { kind: "unread" } });
    assert.deepStrictEqual(agent.planChat("有没有给我的邮件", null), { type: "clarify", expect: "filter" });
    const savedMemory = agent.answer("nativeAgent:memorySet", [{ notes: "Prefer short replies." }]);
    assert.strictEqual(savedMemory.data.notes, "Prefer short replies.");
    const asked = await agent.answer("nativeAgent:chat", [{ text: "What should I handle?" }]);
    assert.strictEqual(asked.data.intent, "chat");
    assert.strictEqual(asked.data.turn.role, "agent");
    assert.match(asked.data.turn.text, /Ada needs a reply about the notes/);
    assert.ok(seenBodies.some((body) => body.includes("Prefer short replies.") && body.includes("Never invent")));
    assert.ok(!JSON.stringify(asked.data).includes("Analytical Engine"));
    const beforeBroad = seenBodies.length;
    const broad = await agent.answer("nativeAgent:chat", [{ text: "any email address to me?" }]);
    assert.strictEqual(broad.data.intent, "chat");
    assert.strictEqual(broad.data.turn.reply.kind, "clarify");
    assert.strictEqual(broad.data.turn.reply.expect, "filter");
    assert.ok(!broad.data.turn.reply.cards);
    assert.strictEqual(broad.data.turn.text, "Do you want unread mail, mail from today, or mail from one sender?");
    assert.ok(!seenBodies.slice(beforeBroad).some((body) => body.includes("Can you send the notes")));
    const listed = await agent.answer("nativeAgent:chat", [{ text: "What is unread?" }]);
    assert.strictEqual(listed.data.turn.reply.cards[0].messageId, "m-live");
    assert.deepStrictEqual(listed.data.turn.reply.cards[0].followUps.map((row) => row.kind), ["open", "draft"]);
    assert.match(listed.data.turn.text, /1 unread message/);
    assert.ok(!listed.data.turn.text.includes("Need the notes"));
    const more = await agent.answer("nativeAgent:chat", [{ text: "any other" }]);
    assert.strictEqual(more.data.turn.reply.kind, "list");
    assert.strictEqual(more.data.turn.reply.cards.length, 0);
    assert.strictEqual(more.data.turn.reply.filter.kind, "unread");
    assert.strictEqual(more.data.turn.text, "That's the last of this list.");
    const chinese = await agent.answer("nativeAgent:chat", [{ text: "有没有给我的邮件" }]);
    assert.strictEqual(chinese.data.turn.text, "要看未读、今天的邮件，还是某一位发件人的邮件？");
    assert.strictEqual(chinese.data.turn.reply.kind, "clarify");
    const viaSkill = await agent.answer("nativeAgent:chat", [{ text: "Run Morning Brief" }]);
    assert.strictEqual(viaSkill.data.intent, "skill");
    assert.strictEqual(viaSkill.data.turn.kind, "skill");
    assert.strictEqual(viaSkill.data.turn.name, "Morning Brief");
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
    assert.ok(seenBodies.some((body) => body.includes("personaMode") && body.includes("rebuild") && body.includes("Distill an Email Brain persona from scratch")));
    assert.ok(!seenBodies.some((body) => body.includes("Keep prior facts unless")));
    const manual = brain.answer("emailBrain:refresh", [{ source: "manual" }]);
    assert.strictEqual(manual.data.accepted, true);
    assert.strictEqual(manual.data.mode, "refresh");
    assert.ok(!manual.data.cached);
    await settlePersona();
    const afterRefresh = brain.answer("emailBrain:getCached", []);
    assert.ok(brainUi.brainUserRules(brainUi.brainSections(afterRefresh.data)).some((row) => row.value === "Sticky rule."));
    assert.ok((afterRefresh.data.persona.recentActivity || []).some((row) => row.kind === "refresh"));
    assert.ok(seenBodies.some((body) => body.includes('"personaMode":"refresh"') || (body.includes("personaMode") && body.includes("refresh"))));
    assert.ok(seenBodies.some((body) => body.includes("personaMode") && body.includes("refresh") && body.includes("Distill the living Email Brain profile")));
    assert.ok(!seenBodies.some((body) => body.includes("Keep prior facts unless")));
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
  const coloredHtml = '<p><font color="#c0392b"><span style="background-color:#fff3a0">Ada</span></font></p>';
  const colored = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    id: createdId,
    name: "Work",
    html: coloredHtml,
    isDefault: true,
  }]);
  assert.strictEqual(colored.success, true);
  assert.strictEqual(colored.data.html, coloredHtml);
  assert.strictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]).data.signatures[0].html, coloredHtml);
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
  const bound = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    id: createdId,
    name: "Work",
    text: "Thanks,\nAda",
    isDefault: true,
    domains: ["@HKBSCL.com", "gmail.com"],
  }]);
  assert.strictEqual(bound.success, true);
  const boundMap = { "hkbscl.com": createdId, "gmail.com": createdId };
  assert.deepStrictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]).data.signatureByDomainPerAccount["imap-test"], boundMap);
  const rebound = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    id: createdId,
    name: "Work",
    text: "Thanks,\nAda",
    isDefault: true,
    domains: ["hkbscl.com", "@gmail.com"],
  }]);
  assert.strictEqual(rebound.success, true);
  assert.deepStrictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]).data.signatureByDomainPerAccount["imap-test"], boundMap);
  const clash = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    name: "Personal",
    text: "— Ada",
    domains: ["hkbscl.com"],
  }]);
  assert.strictEqual(clash.success, false);
  assert.match(clash.error.message, /hkbscl.com is already bound to Work\./);
  const afterClash = engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]).data;
  assert.deepStrictEqual(afterClash.signatures.map((row) => row.name), ["Work"]);
  assert.deepStrictEqual(afterClash.signatureByDomainPerAccount["imap-test"], boundMap);
  const badDomain = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    id: createdId,
    name: "Work",
    text: "Thanks,\nAda",
    domains: ["not a domain"],
  }]);
  assert.strictEqual(badDomain.error.code, "invalid");
  assert.deepStrictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]).data.signatureByDomainPerAccount["imap-test"], boundMap);
  const extra = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    name: "Extra",
    text: "Extra line",
    domains: ["extra.example"],
  }]);
  assert.strictEqual(extra.success, true);
  assert.strictEqual(engine.answer("mail:deleteSignature", [{ id: extra.data.id }]).success, true);
  assert.deepStrictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]).data.signatureByDomainPerAccount["imap-test"], boundMap);
  const omittedDomains = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    id: createdId,
    name: "Work",
    text: "Thanks,\nAda",
    isDefault: true,
  }]);
  assert.strictEqual(omittedDomains.success, true);
  assert.deepStrictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]).data.signatureByDomainPerAccount["imap-test"], boundMap);
  const clearedDomains = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    id: createdId,
    name: "Work",
    text: "Thanks,\nAda",
    isDefault: true,
    domains: [],
  }]);
  assert.strictEqual(clearedDomains.success, true);
  assert.equal(engine.answer("mail:listSignatures", []).data.signatureByDomainPerAccount["imap-test"], undefined);
  const restoredDomains = engine.answer("mail:upsertSignature", [{
    accountId: "imap-test",
    id: createdId,
    name: "Work",
    text: "Thanks,\nAda",
    isDefault: true,
    domains: ["hkbscl.com", "gmail.com"],
  }]);
  assert.strictEqual(restoredDomains.success, true);
  assert.deepStrictEqual(engine.answer("mail:listSignatures", [{ accountId: "imap-test" }]).data.signatureByDomainPerAccount["imap-test"], boundMap);

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
  assert.deepStrictEqual(againSig.data.signatureByDomainPerAccount["imap-test"], { "hkbscl.com": createdId, "gmail.com": createdId });
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
  assert.strictEqual(failed.status, "unknown", "an unclassified transport failure must not claim the message was definitely unsent");
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
    domains: ["drop.example"],
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
  assert.equal(engine.answer("mail:listSignatures", []).data.signatureByDomainPerAccount["imap-drop"], undefined);
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
  const syncNames = ["selectedAccount", "composeAccount", "isLive", "composeFileMeta", "composeAttachmentList", "attachmentPayload", "composePayload", "composeHasRecipient", "outgoingBody", "toHtml", "joinComposeHtml", "blankComposeHtml", "readComposeEditorHtml"];
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
      signatureByDomainPerAccount: {},
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
    const discovered = await remote.listFolderRecords({
      list: async () => [
        { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
        { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All" },
        { path: "[Google Mail]/All Mail", name: "[Google Mail]/All Mail" },
        { path: "All Mail", name: "All Mail" },
        { path: "Everything", name: "Everything", specialUse: "\\All" },
        { path: "[Gmail]/Starred", name: "Starred", specialUse: "\\Flagged" },
        { path: "[Gmail]/Important", name: "Important", specialUse: "\\Important" },
      ],
    });
    assert.deepStrictEqual(discovered.folders.map((folder) => [folder.path, folder.wellKnown]), [
      ["INBOX", "inbox"],
      ["[Gmail]/All Mail", "all"],
      ["[Google Mail]/All Mail", "all"],
      ["All Mail", null],
      ["Everything", "all"],
    ]);
    function insertMailbox(id, email, profile) {
      db.insertAccount({
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
      });
    }
    insertMailbox("gmail-all", "leo@hkbscl.com", "gmail");
    db.replaceFolders("gmail-all", [
      { path: "INBOX", name: "INBOX", wellKnown: "inbox" },
      { path: "[Gmail]/All Mail", name: "[Gmail]/All Mail", wellKnown: null },
      { path: "[Gmail]/Sent Mail", name: "Sent Mail", wellKnown: "sentitems" },
      { path: "[Gmail]", name: "[Gmail]", wellKnown: null },
      { path: "Notes", name: "Notes", wellKnown: null },
      { path: "[Gmail]/Trash", name: "Trash", wellKnown: "deleteditems" },
    ], "/");
    const gmailAccount = engine.answer("mail:listAccounts").data.find((row) => row.id === "gmail-all");
    const gmailPrimary = gmailAccount.folders.primary.map((folder) => folder.wellKnownName);
    assert.deepStrictEqual(gmailPrimary, ["all", "inbox", "sentitems", "starred", "unread", "deleteditems"]);
    assert.strictEqual(gmailAccount.folders.primary[0].name, "All Mail");
    assert.strictEqual(gmailAccount.folders.primary[0].id, "[Gmail]/All Mail");
    assert.ok(gmailPrimary.indexOf("all") < gmailPrimary.indexOf("inbox"));
    assert.ok(gmailAccount.folders.more.some((folder) => folder.id === "Notes"));
    insertMailbox("plain-all", "plain@example.com", "custom");
    db.replaceFolders("plain-all", [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "All Mail", name: "All Mail", wellKnown: null },
    ], "/");
    const plainAccount = engine.answer("mail:listAccounts").data.find((row) => row.id === "plain-all");
    assert.ok(!plainAccount.folders.primary.some((folder) => folder.wellKnownName === "all"));
    assert.ok(plainAccount.folders.more.some((folder) => folder.id === "All Mail" && folder.name === "All Mail"));
    insertMailbox("special-all", "special@example.com", "custom");
    db.replaceFolders("special-all", [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Everything", name: "Everything", wellKnown: "all" },
    ], "/");
    const specialAccount = engine.answer("mail:listAccounts").data.find((row) => row.id === "special-all");
    assert.strictEqual(specialAccount.folders.primary[0].wellKnownName, "all");
    assert.strictEqual(specialAccount.folders.primary[0].name, "Everything");
    db.insertMessage({
      id: "m-all-archived",
      accountId: "gmail-all",
      folderPath: "[Gmail]/All Mail",
      uid: 1,
      uidValidity: 3,
      threadId: "thr-all",
      subject: "Archived client note",
      snippet: "kept",
      from: "Client <client@example.com>",
      date: "2026-10-01T00:00:00.000Z",
      listSortTs: 1759276800000,
      unread: false,
      bodyComplete: true,
    });
    db.insertMessage({
      id: "m-all-inbox",
      accountId: "gmail-all",
      folderPath: "INBOX",
      uid: 2,
      uidValidity: 3,
      threadId: "thr-in",
      subject: "Inbox only",
      snippet: "new",
      from: "Client <client@example.com>",
      date: "2026-10-02T00:00:00.000Z",
      listSortTs: 1759363200000,
      unread: true,
      bodyComplete: true,
    });
    db.insertMessage({
      id: "m-all-trash",
      accountId: "gmail-all",
      folderPath: "[Gmail]/Trash",
      uid: 3,
      uidValidity: 3,
      threadId: "thr-trash",
      subject: "Trash only",
      snippet: "gone",
      from: "Client <client@example.com>",
      date: "2026-10-03T00:00:00.000Z",
      listSortTs: 1759449600000,
      unread: false,
      bodyComplete: true,
    });
    assert.deepStrictEqual(
      engine.answer("mail:listFromCache", [{ accountId: "gmail-all", folderId: "[Gmail]/All Mail", limit: 20 }]).data.emails.map((row) => row.subject),
      ["Archived client note"],
    );
    assert.deepStrictEqual(
      engine.answer("mail:listFromCache", [{ accountId: "gmail-all", folderId: "INBOX", limit: 20 }]).data.emails.map((row) => row.subject),
      ["Inbox only"],
    );
    function primaryPair(id) {
      return db.primaryMailboxes().find((row) => row.accountId === id) || null;
    }
    function stampMessage(row) {
      db.insertMessage(Object.assign({
        uid: 1,
        uidValidity: 9,
        from: "Client <client@example.com>",
        date: "2026-10-22T00:00:00.000Z",
        listSortTs: 9000000000000,
        unread: false,
        bodyComplete: true,
        snippet: "primary",
      }, row));
    }
    db.updateMessage("m-all-archived", { list_sort_ts: 9000000000001 });
    db.updateMessage("m-all-inbox", { list_sort_ts: 9000000000002 });
    db.updateMessage("m-all-trash", { list_sort_ts: 9000000000003 });
    stampMessage({
      id: "m-all-unread",
      accountId: "gmail-all",
      folderPath: "[Gmail]/All Mail",
      uid: 4,
      threadId: "thr-all-unread",
      subject: "Unread in All Mail",
      listSortTs: 9000000000004,
      unread: true,
    });
    insertMailbox("outlook-primary", "outlook-primary@example.com", "outlook");
    db.replaceFolders("outlook-primary", [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Sent", name: "Sent", wellKnown: "sentitems" },
    ], "/");
    stampMessage({
      id: "m-outlook-in",
      accountId: "outlook-primary",
      folderPath: "INBOX",
      threadId: "thr-outlook-in",
      subject: "Outlook inbox",
      listSortTs: 9000000000005,
      unread: true,
    });
    stampMessage({
      id: "m-outlook-sent",
      accountId: "outlook-primary",
      folderPath: "Sent",
      uid: 2,
      threadId: "thr-outlook-sent",
      subject: "Outlook sent",
      listSortTs: 9000000000006,
    });
    insertMailbox("gmail-fallback", "fallback@example.com", "gmail");
    db.replaceFolders("gmail-fallback", [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "[Gmail]/Sent Mail", name: "Sent Mail", wellKnown: "sentitems" },
    ], "/");
    stampMessage({
      id: "m-fallback-in",
      accountId: "gmail-fallback",
      folderPath: "INBOX",
      threadId: "thr-fallback",
      subject: "Fallback inbox",
      listSortTs: 9000000000007,
      unread: true,
    });
    insertMailbox("gmail-well", "well@example.com", "gmail");
    db.replaceFolders("gmail-well", [
      { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
      { path: "Everything", name: "Everything", wellKnown: "all" },
    ], "/");
    stampMessage({
      id: "m-well-in",
      accountId: "gmail-well",
      folderPath: "INBOX",
      threadId: "thr-well-in",
      subject: "Well inbox",
      listSortTs: 9000000000008,
    });
    stampMessage({
      id: "m-well-all",
      accountId: "gmail-well",
      folderPath: "Everything",
      uid: 2,
      threadId: "thr-well-all",
      subject: "Well all",
      listSortTs: 9000000000009,
      unread: true,
    });
    stampMessage({
      id: "m-special-all",
      accountId: "special-all",
      folderPath: "Everything",
      threadId: "thr-special-all",
      subject: "Special all",
      listSortTs: 9000000000010,
    });
    stampMessage({
      id: "m-special-in",
      accountId: "special-all",
      folderPath: "INBOX",
      uid: 2,
      threadId: "thr-special-in",
      subject: "Special inbox",
      listSortTs: 9000000000011,
    });
    assert.equal(db.folderByPath("gmail-all", "[Gmail]/All Mail").well_known, null);
    assert.deepStrictEqual(db.pathsForKey("gmail-all", "all"), []);
    assert.deepStrictEqual(db.pathsForKey("special-all", "all").map((row) => row.path), ["Everything"]);
    assert.deepStrictEqual([primaryPair("gmail-all").path, primaryPair("gmail-all").role], ["[Gmail]/All Mail", "all"]);
    assert.deepStrictEqual([primaryPair("outlook-primary").path, primaryPair("outlook-primary").role], ["INBOX", "inbox"]);
    assert.deepStrictEqual([primaryPair("gmail-fallback").path, primaryPair("gmail-fallback").role], ["INBOX", "inbox"]);
    assert.deepStrictEqual([primaryPair("special-all").path, primaryPair("special-all").role], ["INBOX", "inbox"]);
    assert.deepStrictEqual([primaryPair("plain-all").path, primaryPair("plain-all").role], ["INBOX", "inbox"]);
    assert.deepStrictEqual([primaryPair("gmail-well").path, primaryPair("gmail-well").role], ["Everything", "all"]);
    const primaryIds = ["gmail-all", "outlook-primary", "gmail-fallback", "gmail-well", "special-all", "plain-all"];
    function subjectsFor(emails, accountId) {
      return emails.filter((row) => row.accountId === accountId).map((row) => row.subject).sort();
    }
    const primaryList = engine.answer("mail:listFromCache", [{ folderKey: "primary", limit: 40 }]).data.emails;
    assert.deepStrictEqual(subjectsFor(primaryList, "gmail-all"), ["Archived client note", "Unread in All Mail"]);
    assert.deepStrictEqual(subjectsFor(primaryList, "outlook-primary"), ["Outlook inbox"]);
    assert.deepStrictEqual(subjectsFor(primaryList, "gmail-fallback"), ["Fallback inbox"]);
    assert.deepStrictEqual(subjectsFor(primaryList, "gmail-well"), ["Well all"]);
    assert.deepStrictEqual(subjectsFor(primaryList, "special-all"), ["Special inbox"]);
    const pairs = db.primaryMailboxes()
      .filter((row) => primaryIds.includes(row.accountId))
      .map((row) => ({ accountId: row.accountId, path: row.path, role: row.role }));
    const boxed = engine.answer("mail:listFromCache", [{ mailboxes: pairs, limit: 40 }]).data.emails;
    assert.deepStrictEqual(
      boxed.map((row) => row.id).sort(),
      primaryList.filter((row) => primaryIds.includes(row.accountId)).map((row) => row.id).sort(),
    );
    assert.deepStrictEqual(
      subjectsFor(engine.answer("mail:listFromCache", [{ folderKey: "primary", filterUnread: true, limit: 40 }]).data.emails, "gmail-all"),
      ["Unread in All Mail"],
    );
    assert.deepStrictEqual(
      engine.answer("mail:listFromCache", [{ accountId: "gmail-all", folderId: "[Gmail]/All Mail", limit: 20 }]).data.emails.map((row) => row.subject).sort(),
      ["Archived client note", "Unread in All Mail"],
    );
    assert.deepStrictEqual(
      engine.answer("mail:listFromCache", [{ accountId: "gmail-all", folderKey: "inbox", limit: 20 }]).data.emails.map((row) => row.subject),
      ["Inbox only"],
    );
    const until = new Date(Date.now() + 3600000).toISOString();
    db.setSnooze("gmail-all", "thr-all", until);
    const snoozedPrimary = engine.answer("mail:listFromCache", [{ folderKey: "primary", limit: 40 }]).data.emails;
    assert.equal(snoozedPrimary.some((row) => row.accountId === "gmail-all" && row.threadId === "thr-all"), false);
    assert.equal(snoozedPrimary.some((row) => row.subject === "Unread in All Mail"), true);
    assert.equal(
      engine.answer("mail:listFromCache", [{ accountId: "gmail-all", folderId: "[Gmail]/All Mail", limit: 20 }]).data.emails.some((row) => row.threadId === "thr-all"),
      true,
    );
    db.clearSnooze("gmail-all", "thr-all");
    db.setSnooze("gmail-fallback", "thr-fallback", until);
    assert.equal(engine.answer("mail:listFromCache", [{ folderKey: "primary", limit: 40 }]).data.emails.some((row) => row.id === "m-fallback-in"), false);
    db.clearSnooze("gmail-fallback", "thr-fallback");
    assert.equal(engine.answer("mail:listFromCache", [{ folderKey: "primary", limit: 40 }]).data.emails.some((row) => row.id === "m-fallback-in"), true);
    db.removeAccount("gmail-all");
    db.removeAccount("plain-all");
    db.removeAccount("special-all");
    db.removeAccount("outlook-primary");
    db.removeAccount("gmail-fallback");
    db.removeAccount("gmail-well");
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
    assert.strictEqual(inbox.sync_horizon_days, 0);
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
    assert.strictEqual(db.folderByPath("imap-ol", "INBOX").sync_horizon_days, 0);

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
    assert.strictEqual(db.folderByPath("imap-old", "INBOX").sync_horizon_days, 0);
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
    assert.strictEqual(db.folderByPath("imap-old", "INBOX").sync_horizon_days, 0);
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
    assert.deepStrictEqual([...new Set(touched)].sort(), ["INBOX", "Notes"]);
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
    assert.strictEqual(engine.syncPolicy.syncDays, 0);
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
    if (new URL(href).searchParams.get("$select") === "id") return jsonResponse({}, 404);
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
        if (new URL(url).searchParams.get("$select") === "id") return String(url).includes("/inbox?") ? jsonResponse({ id: "in" }) : jsonResponse({}, 404);
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
      if (new URL(href).searchParams.get("$select") === "id") return jsonResponse({}, 404);
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
    assert.deepStrictEqual(calendarApi.selectedCalendarIds([
      { id: "work" },
      { id: "home", primary: true },
    ], { calendarIds: ["missing", "work", "work", "home"] }), ["work", "home"]);
    assert.deepStrictEqual(calendarApi.selectedCalendarIds([
      { id: "work" },
      { id: "home", primary: true },
    ], { calendarId: "work" }), ["work"]);
    assert.deepStrictEqual(calendarApi.selectedCalendarIds([
      { id: "work" },
      { id: "home", primary: true },
    ], {}), ["home"]);
    const merged = await calendarApi.listEventsForIds("google", "token", ["home", "work"], {
      timeMin: "2026-10-01T00:00:00.000Z",
      timeMax: "2026-11-01T00:00:00.000Z",
    }, async (url) => {
      const home = String(url).includes("/calendars/home/");
      return jsonResponse({
        items: [{
          id: home ? "h" : "w",
          summary: home ? "Home" : "Work",
          start: { dateTime: "2026-10-02T10:00:00Z" },
          end: { dateTime: "2026-10-02T11:00:00Z" },
        }],
      });
    });
    assert.deepStrictEqual(merged.calendarIds, ["home", "work"]);
    assert.deepStrictEqual(merged.events.map((event) => event.calendarId), ["home", "work"]);
    const rateSeen = [];
    await assert.rejects(() => calendarApi.listEventsForIds("google", "token", ["a", "b"], {
      timeMin: "2026-10-01T00:00:00.000Z",
      timeMax: "2026-11-01T00:00:00.000Z",
    }, async (url) => {
      rateSeen.push(String(url));
      return jsonResponse({}, 429);
    }));
    assert.deepStrictEqual(rateSeen.map((url) => url.includes("/calendars/b/")), [false]);
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
    assert.deepStrictEqual(calendarApi.googleEventBody({
      title: "Offsite",
      allDay: true,
      start: "2026-10-01",
      end: "2026-10-02",
    }).start, { date: "2026-10-01" });
    const described = calendarApi.normalizeGoogleEvent({
      id: "evt-html",
      summary: "Notes",
      description: "<b>Hello</b><br>Next",
      start: { date: "2026-10-03" },
      end: { date: "2026-10-04" },
    }, "cal-1");
    assert.strictEqual(described.allDay, true);
    assert.strictEqual(described.description, "Hello\nNext");
    const preview = calendarApi.normalizeGraphEvent({
      id: "evt-prev",
      subject: "Brief",
      start: { dateTime: "2026-10-06T15:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-10-06T16:00:00.0000000", timeZone: "UTC" },
      isAllDay: false,
      bodyPreview: "Bring the brief",
    }, "cal-ms");
    assert.strictEqual(preview.description, "Bring the brief");
    let patched = null;
    await calendarApi.updateEvent("google", "token", "cal-1", "evt-new", {
      title: "Standup",
      start: "2026-10-17T10:00:00.000Z",
      end: "2026-10-17T11:00:00.000Z",
      description: "Agenda",
      descriptionBase: "",
    }, async (url, init) => {
      if (init.method === "GET") return jsonResponse({ id: "evt-new", description: "", etag: '"calendar-revision"' });
      assert.strictEqual(init.headers["if-match"], '"calendar-revision"');
      patched = { url: String(url), method: init.method, body: JSON.parse(init.body) };
      return jsonResponse({
        id: "evt-new",
        summary: "Standup",
        description: "Agenda",
        start: { dateTime: "2026-10-17T10:00:00Z" },
        end: { dateTime: "2026-10-17T11:00:00Z" },
      });
    });
    assert.ok(patched.url.endsWith("/events/evt-new"));
    assert.strictEqual(patched.method, "PATCH");
    assert.strictEqual(patched.body.description, "Agenda");
    let removedEvent = null;
    const deleted = await calendarApi.deleteEvent("google", "token", "cal-1", "evt-new", async (url, init) => {
      removedEvent = { url: String(url), method: init.method };
      return jsonResponse({}, 204);
    });
    assert.strictEqual(removedEvent.method, "DELETE");
    assert.strictEqual(deleted.deleted, true);
    await assert.rejects(
      () => calendarApi.updateEvent("google", "token", "cal-1", "", {
        title: "Standup",
        start: "2026-10-17T10:00:00.000Z",
        end: "2026-10-17T11:00:00.000Z",
      }, async () => jsonResponse({})),
      (error) => error && error.code === "invalid",
    );
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
        if (new URL(href).searchParams.get("$select") === "id") return href.includes("/inbox?") ? jsonResponse({ id: "inbox-id" }) : jsonResponse({}, 404);
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
        return jsonResponse({ value: [
          { id: "cal-ms", name: "Grace", isDefaultCalendar: true },
          { id: "cal-home", name: "Home", isDefaultCalendar: false },
        ] });
      }
      if (href.includes("/calendarView")) {
        const calendarId = decodeURIComponent(href.split("/calendars/")[1].split("/")[0]);
        const home = calendarId === "cal-home";
        return jsonResponse({
          value: [{
            id: home ? "evt-home" : "evt-1",
            subject: home ? "Home lunch" : "Design review",
            start: { dateTime: home ? "2026-10-07T15:00:00Z" : "2026-10-06T15:00:00Z" },
            end: { dateTime: home ? "2026-10-07T16:00:00Z" : "2026-10-06T16:00:00Z" },
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
    const deniedUpdate = await engine.answer("calendar:updateEvent", [{
      accountId: "gmail-live",
      calendarId: "cal-1",
      eventId: "evt-1",
      title: "Nope",
      start: "2026-10-17T10:00:00.000Z",
      end: "2026-10-17T11:00:00.000Z",
    }]);
    assert.strictEqual(deniedUpdate.success, false);
    assert.strictEqual(calls.length, 0);
    const deniedDelete = await engine.answer("calendar:deleteEvent", [{
      accountId: "gmail-live",
      calendarId: "cal-1",
      eventId: "evt-1",
    }]);
    assert.strictEqual(deniedDelete.success, false);
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
    assert.deepStrictEqual(month.data.calendarIds, ["cal-ms"]);
    const both = await engine.answer("calendar:list", [{
      accountId: "outlook-live",
      timeMin: october.timeMin,
      timeMax: october.timeMax,
      calendarIds: ["cal-home", "cal-ms", "missing"],
    }]);
    assert.strictEqual(both.success, true);
    assert.deepStrictEqual(both.data.calendarIds, ["cal-home", "cal-ms"]);
    assert.strictEqual(both.data.calendarId, "cal-home");
    assert.deepStrictEqual(both.data.events.map((event) => [event.id, event.calendarId]), [
      ["evt-home", "cal-home"],
      ["evt-1", "cal-ms"],
    ]);
    const fallbackIds = await engine.answer("calendar:list", [{
      accountId: "outlook-live",
      timeMin: october.timeMin,
      timeMax: october.timeMax,
      calendarIds: ["missing"],
    }]);
    assert.deepStrictEqual(fallbackIds.data.calendarIds, ["cal-ms"]);
    assert.strictEqual(fallbackIds.data.events[0].id, "evt-1");
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
    if (request === "node:process") return { platform: "win32" };
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
        if (new URL(href).searchParams.get("$select") === "id") return href.includes("/archive?") ? jsonResponse({ id: "archive-id" }) : jsonResponse({}, 404);
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
    assert.ok(html.includes('id="inbox-rules-open"') && html.includes(">Inbox Automation</span>"));
    assert.ok(html.includes('id="brain-tab-rules"') && html.includes(">Automation</button>") && html.includes('id="brain-rules-title">Inbox Automation Rules</h3>'));
    assert.ok(html.includes("Each row is one rule.") && html.includes('placeholder="File invoices"') && html.includes('placeholder="newsletter@example.com"') && html.includes('placeholder="billing@example.com"') && html.includes('placeholder="invoice"') && html.includes('placeholder="amount due"'));
    assert.ok(appJs.includes("Pick a folder, or leave mail where it is") && appJs.includes("Pick a label, or add none"));
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
    assert.strictEqual(rulesAuth.searchParams.get("prompt"), null);
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

async function checkFetchedModelChooser() {
  const { renderer } = require("./check-ux-workflows");
  const elements = new Map();
  const calls = [];
  const queue = [];
  function FakeEl(id) {
    const listeners = {};
    const attrs = {};
    const classes = new Set();
    const el = {
      value: "",
      hidden: false,
      textContent: "",
      className: "",
      size: 0,
      placeholder: "",
      options: [],
      children: [],
      parentNode: null,
      addEventListener(type, fn) {
        (listeners[type] || (listeners[type] = [])).push(fn);
      },
      dispatchEvent(event) {
        for (const fn of listeners[event.type] || []) fn(event);
        return true;
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      },
      setAttribute(name, value) {
        attrs[name] = String(value);
      },
      removeAttribute(name) {
        delete attrs[name];
      },
      remove() {
        if (el.parentNode && Array.isArray(el.parentNode.children)) {
          el.parentNode.children = el.parentNode.children.filter((child) => child !== el);
        }
        el.parentNode = null;
      },
      closest() { return null; },
      querySelector() { return null; },
      contains() { return false; },
      replaceChildren() {
        el.options = [];
        el.children = [];
      },
      appendChild(child) {
        child.parentNode = el;
        el.children.push(child);
        el.options.push(child);
        return child;
      },
      insertBefore(node, before) {
        node.parentNode = el;
        const index = before ? el.children.indexOf(before) : -1;
        el.children.splice(index < 0 ? el.children.length : index, 0, node);
        return node;
      },
    };
    el.classList = {
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name);
        else classes.delete(name);
        el.className = [...classes].join(" ");
        return on;
      },
      add(name) {
        classes.add(name);
        el.className = [...classes].join(" ");
      },
      remove(name) {
        classes.delete(name);
        el.className = [...classes].join(" ");
      },
      contains(name) {
        return classes.has(name);
      },
    };
    let currentId = id || "";
    Object.defineProperty(el, "id", {
      get() { return currentId; },
      set(next) {
        if (currentId && elements.get(currentId) === el) elements.delete(currentId);
        currentId = String(next || "");
        if (currentId) elements.set(currentId, el);
      },
    });
    if (currentId) elements.set(currentId, el);
    return el;
  }
  for (const id of ["ai-base", "ai-model", "ai-key", "ai-status", "ai-dirty", "ai-model-select"]) FakeEl(id);
  const chooser = FakeEl("ai-model-chooser");
  chooser.hidden = true;
  const ui = renderer({
    Event,
    document: {
      getElementById(id) { return elements.get(id) || null; },
      createElement() { return FakeEl(""); },
    },
    window: {
      morrow: {
        invoke(channel, payload) {
          calls.push({ channel, payload: payload ? { ...payload } : payload });
          if (!queue.length) return Promise.reject(new Error("no queued AI result"));
          return Promise.resolve(queue.shift());
        },
      },
    },
  });
  ui.run(`
    $("ai-base").value = "https://example.test/v1";
    $("ai-model").value = "typed-model";
    $("ai-key").value = "";
    aiBaseline = aiFormState();
    globalThis.modelInputs = 0;
    $("ai-model").addEventListener("input", () => { globalThis.modelInputs += 1; });
  `);
  queue.push({ ok: true, models: [" alpha ", "beta", "alpha", "", 3] });
  await ui.run("fetchAiModels()");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].channel, "host:aiListModels");
  assert.strictEqual(calls[0].payload.baseUrl, "https://example.test/v1");
  assert.strictEqual(calls[0].payload.apiKey, "");
  assert.strictEqual(ui.run('$("ai-model").value'), "typed-model");
  assert.strictEqual(ui.run('$("ai-model-chooser").hidden'), false);
  assert.deepStrictEqual(ui.run('$("ai-model-select").options.map((option) => option.value)'), ["", "alpha", "beta"]);
  assert.strictEqual(ui.run('$("ai-model-select").options[0].textContent'), "Choose a model");
  assert.strictEqual(ui.run('$("ai-model-select").size'), 3);
  assert.strictEqual(ui.run('$("ai-model-select").value'), "");
  assert.match(ui.run('$("ai-status").textContent'), /Fetched 2 models/);
  ui.run('chooseFetchedModel()');
  assert.strictEqual(ui.run('$("ai-model").value'), "typed-model");
  assert.strictEqual(ui.run("modelInputs"), 0);
  ui.run('$("ai-model-select").value = "beta"; chooseFetchedModel();');
  assert.strictEqual(ui.run('$("ai-model").value'), "beta");
  assert.strictEqual(ui.run("modelInputs"), 1);
  assert.strictEqual(ui.run('$("ai-dirty").hidden'), false);
  assert.match(ui.run('$("ai-dirty").textContent'), /Unsaved changes/);
  ui.run('$("ai-model-select").value = "beta"; chooseFetchedModel();');
  assert.strictEqual(ui.run("modelInputs"), 1);
  queue.push({ ok: false, message: "Could not list models." });
  await ui.run("fetchAiModels()");
  assert.strictEqual(ui.run('$("ai-model-chooser").hidden'), false);
  assert.strictEqual(ui.run('$("ai-status").textContent'), "Could not list models.");
  assert.strictEqual(ui.run('$("ai-status").classList.contains("error")'), true);
  assert.strictEqual(ui.run('$("ai-model").value'), "beta");
  queue.push({ ok: true, models: [] });
  await ui.run("fetchAiModels()");
  assert.strictEqual(ui.run('$("ai-model-chooser").hidden'), true);
  assert.match(ui.run('$("ai-status").textContent'), /No models returned/);
  assert.strictEqual(ui.run('$("ai-status").classList.contains("error")'), false);
  assert.strictEqual(ui.run('$("ai-model").value'), "beta");
}

async function checkTranslateBatches() {
  const translate = require("../host/translate");
  const piece = "a".repeat(5000) + "TAIL";
  const parts = translate.splitSegment(piece, translate.SEGMENT_CHARS);
  assert.strictEqual(parts.join(""), piece);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= translate.SEGMENT_CHARS));
  assert.ok(parts[parts.length - 1].endsWith("TAIL"));
  const sent = [];
  let system = "";
  const long = await translate.translateSegments([{ node_id: "n0", text: piece }], {
    targetLanguage: "zh-Hant",
    complete: async (messages) => {
      system = messages[0].content;
      const rows = JSON.parse(messages[1].content);
      for (const row of rows) {
        assert.ok(row.text.length <= translate.SEGMENT_CHARS);
        sent.push(row.text);
      }
      return JSON.stringify({ translations: rows.map((row) => ({ node_id: row.node_id, text: "譯" })) });
    },
  });
  assert.strictEqual(sent.join(""), piece);
  assert.ok(sent.length > 1);
  assert.strictEqual(long[0].node_id, "n0");
  assert.ok(long[0].text.includes("譯"));
  assert.match(system, /Traditional Chinese \(zh-Hant\)/);
  assert.doesNotMatch(system, /into Simplified/);
  let defaultSystem = "";
  await translate.translateSegments([{ node_id: "n0", text: "Hi" }], {
    complete: async (messages) => {
      defaultSystem = messages[0].content;
      const rows = JSON.parse(messages[1].content);
      return JSON.stringify({ translations: rows.map((row) => ({ node_id: row.node_id, text: "嗨" })) });
    },
  });
  assert.match(defaultSystem, /Traditional Chinese \(zh-Hant\)/);
  let fatalCalls = 0;
  await assert.rejects(() => translate.translateSegments([{ node_id: "n0", text: "Hello" }], {
    targetLanguage: "zh-Hant",
    complete: async () => {
      fatalCalls += 1;
      const error = new Error("Add an API key in Morrow Mail → AI Setup.");
      error.code = "ai-unconfigured";
      throw error;
    },
  }));
  assert.strictEqual(fatalCalls, 1);
  let splitCalls = 0;
  let splitSystem = "";
  const left = "A".repeat(1000);
  const right = "B".repeat(1000);
  const split = await translate.translateSegments([
    { node_id: "n0", text: left },
    { node_id: "n1", text: right },
  ], {
    targetLanguage: "en",
    complete: async (messages) => {
      splitCalls += 1;
      splitSystem = messages[0].content;
      const rows = JSON.parse(messages[1].content);
      if (rows.length > 1) return "not-json";
      return JSON.stringify({ translations: rows.map((row) => ({ node_id: row.node_id, text: "X" + row.node_id })) });
    },
  });
  assert.ok(splitCalls >= 3);
  assert.deepStrictEqual(split.map((row) => row.text), ["Xn0#0", "Xn1#0"]);
  assert.match(splitSystem, /into English/);
  assert.doesNotMatch(splitSystem, /Traditional Chinese/);
}

checkGoogleOauthAlias();
require("./check-bake-google-oauth").run();
require("./check-win-secrets").run();
require("./check-bot-client").run();
require("./check-cli-capabilities").run();
require("./check-bot-setup-ux").run();

checkFetchedModelChooser().then(() => require("./check-bot-probe").run()).then(() => require("./check-macos-sign").run()).then(() => checkUpdateAuth()).then(() => checkAiDraft()).then(() => checkComposeMailbox()).then(() => checkTidy()).then(() => checkProviderApi()).then(() => checkInboxRules()).then(() => require("./check-mail-calendar-consent").run()).then(() => require("./check-oauth-graph-regressions").run()).then(() => require("./check-mail-reader").run()).then(() => require("./check-account-recovery").run()).then(() => require("./check-mail-serialization").run()).then(() => require("./check-star").run()).then(() => require("./check-settings-horizon").run()).then(() => require("./check-vacation").run()).then(() => checkOauthSession()).then(() => checkAiModels()).then(() => require("./check-idle").run()).then(() => require("./check-sync-retry").run()).then(() => require("./check-bot-bridge").run()).then(() => require("./check-bot-send-authorization").run()).then(() => require("./check-ux-workflows").run()).then(() => require("./check-operation-receipts").run()).then(() => require("./check-mail-actions").run()).then(() => require("./check-compose-recovery").run()).then(() => require("./check-dialog-feedback").run()).then(() => require("./check-search-scope").run()).then(() => require("./check-rules-context").run()).then(() => require("./check-scheduled-management").run()).then(() => require("./check-quit-scheduled").run()).then(() => require("./check-ux-remainder").run()).then(() => require("./check-mail-persistence").run()).then(() => {
  return require("./check-compose-identity").run();
}).then(() => require("./check-batch-b").run()).then(() => require("./check-background-folders").run()).then(() => require("./check-overnight-bodies").run()).then(() => require("./check-mail-review-regressions").run()).then(() => require("./check-confirmed-identity").run()).then(() => require("./check-move-calendar-patches").run()).then(() => require("./check-draft-scheduled-recovery").run()).then(() => require("./check-draft-partial-delivery").run()).then(() => require("./check-draft-revisions").run()).then(() => {
  // This fixture supplies its own Electron file dialogs; isolate it from the
  // earlier suites' VM-loaded host and native-window mocks.
  const result = spawnSync(process.execPath, [path.join(root, "scripts/check-account-calendar-attachments.js")], { stdio: "inherit", timeout: 30000 });
  assert.strictEqual(result.status, 0, "Account/calendar/attachment fixture failed");
  const liveness = spawnSync(process.execPath, [path.join(root, "scripts/check-account-liveness.js")], { stdio: "inherit", timeout: 30000 });
  assert.strictEqual(liveness.status, 0, "Account liveness fixture failed");
  for (const name of ["check-ipc-diagnostics.js", "check-bot-provider-metadata.js", "check-reconnect-calendar-preservation.js", "check-chatgpt.js", "check-chatgpt-ui.js", "check-ai-settings-ownership.js", "check-imap-client-errors.js", "check-ai-consent.js", "check-gmail-mail-api.js", "check-sender-names.js"]) {
    const fixture = spawnSync(process.execPath, [path.join(root, "scripts", name)], { stdio: "inherit", timeout: 30000 });
    assert.strictEqual(fixture.status, 0, name + " failed");
  }
}).then(() => checkTranslateBatches()).then(() => {
  console.log("ui-path-ok");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
