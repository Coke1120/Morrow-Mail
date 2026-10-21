const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const quitScheduled = require("../host/quit-scheduled");
const { renderer } = require("./check-ux-workflows");

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await settle();
}

function event() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

async function checkController() {
  const format = () => "Jan 1, 2099, 8:00 AM";
  const pending = { id: "a", subject: "  Board notes  ", sendAt: "2099-01-01T08:00:00.000Z", status: "pending" };
  const sending = { id: "b", subject: "", sendAt: "not-a-date", status: "sending" };
  const failed = { id: "c", subject: "Already failed", sendAt: "2099-01-02T08:00:00.000Z", status: "failed" };
  assert.equal(quitScheduled.quitPrompt([failed]), null);
  assert.equal(quitScheduled.quitPrompt([]), null);
  assert.equal(quitScheduled.quitPrompt(null), null);
  const prompt = quitScheduled.quitPrompt([failed, pending, sending], format);
  assert.equal(prompt.count, 2);
  assert.equal(prompt.hidden, 0);
  assert.equal(prompt.items[0].subject, "Board notes");
  assert.equal(prompt.items[0].time, "Jan 1, 2099, 8:00 AM");
  assert.equal(prompt.items[0].status, "pending");
  assert.equal(prompt.items[1].subject, "(no subject)");
  assert.equal(prompt.items[1].time, "Unknown time");
  assert.equal(prompt.items[1].status, "sending");
  const many = quitScheduled.quitPrompt(Array.from({ length: 6 }, (_, index) => ({
    subject: "Item " + index,
    sendAt: "2099-01-01T08:00:00.000Z",
    status: "pending",
  })), format);
  assert.equal(many.count, 6);
  assert.equal(many.items.length, quitScheduled.QUIT_LIST_LIMIT);
  assert.equal(many.hidden, 1);
  const copy = quitScheduled.quitCopy(prompt);
  assert.match(copy.title, /2 scheduled messages are still pending/);
  assert.match(copy.body, /will not send while Morrow Mail is closed/);
  assert.match(copy.body, /next time you open it/);
  assert.match(quitScheduled.quitCopy({ count: 1, items: [], hidden: 0 }).title, /1 scheduled message/);
  const uncertain = quitScheduled.uncertainPrompt();
  assert.match(quitScheduled.quitCopy(uncertain).body, /could not check pending scheduled messages/);
  const options = quitScheduled.nativeDialogOptions(many);
  assert.deepEqual(options.buttons, ["Stay open", "Quit anyway"]);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.match(options.detail, /Item 0/);
  assert.match(options.detail, /1 more scheduled message/);
  assert.match(quitScheduled.nativeDialogOptions({ ...prompt, items: [sending] }).detail, /sending now/);
  assert.equal(quitScheduled.nativeResponseChoice(1), "quit");
  assert.equal(quitScheduled.nativeResponseChoice(0), "stay");
  assert.equal(quitScheduled.nativeResponseChoice(undefined), "stay");
  assert.equal(quitScheduled.choiceAllowsQuit("quit"), true);
  assert.equal(quitScheduled.choiceAllowsQuit("stay"), false);
  assert.equal(quitScheduled.choiceAllowsQuit("view"), false);

  let calls = 0;
  let quits = 0;
  let cleaned = 0;
  const rows = [pending];
  const stay = quitScheduled.createQuitController({
    listRows: () => rows,
    requestChoice: async () => { calls += 1; return "stay"; },
    quitApp: () => { quits += 1; },
    cleanup: async () => { cleaned += 1; },
  });
  const blocked = event();
  assert.equal(stay.onClose(blocked), "blocked");
  assert.equal(blocked.prevented, true);
  const again = event();
  assert.equal(stay.onClose(again), "blocked");
  await flush();
  assert.equal(calls, 1, "one dialog while the first choice is in flight");
  assert.equal(quits, 0);
  assert.equal(cleaned, 0);
  const later = event();
  assert.equal(stay.onClose(later), "blocked");
  await flush();
  assert.equal(calls, 2);
  assert.equal(quits, 0);

  const failedOnly = quitScheduled.createQuitController({
    listRows: () => [failed],
    requestChoice: async () => { throw new Error("should not ask"); },
    quitApp: () => { quits += 1; },
    cleanup: async () => { cleaned += 1; },
  });
  const allow = event();
  assert.equal(failedOnly.onClose(allow), "allow");
  assert.equal(allow.prevented, false);

  let seen = null;
  const unknown = quitScheduled.createQuitController({
    listRows: () => { throw new Error("scheduled store unavailable"); },
    requestChoice: async (value) => { seen = value; return "stay"; },
    quitApp: () => { quits += 1; },
    cleanup: async () => {},
  });
  const held = event();
  assert.equal(unknown.onClose(held), "blocked");
  await flush();
  assert.equal(seen.uncertain, true);
  assert.equal(quits, 0);

  let quitCalls = 0;
  let cleanups = 0;
  let prevented = 0;
  const quitting = quitScheduled.createQuitController({
    listRows: () => [pending],
    requestChoice: async () => "quit",
    quitApp() {
      quitCalls += 1;
      quitting.onBeforeQuit({ preventDefault() { prevented += 1; } });
    },
    cleanup: async () => { cleanups += 1; },
  });
  const quitEvent = event();
  assert.equal(quitting.onBeforeQuit(quitEvent), "blocked");
  assert.equal(quitEvent.prevented, true);
  await flush();
  assert.equal(quitCalls, 2, "confirm starts quit, cleanup finishes it");
  assert.equal(cleanups, 1);
  assert.equal(quitting.confirmed, true);
  assert.equal(quitting.cleaning, true);
  const duringQuit = event();
  assert.equal(quitting.onClose(duringQuit), "allow");
  assert.equal(duringQuit.prevented, false);

  let viewQuits = 0;
  const viewing = quitScheduled.createQuitController({
    listRows: () => [pending],
    requestChoice: async () => "view",
    quitApp: () => { viewQuits += 1; },
    cleanup: async () => { throw new Error("view must not clean up"); },
  });
  assert.equal(viewing.onBeforeQuit(event()), "blocked");
  await flush();
  assert.equal(viewQuits, 0);
  assert.equal(viewing.confirmed, false);

  let emptyQuits = 0;
  let emptyCleanups = 0;
  let emptyPrevents = 0;
  const empty = quitScheduled.createQuitController({
    listRows: () => [],
    requestChoice: async () => { throw new Error("empty queue must not ask"); },
    quitApp() {
      emptyQuits += 1;
      empty.onBeforeQuit({ preventDefault() { emptyPrevents += 1; } });
    },
    cleanup: async () => { emptyCleanups += 1; },
  });
  const emptyEvent = event();
  assert.equal(empty.onBeforeQuit(emptyEvent), "cleanup");
  assert.equal(emptyEvent.prevented, true);
  await flush();
  assert.equal(emptyCleanups, 1);
  assert.equal(emptyQuits, 1);
  assert.equal(emptyPrevents, 0, "the cleanup quit is not held");
  const emptyClose = event();
  assert.equal(empty.onClose(emptyClose), "allow");
  assert.equal(emptyClose.prevented, false);
}

async function checkMacClose() {
  const pending = { id: "a", subject: "Board notes", sendAt: "2099-01-01T08:00:00.000Z", status: "pending" };
  assert.equal(quitScheduled.hidesWindowOnClose("darwin"), true);
  assert.equal(quitScheduled.hidesWindowOnClose("win32"), false);
  assert.equal(quitScheduled.hidesWindowOnClose("linux"), false);

  let listed = 0;
  const hidden = quitScheduled.createQuitController({
    platform: "darwin",
    listRows: () => { listed += 1; throw new Error("scheduled store unavailable"); },
    requestChoice: async () => { throw new Error("hide must not ask"); },
    quitApp: () => { throw new Error("hide must not quit"); },
    cleanup: async () => { throw new Error("hide must not clean up"); },
  });
  const hideEvent = event();
  assert.equal(hidden.onClose(hideEvent), "hide");
  assert.equal(hideEvent.prevented, true);
  assert.equal(listed, 0, "hiding does not read the scheduled queue");
  const pendingHide = quitScheduled.createQuitController({
    platform: "darwin",
    listRows: () => [pending],
    requestChoice: async () => { throw new Error("hide must not ask"); },
    quitApp: () => { throw new Error("hide must not quit"); },
    cleanup: async () => { throw new Error("hide must not clean up"); },
  });
  const pendingEvent = event();
  assert.equal(pendingHide.onClose(pendingEvent), "hide");
  assert.equal(pendingEvent.prevented, true);

  let resolveChoice = null;
  let quitCalls = 0;
  const during = quitScheduled.createQuitController({
    platform: "darwin",
    listRows: () => [pending],
    requestChoice: () => new Promise((resolve) => { resolveChoice = resolve; }),
    quitApp: () => { quitCalls += 1; },
    cleanup: async () => { throw new Error("stay must not clean up"); },
  });
  assert.equal(during.onBeforeQuit(event()), "blocked");
  const whileAsking = event();
  assert.equal(during.onClose(whileAsking), "blocked");
  assert.equal(whileAsking.prevented, true);
  await settle();
  assert.equal(typeof resolveChoice, "function");
  resolveChoice("stay");
  await flush();
  const afterStay = event();
  assert.equal(during.onClose(afterStay), "hide");
  assert.equal(afterStay.prevented, true);
  assert.equal(quitCalls, 0);

  let darwinQuits = 0;
  const darwinQuit = quitScheduled.createQuitController({
    platform: "darwin",
    listRows: () => [],
    requestChoice: async () => { throw new Error("empty queue must not ask"); },
    quitApp() {
      darwinQuits += 1;
      darwinQuit.onBeforeQuit({ preventDefault() {} });
    },
    cleanup: async () => {},
  });
  const darwinQuitEvent = event();
  assert.equal(darwinQuit.onBeforeQuit(darwinQuitEvent), "cleanup");
  assert.equal(darwinQuitEvent.prevented, true);
  await flush();
  assert.equal(darwinQuits, 1);
  const duringDarwinQuit = event();
  assert.equal(darwinQuit.onClose(duringDarwinQuit), "allow");
  assert.equal(duringDarwinQuit.prevented, false);

  let confirmedQuits = 0;
  const confirmed = quitScheduled.createQuitController({
    platform: "darwin",
    listRows: () => [pending],
    requestChoice: async () => "quit",
    quitApp() {
      confirmedQuits += 1;
      confirmed.onBeforeQuit({ preventDefault() {} });
    },
    cleanup: async () => {},
  });
  assert.equal(confirmed.onBeforeQuit(event()), "blocked");
  await flush();
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmedQuits >= 1, true);
  const confirmedClose = event();
  assert.equal(confirmed.onClose(confirmedClose), "allow");
  assert.equal(confirmedClose.prevented, false);

  let winAsked = 0;
  const windows = quitScheduled.createQuitController({
    platform: "win32",
    listRows: () => [pending],
    requestChoice: async () => { winAsked += 1; return "stay"; },
    quitApp: () => { throw new Error("stay must not quit"); },
    cleanup: async () => { throw new Error("stay must not clean up"); },
  });
  const winEvent = event();
  assert.equal(windows.onClose(winEvent), "blocked");
  assert.equal(winEvent.prevented, true);
  await flush();
  assert.equal(winAsked, 1);
  const linux = quitScheduled.createQuitController({
    platform: "linux",
    listRows: () => [],
    requestChoice: async () => { throw new Error("empty queue must not ask"); },
    quitApp: () => {},
    cleanup: async () => {},
  });
  const linuxEvent = event();
  assert.equal(linux.onClose(linuxEvent), "allow");
  assert.equal(linuxEvent.prevented, false);
}

function dialogNode(id) {
  return {
    id,
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    open: false,
    dataset: {},
    classList: { toggle() {} },
    focused: false,
    children: [],
    focus() { this.focused = true; },
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
    close() { this.open = false; },
    showModal() { this.open = true; },
    addEventListener() {},
    setAttribute() {},
  };
}

async function checkRenderer() {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, dialogNode(id));
    return nodes.get(id);
  };
  const ui = renderer({
    document: {
      getElementById: get,
      createElement: () => ({ textContent: "", hidden: false }),
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
    },
  });
  ui.context.choices = [];
  ui.context.shown = [];
  ui.context.viewed = 0;
  ui.run(`
    api.replyQuitScheduled = (payload) => { choices.push(payload); };
    api.replyQuitScheduledShown = (payload) => { shown.push(payload.nonce); };
    showScheduled = async () => { viewed += 1; };
    showStatus = () => {};
  `);
  const payload = {
    nonce: "n1",
    title: "2 scheduled messages are still pending",
    body: "Scheduled messages will not send while Morrow Mail is closed. A time that passes while the app is closed is sent the next time you open it.",
    count: 2,
    hidden: 1,
    items: [
      { subject: "Board notes", time: "Jan 1, 2099, 8:00 AM", status: "pending" },
      { subject: "Invoice", time: "Jan 2, 2099, 9:00 AM", status: "sending" },
    ],
  };
  ui.run(`acceptQuitScheduled(${JSON.stringify(payload)})`);
  const dialog = get("quit-scheduled");
  assert.equal(dialog.open, true);
  assert.equal(get("quit-scheduled-title").textContent, payload.title);
  assert.match(get("quit-scheduled-body").textContent, /will not send while Morrow Mail is closed/);
  assert.equal(get("quit-scheduled-list").children.length, 2);
  assert.match(get("quit-scheduled-list").children[0].textContent, /Board notes · Jan 1, 2099, 8:00 AM/);
  assert.match(get("quit-scheduled-list").children[1].textContent, /Invoice · Jan 2, 2099, 9:00 AM · Sending now/);
  assert.equal(get("quit-scheduled-more").hidden, false);
  assert.match(get("quit-scheduled-more").textContent, /1 more scheduled message/);
  assert.equal(get("quit-scheduled-stay").focused, true);
  assert.deepEqual(ui.run("shown"), ["n1"]);
  ui.run(`acceptQuitScheduled(${JSON.stringify({ ...payload, nonce: "n2" })})`);
  assert.equal(ui.run("choices.length"), 1);
  assert.equal(ui.run("choices[0].nonce"), "n2");
  assert.equal(ui.run("choices[0].choice"), "stay");
  assert.equal(dialog.open, true);
  assert.equal(get("quit-scheduled-title").textContent, payload.title);
  const cancel = { preventDefault() { this.defaultPrevented = true; } };
  dialog.oncancel(cancel);
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(dialog.open, false);
  assert.equal(ui.run("choices.at(-1).choice"), "stay");
  assert.equal(ui.run("choices.at(-1).nonce"), "n1");

  ui.run(`acceptQuitScheduled(${JSON.stringify({ ...payload, nonce: "n3" })})`);
  assert.equal(dialog.open, true);
  get("quit-scheduled-quit").onclick();
  assert.equal(ui.run("choices.at(-1).nonce"), "n3");
  assert.equal(ui.run("choices.at(-1).choice"), "quit");
  assert.equal(dialog.open, false);

  ui.run(`acceptQuitScheduled(${JSON.stringify({ ...payload, nonce: "n4" })})`);
  get("quit-scheduled-view").onclick();
  await flush();
  assert.equal(ui.run("choices.at(-1).choice"), "view");
  assert.equal(ui.run("viewed"), 1);
  assert.equal(dialog.open, false);

  ui.run(`acceptQuitScheduled(${JSON.stringify({ ...payload, nonce: "n5" })})`);
  const submit = { preventDefault() { this.defaultPrevented = true; } };
  get("quit-scheduled-form").onsubmit(submit);
  assert.equal(submit.defaultPrevented, true);
  assert.equal(ui.run("choices.at(-1).choice"), "stay");

  ui.run(`acceptQuitScheduled(${JSON.stringify({ ...payload, nonce: "n6" })})`);
  ui.run(`dismissQuitScheduled({ nonce: "n6" })`);
  assert.equal(dialog.open, false);
  const before = ui.run("choices.length");
  ui.run(`acceptQuitScheduled(${JSON.stringify({ ...payload, nonce: "n6", title: "Late" })})`);
  assert.equal(dialog.open, false);
  assert.equal(ui.run("choices.length"), before);
  ui.run(`acceptQuitScheduled(${JSON.stringify({ ...payload, nonce: "n7" })})`);
  assert.equal(dialog.open, true);
  assert.equal(get("quit-scheduled-title").textContent, payload.title);
}

async function checkEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-quit-scheduled-"));
  const env = {
    MORROW_MAIL_DIR: process.env.MORROW_MAIL_DIR,
    MORROW_MAIL_SECRETS: process.env.MORROW_MAIL_SECRETS,
  };
  process.env.MORROW_MAIL_DIR = dir;
  process.env.MORROW_MAIL_SECRETS = "memory";
  const engine = require("../host/mail/engine");
  const db = require("../host/mail/db");
  try {
    await engine.init();
    db.insertAccount({
      id: "queue",
      email: "queue@example.invalid",
      username: "queue",
      profile: "custom",
      createdAt: Date.now(),
      imapHost: "invalid",
      imapPort: 993,
      imapTls: true,
      smtpHost: "invalid",
      smtpPort: 587,
      smtpTls: true,
    });
    const queued = engine.answer("mail:scheduleSend", [{
      accountId: "queue",
      to: "recipient@example.invalid",
      subject: "Board notes",
      body: "<p>Hi</p>",
      sendAt: "2099-01-01T08:00:00.000Z",
    }]);
    assert.equal(queued.success, true);
    const later = engine.answer("mail:scheduleSend", [{
      accountId: "queue",
      to: "recipient@example.invalid",
      subject: "Later note",
      body: "<p>Later</p>",
      sendAt: "2099-06-01T08:00:00.000Z",
    }]);
    assert.equal(later.success, true);
    db.markScheduledFailed(queued.data.id, "The server rejected it.");
    const listed = engine.answer("mail:listScheduled", []);
    assert.equal(listed.success, true);
    const prompt = quitScheduled.quitPrompt(listed.data);
    assert.equal(prompt.count, 1);
    assert.equal(prompt.items[0].subject, "Later note");
    assert.equal(prompt.items[0].status, "pending");
    db.markScheduledFailed(later.data.id, "Also failed.");
    assert.equal(quitScheduled.quitPrompt(engine.answer("mail:listScheduled", []).data), null);
  } finally {
    try { db.close(); } catch { /* the temp database is discarded */ }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function checkWiring() {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  const preload = fs.readFileSync(path.join(root, "renderer/preload.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "host/main.js"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
  assert.match(html, /id="quit-scheduled"/);
  assert.match(html, /role="alertdialog"/);
  assert.match(html, /id="quit-scheduled-stay"[^>]*>Stay open/);
  assert.match(html, /id="quit-scheduled-view"[^>]*>View scheduled/);
  assert.match(html, /id="quit-scheduled-quit"[^>]*>Quit anyway/);
  assert.match(preload, /app:confirmQuitScheduled/);
  assert.match(preload, /app:dismissQuitScheduled/);
  assert.match(preload, /app:quitScheduledChoice/);
  assert.match(preload, /app:quitScheduledShown/);
  assert.match(main, /quitController\.onClose\(event\)/);
  assert.match(main, /quitController\.onBeforeQuit\(event\)/);
  assert.match(main, /platform: process\.platform/);
  assert.match(main, /action === "hide"/);
  assert.match(main, /hideShell\(win\)/);
  assert.match(main, /revealShell\(shellWindow\)/);
  assert.match(main, /app\.on\("activate", \(\) => \{/);
  assert.match(main, /presentShell\(\)/);
  assert.match(main, /app\.on\("window-all-closed"/);
  assert.match(main, /if \(!quitScheduled\.hidesWindowOnClose\(process\.platform\)\) app\.quit\(\)/);
  assert.match(main, /label: "File"/);
  assert.match(main, /role: "close"/);
  assert.match(main, /openShellWindow\(\)/);
  assert.match(main, /leave-full-screen/);
  assert.match(main, /app:confirmQuitScheduled/);
  assert.match(main, /app:dismissQuitScheduled/);
  assert.match(appJs, /dialog\.id === "quit-scheduled"/);
  assert.match(appJs, /replyQuitScheduled\("stay"\)/);
  assert.match(appJs, /api\.on\("app:confirmQuitScheduled", acceptQuitScheduled\)/);
}

async function run() {
  await checkController();
  await checkMacClose();
  await checkRenderer();
  checkWiring();
  await checkEngine();
  console.log("quit-scheduled-ok");
}

module.exports = { run };
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
