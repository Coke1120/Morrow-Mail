const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");
const { renderer } = require("./check-ux-workflows");

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.childNodes = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = new Map();
    this.text = "";
    this.value = "";
    this.hidden = false;
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      toggle: (name, force) => force ? this.classes.add(name) : this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }
  get isConnected() { return this.tagName === "body" || !!this.parentNode?.isConnected; }
  get textContent() { return this.text + this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  appendChild(node) { node.remove(); node.parentNode = this; this.childNodes.push(node); return node; }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  replaceChildren(...nodes) { this.childNodes.forEach((node) => { node.parentNode = null; }); this.childNodes = []; this.text = ""; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this); this.parentNode = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { return this.listeners.get("click")?.({ stopPropagation() {} }); }
  querySelectorAll(selector) {
    const rows = this.childNodes.flatMap((node) => [node, ...node.querySelectorAll("*")]);
    return rows.filter((node) => selector === "*" || selector === node.tagName || selector.startsWith(".") && String(node.className || "").split(" ").includes(selector.slice(1)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {}
}

function createRenderer(invoke) {
  const body = new Element("body");
  const nodes = new Map();
  for (const id of ["status", "notice", "status-chip", "undo", "settings", "agent-learned-list", "agent-sections", "agent-proposals", "brain-skill-result", "features-catalog", "features-empty"]) {
    const node = new Element(id === "undo" ? "button" : "div");
    node.id = id;
    nodes.set(id, node);
    body.appendChild(node);
  }
  const document = {
    body,
    getElementById: (id) => nodes.get(id) || null,
    createElement: (tagName) => new Element(tagName),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    querySelector: (selector) => body.querySelector(selector),
  };
  const ui = renderer({ document, window: { morrow: { invoke, on() {} } } });
  ui.run("renderList = () => {}; settleOpenView = async () => {}; state.view = 'mail';");
  return ui;
}

function prepareCompose(ui) {
  const document = ui.context.document;
  const originalGet = document.getElementById;
  const nodes = new Map();
  document.getElementById = (id) => {
    const original = originalGet(id);
    if (original) return original;
    if (!nodes.has(id)) nodes.set(id, document.createElement("input"));
    return nodes.get(id);
  };
  ui.run(`
    state.accounts = [{ id: "synthetic", email: "me@example.test", platform: "imap" }]; state.accountId = "synthetic";
    resetDraftWrite = () => {}; syncScheduleFields = () => {}; paintComposeChrome = () => {}; paintComposeFromPicker = () => {};
    paintQuoteBody = () => {}; scheduleComposeLayout = () => {}; fillSignatures = async () => {}; loadScheduled = async () => {};
    hideRecipientSuggest = () => {}; closeComposeAi = () => {}; finishComposeOpen = () => {}; openDialog = () => {};
  `);
}

async function settle(ui, outcomes) {
  ui.context.settlement = { outcomes, opIds: [] };
  ui.run("applyActionSettlement(settlement)");
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function loadAgent(database) {
  const filename = require.resolve("../host/agent");
  const fixture = { exports: {} };
  const originalLoad = Module._load;
  Module._load = function (request, ...args) {
    if (request === "electron") return { BrowserWindow: { getAllWindows: () => [] } };
    return originalLoad.call(this, request, ...args);
  };
  try {
    const localRequire = Module.createRequire(filename);
    const fixtureRequire = (request) => request === "./mail/db" ? database : localRequire(request);
    vm.runInThisContext(Module.wrap(fs.readFileSync(filename, "utf8")), { filename })(fixture.exports, fixtureRequire, fixture, filename, path.dirname(filename));
    return fixture.exports;
  } finally {
    Module._load = originalLoad;
  }
}

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-learning-ui-"));
  const previous = process.env.MORROW_AI_CONFIG_DIR;
  process.env.MORROW_AI_CONFIG_DIR = directory;
  const learning = require("../host/agent-learning");
  const calls = [];
  let receipt = (id) => ({ pending: [{ id, actionId: "action-" + id, generation: 1 }], outcomes: [] });
  const ui = createRenderer(async (channel, payload) => {
    calls.push({ channel, payload });
    if (channel === "mail:markRead") return { success: true, data: receipt(payload.emailId) };
    if (channel === "mail:markReadBatch") return { success: true, data: { pending: payload.items.map((item) => receipt(item.emailId).pending[0]), outcomes: [] } };
    if (channel === "nativeAgent:learning:observe") return { success: true, data: learning.observe(payload) };
    if (channel === "nativeAgent:learning:forget") return { success: true, data: learning.forget(payload) };
    return { success: true, data: null };
  });
  const seed = (id, categoryId = "needs-you") => ({ messageId: id, accountId: "synthetic", categoryId, unread: true, from: "same@example.test", threadId: "shared" });
  const outcome = (id, status, extra = {}) => ({ id, actionId: "action-" + id, generation: 1, kind: "read", status, projection: { unread: status === "failed" || status === "not_attempted" }, ...extra });
  const reset = () => {
    calls.length = 0;
    fs.rmSync(learning.storePath(), { force: true });
    ui.run("agentPendingReads.clear(); agentMarkedRead.clear(); actionGeneration.clear(); state.agentLearning = null; agentPaintPayload = null;");
  };
  try {
    ui.context.item = seed("single");
    ui.run("state.prefs.markReadCompletesTodos = true");
    await ui.run("markAgentMessageRead(item)");
    assert.equal(learning.list().patterns.length, 0);
    assert.equal(calls.some((row) => row.channel.endsWith("todoUpdate")), false);
    assert.equal(ui.run("agentPendingReads.get('single').receipt.actionId"), "action-single");
    await ui.run("markAgentMessageRead(item, null, 'done')");
    assert.equal(calls.filter((row) => row.channel === "mail:markRead").length, 1);
    await settle(ui, [outcome("single", "completed")]);
    assert.equal(learning.list().patterns[0].count, 1);
    assert.equal(calls.filter((row) => row.channel.endsWith("todoUpdate")).length, 1);
    await settle(ui, [outcome("single", "completed")]);
    assert.equal(learning.list().patterns[0].count, 1);

    for (const status of ["failed", "unknown", "not_attempted"]) {
      reset();
      ui.context.item = seed(status);
      await ui.run("markAgentMessageRead(item, null, 'done')");
      await settle(ui, [outcome(status, status)]);
      assert.equal(learning.list().patterns.length, 0);
      assert.equal(calls.some((row) => row.channel.endsWith("todoUpdate")), false);
      if (status !== "unknown") {
        assert.equal(ui.run("item.unread"), true);
        assert.equal(ui.run(`agentMarkedRead.has(${JSON.stringify(status)})`), false);
      }
    }

    reset();
    ui.context.item = seed("superseded");
    await ui.run("markAgentMessageRead(item)");
    await settle(ui, [outcome("superseded", "completed", { generation: 2, projection: { unread: true } })]);
    await settle(ui, [outcome("superseded", "completed")]);
    assert.equal(learning.list().patterns.length, 0);
    assert.equal(ui.run("item.unread"), true);

    reset();
    ui.context.item = seed("read-then-star");
    await ui.run("markAgentMessageRead(item)");
    await settle(ui, [outcome("read-then-star", "completed", { kind: "star", actionId: "star", generation: 2 })]);
    assert.equal(ui.run("agentPendingReads.size"), 1);
    await settle(ui, [outcome("read-then-star", "completed")]);
    assert.equal(learning.list().patterns[0].count, 1);

    for (const category of [false, true]) {
      reset();
      ui.context.items = [seed("first", category ? "fyi" : "needs-you"), seed("second", category ? "fyi" : "needs-you")];
      await ui.run(category ? "markAgentCategoryRead(items)" : "applyReplySelection(items, 'read')");
      assert.equal(learning.list().patterns.length, 0);
      await settle(ui, [outcome("first", "completed")]);
      learning.observe({ kind: "action", action: "mark-read", begunAt: 123, items: [seed("interleaved")] });
      await settle(ui, [outcome("second", "completed")]);
      assert.ok(learning.list().patterns.every((row) => row.count === 2));
      assert.equal(calls.filter((row) => row.channel.endsWith("todoUpdate")).length, category ? 0 : 2);
    }

    reset();
    ui.context.items = [seed("good", "fyi"), { ...seed("bad", "fyi"), from: "failed@example.test", threadId: "failed-thread" }];
    await ui.run("markAgentCategoryRead(items)");
    await settle(ui, [outcome("good", "completed"), outcome("bad", "failed")]);
    assert.equal(ui.run("items[1].unread"), true);
    assert.ok(learning.list().patterns.every((row) => row.match.key !== "failed@example.test" && row.match.key !== "failed-thread"));

    for (const status of ["failed", "completed"]) {
      reset();
      receipt = (id) => {
        ui.run(`applyActionSettlement(${JSON.stringify({ outcomes: [outcome(id, status)], opIds: [] })})`);
        return { pending: [{ id, actionId: "action-" + id, generation: 1 }], outcomes: [] };
      };
      ui.context.item = seed("early");
      await ui.run("markAgentMessageRead(item)");
      assert.equal(ui.run("item.unread"), status !== "completed");
      assert.equal(learning.list().patterns.length, status === "completed" ? 2 : 0);
    }

    reset();
    receipt = () => ({});
    ui.context.item = seed("unverified-ipc");
    await ui.run("markAgentMessageRead(item)");
    assert.equal(learning.list().patterns.length, 0);
    assert.equal(ui.run("item.unread"), true);

    reset();
    receipt = (id) => ({ pending: [], outcomes: [outcome(id, "completed")] });
    ui.context.item = seed("immediate");
    await ui.run("markAgentMessageRead(item)");
    assert.equal(learning.list().patterns[0].count, 1);

    reset();
    ui.run("globalThis.savedPaintProjection = paintAgentReadProjection; paintAgentReadProjection = () => { throw new Error('list chrome missing'); };");
    try {
      receipt = (id) => ({ pending: [], outcomes: [outcome(id, "completed")] });
      ui.context.item = seed("paint-fails");
      await ui.run("markAgentMessageRead(item)").catch((error) => {
        if (!/list chrome missing/.test(String(error && error.message))) throw error;
      });
      assert.equal(learning.list().patterns[0].count, 1);
    } finally {
      ui.run("paintAgentReadProjection = savedPaintProjection;");
    }

    for (const category of ["fyi", "other", "done"]) {
      for (const kind of ["reply", "all"]) {
        ui.context.source = { id: category, accountId: "synthetic", from: category + "@example.test", threadId: category + "-thread", subject: "Source" };
        ui.context.kind = kind;
        ui.run("state.agentReplyTodo = null; state.agentReplySource = freshReplyLearningSource(composeSeed(source, kind, 'me@example.test')); state.composeIdentity = { kind }; state.email = { id: 'unrelated', from: 'wrong@example.test', threadId: 'wrong' };");
        const payload = ui.run("withAgentReplyTodo({ to: 'recipient@example.test' })");
        assert.equal(payload.agentTodo, undefined);
        assert.equal(payload.agentLearning.action, kind === "all" ? "reply-all" : "reply");
        assert.equal(payload.agentLearning.items[0].messageId, category);
        assert.equal(payload.agentLearning.items[0].from, category + "@example.test");
        assert.equal(payload.agentLearning.items[0].threadId, category + "-thread");
      }
    }
    assert.equal(ui.run("freshReplyLearningSource({ kind: 'forward', sourceMessageId: 'source' })"), null);
    assert.equal(ui.run("freshReplyLearningSource({ kind: 'reply', sourceMessageId: 'source', draftId: 'saved' })"), null);

    reset();
    ui.run(`agentTurns = [{ role: "assistant", followUps: [{ messageId: "synthetic", label: "Review reply", kind: "open" }] }]; agentProposalIds = ["proposal"]; paintThread(); paintSkillBlocks($("brain-skill-result"), { followUps: [{ messageId: "synthetic", label: "Review reply" }], proposals: [{ id: "skill-proposal", labelName: "Filing" }] }); paintProposals($("agent-proposals"), [{ id: "proposal", labelName: "Filing" }]);`);
    const counts = () => ["agent-sections", "brain-skill-result", "agent-proposals"].map((id) => ui.run(`$(${JSON.stringify(id)}).querySelectorAll('button').length`));
    assert.deepEqual(counts(), [1, 3, 2]);
    ui.run("applyAgentLearning({ patterns: [], suppressed: ['Review reply', 'Filing'] })");
    assert.deepEqual(counts(), [0, 0, 0]);
    ui.run("paintThread(); applyAgentLearning({ patterns: [], suppressed: [] })");
    assert.deepEqual(counts(), [1, 3, 2]);
    ui.run("applyAgentLearning({ patterns: [], suppressed: ['Review reply', 'Filing'] })");
    assert.deepEqual(counts(), [0, 0, 0]);
    assert.equal(calls.length, 0);
    for (const className of ["Review reply", "Filing"]) {
      for (const begunAt of [1, 2, 3]) learning.observe({ kind: "suggestion", choice: "dismiss", className, begunAt });
    }
    ui.context.learned = learning.list();
    ui.run("renderAgentLearned(learned)");
    ui.run("$('agent-learned-list').querySelectorAll('button').forEach((button) => button.click())");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(counts(), [1, 3, 2]);
    assert.ok(calls.every((row) => row.channel === "nativeAgent:learning:forget"));

    ui.context.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
    ui.run("paintFeatureCatalog()");
    const features = ui.run("$('features-catalog').textContent");
    assert.match(features, /wait for mailbox confirmation/);
    assert.match(features, /Replies in any category/);
    assert.match(features, /multi-sender threads/);
    assert.match(features, /refreshes suggestions in open conversations, skills, and proposals/);
    assert.match(features, /do not send mail or move it/);
    const help = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
    assert.match(help, /Reads count only after mailbox confirmation/);
    assert.match(help, /Replies in any category count only after non-partial delivery/);
    assert.match(help, /immediately refreshes open suggestion views/);

    reset();
    fs.writeFileSync(path.join(directory, "ai.json"), JSON.stringify({ apiKey: "synthetic-not-a-live-key" }));
    const messages = ["ada", "bo", "cy"].map((name) => ({ id: name, accountId: "synthetic", from: name + "@example.test", threadId: "multi-sender", unread: true }));
    const database = { hasAccounts: () => true, messageById: (id) => ({ id, account_id: "synthetic", thread_id: "multi-sender" }) };
    const agent = loadAgent(database);
    const categories = [{ id: "needs-you", name: "Needs You" }, { id: "other", name: "Other" }];
    const sections = agent.groupTriage(categories, messages, messages.map((message) => ({ messageId: message.id, categoryId: "needs-you" })));
    const fresh = sections[0].items;
    for (const [index, item] of fresh.entries()) learning.observe({ kind: "action", action: "mark-read", begunAt: index + 1, items: [item] });
    ui.context.learned = learning.list();
    ui.context.fresh = fresh;
    ui.run("state.agentLearning = learned");
    assert.equal(learning.list().patterns.filter((row) => row.learned).length, 1);
    assert.equal(JSON.stringify(ui.run("fresh.map(agentLearnedNotes)")), JSON.stringify(messages.map(() => ["Learned: Mark as read"])));
    const cached = fresh.map(({ threadId, ...item }) => ({ ...item, categoryId: "needs-you" }));
    cached.push({ ...cached[0], messageId: "wrong-account", accountId: "different" });
    fs.writeFileSync(path.join(directory, "agent.json"), JSON.stringify({ triage: { items: cached }, todos: {}, proposals: [], runs: [] }));
    const projected = agent.getTriage().data.sections.flatMap((section) => section.items);
    assert.equal(projected.find((item) => item.messageId === "wrong-account").threadId, "");
    ui.context.projected = projected.filter((item) => item.messageId !== "wrong-account");
    assert.equal(JSON.stringify(ui.run("projected.map(agentLearnedNotes)")), JSON.stringify(messages.map(() => ["Learned: Mark as read"])));
    const compose = createRenderer(async (channel, payload) => {
      if (channel === "mail:getComposeContext") return { success: true, data: {
        ...require("../shared/compose-policy").resolve({ id: "synthetic", email: "me@example.test" }, null, { ccByDomain: {}, accounts: {} }, "new", payload.fromAddress),
        settings: { ccByDomain: {}, accounts: {} },
      } };
      return { success: true, data: null };
    });
    prepareCompose(compose);
    for (const kind of ["reply", "all"]) {
      await compose.run(`openCompose(composeSeed({ id: "fyi-source", accountId: "synthetic", from: "source@example.test", threadId: "fyi-thread" }, ${JSON.stringify(kind)}, "me@example.test"))`);
      assert.equal(compose.run("state.agentReplyTodo"), null);
      assert.equal(compose.run("withAgentReplyTodo({}).agentLearning.items[0].messageId"), "fyi-source");
    }
    console.log("agent-learning-followups-ok: actual renderer receipts, deferred completion, projection, reply source, mounted suggestions");
  } finally {
    if (previous === undefined) delete process.env.MORROW_AI_CONFIG_DIR;
    else process.env.MORROW_AI_CONFIG_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { run, createRenderer, prepareCompose, settle, loadAgent };
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
