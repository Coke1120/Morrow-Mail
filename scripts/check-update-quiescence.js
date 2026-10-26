"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const vm = require("node:vm");
const { createGate, requestRendererQuiescence } = require("../host/update-quiescence");

async function main() {
  const gate = createGate();
  let finish;
  const active = gate.run(async () => {
    await new Promise(resolve => { finish = resolve; });
    // Finishing a previously admitted operation may itself persist more work.
    return gate.run(() => 42);
  });
  let drained = false;
  const drain = gate.prepare().then(() => { drained = true; });
  assert.throws(() => gate.run(() => assert.fail("new write started")), /update/);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(drained, false);
  finish();
  assert.equal(await active, 42);
  await drain;
  assert.equal(gate.pending, 0);
  await assert.rejects(gate.prepare(), /already/);
  gate.resume();
  assert.equal(gate.run(() => 7), 7);
  let release;
  const stuck = gate.run(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(gate.prepare({ timeoutMs: 5 }), /still running/);
  assert.equal(gate.closed, true);
  gate.resume(); release(); await stuck;
  assert.throws(() => gate.run(() => { throw Error("failed write"); }), /failed write/);
  assert.equal(gate.pending, 0);

  const ipc = new EventEmitter();
  const contents = new EventEmitter();
  contents.mainFrame = {};
  contents.isDestroyed = () => false;
  const sent = [];
  contents.send = (channel, payload) => sent.push({ channel, payload });
  const win = { isDestroyed: () => false, webContents: contents };
  const prepared = requestRendererQuiescence(win, ipc);
  const nonce = sent[0].payload.nonce;
  ipc.emit("host:updatePrepared", { sender: contents, senderFrame: {} }, { nonce, ok: true });
  assert.equal(ipc.listenerCount("host:updatePrepared"), 1, "subframe reply cannot approve");
  ipc.emit("host:updatePrepared", { sender: {}, senderFrame: contents.mainFrame }, { nonce, ok: true });
  await assert.rejects(requestRendererQuiescence(win, ipc), /already/);
  ipc.emit("host:updatePrepared", { sender: contents, senderFrame: contents.mainFrame }, { nonce, ok: true });
  const resume = await prepared;
  assert.equal(ipc.listenerCount("host:updatePrepared"), 0);
  resume();
  assert.equal(sent.at(-1).channel, "host:updateResume");
  await assert.rejects(requestRendererQuiescence(win, ipc, { timeoutMs: 5 }), /did not confirm/);
  assert.equal(sent.at(-1).channel, "host:updateResume");
  const refused = requestRendererQuiescence(win, ipc);
  ipc.emit("host:updatePrepared", { sender: contents, senderFrame: contents.mainFrame }, { nonce: sent.at(-1).payload.nonce, ok: false });
  await assert.rejects(refused, /drafts/);

  const app = fs.readFileSync(require.resolve("../renderer/app.js"), "utf8");
  const guards = app.slice(app.indexOf("function updateRestartBlocked()"), app.indexOf("function shellLook("));
  let dialogs = [];
  const nodes = { "agent-memory": { value: "" }, "agent-input": { value: "" } };
  const replies = [];
  const context = vm.createContext({
    document: { body: { inert: false }, querySelectorAll: () => dialogs },
    $: id => nodes[id], api: { replyUpdatePreparation: p => replies.push(p) },
    oooDirty: () => false, aiDirty: () => false, inboxRuleBaseline: "", updateAiBaseline: null,
    state: {}, sendTimer: null, agentChatBusy: false, brainSkillBusy: false,
    attachmentTasks: new Map(),
    brainFixBusy: false, brainCategoryBusy: false, brainView: {},
    brainCategories: [], updateCategoriesBaseline: "[]", updateMemoryBaseline: "",
    updateFreezeNonce: null, updateWasInert: false,
  });
  vm.runInContext(guards, context);
  assert.equal(context.updateRestartBlocked(), false);
  context.attachmentTasks.set("download", {});
  assert.equal(context.updateRestartBlocked(), true, "active attachment requests block restart");
  context.attachmentTasks.clear();
  context.aiDirty = () => true;
  assert.equal(context.updateRestartBlocked(), true, "unsaved AI authentication/model changes block restart");
  context.aiDirty = () => false;
  dialogs = [{ id: "compose" }];
  context.prepareUpdateRestart({ nonce: "draft" });
  assert.equal(replies.at(-1).ok, false);
  assert.equal(context.document.body.inert, false);
  dialogs = [{ id: "settings" }];
  assert.equal(context.updateRestartBlocked(), true);
  dialogs = [{ id: "about-dialog" }];
  nodes["agent-memory"].value = "unsaved notes";
  assert.equal(context.updateRestartBlocked(), true);
  nodes["agent-memory"].value = "";
  context.brainCategories = [{ id: "unsaved" }];
  assert.equal(context.updateRestartBlocked(), true);
  context.brainCategories = [];
  context.state.composeQueued = true;
  assert.equal(context.updateRestartBlocked(), true, "undo-send must not be accelerated");
  context.state.composeQueued = false;
  context.prepareUpdateRestart({ nonce: "safe" });
  assert.equal(context.document.body.inert, true);
  context.resumeAfterUpdate({ nonce: "wrong" });
  assert.equal(context.document.body.inert, true);
  context.resumeAfterUpdate({ nonce: "safe" });
  assert.equal(context.document.body.inert, false);
  console.log("Update shutdown gate, authenticated renderer handshake, editor refusal and recovery checks passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
