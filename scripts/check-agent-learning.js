// Synthetic Agent learning: threshold, revoke, and no silent rule rewrite.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JSDOM } = require("jsdom");

function configure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  Object.assign(process.env, {
    MORROW_USER_DATA: dir,
    MORROW_MAIL_DIR: dir,
    MORROW_AI_CONFIG_DIR: dir,
    MORROW_MAIL_SECRETS: "memory",
  });
  return dir;
}

function freshDir() {
  return configure(fs.mkdtempSync(path.join(os.tmpdir(), "morrow-learn-")));
}

function learningFile(dir) {
  return path.join(dir, "agent-learning.json");
}

function pattern(view, id) {
  return view.patterns.find((row) => row.id === id);
}

function markRead(learning, begunAt, items) {
  return learning.observe({
    kind: "action",
    action: "mark-read",
    begunAt,
    items,
  });
}

function writeTriage(dir) {
  const triage = {
    reason: "ready",
    updatedAt: new Date().toISOString(),
    stale: false,
    items: [
      { messageId: "m-need", accountId: "ada", categoryId: "needs-you", subject: "Need", unread: true, from: "Ada <ada@example.test>" },
      { messageId: "m-fyi", accountId: "ada", categoryId: "fyi", subject: "Notice", unread: true, from: "News <news@example.test>" },
    ],
  };
  fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({
    installedSkillIds: null, runs: [], triage, proposals: [], todos: {}, schedules: [],
  }));
}

function hostChecks() {
  const dir = freshDir();
  const learning = require("../host/agent-learning");
  assert.equal(learning.THRESHOLD, 3);

  const ada = { messageId: "m1", from: "Ada <ada@example.test>", threadId: "thr-ada" };
  const first = markRead(learning, 1, [ada, { messageId: "m2", from: "Ada <ada@example.test>", threadId: "thr-ada" }]);
  const senderId = "action:mark-read:sender:" + encodeURIComponent("ada@example.test");
  const threadId = "action:mark-read:thread:" + encodeURIComponent("thr-ada");
  assert.equal(pattern(first, senderId).count, 1);
  assert.equal(pattern(first, senderId).learned, false);
  assert.equal(pattern(first, threadId).count, 1);
  assert.equal(markRead(learning, 1, [ada]).patterns.find((row) => row.id === senderId).count, 1);

  markRead(learning, 2, [ada]);
  const learned = markRead(learning, 3, [ada]);
  assert.equal(pattern(learned, senderId).count, 3);
  assert.equal(pattern(learned, senderId).learned, true);
  assert.equal(pattern(learned, senderId).threshold, 3);
  assert.match(pattern(learned, senderId).label, /Mark as read/);
  assert.match(pattern(learned, senderId).label, /ada@example\.test/);

  const mixed = learning.observe({
    kind: "action",
    action: "mark-read",
    begunAt: 4,
    items: [
      { messageId: "a", from: "Bo <bo@example.test>" },
      { messageId: "b", from: "Cy <cy@example.test>" },
    ],
  });
  assert.equal(pattern(mixed, "action:mark-read:sender:" + encodeURIComponent("bo@example.test")).count, 1);
  assert.equal(pattern(mixed, "action:mark-read:sender:" + encodeURIComponent("cy@example.test")).count, 1);

  assert.equal(learning.observe({ kind: "action", action: "mark-read", begunAt: 5, automatic: true, items: [ada] }).patterns.find((row) => row.id === senderId).count, 3);
  assert.equal(learning.observe({ kind: "action", action: "mark-read", begunAt: 6, source: "learned", items: [ada] }).patterns.find((row) => row.id === senderId).count, 3);

  const forgotten = learning.forget({ id: senderId });
  assert.equal(pattern(forgotten, senderId), undefined);
  const stale = markRead(learning, 3, [ada]);
  assert.equal(pattern(stale, senderId), undefined);
  const again = markRead(learning, Date.now() + 1000, [ada]);
  assert.equal(pattern(again, senderId).count, 1);
  assert.equal(pattern(again, senderId).learned, false);

  const pending = learning.observe({
    kind: "suggestion", choice: "dismiss", className: "Review  reply", begunAt: 11,
  });
  const classId = "suggestion:dismiss:" + encodeURIComponent("Review reply");
  assert.equal(pattern(pending, classId).count, 1);
  assert.deepEqual(pending.suppressed, []);
  learning.observe({ kind: "suggestion", choice: "dismiss", className: "Review reply", begunAt: 12 });
  const hidden = learning.observe({ kind: "suggestion", choice: "dismiss", className: "Review reply", begunAt: 13 });
  assert.equal(pattern(hidden, classId).learned, true);
  assert.deepEqual(hidden.suppressed, ["Review reply"]);
  learning.observe({ kind: "suggestion", choice: "open", className: "Review reply", begunAt: 14 });
  learning.observe({ kind: "suggestion", choice: "open", className: "Review reply", begunAt: 15 });
  const opened = learning.observe({ kind: "suggestion", choice: "open", className: "Review reply", begunAt: 16 });
  assert.equal(opened.suppressed.includes("Review reply"), false);

  const batched = learning.observe({
    kind: "category",
    fromCategoryId: "needs-you",
    toCategoryId: "fyi",
    fromName: "Needs You",
    toName: "FYI",
    begunAt: 21,
    items: [
      { from: "Ada <ada@example.test>" },
      { from: "Bo <bo@example.test>" },
      { from: "Ada <ada@example.test>" },
    ],
  });
  const pairId = "category:needs-you:fyi";
  assert.equal(pattern(batched, pairId).count, 1);
  assert.deepEqual(pattern(batched, pairId).senders, ["ada@example.test", "bo@example.test"]);
  assert.equal(pattern(batched, pairId).learned, false);
  learning.observe({ kind: "category", fromCategoryId: "worth-a-look", toCategoryId: "fyi", begunAt: 22, items: [{ from: "Ada <ada@example.test>" }] });
  assert.equal(learning.list().patterns.some((row) => String(row.id).includes("worth-a-look")), false);
  learning.observe({ kind: "category", fromCategoryId: "needs-you", toCategoryId: "fyi", begunAt: 23, items: [{ from: "Ada <ada@example.test>" }] });
  const filed = learning.observe({ kind: "category", fromCategoryId: "Needs You", toCategoryId: "FYI", begunAt: 24, items: [{ from: "Ada <ada@example.test>" }] });
  assert.equal(pattern(filed, pairId).learned, true);
  assert.equal(pattern(filed, pairId).label, "Needs You → FYI");

  fs.writeFileSync(learningFile(dir), "{");
  assert.equal(learning.observe({ kind: "action", action: "mark-read", begunAt: 30, items: [ada] }), null);
  assert.equal(fs.readFileSync(learningFile(dir), "utf8"), "{");
  assert.equal(fs.existsSync(path.join(dir, "brain.json")), false);

  const moved = freshDir();
  writeTriage(moved);
  const agent = require("../host/agent");
  const before = agent.answer("nativeAgent:home:replyTarget", [{ messageId: "m-need", accountId: "ada" }]).data;
  assert.deepEqual(before, { messageId: "m-need", accountId: "ada" });
  learning.observe({ kind: "category", fromCategoryId: "needs-you", toCategoryId: "other", begunAt: 41, items: [{ from: "Ada <ada@example.test>" }] });
  learning.observe({ kind: "category", fromCategoryId: "needs-you", toCategoryId: "other", begunAt: 42, items: [{ from: "Ada <ada@example.test>" }] });
  learning.observe({ kind: "category", fromCategoryId: "needs-you", toCategoryId: "other", begunAt: 43, items: [{ from: "Ada <ada@example.test>" }] });
  assert.deepEqual(agent.answer("nativeAgent:home:replyTarget", [{ messageId: "m-need", accountId: "ada" }]).data, before);
  const stored = JSON.parse(fs.readFileSync(path.join(moved, "agent.json"), "utf8"));
  assert.equal(stored.triage.items[0].categoryId, "needs-you");
  const result = agent.answer("nativeAgent:learning:moveCategory", [{
    messageId: "m-need", accountId: "ada", toCategoryId: "fyi", toName: "FYI", fromName: "Needs You", begunAt: 50,
  }]);
  assert.equal(result.success, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(moved, "agent.json"), "utf8")).triage.items[0].categoryId, "fyi");
  assert.equal(agent.answer("nativeAgent:home:replyTarget", [{ messageId: "m-need", accountId: "ada" }]).data, null);
  assert.equal(pattern(learning.list(), "category:needs-you:fyi").count, 1);
  assert.equal(agent.answer("nativeAgent:learning:moveCategory", [{ messageId: "m-need", toCategoryId: "upcoming-today", begunAt: 51 }]).success, false);
  assert.equal(fs.existsSync(path.join(moved, "brain.json")), false);
}

async function sendChecks() {
  const dir = freshDir();
  const engine = require("../host/mail/engine");
  const db = require("../host/mail/db");
  const learning = require("../host/agent-learning");
  await engine.init();
  db.insertAccount({
    id: "ada", email: "ada@example.test", username: "ada", profile: "custom", createdAt: Date.now(),
    imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true,
  });
  db.replaceFolders("ada", [
    { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
    { path: "Sent", name: "Sent", wellKnown: "sentitems" },
  ]);
  const signal = {
    kind: "action",
    action: "reply",
    begunAt: Date.now(),
    items: [{ messageId: "m-need", accountId: "ada", from: "Ada <ada@example.test>", threadId: "thr-need" }],
  };
  const base = {
    accountId: "ada", to: "bob@example.test", subject: "Reply", body: "<p>Hi</p>", fromAddress: "ada@example.test",
  };
  engine.setSmtpSenderForTest(async () => { throw new Error("down"); });
  const failed = await engine.answer("mail:send", [{ ...base, subject: "Fail", agentLearning: signal }]);
  assert.equal(failed.success, false);
  assert.equal(learning.list().patterns.length, 0);

  engine.setSmtpSenderForTest(async () => ({ messageId: "<ok@test>", accepted: ["bob@example.test"], rejected: [] }));
  const queued = engine.answer("mail:scheduleSend", [{
    ...base, subject: "Later", sendAt: "2099-01-01T00:00:00.000Z", agentLearning: signal,
  }]);
  assert.equal(queued.success, true);
  assert.match(db.scheduledById(queued.data.id).payload_json, /agentLearning/);
  assert.equal(learning.list().patterns.length, 0);
  const canceled = engine.answer("mail:scheduleSend", [{
    ...base, subject: "Cancel", sendAt: "2099-01-02T00:00:00.000Z", agentLearning: { ...signal, begunAt: Date.now() + 1 },
  }]);
  assert.equal(engine.answer("mail:cancelScheduled", [{ id: canceled.data.id }]).success, true);
  assert.equal(learning.list().patterns.length, 0);

  db.setScheduledSendAt(queued.data.id, 0);
  await engine.pumpScheduled();
  const senderId = "action:reply:sender:" + encodeURIComponent("ada@example.test");
  const afterQueue = learning.list();
  assert.equal(pattern(afterQueue, senderId).count, 1);
  assert.equal(pattern(afterQueue, senderId).learned, false);
  assert.equal(pattern(afterQueue, "action:reply:thread:" + encodeURIComponent("thr-need")).count, 1);

  const sent = await engine.answer("mail:send", [{ ...base, subject: "Now", agentLearning: { ...signal, begunAt: Date.now() + 2 } }]);
  assert.equal(sent.success, true);
  assert.equal(pattern(learning.list(), senderId).count, 2);
  assert.equal(pattern(learning.list(), senderId).learned, false);
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function rendererChecks() {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://morrow.test/learn" });
  const document = dom.window.document;
  document.body.innerHTML = `
    <p id="status"></p><div id="notice"></div><button id="status-chip" hidden></button><button id="undo" hidden></button>
    <dialog id="settings"></dialog>
    <ul id="agent-learned-list"></ul>
    <p id="agent-greeting"></p><p id="agent-status"></p><p id="agent-context"></p>
    <div id="agent-home"></div><div id="agent-proposals"></div><div id="agent-history"></div><div id="agent-sections"></div>`;
  const calls = [];
  let patterns = [
    { id: "category:needs-you:fyi", kind: "category", label: "Needs You → FYI", count: 3, threshold: 3, learned: true, match: { fromCategoryId: "needs-you", toCategoryId: "fyi", fromName: "Needs You", toName: "FYI" }, senders: ["ada@example.test"] },
    { id: "action:mark-read:sender:ada%40example.test", kind: "action", label: "Mark as read · ada@example.test", count: 2, threshold: 3, learned: false, actionLabel: "Mark as read", match: { action: "mark-read", scope: "sender", key: "ada@example.test" } },
  ];
  dom.window.morrow = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === "nativeAgent:learning:forget") {
        patterns = patterns.filter((row) => row.id !== payload.id);
        return { success: true, data: { threshold: 3, patterns, suppressed: [] } };
      }
      if (channel === "nativeAgent:learning:moveCategory") {
        return { success: true, data: { learning: { threshold: 3, patterns, suppressed: [] }, sections: [] } };
      }
      return { success: true, data: { threshold: 3, patterns, suppressed: [] } };
    },
    on() { return function () {}; },
  };
  const { renderer } = require("./check-ux-workflows");
  const ui = renderer({
    document,
    window: dom.window,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Event: dom.window.Event,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  });
  ui.context.localStorage = dom.window.localStorage;
  ui.run(`renderAgentLearned(${JSON.stringify({ threshold: 3, patterns, suppressed: [] })})`);
  const list = document.getElementById("agent-learned-list");
  assert.match(list.textContent, /Needs You → FYI — Learned/);
  assert.match(list.textContent, /Mark as read · ada@example\.test — 2 of 3/);
  list.querySelector("button").click();
  await tick();
  assert.equal(calls[0].channel, "nativeAgent:learning:forget");
  assert.equal(calls[0].payload.id, "category:needs-you:fyi");
  assert.doesNotMatch(list.textContent, /Needs You → FYI/);
  assert.match(list.textContent, /2 of 3/);

  ui.run(`state.agentLearning = ${JSON.stringify({
    patterns: [{
      learned: true, kind: "category", senders: ["ada@example.test"],
      match: { fromCategoryId: "needs-you", toCategoryId: "fyi", toName: "FYI" },
    }, {
      learned: true, kind: "action", actionLabel: "Mark as read",
      match: { action: "mark-read", scope: "sender", key: "news@example.test" },
    }],
    suppressed: ["Review reply"],
  })}`);
  assert.equal(JSON.stringify(ui.run(`agentLearnedNotes({ categoryId: "needs-you", from: "Ada <ada@example.test>" })`)), JSON.stringify(["Learned: move to FYI"]));
  assert.equal(JSON.stringify(ui.run(`agentLearnedNotes({ categoryId: "needs-you", from: "Bo <bo@example.test>" })`)), "[]");
  assert.equal(JSON.stringify(ui.run(`agentLearnedNotes({ categoryId: "fyi", from: "News <news@example.test>" })`)), JSON.stringify(["Learned: Mark as read"]));
  assert.equal(ui.run(`suggestionSuppressed("Review reply")`), true);
  assert.equal(ui.run(`suggestionSuppressed("Open")`), false);

  const payload = {
    reason: "ready",
    sections: [
      { id: "needs-you", name: "Needs You", items: [
        { messageId: "m1", accountId: "ada", subject: "Hi", unread: true, from: "Ada <ada@example.test>", followUps: [{ kind: "draft", label: "Review reply", messageId: "m1", body: "Thanks" }] },
      ] },
      { id: "worth-a-look", name: "Worth a look", items: [
        { messageId: "m3", accountId: "ada", subject: "Later", from: "Bo <bo@example.test>" },
      ] },
    ],
  };
  ui.run(`state.view = "agent"; agentPaintPayload = ${JSON.stringify(payload)}; paintAgentHome(agentPaintPayload);`);
  const home = document.getElementById("agent-home");
  const needs = [...home.querySelectorAll(".agent-section")].find((node) => node.querySelector("h3").textContent.includes("Needs You"));
  assert.equal([...needs.querySelectorAll("button")].some((button) => button.textContent === "Review reply"), false);
  assert.equal([...needs.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === "Move to FYI"), true);
  assert.equal([...needs.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === "Move to Other"), true);
  const worth = [...home.querySelectorAll(".agent-section")].find((node) => node.querySelector("h3").textContent.includes("Worth a look"));
  assert.equal([...worth.querySelectorAll("button")].some((button) => String(button.getAttribute("aria-label") || "").startsWith("Move to")), false);
  calls.length = 0;
  [...needs.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Move to FYI").click();
  await tick();
  assert.equal(calls[0].channel, "nativeAgent:learning:moveCategory");
  assert.equal(calls[0].payload.messageId, "m1");
  assert.equal(calls[0].payload.toCategoryId, "fyi");
  assert.equal(calls[0].payload.toName, "FYI");
  assert.equal(calls[0].payload.fromName, "Needs You");
  assert.equal(typeof calls[0].payload.begunAt, "number");

  ui.run(`state.agentLearning = { patterns: [], suppressed: [] }; paintAgentHome(${JSON.stringify(payload)});`);
  const shown = [...home.querySelectorAll(".agent-section")].find((node) => node.querySelector("h3").textContent.includes("Needs You"));
  assert.equal([...shown.querySelectorAll("button")].some((button) => button.textContent === "Review reply"), true);
  assert.equal([...shown.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === "Dismiss Review reply"), true);
  calls.length = 0;
  [...shown.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Dismiss Review reply").click();
  await tick();
  assert.equal(calls[0].channel, "nativeAgent:learning:observe");
  assert.equal(calls[0].payload.choice, "dismiss");
  assert.equal(calls[0].payload.className, "Review reply");
  assert.equal([...shown.querySelectorAll("button")].some((button) => button.textContent === "Review reply"), false);
}

function sourceChecks() {
  const root = path.join(__dirname, "..");
  const catalog = require("../renderer/features-catalog").items.find((row) => row.id === "agent-triage");
  assert.match(catalog.blurb, /Settings → Learned/);
  assert.match(catalog.blurb, /after 3 times/);
  assert.match(catalog.blurb, /Delete removes that pattern/);
  assert.match(catalog.blurb, /do not send mail/);
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  assert.match(html, /id="agent-learned-list"/);
  assert.match(html, /aria-label="Learned Agent patterns"/);
  const adr = fs.readFileSync(path.join(root, "docs/adr/2026-10-29-agent-learning.md"), "utf8");
  assert.match(adr, /agent-learning\.json/);
  assert.match(adr, /at least three/);
  assert.match(adr, /Delete removes that\s+pattern/);
  assert.match(adr, /does not rewrite/);
}

async function main() {
  sourceChecks();
  hostChecks();
  await sendChecks();
  await rendererChecks();
  console.log("agent learning ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
