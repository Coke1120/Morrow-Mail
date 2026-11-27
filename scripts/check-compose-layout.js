// Plain Node: display-aware native placement and unchanged window/seed lifecycle.
// Rendered geometry is covered separately by check-reply-history-browser.js and
// check-compose-window.js, which require Chromium / a graphical Electron session.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { composeWindowBounds } = require("../host/compose-window");

const root = path.join(__dirname, "..");
const primary = { x: 0, y: 24, width: 1920, height: 1056 };
const secondary = { x: -1280, y: 20, width: 1280, height: 720 };
const fits = (bounds, area) => {
  assert.ok(bounds.x >= area.x && bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
  assert.ok(bounds.minWidth <= bounds.width && bounds.minHeight <= bounds.height);
};

assert.deepEqual(composeWindowBounds(null, 0), { width: 1200, height: 900, minWidth: 720, minHeight: 560 });
for (const area of [primary, secondary, { x: 1600, y: -900, width: 600, height: 400 }]) {
  for (let index = 0; index < 12; index++) {
    for (const parent of [null, { x: area.x + area.width - 50, y: area.y + area.height - 50 }, { x: -9000, y: 9000 }]) {
      fits(composeWindowBounds(parent, index, area), area);
    }
  }
}
const large = composeWindowBounds(null, 0, primary);
assert.equal(large.width, 1200); assert.equal(large.height, 900);
assert.equal(large.x, 360); assert.equal(large.y, 102);
const compact = composeWindowBounds(null, 0, { x: 0, y: 0, width: 600, height: 400 });
assert.equal(compact.width, 568); assert.equal(compact.height, 368);
assert.equal(compact.minWidth, 568); assert.equal(compact.minHeight, 368);
assert.deepEqual(composeWindowBounds(null, 0, { ...primary, width: NaN }), composeWindowBounds(null, 0));

const handles = new Map(), listeners = new Map(), windows = [], matches = [];
let nextId = 0, primaryReads = 0, screenUnavailable = false;
class Window extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.destroyed = false;
    this.webContents = new EventEmitter();
    Object.assign(this.webContents, {
      id: ++nextId, sent: [], menuShortcutFilters: [], isLoading: () => false,
      setIgnoreMenuShortcuts(value) { this.menuShortcutFilters.push(value); },
      setWindowOpenHandler() {}, send(channel) { this.sent.push(channel); },
    });
    windows.push(this);
  }
  static fromWebContents(contents) { return contents.owner || null; }
  getBounds() { return this.options; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return true; }
  focus() {}
  setTitle(title) { this.title = title; }
  loadFile(file, options) { this.loaded = { file, options }; return Promise.resolve(); }
  close() {
    let prevented = false;
    this.emit("close", { preventDefault() { prevented = true; } });
    if (!prevented) { this.destroyed = true; this.emit("closed"); }
  }
}
const electron = {
  BrowserWindow: Window,
  ipcMain: { handle(channel, fn) { handles.set(channel, fn); }, on(channel, fn) { listeners.set(channel, fn); } },
  screen: {
    getDisplayMatching(bounds) {
      if (screenUnavailable) throw new Error("display unavailable");
      matches.push(bounds); return { workArea: bounds.x < 0 ? secondary : primary };
    },
    getPrimaryDisplay() { primaryReads++; if (screenUnavailable) throw new Error("display unavailable"); return { workArea: primary }; },
  },
};
const moduleFixture = { exports: {} };
const platformFixture = { platform: "darwin" };
vm.runInNewContext(fs.readFileSync(path.join(root, "host/compose-window.js"), "utf8"), {
  module: moduleFixture, URL, process: platformFixture,
  require(name) {
    if (name === "electron") return electron;
    if (name === "./compose-editing-menu") return { installComposeEditingMenu() {} };
    throw new Error("Unexpected dependency: " + name);
  },
});
let parent = { isDestroyed: () => false, getBounds: () => ({ x: 100, y: 50, width: 1300, height: 900 }) };
const host = moduleFixture.exports.createComposeHost({ getParent: () => parent, htmlFile: "renderer/index.html", mode: "bundled" });
host.register();
const reader = { isDestroyed: () => false, getBounds: () => ({ x: -1250, y: 50, width: 960, height: 660 }) };
const seed = { title: "Reply all", kind: "all", to: "sender@example.test", cc: "participant@example.test", bcc: "", body: "Saved reply" };
const open = owner => handles.get("compose:open")({ sender: { owner } }, seed);
open(reader);
const reply = windows.at(-1);
assert.equal(matches.at(-1).x, -1250, "the detached reader, not the shell, selects the display");
fits(reply.options, secondary);
assert.equal(reply.options.width, 1200); assert.equal(reply.options.height, 688);
assert.equal(reply.options.parent, undefined); assert.equal(reply.options.modal, undefined);
assert.equal(reply.options.webPreferences.contextIsolation, true);
assert.equal(reply.loaded.options.query.role, "compose");
for (const input of [
  { type: "keyDown", key: "h", meta: true },
  { type: "keyUp", key: "h", meta: true },
  { type: "keyDown", key: "z", meta: true },
  { type: "keyDown", key: "H", meta: true, shift: true },
  { type: "keyDown", key: "h", meta: true, control: true },
  { type: "keyDown", key: "h", meta: true, alt: true },
]) reply.webContents.emit("before-input-event", {}, input);
assert.deepEqual(reply.webContents.menuShortcutFilters, [true, false, false, false, false, false],
  "only exact macOS Cmd+H keydown bypasses the menu in Compose");
seed.body = "Newer external edit";
const pulled = handles.get("compose:pullSeed")({ sender: reply.webContents });
assert.equal(pulled.body, "Saved reply"); assert.equal(pulled.cc, "participant@example.test"); assert.equal(pulled.bcc, "");
reply.close();
assert.equal(reply.destroyed, false, "native close still asks renderer to review unsaved work");
assert.equal(reply.webContents.sent.at(-1), "compose:requestClose");
listeners.get("compose:allowClose")({ sender: reply.webContents });
assert.equal(reply.destroyed, true); assert.equal(host.records.size, 0);
open(reader); fits(windows.at(-1).options, secondary);
assert.equal(windows.at(-1).options.x, reply.options.x, "reopen does not walk off screen");
open({ isDestroyed: () => true });
assert.equal(matches.at(-1).x, 100, "destroyed opener falls back to the live shell");
parent = null; open(null);
assert.ok(primaryReads > 0); fits(windows.at(-1).options, primary);
screenUnavailable = true; platformFixture.platform = "win32"; open(null);
assert.equal(windows.at(-1).webContents.listenerCount("before-input-event"), 0);
assert.equal(windows.at(-1).options.width, 1200, "display lookup failure retains the default");

// Disclosure preserves the guidance without collapsing live file feedback.
const dom = new JSDOM(fs.readFileSync(path.join(root, "renderer/index.html"), "utf8"));
const document = dom.window.document, help = document.getElementById("compose-editing-help");
assert.equal(help.open, false);
assert.match(help.textContent, /spelling corrections/);
assert.match(help.textContent, /Forward includes the original files/);
assert.match(help.textContent, /Wait for Preparing attachment/);
assert.equal(document.getElementById("compose-attachments").closest("details"), null);
assert.equal(document.getElementById("compose-attach-error").closest("details"), null);
for (const id of ["compose-status", "compose-send", "compose-save", "compose-close"]) {
  assert.equal(document.getElementById(id).closest(".compose-draft"), null, id + " stays outside draft scrolling");
}
dom.window.close();
console.log("compose-layout-ok: native display placement, opener, close/reopen, seed and disclosure contracts (not rendered geometry)");
