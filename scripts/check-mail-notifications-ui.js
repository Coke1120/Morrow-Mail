// Real preload + first-party Settings + production preference validation. No OS UI.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-notification-ui-"));
process.env.MORROW_USER_DATA = dir;
const settings = require("../host/settings"), notifications = require("../host/mail/notifications");
const root = path.join(__dirname, "..");
const { after } = require("node:test");
after(() => { notifications.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "renderer/index.html"), "utf8")), document = dom.window.document;
  let bridge, notificationTarget = null;
  const calls = [], events = new Map();
  vm.runInNewContext(fs.readFileSync(path.join(root, "renderer/preload.js"), "utf8"), { require(name) {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld(key, value) { if (key === "morrow") bridge = value; } },
      ipcRenderer: { async invoke(channel, ...args) {
        calls.push([channel, ...args]);
        if (channel === "mail:getNotificationSettings") return { success: true, data: notifications.status() };
        if (channel === "mail:takeNotificationTarget") { const value = notificationTarget; notificationTarget = null; return { success: true, data: value }; }
        const result = settings.answer(channel, args); assert.notEqual(result, undefined, channel); return result;
      }, on(channel, callback) { events.set(channel, callback); }, removeListener() {} } };
  } });
  const ui = renderer({ document, window: { morrow: bridge }, setTimeout: () => 1, clearTimeout() {} });
  ui.run("paintPrefs = () => {}; syncAccentPicker = () => {}; applyShellTheme = () => {}; ");
  return { dom, document, bridge, ui, calls, events, get: id => document.getElementById(id), target(value) { notificationTarget = value; } };
}

test("Settings uses the real allowlisted preload, strict values, durable defaults and save/error feedback", async () => {
  const f = fixture();
  await f.ui.run("loadSettings()");
  assert.equal(f.get("pref-mail-notifications").checked, true); assert.equal(f.get("pref-mail-notification-preview").value, "hidden");
  f.get("pref-mail-notifications").checked = false;
  await f.ui.run("savePref(prefRows().find(row => row[0] === 'pref-mail-notifications'))");
  assert.equal(settings.notificationPreferences().enabled, false);
  assert.match(f.get("mail-notification-status").textContent, /off/);
  f.get("pref-mail-notification-preview").value = "sender";
  await f.ui.run("savePref(prefRows().find(row => row[0] === 'pref-mail-notification-preview'))");
  assert.equal(settings.notificationPreferences().preview, "sender");
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.equal(persisted.mailNotificationPreview, "sender"); assert.equal(persisted.mailNotificationsEnabled, false);
  for (const value of ["true", 1, {}, null]) await assert.rejects(f.bridge.invoke("morrow:configSetMailNotificationsEnabled", value), /on or off/);
  for (const value of ["html", "sender-and-body", true, null, {}]) await assert.rejects(f.bridge.invoke("morrow:configSetMailNotificationPreview", value), /preview/);
  await assert.rejects(f.bridge.invoke("mail:showNotification", "untrusted content"));
  f.get("pref-mail-notification-preview").value = "";
  await f.ui.run("savePref(prefRows().find(row => row[0] === 'pref-mail-notification-preview'))");
  assert.equal(f.get("pref-mail-notification-preview").value, "sender"); assert.match(f.get("settings-status").textContent, /preview/);
  assert.equal(f.get("pref-save-status-pref-mail-notification-preview").getAttribute("role"), "status");
  await f.bridge.invoke("morrow:configSetMailNotificationsEnabled", true);
  await f.ui.run("refreshMailNotificationStatus()"); assert.match(f.get("mail-notification-status").textContent, /unavailable/);
  for (const id of ["pref-mail-notifications", "pref-mail-notification-preview"]) {
    const control = f.get(id); assert.ok(f.document.querySelector(`label[for='${id}']`));
    for (const described of control.getAttribute("aria-describedby").split(/\s+/)) assert.ok(f.get(described));
  }
  assert.match(f.get("mail-notifications-help").textContent, /running.*syncing.*Do Not Disturb/);
  f.dom.window.close();
});

test("click routing waits for shell/account readiness and opens the validated account/message; invalid/missing targets stay safe", async () => {
  const f = fixture(), navigation = [];
  f.ui.context.navigation = navigation;
  f.ui.run(`
    state.accounts = [{ id: 'a' }, { id: 'b' }];
    showMail = () => navigation.push('mail');
    selectFolder = async (accountId, folderId) => { state.accountId = accountId; state.folderId = folderId; navigation.push([accountId, folderId]); };
    openMessage = async id => navigation.push(id);
    showStatus = text => navigation.push(text);
  `);
  f.target({ accountId: "b", folderId: "INBOX", messageId: "b-new" });
  await f.ui.run("onMailNotificationClick()"); assert.equal(navigation.length, 0);
  f.ui.run("notificationShellReady = true");
  await f.ui.run("onMailNotificationClick()");
  assert.deepEqual(JSON.parse(JSON.stringify(navigation)), ["mail", ["b", "INBOX"], "b-new"]);
  f.target({ accountId: "a", folderId: "INBOX", messageId: null });
  await f.ui.run("onMailNotificationClick()"); assert.match(navigation.at(-1), /no longer available/);
  const count = navigation.length;
  f.target({ accountId: "\0bad", folderId: "INBOX", messageId: "x" });
  await f.ui.run("onMailNotificationClick()"); assert.equal(navigation.length, count);
  await f.ui.run("onMailNotificationClick()"); assert.equal(navigation.length, count);
  assert.ok(f.calls.every(([name]) => name === "mail:takeNotificationTarget"));
  f.bridge.on("mail:notificationClicked", () => {}); assert.ok(f.events.has("mail:notificationClicked"));
  f.dom.window.close();
});

test("main-process notification wiring keeps Windows identity aligned and exposes no renderer show channel", () => {
  const main = fs.readFileSync(path.join(root, "host/main.js"), "utf8"), pkg = require("../package.json");
  assert.ok(main.includes(`app.setAppUserModelId(${JSON.stringify(pkg.build.appId)})`));
  assert.notEqual(pkg.build.nsis.createStartMenuShortcut, false);
  assert.ok(main.includes("mailNotifications.configure({ Notification, platform: process.platform"));
  assert.ok(main.includes('win.webContents.send("mail:notificationClicked")'));
});
