// Synthetic Agent card view. No live mailbox, network, or consent files.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sectionNamed(root, name) {
  return [...root.querySelectorAll(".agent-section")].find((node) => (node.querySelector("h3") || {}).textContent.includes(name));
}

async function rendererChecks() {
  const dom = new JSDOM("<!doctype html><body></body>", { url: "https://morrow.test/agent" });
  const document = dom.window.document;
  if (typeof dom.window.PointerEvent !== "function") {
    dom.window.PointerEvent = class PointerEvent extends dom.window.MouseEvent {
      constructor(type, init) {
        super(type, init || {});
        this.pointerType = init && init.pointerType || "";
      }
    };
  }
  document.body.innerHTML = `
    <p id="status"></p><div id="notice"></div><button id="status-chip" hidden></button><button id="undo" hidden></button>
    <section id="agent-panel" data-agent-pane="home">
      <div class="space-head">
        <h2 id="agent-greeting">Agent</h2>
        <div class="agent-view-switch" id="agent-view-switch" role="group" aria-label="Todo view">
          <button type="button" id="agent-view-list" data-agent-view="list" aria-pressed="true">List</button>
          <button type="button" id="agent-view-card" data-agent-view="card" aria-pressed="false">Card</button>
        </div>
      </div>
      <p id="agent-status"></p><p id="agent-context"></p>
      <div id="agent-home"></div>
      <div id="agent-proposals"></div><div id="agent-history"></div><div id="agent-sections"></div>
    </section>
    <button type="button" id="outside">Outside</button>`;
  const calls = [];
  const payload = {
    reason: "ready",
    sections: [
      { id: "needs-you", name: "Needs You", description: "Messages that need a reply or a decision from you.", items: [
        { messageId: "m1", accountId: "ada", subject: "First deadline", unread: true, from: "Ada <ada@example.test>", summary: "Ada asks for the Friday number before noon.", snippet: "Can you send Friday's number?" },
      ] },
      { id: "fyi", name: "FYI", description: "Newsletters, receipts, and notices to skim.", items: [
        { messageId: "m4", accountId: "ada", subject: "Newsletter", unread: true, from: "News <news@example.test>", summary: "Weekly notes." },
      ] },
    ],
  };
  dom.window.morrow = {
    invoke: async (channel, body) => {
      calls.push({ channel, payload: body });
      if (channel === "nativeAgent:home:todoUpdate") return { success: true, data: payload };
      return { success: true, data: {} };
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
    KeyboardEvent: dom.window.KeyboardEvent,
    PointerEvent: dom.window.PointerEvent,
    MouseEvent: dom.window.MouseEvent,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  });
  ui.context.localStorage = dom.window.localStorage;
  const home = document.getElementById("agent-home");
  ui.run(`agentPaintPayload = ${JSON.stringify(payload)}; paintAgentHome(agentPaintPayload);`);
  assert.equal(home.dataset.todoView, "list");
  assert.equal(home.querySelectorAll('[data-testid="agent-card"]').length, 0);
  assert.ok(sectionNamed(home, "Needs You").querySelector('[data-testid="agent-todo-actions"]'));
  assert.equal(document.getElementById("agent-view-card").getAttribute("aria-pressed"), "false");

  ui.run("wireAgentTodoView()");
  document.getElementById("agent-view-card").click();
  assert.equal(home.dataset.todoView, "card");
  assert.equal(document.getElementById("agent-view-card").getAttribute("aria-pressed"), "true");
  assert.equal(document.getElementById("agent-view-list").getAttribute("aria-pressed"), "false");
  assert.equal(home.querySelector('[data-testid="agent-todo-actions"]'), null);
  const needs = sectionNamed(home, "Needs You");
  const card = needs.querySelector('[data-testid="agent-card"]');
  const face = card.querySelector("[data-agent-face]");
  const detail = card.querySelector(".agent-card-detail");
  const summary = card.querySelector(".agent-card-summary");
  assert.equal(detail.getAttribute("role"), "group");
  assert.notEqual(detail.getAttribute("role"), "tooltip");
  assert.equal(card.querySelector(".agent-card-sender").textContent, "Ada");
  assert.equal(card.querySelector(".agent-card-subject").textContent, "First deadline");
  assert.equal(card.querySelector(".agent-card-line").textContent, "Ada asks for the Friday number before noon.");
  assert.deepEqual([...card.querySelectorAll(".agent-card-chips button")].map((button) => button.getAttribute("aria-label")), ["Reply", "Done"]);
  assert.deepEqual([...card.querySelectorAll(".agent-card-quick button")].map((button) => button.getAttribute("aria-label")), ["Reply", "Done", "Dismiss"]);
  assert.equal(summary.querySelector("button"), null);
  assert.equal(card.querySelector(".agent-card-class").textContent, "Needs You — Messages that need a reply or a decision from you.");
  assert.equal(card.querySelector(".agent-card-thread").textContent, "Can you send Friday's number?");
  assert.ok(card.querySelector(".agent-select"));
  const fyi = sectionNamed(home, "FYI").querySelector('[data-testid="agent-card"]');
  assert.equal(fyi.querySelector(".agent-select"), null);
  assert.equal(fyi.querySelector(".agent-card-thread").textContent, "Thread · Newsletter");
  assert.equal(needs.querySelector(".agent-section-head").getAttribute("aria-describedby"), null);
  assert.equal(document.querySelector(".space-head").querySelector("[aria-describedby]"), null);
  assert.equal(document.querySelector(".space-head").querySelector(".agent-card-detail"), null);
  assert.equal(detail.hidden, true);
  assert.equal(face.getAttribute("title"), "Ada asks for the Friday number before noon.");
  assert.equal(face.getAttribute("aria-describedby"), null);
  assert.equal(calls.length, 0, "painting and switching views does not read or complete mail");

  card.dispatchEvent(new dom.window.PointerEvent("pointerenter", { bubbles: false, pointerType: "mouse" }));
  assert.equal(card.classList.contains("is-open"), true);
  assert.equal(detail.hidden, false);
  assert.equal(face.getAttribute("title"), null, "native title is suppressed while the detail is open");
  assert.equal(face.getAttribute("aria-describedby"), summary.id);
  assert.equal(face.getAttribute("aria-expanded"), "true");
  const described = [...home.querySelectorAll("[aria-describedby]")].filter((node) => node.getAttribute("aria-describedby").split(/\s+/).includes(summary.id));
  assert.deepEqual(described, [face]);
  for (const button of card.querySelectorAll("button")) assert.equal(button.getAttribute("aria-describedby"), null);
  assert.equal(calls.length, 0, "opening the detail does not open the message or complete the todo");
  face.setAttribute("aria-describedby", summary.id + " kept-note");
  card.dispatchEvent(new dom.window.PointerEvent("pointerleave", { bubbles: false, pointerType: "mouse" }));
  assert.equal(card.classList.contains("is-open"), false);
  assert.equal(face.getAttribute("aria-describedby"), "kept-note");
  assert.equal(face.getAttribute("title"), "Ada asks for the Friday number before noon.");

  face.focus();
  assert.equal(card.classList.contains("is-open"), true);
  assert.equal(document.activeElement, face);
  face.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(card.classList.contains("is-open"), false);
  assert.equal(document.activeElement, face);
  assert.equal(face.getAttribute("title"), "Ada asks for the Friday number before noon.");
  assert.equal(face.getAttribute("aria-describedby"), "kept-note");
  card.dispatchEvent(new dom.window.PointerEvent("pointerenter", { bubbles: false, pointerType: "mouse" }));
  assert.equal(card.classList.contains("is-open"), false, "Escape keeps the detail closed until a new pointer entry");
  card.dispatchEvent(new dom.window.PointerEvent("pointerleave", { bubbles: false, pointerType: "mouse" }));
  card.dispatchEvent(new dom.window.PointerEvent("pointerenter", { bubbles: false, pointerType: "mouse" }));
  assert.equal(card.classList.contains("is-open"), true);
  document.getElementById("outside").focus();
  await tick();
  assert.equal(card.classList.contains("is-open"), false, "blur dismisses after focus leaves the card");

  face.focus();
  assert.equal(card.classList.contains("is-open"), true);
  document.getElementById("outside").dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
  assert.equal(card.classList.contains("is-open"), false, "a press outside dismisses the detail");

  const reply = card.querySelector(".agent-card-chips [data-action='reply']");
  reply.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
  reply.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(card.classList.contains("is-open"), true);
  assert.equal(calls.length, 0, "the first tap opens the detail and does not run the chip");
  reply.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, "mail:openEmail");
  assert.equal(calls.some((row) => row.channel === "nativeAgent:home:todoUpdate"), false);
  calls.length = 0;

  const done = card.querySelector(".agent-card-chips [data-action='done']");
  done.click();
  await tick();
  assert.equal(calls[0].channel, "nativeAgent:home:todoUpdate");
  assert.equal(calls[0].payload.status, "done");
  assert.equal(calls[0].payload.messageId, "m1");
  assert.equal(calls.some((row) => row.channel === "mail:markRead" || row.channel === "mail:markReadBatch"), false);
  calls.length = 0;
  sectionNamed(home, "Needs You").querySelector(".agent-card-quick [data-action='dismiss']").click();
  await tick();
  assert.equal(calls[0].payload.status, "dismissed");
  assert.equal(calls[0].payload.accountId, "ada");

  document.getElementById("agent-view-list").click();
  assert.equal(home.dataset.todoView, "list");
  assert.ok(sectionNamed(home, "Needs You").querySelector('[data-testid="agent-todo-actions"]'));
  assert.equal(home.querySelector('[data-testid="agent-card"]'), null);
  assert.equal(dom.window.localStorage.getItem("morrow.agentTodoView"), "list");
}

function sourceChecks() {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  const head = html.slice(html.indexOf('id="agent-panel"'), html.indexOf('id="agent-nav"'));
  assert.match(head, /id="agent-view-switch"/);
  assert.match(head, /id="agent-view-list"/);
  assert.match(head, /id="agent-view-card"[\s\S]*Card\s*<\/button>/);
  assert.doesNotMatch(head, /agent-card-detail|agent-card-summary|<details|aria-describedby="agent-detail/, "header has the switcher and no second detail disclosure");
  assert.doesNotMatch(html, /class="agent-card-detail"/, "detail is created with the card, not copied into the page");
  const css = fs.readFileSync(path.join(root, "renderer/app.css"), "utf8");
  assert.match(css, /@media \(hover: none\), \(max-width: 720px\)/);
  assert.match(css, /\.agent-card-detail\[hidden\]/);
  const catalog = require("../renderer/features-catalog").items.find((row) => row.id === "agent-triage");
  assert.match(catalog.blurb, /Todos switcher includes List and Card/);
  assert.match(catalog.blurb, /page header does not repeat that detail/);
  assert.match(catalog.blurb, /Opening the detail does not open the message or complete the todo/);
}

async function main() {
  sourceChecks();
  await rendererChecks();
  console.log("agent card view ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
