// Synthetic Agent todo completion and FYI/Other batch read. No live mailbox.
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
}

function writeTriage(dir) {
  const triage = {
    reason: "ready",
    updatedAt: new Date().toISOString(),
    stale: false,
    items: [
      { messageId: "m-need", accountId: "ada", categoryId: "needs-you", subject: "Need", unread: true, from: "Ada <ada@example.test>" },
      { messageId: "m-fyi", accountId: "ada", categoryId: "fyi", subject: "Notice", unread: true, from: "News <news@example.test>" },
      { messageId: "m-other-box", accountId: "grace", categoryId: "needs-you", subject: "Other box", unread: true, from: "Grace <grace@example.test>" },
      { messageId: "m-queued", accountId: "ada", categoryId: "needs-you", subject: "Queued", unread: true, from: "Ada <ada@example.test>" },
      { messageId: "m-part", accountId: "ada", categoryId: "needs-you", subject: "Partial", unread: true, from: "Ada <ada@example.test>" },
      { messageId: "m-fail", accountId: "ada", categoryId: "needs-you", subject: "Fail", unread: true, from: "Ada <ada@example.test>" },
    ],
  };
  fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({
    installedSkillIds: null, runs: [], triage, proposals: [], todos: {}, schedules: [],
  }));
}

function todoStatus(dir, id) {
  const store = JSON.parse(fs.readFileSync(path.join(dir, "agent.json"), "utf8"));
  const mark = store.todos && store.todos[id];
  return mark && mark.status ? mark.status : "open";
}

function seedAccount(db, id) {
  db.insertAccount({
    id, email: id + "@example.test", username: id, profile: "custom", createdAt: Date.now(),
    imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true,
  });
  db.replaceFolders(id, [
    { path: "INBOX", name: "Inbox", wellKnown: "inbox" },
    { path: "Drafts", name: "Drafts", wellKnown: "drafts" },
    { path: "Sent", name: "Sent", wellKnown: "sentitems" },
  ]);
}

async function hostChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-agent-todos-"));
  configure(dir);
  writeTriage(dir);
  const agent = require("../host/agent");
  const engine = require("../host/mail/engine");
  const db = require("../host/mail/db");
  await engine.init();
  seedAccount(db, "ada");
  seedAccount(db, "grace");
  try {
    const target = agent.answer("nativeAgent:home:replyTarget", [{ messageId: "m-need", accountId: "ada" }]);
    assert.equal(target.success, true);
    assert.deepEqual(target.data, { messageId: "m-need", accountId: "ada" });
    assert.equal(agent.answer("nativeAgent:home:replyTarget", [{ messageId: "m-fyi", accountId: "ada" }]).data, null);
    assert.equal(agent.answer("nativeAgent:home:replyTarget", [{ messageId: "m-need", accountId: "grace" }]).data, null);
    assert.deepEqual(agent.answer("nativeAgent:home:replyTarget", [{ messageId: "m-other-box", accountId: "grace" }]).data, {
      messageId: "m-other-box", accountId: "grace",
    });
    assert.equal(agent.answer("nativeAgent:home:replyTarget", [{ messageId: "m-other-box", accountId: "ada" }]).data, null);
    assert.equal(agent.answer("nativeAgent:home:replyTarget", [{}]).data, null);

    assert.equal(agent.setTodo({ messageId: "m-need", accountId: "grace", status: "done" }).success, true);
    assert.equal(todoStatus(dir, "m-need"), "open");
    assert.equal(agent.setTodo({ messageId: "m-gone", accountId: "ada", status: "done" }).success, true);
    assert.equal(todoStatus(dir, "m-gone"), "done");
    agent.setTodo({ messageId: "m-need", accountId: "ada", status: "done" });
    assert.equal(todoStatus(dir, "m-need"), "done");
    assert.equal(agent.answer("nativeAgent:home:replyTarget", [{ messageId: "m-need", accountId: "ada" }]).data, null);
    agent.setTodo({ messageId: "m-need", accountId: "ada", status: "open" });
    assert.equal(todoStatus(dir, "m-need"), "open");

    const queued = engine.answer("mail:scheduleSend", [{
      accountId: "ada", to: "bob@example.test", subject: "Queued reply", body: "<p>Queued</p>",
      fromAddress: "ada@example.test", sendAt: "2099-01-01T00:00:00.000Z",
      agentTodo: { messageId: "m-queued", accountId: "ada" },
    }]);
    assert.equal(queued.success, true);
    assert.match(db.scheduledById(queued.data.id).payload_json, /"messageId":"m-queued"/);
    const edited = engine.answer("mail:editScheduled", [{ id: queued.data.id }]);
    assert.equal(edited.success, true);
    assert.deepEqual(edited.data.agentTodo, { messageId: "m-queued", accountId: "ada" });
    assert.equal(todoStatus(dir, "m-queued"), "open");

    const canceled = engine.answer("mail:scheduleSend", [{
      accountId: "ada", to: "bob@example.test", subject: "Cancel me", body: "<p>Cancel</p>",
      fromAddress: "ada@example.test", sendAt: "2099-01-02T00:00:00.000Z",
      agentTodo: { messageId: "m-queued", accountId: "ada" },
    }]);
    const cancel = engine.answer("mail:cancelScheduled", [{ id: canceled.data.id }]);
    assert.equal(cancel.success, true);
    assert.match(cancel.data.snapshot.payloadJson, /m-queued/);
    assert.equal(todoStatus(dir, "m-queued"), "open");

    engine.setSmtpSenderForTest(async () => ({ messageId: "<ok@test>", accepted: ["bob@example.test"], rejected: [] }));
    const sent = engine.answer("mail:scheduleSend", [{
      accountId: "ada", to: "bob@example.test", subject: "Send reply", body: "<p>Send</p>",
      fromAddress: "ada@example.test", sendAt: new Date(Date.now() + 3600000).toISOString(),
      agentTodo: { messageId: "m-need", accountId: "ada" },
    }]);
    assert.equal(sent.success, true);
    db.setScheduledSendAt(sent.data.id, 0);
    await engine.pumpScheduled();
    assert.equal(db.scheduledById(sent.data.id), null);
    assert.equal(todoStatus(dir, "m-need"), "done");
    assert.equal(todoStatus(dir, "m-fyi"), "open");

    const mismatch = engine.answer("mail:scheduleSend", [{
      accountId: "ada", to: "bob@example.test", subject: "Wrong box", body: "<p>Wrong</p>",
      fromAddress: "ada@example.test", sendAt: new Date(Date.now() + 3600000).toISOString(),
      agentTodo: { messageId: "m-other-box", accountId: "ada" },
    }]);
    db.setScheduledSendAt(mismatch.data.id, 0);
    await engine.pumpScheduled();
    assert.equal(todoStatus(dir, "m-other-box"), "open");

    engine.setSmtpSenderForTest(async () => ({
      messageId: "<part@test>", accepted: ["ok@example.test"], rejected: ["bad@example.test"],
      rejectedErrors: [{ recipient: "bad@example.test", responseCode: 550 }],
    }));
    const partial = engine.answer("mail:scheduleSend", [{
      accountId: "ada", to: "ok@example.test", cc: "bad@example.test", subject: "Partial", body: "<p>Partial</p>",
      fromAddress: "ada@example.test", sendAt: new Date(Date.now() + 3600000).toISOString(),
      agentTodo: { messageId: "m-part", accountId: "ada" },
    }]);
    db.setScheduledSendAt(partial.data.id, 0);
    await engine.pumpScheduled();
    assert.equal(todoStatus(dir, "m-part"), "open");

    engine.setSmtpSenderForTest(async () => {
      const error = new Error("getaddrinfo ENOTFOUND smtp.example.test");
      error.code = "ENOTFOUND";
      throw error;
    });
    const failed = engine.answer("mail:scheduleSend", [{
      accountId: "ada", to: "bob@example.test", subject: "Failed reply", body: "<p>Failed</p>",
      fromAddress: "ada@example.test", sendAt: new Date(Date.now() + 20000).toISOString(), outbox: true,
      agentTodo: { messageId: "m-fail", accountId: "ada" },
    }]);
    db.setScheduledSendAt(failed.data.id, 0);
    const notices = await engine.pumpScheduled();
    assert.equal(todoStatus(dir, "m-fail"), "open");
    assert.equal(notices[0].outboxRestore.seed.agentTodo.messageId, "m-fail");

    db.insertMessage({
      id: "m-read", accountId: "ada", folderPath: "INBOX", subject: "Read me", from: "Ada <ada@example.test>",
      date: "2026-10-29T00:00:00.000Z", listSortTs: 1, unread: true, bodyComplete: true,
    });
    const marked = engine.answer("mail:markRead", [{ emailId: "m-read", isRead: true }]);
    assert.equal(marked.success, true);
    const generation = marked.data.outcomes[0].generation;
    assert.equal(typeof generation, "number");
    engine.answer("mail:toggleStar", [{ emailId: "m-read", isStarred: true }]);
    const restored = engine.answer("mail:markReadBatch", [{
      isRead: false, restoreRead: true,
      items: [{ emailId: "m-read", accountId: "ada", generation }],
    }]);
    assert.equal(restored.success, true);
    assert.equal(restored.data.outcomes[0].status, "completed");
    assert.equal(db.messageById("m-read").unread, 1);
    engine.answer("mail:markRead", [{ emailId: "m-read", isRead: true }]);
    const blocked = engine.answer("mail:markReadBatch", [{
      isRead: false, restoreRead: true,
      items: [{ emailId: "m-read", accountId: "ada", generation }],
    }]);
    assert.equal(blocked.data.outcomes.length, 0);
    assert.equal(db.messageById("m-read").unread, 0);
    engine.answer("mail:markReadBatch", [{
      isRead: false, restoreRead: true,
      items: [{ emailId: "m-read", accountId: "grace", generation: 99 }],
    }]);
    assert.equal(db.messageById("m-read").unread, 0);
    const latest = engine.answer("mail:markRead", [{ emailId: "m-read", isRead: true }]).data.outcomes[0].generation;
    engine.answer("mail:markReadBatch", [{
      isRead: false, restoreRead: true,
      items: [{ emailId: "m-read", accountId: "ada", generation: latest }],
    }]);
    assert.equal(db.messageById("m-read").unread, 1);
  } finally {
    engine.setSmtpSenderForTest(null);
    await db.close();
  }
}

function sectionNamed(root, name) {
  return [...root.querySelectorAll(".agent-section")].find((node) => (node.querySelector("h3") || {}).textContent.includes(name));
}

async function rendererChecks() {
  const dom = new JSDOM(`<!doctype html><body>
    <p id="status"></p>
    <div id="notice"></div>
    <button id="status-chip" hidden></button>
    <button id="undo" hidden></button>
    <p id="agent-greeting"></p>
    <div id="agent-home"></div>
    <p id="agent-status"></p>
    <p id="agent-context"></p>
    <div id="agent-proposals"></div>
    <div id="agent-history"></div>
    <div id="agent-sections"></div>
  </body>`);
  const calls = [];
  dom.window.morrow = {
    invoke: async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === "mail:markReadBatch") {
        const items = payload.items || [];
        return { success: true, data: { pending: [], outcomes: items.map((item, index) => ({ id: item.emailId, status: "completed", generation: 7 + index })) } };
      }
      if (channel === "nativeAgent:home:todoUpdate") return { success: true, data: { sections: [] } };
      return { success: true, data: {} };
    },
    on() { return function () {}; },
  };
  const { renderer } = require("./check-ux-workflows");
  const ui = renderer({
    document: dom.window.document,
    window: dom.window,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Event: dom.window.Event,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  });
  const home = dom.window.document.getElementById("agent-home");
  const payload = {
    reason: "ready",
    sections: [
      { id: "needs-you", name: "Needs You", items: [
        { messageId: "m1", accountId: "ada", subject: "First", unread: true, from: "Ada <ada@example.test>" },
        { messageId: "m2", accountId: "ada", subject: "Second", unread: false, from: "Grace <grace@example.test>" },
      ] },
      { id: "worth-a-look", name: "Worth a look", items: [
        { messageId: "m3", accountId: "ada", subject: "Later", unread: true, from: "Bo <bo@example.test>" },
      ] },
      { id: "fyi", name: "FYI", collapseView: true, items: [
        { messageId: "m4", accountId: "ada", subject: "Newsletter", unread: true, from: "News <news@example.test>" },
        { messageId: "m5", accountId: "ada", subject: "Receipt", unread: true, from: "Shop <shop@example.test>" },
        { messageId: "m6", accountId: "ada", subject: "Read already", unread: false, from: "Shop <shop@example.test>" },
      ] },
      { id: "other", name: "Other", items: [] },
    ],
  };
  ui.run(`paintAgentHome(${JSON.stringify(payload)})`);
  assert.equal(home.querySelectorAll('[data-testid="agent-category-read"]').length, 1);
  assert.equal(home.querySelector('[data-testid="agent-category-read"]').dataset.pile, "fyi");
  assert.equal(sectionNamed(home, "Other").querySelector('[data-testid="agent-category-read"]'), null);
  assert.equal(sectionNamed(home, "Worth a look").querySelector(".agent-section-tools button"), null);
  const replyTools = sectionNamed(home, "Needs You").querySelector(".agent-section-tools");
  assert.equal(replyTools.querySelector('[data-testid="agent-category-read"]'), null);
  assert.equal(replyTools.querySelector('[data-action="read"]'), null);
  assert.equal(replyTools.querySelector(".agent-mark-selected").textContent, "Mark selected as read");
  assert.equal(replyTools.querySelector(".agent-complete-selected").textContent, "Complete selected");
  const needsActions = sectionNamed(home, "Needs You").querySelector('[data-testid="agent-todo-actions"]');
  assert.ok([...needsActions.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === "Mark read & done"));
  const fyiActions = sectionNamed(home, "FYI").querySelector('[data-testid="agent-todo-actions"]');
  assert.ok(![...fyiActions.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === "Mark read & done"));
  assert.match(home.querySelector("#agent-todo-note").textContent, /do not archive, delete, mark read, or reply/);

  replyTools.querySelector(".agent-mark-selected").click();
  replyTools.querySelector(".agent-complete-selected").click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0);

  const boxes = [...sectionNamed(home, "Needs You").querySelectorAll(".agent-select")];
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].getAttribute("aria-label"), "Select First");
  boxes[0].checked = true;
  boxes[0].dispatchEvent(new dom.window.Event("change"));
  assert.equal(replyTools.querySelector(".agent-mark-selected").textContent, "Mark selected as read");
  boxes[1].checked = true;
  boxes[1].dispatchEvent(new dom.window.Event("change"));
  assert.equal(replyTools.querySelector(".agent-mark-selected").textContent, "Mark all as read");
  assert.equal(replyTools.querySelector(".agent-complete-selected").textContent, "Complete all");

  ui.run("setRead = async (email) => { globalThis.readIds.push(email.id); return { outcomes: [{ id: email.id, generation: 1, status: 'completed', kind: 'read', projection: { unread: false } }] }; }; globalThis.readIds = [];");
  replyTools.querySelector(".agent-complete-selected").click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls.map((row) => row.channel), ["nativeAgent:home:todoUpdate", "nativeAgent:home:todoUpdate"]);
  assert.equal(calls[0].payload.status, "done");
  assert.equal(calls[0].payload.messageId, "m1");
  assert.equal(ui.run("readIds.length"), 0);
  calls.length = 0;

  ui.run(`state.prefs.markReadCompletesTodos = false; paintAgentHome(${JSON.stringify(payload)})`);
  const needs = sectionNamed(home, "Needs You");
  needs.querySelector(".agent-select").checked = true;
  needs.querySelector(".agent-select").dispatchEvent(new dom.window.Event("change"));
  needs.querySelector(".agent-mark-selected").click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual([...ui.run("readIds")], ["m1"]);
  assert.deepEqual(calls.map((row) => row.channel), ["nativeAgent:learning:observe"]);
  assert.equal(calls[0].payload.kind, "action");
  assert.equal(calls[0].payload.action, "mark-read");
  assert.equal(calls[0].payload.items.length, 1);
  assert.equal(calls[0].payload.items[0].messageId, "m1");

  ui.run("state.prefs.markReadCompletesTodos = true; readIds = [];");
  calls.length = 0;
  sectionNamed(home, "FYI").querySelector('[data-action="read"]').click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual([...ui.run("readIds")], ["m4"]);
  assert.equal(calls.some((row) => row.channel === "nativeAgent:home:todoUpdate"), false);

  calls.length = 0;
  ui.run(`agentMarkedRead.clear(); readIds = []; state.prefs.markReadCompletesTodos = false; paintAgentHome(${JSON.stringify(payload)})`);
  sectionNamed(home, "Needs You").querySelector('[data-action="read-done"]').click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual([...ui.run("readIds")], ["m1"]);
  assert.equal(calls.some((row) => row.channel === "nativeAgent:home:todoUpdate" && row.payload.messageId === "m1"), true);

  calls.length = 0;
  ui.run(`agentMarkedRead.clear(); state.prefs.markReadCompletesTodos = true; paintAgentHome(${JSON.stringify(payload)})`);
  sectionNamed(home, "FYI").querySelector('[data-testid="agent-category-read"]').click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const batch = calls.find((row) => row.channel === "mail:markReadBatch");
  assert.ok(batch);
  assert.deepEqual([...batch.payload.items.map((item) => item.emailId)], ["m4", "m5"]);
  assert.equal(batch.payload.isRead, true);
  assert.equal(calls.some((row) => row.channel === "nativeAgent:home:todoUpdate"), false);
  const undo = dom.window.document.getElementById("undo");
  assert.equal(undo.hidden, false);
  assert.equal(undo.textContent, "Undo");
  ui.run('showStatus("Sent.")');
  assert.equal(undo.hidden, true);

  calls.length = 0;
  ui.run(`agentMarkedRead.clear(); paintAgentHome(${JSON.stringify(payload)})`);
  sectionNamed(home, "FYI").querySelector('[data-testid="agent-category-read"]').click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  calls.length = 0;
  await ui.run("undoRemoval()");
  const restore = calls.find((row) => row.channel === "mail:markReadBatch");
  assert.ok(restore, "undoRemoval should call mail:markReadBatch");
  assert.equal(restore.payload.restoreRead, true);
  assert.equal(restore.payload.isRead, false);
  assert.deepEqual([...restore.payload.items.map((item) => item.emailId)], ["m4", "m5"]);
  assert.ok(restore.payload.items.every((item) => item.accountId === "ada" && typeof item.generation === "number"));

  ui.run('showUndo("Moved.", ["op-1"])');
  ui.run('showStatus("Background note.")');
  assert.equal(undo.hidden, false);
  assert.match(undo.textContent, /completed changes/);
  assert.match(dom.window.document.getElementById("status").textContent, /Moved/);
  assert.match(dom.window.document.getElementById("status").textContent, /Background note/);

  ui.run(`
    state.composeSession = 4;
    state.agentReplyTodo = { messageId: "m-need", accountId: "ada" };
    state.view = "mail";
    globalThis.sentPayload = withAgentReplyTodo({ to: "bob@example.test" });
    globalThis.bare = withAgentReplyTodo;
  `);
  assert.deepEqual({ ...ui.run("sentPayload.agentTodo") }, { messageId: "m-need", accountId: "ada" });
  calls.length = 0;
  await ui.run("finishAgentReplyTodo(4)");
  assert.equal(calls[0].channel, "nativeAgent:home:todoUpdate");
  assert.equal(calls[0].payload.messageId, "m-need");
  assert.equal(ui.run("state.agentReplyTodo"), null);
  ui.run('state.agentReplyTodo = { messageId: "m-need", accountId: "ada" };');
  calls.length = 0;
  await ui.run("finishAgentReplyTodo(1)");
  assert.equal(calls.length, 0);
  assert.equal(ui.run("state.agentReplyTodo.messageId"), "m-need");
}

async function main() {
  await hostChecks();
  await rendererChecks();
  console.log("agent todos ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
