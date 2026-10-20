const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { renderer } = require("./check-ux-workflows");

const root = path.join(__dirname, "..");

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

function element() {
  return {
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    open: false,
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    style: {},
    focus() {},
    setSelectionRange() {},
    replaceChildren() {},
    append() {},
    appendChild() {},
    addEventListener() {},
    setAttribute() {},
    close() { this.open = false; },
    showModal() { this.open = true; },
  };
}

function checkWindowState() {
  const windowState = require("../host/window-state");
  const display = { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const first = windowState.place(null, [display], { width: 1200, height: 800 });
  assert.deepStrictEqual(first.bounds, { width: 1200, height: 800 });
  assert.strictEqual(first.zoomLevel, 0);
  assert.strictEqual(first.maximized, false);
  assert.strictEqual(first.fullscreen, false);
  const restored = windowState.place({
    x: 40,
    y: 50,
    width: 1100,
    height: 720,
    maximized: true,
    zoomLevel: 2,
  }, [display], { width: 1200, height: 800 });
  assert.strictEqual(restored.bounds.x, 40);
  assert.strictEqual(restored.bounds.y, 50);
  assert.strictEqual(restored.bounds.width, 1100);
  assert.strictEqual(restored.bounds.height, 720);
  assert.strictEqual(restored.maximized, true);
  assert.strictEqual(restored.zoomLevel, 2);
  const off = windowState.place({
    x: -4000,
    y: -4000,
    width: 900,
    height: 700,
    zoomLevel: 99,
  }, [display], { width: 1200, height: 800 });
  assert.strictEqual(off.bounds.x, undefined);
  assert.strictEqual(off.bounds.y, undefined);
  assert.strictEqual(off.bounds.width, 900);
  assert.strictEqual(off.zoomLevel, 9);
  const tiny = windowState.place({ width: 10, height: 10, zoomLevel: -99 }, [display], { width: 1200, height: 800 });
  assert.deepStrictEqual(tiny.bounds, { width: 1200, height: 800 });
  assert.strictEqual(tiny.zoomLevel, -8);
  const headless = windowState.place({ x: 10, y: 10, width: 900, height: 700, zoomLevel: 1 }, [], { width: 1200, height: 800 });
  assert.strictEqual(headless.bounds.x, undefined);
  assert.strictEqual(headless.bounds.width, 900);

  const prev = process.env.MORROW_USER_DATA;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-window-state-"));
  process.env.MORROW_USER_DATA = dir;
  try {
    assert.strictEqual(windowState.read().zoomLevel, 0);
    const saved = windowState.update({ x: 80, y: 90, width: 1280, height: 800, zoomLevel: 1.5, maximized: true });
    assert.strictEqual(saved.zoomLevel, 1.5);
    const again = windowState.read();
    assert.strictEqual(again.x, 80);
    assert.strictEqual(again.width, 1280);
    assert.strictEqual(again.maximized, true);
    const placed = windowState.place(again, [display], { width: 1200, height: 800 });
    assert.strictEqual(placed.bounds.x, 80);
    assert.strictEqual(placed.zoomLevel, 1.5);
    fs.writeFileSync(path.join(dir, "window-state.json"), "{");
    assert.strictEqual(windowState.read().width, null);
    assert.strictEqual(windowState.read().zoomLevel, 0);
  } finally {
    if (prev === undefined) delete process.env.MORROW_USER_DATA;
    else process.env.MORROW_USER_DATA = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function checkSources() {
  const appJs = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "host/main.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  const preload = fs.readFileSync(path.join(root, "renderer/preload.js"), "utf8");
  const independent = fs.readFileSync(path.join(root, "docs/INDEPENDENT_UI.md"), "utf8");
  const parity = fs.readFileSync(path.join(root, "docs/PARITY_SHELL.md"), "utf8");
  assert.ok(main.includes('require("./window-state")'));
  assert.ok(main.includes("setZoomLevel"));
  assert.ok(main.includes("getNormalBounds"));
  assert.ok(main.includes("CommandOrControl+Plus"));
  assert.ok(main.includes("CommandOrControl+0"));
  assert.ok(main.includes("ZOOM_STEP"));
  assert.ok(functionSource(appJs, "loadScheduled").includes('call("mail:listScheduled", {})'));
  assert.ok(!functionSource(appJs, "renderScheduled").includes("state.accountId"));
  assert.ok(functionSource(appJs, "requestSendPreview").includes("openComposePreview"));
  assert.ok(!functionSource(appJs, "requestSendPreview").includes("mail:send"));
  assert.ok(functionSource(appJs, "confirmComposePreview").includes("scheduleMail"));
  assert.ok(functionSource(appJs, "confirmComposePreview").includes("sendMail"));
  assert.ok(html.includes('id="compose-preview"') && html.includes("Confirm send") && html.includes('id="compose-send-now"'));
  assert.ok(html.includes('id="undo-schedule"') && html.includes('id="scheduled-undo"'));
  assert.ok(html.includes("Sends while the app is open"));
  for (const channel of [
    "morrow:configGetDefaultScheduleDelayMinutes",
    "morrow:configSetDefaultScheduleDelayMinutes",
    "morrow:configGetLayoutPanes",
    "morrow:configSetLayoutPanes",
    "mail:restoreScheduled",
  ]) {
    assert.ok(preload.includes('"' + channel + '"'), channel);
    assert.ok(appJs.includes('"' + channel + '"'), channel);
  }
  assert.ok(independent.includes("window-state.json") && independent.includes("layoutPanes") && independent.includes("mail:restoreScheduled"));
  assert.ok(parity.includes("window-state.json") && parity.includes("layoutPanes") && parity.includes("mail:restoreScheduled"));
  assert.ok(parity.includes("while the app is open") && independent.includes("while the app is open"));
}

async function checkComposeFlow() {
  const nodes = new Map();
  const style = { props: {}, setProperty(name, value) { this.props[name] = value; } };
  const ui = renderer({
    document: {
      documentElement: { style },
      getElementById: (id) => {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => element(),
    },
  });
  ui.run(`
    state.accounts = [{ id: "a", email: "me@example.test", platform: "imap" }];
    state.accountId = "a";
    state.composeMeta = { accountId: "a", fromAddress: "me@example.test" };
    state.composeQuote = null;
    state.botDraftReview = null;
    state.prefs.undoSend = 0;
    state.prefs.scheduleDelay = 90;
    globalThis.calls = [];
    loadList = async () => {};
    call = async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === "mail:listScheduled") return [];
      if (channel === "mail:cancelScheduled") {
        return { id: payload.id, snapshot: { id: payload.id, accountId: "a", payloadJson: '{"to":"ada@example.test"}', sendAt: Date.now() + 3600000, status: "pending", error: "", createdAt: Date.now() } };
      }
      if (channel === "mail:restoreScheduled") return { id: payload.snapshot.id, status: payload.snapshot.status };
      return {};
    };
  `);
  const get = (id) => ui.context.document.getElementById(id);
  get("compose-to").value = "ada@example.test";
  get("compose-cc").value = "copy@example.test";
  get("compose-subject").value = "Hello";
  get("compose-body").value = "Body text";
  assert.strictEqual(ui.run("formatScheduleDelay(90)"), "1h 30m");
  assert.strictEqual(ui.run("joinScheduleDelay(168, 1)"), null);
  assert.strictEqual(ui.run("joinScheduleDelay(2, 0)"), 120);
  assert.strictEqual(ui.run("scheduledSummary([])"), "");
  assert.strictEqual(ui.run('scheduledSummary([{id:"a",accountId:"one"},{id:"b",accountId:"two"}])'), "2 scheduled messages from 2 accounts.");
  ui.run("applyLayoutPanes({ folders: 300, list: 480, reading: 640 })");
  assert.strictEqual(style.props["--folders"], "300px");
  assert.strictEqual(style.props["--list"], "480px");
  assert.strictEqual(style.props["--reading"], undefined);

  const before = ui.run("calls.length");
  assert.strictEqual(await ui.run("requestSendPreview()"), true);
  assert.strictEqual(get("compose-preview").open, true);
  assert.strictEqual(get("compose-preview-title").textContent, "Preview scheduled send");
  assert.strictEqual(get("compose-preview-to").textContent, "ada@example.test");
  assert.strictEqual(get("compose-preview-cc").textContent, "copy@example.test");
  assert.strictEqual(get("compose-preview-cc-row").hidden, false);
  assert.strictEqual(get("compose-preview-subject").textContent, "Hello");
  assert.match(get("compose-preview-body").textContent, /Body text/);
  assert.match(get("compose-preview-when").textContent, /Scheduled for /);
  assert.strictEqual(ui.run("calls.length"), before);
  ui.run("cancelComposePreview()");
  assert.strictEqual(get("compose-preview").open, false);
  assert.strictEqual(ui.run("calls.length"), before);
  assert.strictEqual(ui.run("previewDraftState"), null);

  assert.strictEqual(await ui.run("requestSendNowPreview()"), true);
  assert.strictEqual(get("compose-preview-title").textContent, "Preview send");
  assert.strictEqual(get("compose-preview-when").hidden, true);
  assert.strictEqual(get("compose-preview-confirm").textContent, "Confirm send");
  ui.run("cancelComposePreview()");

  const start = Date.now();
  assert.strictEqual(await ui.run("requestSendPreview()"), true);
  await ui.run("confirmComposePreview()");
  const scheduled = ui.run("calls.filter(row => row.channel === 'mail:scheduleSend')");
  assert.strictEqual(scheduled.length, 1);
  const when = Date.parse(scheduled[0].payload.sendAt);
  assert.ok(when >= start + 89 * 60 * 1000 && when <= start + 91 * 60 * 1000);
  assert.strictEqual(ui.run("calls.filter(row => row.channel === 'mail:send').length"), 0);
  ui.run("state.composeQueued = false");

  ui.run("state.prefs.scheduleDelay = 0");
  assert.strictEqual(await ui.run("requestSendPreview()"), true);
  assert.strictEqual(get("compose-preview-title").textContent, "Preview send");
  await ui.run("confirmComposePreview()");
  assert.strictEqual(ui.run("calls.filter(row => row.channel === 'mail:send').length"), 1);

  ui.run("state.prefs.scheduleDelay = 90; state.composeQueued = false");
  get("schedule-preset").value = "custom";
  get("schedule-at").value = "2099-06-01T09:30";
  assert.strictEqual(await ui.run("requestSchedulePreview()"), true);
  assert.strictEqual(get("compose-preview-confirm").textContent, "Confirm schedule");
  const count = ui.run("calls.length");
  await ui.run("confirmComposePreview()");
  const custom = ui.run("calls.filter(row => row.channel === 'mail:scheduleSend')");
  assert.strictEqual(custom.length, 2);
  assert.ok(custom[1].payload.sendAt.startsWith("2099-"));
  assert.ok(ui.run("calls.length") > count);

  ui.run("state.composeQueued = false; state.botDraftReview = { accountId: 'a' }");
  assert.strictEqual(await ui.run("requestSchedulePreview()"), false);
  assert.strictEqual(await ui.run("requestSendNowPreview()"), false);
  assert.strictEqual(ui.run('sendButtonLabel(state.prefs.scheduleDelay, true)'), "Send");

  const row = { id: "s1", accountId: "a", subject: "Hi", to: "ada@example.test", sendAt: "2099-01-01T08:00:00Z", status: "pending" };
  ui.context.row = row;
  ui.run("globalThis.prompts = []; askConfirm = async (copy) => { prompts.push(copy.title); return { ok: false }; };");
  await ui.run("requestCancelScheduled(row)");
  assert.strictEqual(ui.run("JSON.stringify(prompts)"), JSON.stringify(["Cancel scheduled send?"]));
  assert.strictEqual(ui.run("calls.filter(item => item.channel === 'mail:cancelScheduled').length"), 0);

  ui.run("prompts = []; askConfirm = async (copy) => { prompts.push(copy.title); return { ok: true }; };");
  await ui.run("requestCancelScheduled(row)");
  assert.strictEqual(ui.run("JSON.stringify(prompts)"), JSON.stringify(["Cancel scheduled send?", "Confirm cancel?"]));
  assert.strictEqual(ui.run("calls.filter(item => item.channel === 'mail:cancelScheduled').length"), 1);
  assert.ok(ui.run("scheduleUndo && scheduleUndo.id === 's1'"));
  await ui.run("undoCancelScheduled()");
  assert.strictEqual(ui.run("calls.filter(item => item.channel === 'mail:restoreScheduled').length"), 1);
  assert.strictEqual(ui.run("scheduleUndo"), null);
  ui.run("hideScheduleUndo()");
}

async function run() {
  checkWindowState();
  checkSources();
  await checkComposeFlow();
  console.log("batch-b-ok");
}

module.exports = { run };
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
