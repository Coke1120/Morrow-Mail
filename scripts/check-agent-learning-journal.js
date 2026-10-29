const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRenderer, prepareCompose, settle, loadAgent } = require("./check-agent-learning-followups");

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-learning-journal-"));
  const previous = {};
  for (const name of ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS"]) previous[name] = process.env[name];
  Object.assign(process.env, { MORROW_USER_DATA: directory, MORROW_MAIL_DIR: directory, MORROW_AI_CONFIG_DIR: directory, MORROW_MAIL_SECRETS: "memory" });
  let engine;
  let database;
  let remote;
  let savedRemote;
  let releaseProvider = () => {};
  try {
    engine = require("../host/mail/engine");
    database = require("../host/mail/db");
    remote = require("../host/mail/remote");
    savedRemote = { withClient: remote.withClient, changeFlags: remote.changeFlags };
    const secrets = require("../host/mail/secrets");
    const learning = require("../host/agent-learning");
    const agent = loadAgent(database);
    await database.close();
    await engine.init();
    database.insertAccount({ id: "synthetic", email: "me@example.test", username: "me", profile: "custom", createdAt: Date.now(), imapHost: "imap.example.test", imapPort: 993, imapTls: true, smtpHost: "smtp.example.test", smtpPort: 587, smtpTls: true });
    database.replaceFolders("synthetic", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }, { path: "Sent", name: "Sent", wellKnown: "sentitems" }]);
    secrets.setPassword("synthetic", "fixture-only");
    fs.writeFileSync(path.join(directory, "ai.json"), JSON.stringify({ apiKey: "synthetic-not-a-live-key" }));
    const calls = [];
    const ui = createRenderer(async (channel, payload) => {
      calls.push({ channel, payload });
      return channel.startsWith("nativeAgent:") ? agent.answer(channel, [payload]) : engine.answer(channel, [payload]);
    });
    ui.run("state.prefs.markReadCompletesTodos = true");
    let uid = 1;
    const item = (id, categoryId = "needs-you", from = "shared@example.test") => {
      const source = { messageId: id, accountId: "synthetic", categoryId, from, threadId: "shared-thread", unread: true };
      const when = new Date();
      database.insertMessage({
        id, accountId: "synthetic", folderPath: "INBOX", uid: uid++, uidValidity: 1, from, threadId: source.threadId,
        date: when.toISOString(), listSortTs: when.getTime(), unread: true, bodyComplete: true,
        recipientHeaders: { replyTo: [] },
      });
      return source;
    };
    const writeAgent = (items, todos = {}) => fs.writeFileSync(path.join(directory, "agent.json"), JSON.stringify({ installedSkillIds: null, triage: { reason: "ready", updatedAt: new Date().toISOString(), items }, todos, proposals: [], runs: [], schedules: [] }));
    const reset = () => {
      fs.rmSync(learning.storePath(), { force: true });
      calls.length = 0;
      ui.run("agentPendingReads.clear(); agentMarkedRead.clear(); actionGeneration.clear(); agentPaintPayload = null;");
    };
    for (const status of ["completed", "failed", "unknown"]) {
      reset();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      releaseProvider = release;
      remote.withClient = async (_account, _secret, work) => {
        await gate;
        if (status === "failed") throw new Error("synthetic connection refused before STORE");
        return work({});
      };
      remote.changeFlags = async () => { if (status === "unknown") throw new Error("synthetic uncertain STORE"); };
      ui.context.item = item("read-" + status);
      writeAgent([ui.context.item]);
      await ui.run("markAgentMessageRead(item, null, 'done')");
      assert.equal(learning.list().patterns.length, 0);
      assert.equal(calls.some((row) => row.channel.endsWith("todoUpdate")), false);
      release();
      const packet = await engine.settleActions();
      assert.equal(packet.outcomes[0].status, status);
      await settle(ui, packet.outcomes);
      assert.equal(learning.list().patterns.length, status === "completed" ? 2 : 0);
      assert.equal(calls.some((row) => row.channel.endsWith("todoUpdate")), status === "completed");
      if (status === "failed") assert.equal(ui.run("item.unread"), true);
    }

    reset();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    releaseProvider = release;
    remote.withClient = async (_account, _secret, work) => { await gate; return work({}); };
    remote.changeFlags = async () => {};
    ui.context.items = [item("batch-first", "fyi"), item("batch-second", "fyi")];
    writeAgent(ui.context.items);
    await ui.run("markAgentCategoryRead(items)");
    assert.equal(learning.list().patterns.length, 0);
    release();
    const packet = await engine.settleActions();
    assert.equal(packet.outcomes.length, 2);
    for (const outcome of packet.outcomes) {
      await settle(ui, [outcome]);
      assert.ok(learning.list().patterns.every((row) => row.count === 1));
    }
    assert.equal(calls.some((row) => row.channel.endsWith("todoUpdate")), false);

    reset();
    const undoGate = new Promise((resolve) => { release = resolve; });
    releaseProvider = release;
    remote.withClient = async (_account, _secret, work) => { await undoGate; return work({}); };
    ui.context.items = [item("undo-pending", "fyi")];
    writeAgent(ui.context.items);
    await ui.run("markAgentCategoryRead(items)");
    await ui.run("undoReadBatch()");
    assert.equal(ui.run("agentPendingReads.size"), 0);
    release();
    await settle(ui, (await engine.settleActions()).outcomes);
    assert.equal(learning.list().patterns.length, 0);

    reset();
    prepareCompose(ui);
    const sources = [item("reply-fyi", "fyi", "fyi@example.test"), item("reply-other", "other", "other@example.test"), item("reply-done", "needs-you", "done@example.test")];
    writeAgent(sources, { "reply-done": { status: "done" } });
    const success = async () => ({ messageId: "<synthetic-send@example.test>", accepted: ["recipient@example.test"], rejected: [] });
    engine.setSmtpSenderForTest(success);
    const base = { accountId: "synthetic", fromAddress: "me@example.test", to: "recipient@example.test", subject: "Synthetic reply", body: "<p>Synthetic</p>" };
    ui.context.base = base;
    for (const [index, source] of sources.entries()) {
      const kind = index === 1 ? "all" : "reply";
      ui.context.source = { ...source, id: source.messageId };
      await ui.run(`openCompose(composeSeed(source, ${JSON.stringify(kind)}, 'me@example.test'))`);
      assert.equal(ui.run("state.agentReplyTodo"), null);
      ui.run("state.email = { id: 'wrong', from: 'wrong@example.test', threadId: 'wrong' }");
      await new Promise((resolve) => setTimeout(resolve, 2));
      await ui.run("call('mail:send', withAgentReplyTodo(base))");
      assert.equal(learning.list().patterns.find((row) => row.match.key === source.from).count, 1);
    }
    const before = JSON.stringify(learning.list());
    engine.setSmtpSenderForTest(async () => { throw new Error("synthetic send failed"); });
    await assert.rejects(ui.run("call('mail:send', withAgentReplyTodo(base))"));
    assert.equal(JSON.stringify(learning.list()), before);
    engine.setSmtpSenderForTest(async () => ({ messageId: "<partial@example.test>", accepted: ["recipient@example.test"], rejected: ["rejected@example.test"] }));
    await ui.run("call('mail:send', withAgentReplyTodo({ ...base, to: 'recipient@example.test, rejected@example.test' }))");
    assert.equal(JSON.stringify(learning.list()), before);
    engine.setSmtpSenderForTest(success);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const queued = await ui.run("call('mail:scheduleSend', { ...withAgentReplyTodo(base), sendAt: '2099-01-01T00:00:00.000Z' })");
    assert.equal(JSON.stringify(learning.list()), before);
    database.setScheduledSendAt(queued.id, 0);
    await engine.pumpScheduled();
    assert.equal(learning.list().patterns.find((row) => row.match.key === "done@example.test").count, 2);
    const after = JSON.stringify(learning.list());
    const canceled = await ui.run("call('mail:scheduleSend', { ...withAgentReplyTodo(base), sendAt: '2099-01-02T00:00:00.000Z' })");
    engine.answer("mail:cancelScheduled", [{ id: canceled.id }]);
    assert.equal(JSON.stringify(learning.list()), after);
    console.log("agent-learning-journal-ok: real durable actions and renderer-to-host sends, delayed success/failure, partial/canceled sends");
  } finally {
    releaseProvider();
    if (engine) {
      engine.setSmtpSenderForTest(null);
      await engine.settleActions().catch(() => {});
    }
    if (savedRemote) Object.assign(remote, savedRemote);
    if (database) await database.close();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { run };
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
