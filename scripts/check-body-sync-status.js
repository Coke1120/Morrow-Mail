// Synthetic activity/renderer checks. No network or real mailbox state.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createBodyProgress } = require("../host/mail/body-progress");
const { renderer } = require("./check-ux-workflows");

function trackerChecks() {
  let now = 1000;
  const tracker = createBodyProgress({ now: () => now });
  const accounts = [{ id: "a" }, { id: "b" }];
  const read = extra => tracker.snapshot({ accounts, ...extra });
  const first = tracker.queue("a", "visible");
  assert.equal(read().accounts[0].state, "queued");
  tracker.start(first);
  assert.equal(read().accounts[0].state, "running");
  assert.equal(read().accounts[1].state, "idle");
  assert.equal(read({ online: false }).accounts[0].reason, "offline", "offline observation does not cancel an in-flight request");
  now++; tracker.finish(first, "done");
  assert.equal(read().accounts[0].state, "idle");
  assert.equal(read().accounts[0].lastResult, "done");
  const next = tracker.queue("a", "overnight"); tracker.start(next);
  tracker.finish(next, "incomplete");
  assert.equal(read().accounts[0].reason, "incomplete");
  assert.equal(read({ accounts: [{ id: "a", pausedUntil: 2000 }] }).accounts[0].reason, "rate-limit");
  assert.equal(read({ sleeping: true }).accounts[1].reason, "sleeping");
  assert.equal(read({ online: false }).accounts[1].reason, "offline");
  assert.equal(read({ accounts: [{ id: "b", needsConnection: true }] }).accounts[0].reason, "connection");
  const old = tracker.queue("b", "open"), newer = tracker.queue("b", "overnight");
  tracker.start(newer); tracker.finish(newer, "done"); tracker.finish(old, "download-failed");
  assert.equal(read().accounts[1].lastResult, "done", "old completion cannot overwrite a newer result");
  const snapshot = read({ queued: [{ accountId: "a", source: "visible" }], night: true, horizonDays: 180 });
  assert.equal(snapshot.accounts[0].state, "queued");
  assert.equal(snapshot.horizonDays, 180); assert.equal(snapshot.night, true);
  assert.equal(read({ accounts: [] }).accounts.length, 0);
  const replaced = tracker.queue("a", "open", 1); tracker.start(replaced);
  tracker.finish(replaced, "download-failed");
  assert.equal(read({ accounts: [{ id: "a", generation: 2 }] }).accounts[0].state, "idle", "removed/replaced account work cannot retarget its successor");
  const restarted = createBodyProgress({ now: () => ++now });
  assert.notEqual(read().session, restarted.snapshot({ accounts }).session);
  assert.equal(restarted.snapshot({ accounts }).accounts[0].lastResult, "", "restart retains no old running/completion claim");
  const privateTask = restarted.queue("a", "Private subject and body");
  restarted.start(privateTask); restarted.finish(privateTask, "Private provider error");
  const publicText = JSON.stringify(restarted.snapshot({ accounts: [{ id: "a", email: "private@example.test", subject: "Private subject" }] }));
  assert.doesNotMatch(publicText, /private@example|Private|token|percentage|remaining|total/);
  const brokenObserver = createBodyProgress({ onChange() { throw Error("Observer failed"); } });
  assert.doesNotThrow(() => brokenObserver.finish(brokenObserver.queue("a", "open"), "done"));
}

function fixture() {
  const nodes = new Map();
  const element = () => ({ textContent: "", children: [], hidden: false, open: false, attrs: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(k,v) { this.attrs[k] = v; }, replaceChildren(...items) { this.children = items; },
    append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); },
    querySelectorAll() { return []; }, closest() { return null; } });
  const node = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const document = { getElementById: node, createElement: element, querySelector() { return null; }, activeElement: null };
  const ui = renderer({ document });
  ui.run("state.accounts=[{id:'a',name:'Alpha'},{id:'b',name:'Beta'}];state.view='mail'");
  return { ui, node, document };
}

async function rendererChecks() {
  const { ui, node, document } = fixture();
  const payload = { session: "first", startedAt: 1000, sequence: 2, night: true, horizonDays: 365,
    accounts: [{ accountId: "a", state: "running", source: "visible" }, { accountId: "b", state: "paused", reason: "rate-limit" }] };
  ui.context.snapshot = payload;
  assert.equal(ui.run("rememberBodySync(snapshot)"), true);
  node("body-sync").open = true; document.activeElement = node("body-sync-label");
  ui.run("paintBodySyncStatus()");
  const text = n => [n.textContent, ...n.children.map(text)].join(" ");
  assert.match(node("body-sync-label").textContent, /Bodies.*Downloading/);
  assert.match(text(node("body-sync-accounts")), /Alpha.*Message list.*Beta.*rate limit/);
  assert.match(node("body-sync-help").textContent, /365 days/);
  assert.doesNotMatch(text(node("body-sync")), /100%|all bodies cached|remaining/i);
  assert.equal(node("body-sync").open, true);
  assert.equal(document.activeElement, node("body-sync-label"));
  ui.run("state.view='calendar';paintBodySyncStatus()"); assert.equal(node("body-sync").hidden, true);
  ui.run("state.view='mail';state.accounts=[state.accounts[1]];paintBodySyncStatus()");
  assert.doesNotMatch(text(node("body-sync-accounts")), /Alpha/, "removed accounts never survive in display");
  ui.context.snapshot = { ...payload, sequence: 1 };
  assert.equal(ui.run("rememberBodySync(snapshot)"), false);
  ui.context.snapshot = { ...payload, session: "restarted", startedAt: 2000, sequence: 0, accounts: [{ accountId: "b", state: "idle" }] };
  assert.equal(ui.run("rememberBodySync(snapshot)"), true);
  ui.context.snapshot = { ...payload, sequence: 100 };
  assert.equal(ui.run("rememberBodySync(snapshot)"), false);
  ui.run("call=()=>new Promise(resolve=>globalThis.resolveStatus=resolve);globalThis.read=refreshBodySyncStatus()");
  ui.context.fresh = { ...payload, session: "restarted", startedAt: 2000, sequence: 5, accounts: [{ accountId: "b", state: "running", source: "overnight" }] };
  ui.run("acceptBodySync(fresh);resolveStatus(snapshot)"); await ui.run("read");
  assert.equal(ui.run("state.bodySync.sequence"), 5, "late startup/focus read cannot overwrite an event");
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.match(text(node("body-sync-accounts")), /Overnight fill/);
  ui.run("call=async()=>{throw new Error('Private provider content')}");
  await ui.run("refreshBodySyncStatus()");
  assert.match(node("body-sync-label").textContent, /Status unavailable/);
  assert.doesNotMatch(text(node("body-sync-accounts")), /Downloading|Private/);
  ui.context.snapshot = { ...payload, session: "restarted", startedAt: 2000, sequence: 6, accounts: [{ accountId: "b", state: "idle", lastResult: "done" }] };
  ui.run("rememberBodySync(snapshot);paintBodySyncStatus()");
  assert.match(text(node("body-sync-accounts")), /Last body download finished/);
  assert.match(node("body-sync-label").textContent, /Idle/);
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root,"renderer/index.html"),"utf8");
  assert.match(html, /<details id="body-sync"/);
  assert.match(html, /id="body-sync-label" role="status" aria-live="polite"/);
  assert.match(html, /All mailboxes.*separate from list sync/);
  const preload = fs.readFileSync(path.join(root,"renderer/preload.js"),"utf8");
  assert.match(preload, /"mail:getBodySyncStatus"/); assert.match(preload, /"mail:bodySyncStatus"/);
  const catalog = require("../renderer/features-catalog");
  ui.context.window.morrowFeaturesCatalog = catalog;
  ui.run("paintFeatureCatalog()");
  assert.match(text(node("features-catalog")), /Full message bodies.*Mail → Bodies.*no whole-mailbox total or percentage.*3 MiB source limit/);
}
async function run() { trackerChecks(); await rendererChecks(); console.log("body-sync-status-ok (sessions, ownership, states, privacy, synthetic disclosure; no live I/O)"); }
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
