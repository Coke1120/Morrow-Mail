const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const api = require("../renderer/agent-actions");
const { renderer } = require("./check-ux-workflows");

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const msg = (id, accountId, subject, unread = true) => ({
  messageId: id, accountId, subject, unread, folderId: "INBOX", from: "test@example.test", hasAttachments: false,
});
const payload = { sections: [
  { id: "needs-you", name: "Needs You", items: [msg("guard", "ada", "New sign-in notice", false)] },
  { id: "fyi", name: "FYI", items: [msg("a", "ada", "Newsletter"), msg("b", "grace", "Ordinary mail"),
    msg("c", "grace", "Another item"), msg("due", "grace", "Action required · deadline 2026-11-25")] },
] };

function setup() {
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  const markup = html.slice(html.indexOf('<section id="agent-actions-surface"'), html.indexOf('<section id="agent-conversation"'));
  const dom = new JSDOM('<div id="agent-panel"><p id="status"></p><div id="notice"></div><button id="undo" hidden></button>' + markup + '</div>', { url: "https://morrow.test/agent" });
  const calls = [];
  const ui = renderer({
    document: dom.window.document, window: dom.window,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  });
  dom.window.morrowAgentActions = api;
  ui.context.calls = calls;
  ui.context.input = JSON.parse(JSON.stringify(payload));
  ui.run(`
    state.view = "agent"; renderList = () => {};
    state.accounts = [
      { id: "ada", email: "ada@example.test", bodyEpoch: 3 },
      { id: "grace", email: "grace@example.test", bodyEpoch: 7 },
    ];
    state.prefs.markReadCompletesTodos = true;
    showStatus = (text) => { document.getElementById("status").textContent = text; };
    call = async (channel, params) => { calls.push({ channel, params }); return null; };
    paintAgentHome(input);
  `);
  const doc = dom.window.document;
  const control = name => doc.querySelector("[data-" + name + "]");
  const button = (node, label) => [...node.querySelectorAll("button")].find(b => b.textContent === label);
  function check(subject) {
    const box = [...doc.querySelectorAll(".agent-select")].find(node => node.getAttribute("aria-label") === "Select " + subject);
    assert.ok(box, subject);
    box.checked = true;
    box.dispatchEvent(new dom.window.Event("change"));
  }
  return { ui, doc, dom, control, button, calls, check };
}

test("cached decision cards distinguish already-read, deadline and unresolved; local answers do not write or learn", async () => {
  const s = setup();
  const scope = s.control("agent-decision-cards");
  assert.match(scope.textContent, /ada@example.test · Read.*Unresolved/s);
  assert.match(scope.textContent, /Subject deadline: 2026-11-25/);
  const guard = scope.querySelector("article");
  s.button(guard, "Not me").click();
  assert.match(scope.textContent, /Not me · still unresolved/);
  s.button(scope.querySelector("article"), "Recognize this time").click();
  assert.match(scope.textContent, /Recognized this time · no rule saved/);
  assert.equal(s.calls.length, 0);
  s.ui.run('state.accounts.find(a => a.id === "ada").bodyEpoch = 4; paintAgentHome(input)');
  assert.doesNotMatch(scope.textContent, /Recognized this time/);
  const verified = [...scope.querySelectorAll("article")].find(row => row.textContent.includes("New sign-in"));
  s.ui.run(`call = async (channel, params) => {
    calls.push({channel, params}); return { email: { id: "guard", accountId: "grace" } };
  }`);
  s.button(verified, "Open source").click();
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(s.calls)), [{ channel: "mail:openEmail", params: { emailId: "guard", includeThread: false, accountId: "ada" } }]);
  assert.match(s.doc.querySelector("#status").textContent, /no longer available for this mailbox/);
  s.dom.window.close();
});

test("one toolbar reads the exact multi-account selection and keeps a mixed receipt with only confirmed Undo", async () => {
  const s = setup();
  assert.equal(s.control("agent-batch-toolbar").hidden, true);
  s.check("Newsletter"); s.check("Ordinary mail"); s.check("Another item");
  assert.match(s.control("selection-scope").textContent, /3 selected · 2 mailboxes/);
  assert.equal(s.doc.querySelectorAll(".agent-archive-selected").length, 0);
  s.ui.run(`
    globalThis.undoRows = [];
    showReadUndo = (text, rows) => undoRows.push(...rows);
    call = async (channel, params) => {
      calls.push({channel, params});
      if (channel !== "mail:markReadBatch") return null;
      return {
        outcomes: [{ id: "a", generation: 1, actionId: "a1", kind: "read", status: "completed" }],
        pending: [{ id: "b", generation: 2, actionId: "b2", kind: "read" }],
      };
    };
  `);
  s.control("batch-read").click();
  await tick();
  const writes = s.calls.filter(x => x.channel === "mail:markReadBatch");
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].params.items)),
    [{ emailId: "a", accountId: "ada" }, { emailId: "b", accountId: "grace" }, { emailId: "c", accountId: "grace" }]);
  assert.equal(s.calls.filter(x => x.channel.endsWith("todoUpdate")).length, 0);
  assert.match(s.control("agent-batch-receipts").textContent, /Newsletter: Completed/);
  assert.match(s.control("agent-batch-receipts").textContent, /Ordinary mail: Awaiting confirmation/);
  assert.match(s.control("agent-batch-receipts").textContent, /Another item: Unknown/);
  assert.deepEqual(Array.from(s.ui.run("undoRows"), x => x.emailId), ["a"]);
  s.ui.run(`agentUxReceipt.settle({id:"b", generation:1, actionId:"b2", kind:"read", status:"completed"});
    agentUxReceipt.settle({id:"b", generation:2, actionId:"b2", kind:"remove", status:"completed"});`);
  assert.match(s.control("agent-batch-receipts").textContent, /Ordinary mail: Awaiting confirmation/);
  s.ui.run(`agentUxReceipt.settle({id:"b", generation:2, actionId:"b2", kind:"read", status:"failed"});`);
  assert.match(s.control("agent-batch-receipts").textContent, /Ordinary mail: Failed/);
  s.control("batch-clear").click();
  assert.equal(s.control("agent-batch-toolbar").hidden, true);
  s.dom.window.close();
});

test("archive protects unresolved mail, confirms scope and ignores later selections", async () => {
  const s = setup();
  s.ui.run(`
    globalThis.archives = [];
    globalThis.reviews = [];
    askConfirm = (copy) => { reviews.push(copy); return new Promise(resolve => { globalThis.answer = resolve; }); };
    queueBulkRemoval = (...args) => archives.push(args);
  `);
  s.check("New sign-in notice"); s.check("Newsletter");
  s.control("batch-archive").click();
  await tick();
  assert.match(s.doc.querySelector("#status").textContent, /still needs a decision.*Nothing was archived/);
  assert.equal(s.ui.run("reviews.length"), 0);
  s.control("batch-clear").click();
  s.check("Newsletter"); s.check("Ordinary mail");
  s.control("batch-archive").click();
  await tick();
  assert.match(s.ui.run("reviews[0].body"), /Archive 2 messages.*ada@example.test.*grace@example.test.*not their conversations/);
  s.ui.run("answer({ok:false})");
  await tick();
  assert.equal(s.ui.run("archives.length"), 0);
  s.control("batch-archive").click();
  s.check("Another item");
  s.ui.run("answer({ok:true})");
  await tick();
  assert.deepEqual(Array.from(s.ui.run("archives[0][1][0].params.items"), x => x.emailId), ["a", "b"]);
  assert.deepEqual(Array.from(s.ui.run("archives[0][1][0].params.contextOwners"), x => x.accountId), ["ada", "grace"]);
  assert.equal(s.ui.run("archives[0][1][0].params.threadId"), undefined);
  s.ui.run(`archives[0][4].accept([{id:"a", status:"completed", opId:"op"}, {id:"b", status:"not_attempted"}]);`);
  assert.match(s.control("agent-batch-receipts").textContent, /Newsletter: Completed.*Ordinary mail: Not attempted/s);
  assert.equal(s.calls.length, 0);
  s.dom.window.close();
});

test("exact receipts reject stale or unrelated events and archival completion without proof has no Undo", () => {
  const r = api.createReceipt("remove", [{ id: "a" }, { id: "b" }, { id: "c" }], () => {});
  assert.equal(r.settle({ id: "a", actionId: "older-a", generation: 1, kind: "remove", status: "completed", opId: "old" }), false);
  r.settle({ id: "a", actionId: "new-a", generation: 3, kind: "remove", status: "completed", opId: "match" });
  r.accept([{ id: "a", actionId: "new-a", generation: 3, status: "pending" }, { id: "b", status: "completed" }]);
  assert.equal(r.rows.get("c").status, "unknown");
  assert.deepEqual(r.reversible().map(x => x.id), ["a"]);
  assert.equal(api.reasonFor({ subject: "Action required, due 2026-02-30" }, "").date, "");
  assert.equal(api.reasonFor({ subject: "Action required, due 2026-02-28" }, "").date, "2026-02-28");
});

test("stale results preserve visibility but retire recognition and refuse archive, including while review is open", async () => {
  const s = setup();
  s.ui.run("input.stale = true; paintAgentHome(input);");
  const block = s.control("agent-decision-cards");
  assert.match(block.querySelector("[data-decision-stale]").textContent, /out of date/);
  assert.equal(block.querySelector("[data-decision-stale]").hidden, false);
  assert.equal(s.button(block, "Recognize this time"), undefined);
  assert.ok(s.button(block, "Open source"));
  s.check("Newsletter");
  s.control("batch-archive").click();
  await tick();
  assert.match(s.doc.querySelector("#status").textContent, /out of date.*Nothing was archived/);
  s.ui.run(`
    globalThis.archives = [];
    askConfirm = () => new Promise(resolve => { globalThis.answer = resolve; });
    queueBulkRemoval = (...args) => archives.push(args);
    input.stale = false; paintAgentHome(input);
  `);
  s.control("batch-archive").click();
  await tick();
  s.ui.run("input.stale = true; paintAgentHome(input); answer({ok:true});");
  await tick();
  assert.equal(s.ui.run("archives.length"), 0);
  assert.match(s.doc.querySelector("#status").textContent, /out of date.*Nothing was archived/);
  s.control("batch-read").click();
  await tick();
  assert.equal(s.calls.filter(row => row.channel === "mail:markReadBatch").length, 1, "exact mark-as-read still works on a stale classification");
  s.dom.window.close();
});

test("late Agent receipts do not steal a newer unrelated Mail read Undo", async () => {
  const s = setup();
  s.check("Newsletter"); s.check("Ordinary mail");
  s.ui.run(`
    call = async (channel, params) => {
      if (channel === "mail:markReadBatch") return {
        outcomes: [],
        pending: [{id:"a", actionId:"a37", generation:37}, {id:"b", actionId:"b38", generation:38}],
      };
      return null;
    };
    learnAgent = async () => {};
  `);
  s.control("batch-read").click();
  await tick();
  assert.equal(s.ui.run("readUndoItems"), null, "pending Agent changes do not offer Undo");
  s.ui.run(`
    showReadUndo("Unrelated Mail read", [{emailId:"newer",accountId:"ada",generation:1}]);
    applyActionSettlement({outcomes:[
      {id:"a",actionId:"a37",generation:37,kind:"read",status:"completed",projection:{unread:false}},
      {id:"b",actionId:"b38",generation:38,kind:"read",status:"failed",projection:{unread:true}},
    ],opIds:[]});
  `);
  await tick();
  assert.equal(s.ui.run("readUndoItems[0].emailId"), "newer");
  assert.equal(s.ui.run("undoReceipt"), "Unrelated Mail read");
  assert.match(s.control("agent-batch-receipts").textContent, /Newsletter: Completed.*Ordinary mail: Failed/s);
  s.dom.window.close();
});

test("early Agent read settlement supplies the batch receipt and only its verified Undo", async () => {
  for (const toolbar of [true, false]) {
    for (const variant of ["completed", "failed", "wrong-action", "newer-undo"]) {
      const s = setup();
      try {
        s.ui.context.variant = variant;
        s.ui.run(`
          input.sections[1].items = input.sections[1].items.slice(0, 1);
          paintAgentHome(input);
          globalThis.learnCount = 0;
          learnAgent = async () => { learnCount++; };
          call = async (channel, params) => {
            calls.push({ channel, params });
            if (channel !== "mail:markReadBatch") return null;
            if (variant === "newer-undo") showReadUndo("Unrelated Mail read",
              [{emailId:"newer", accountId:"ada", generation:1}]);
            applyActionSettlement({opIds:[], outcomes:[{
              id:"a", kind:"read", actionId:variant === "wrong-action" ? "unrelated" : "a31",
              generation:31, status:variant === "failed" ? "failed" : "completed",
              projection:{unread:variant === "failed"},
            }]});
            return { outcomes:[], pending:[{id:"a", actionId:"a31", generation:31, kind:"read"}] };
          };
        `);
        if (toolbar) {
          s.check("Newsletter");
          s.control("batch-read").click();
        } else {
          s.doc.querySelector("[data-testid=agent-category-read]").click();
        }
        await tick();
        const context = (toolbar ? "toolbar: " : "category: ") + variant;
        const status = s.doc.querySelector("#status").textContent;
        const receipt = toolbar ? s.control("agent-batch-receipts").textContent : status;
        const undo = JSON.parse(s.ui.run("JSON.stringify(readUndoItems)"));
        assert.equal(s.calls.filter(x => x.channel === "mail:markReadBatch").length, 1, context);
        if (variant === "completed") {
          assert.deepEqual(undo, [{emailId:"a", accountId:"ada", generation:31}], context);
          assert.equal(s.ui.run("learnCount"), 1, context);
          assert.match(receipt, /1 completed/i, context);
          assert.doesNotMatch(receipt, /Refresh before retrying|check before retrying/i, context);
        } else if (variant === "newer-undo") {
          assert.equal(undo[0].emailId, "newer", context);
          assert.equal(s.ui.run("undoReceipt"), "Unrelated Mail read", context);
          if (toolbar) assert.match(receipt, /1 completed/i, context);
        } else {
          assert.equal(undo, null, context);
          assert.equal(s.ui.run("learnCount"), 0, context);
          if (variant === "failed") assert.match(receipt, /1 failed/i, context);
          else assert.match(receipt, /1 unknown/i, context);
        }
      } finally {
        s.dom.window.close();
      }
    }
  }
});
