(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowAgentActions = api;
})(globalThis, function () {
  "use strict";

  const security = /\b(?:new (?:sign[ -]?in|log[ -]?in|device)|security (?:alert|notice)|(?:sign[ -]?in|log[ -]?in) (?:alert|notification)|unusual (?:activity|sign[ -]?in)|verification code|one[- ]time (?:code|password)|password (?:reset|chang(?:e|ed)))\b|新裝置|登入通知|驗證碼|新しい端末|認証コード/i;
  const action = /\b(?:payment (?:failed|declined)|deadline|action required|reply requested|(?:build|ci|deploy(?:ment)?) fail(?:ed|ure))\b|付款失敗|限期|需要回覆|支払い失敗/i;
  const labels = {
    submitting: "Submitting", pending: "Awaiting confirmation", completed: "Completed",
    failed: "Failed", unknown: "Unknown · check before retrying", not_attempted: "Not attempted",
    skipped: "No change needed",
  };

  function reasonFor(item, role) {
    const subject = typeof item?.subject === "string" ? item.subject : "";
    const due = subject.match(/(?:\b(?:due|deadline)\s*[:：]?\s*|限期\s*[:：]?\s*)(\d{4}-\d{2}-\d{2})(?![\d-])/i)?.[1] || "";
    const date = due && Number.isFinite(Date.parse(due)) && new Date(due).toISOString().slice(0, 10) === due ? due : "";
    if (security.test(subject)) return { kind: "security", why: "The subject suggests a security event; it is not verified.", date };
    if (action.test(subject)) return { kind: "action", why: "The subject suggests a follow-up or deadline.", date };
    if (role === "reply" || role === "today") return { kind: "action", why: "Agent placed this in a category that may need your action.", date };
    return null;
  }

  function createReceipt(kind, messages, notify) {
    const rows = new Map(messages.map((message) => [String(message.id), {
      id: String(message.id), accountId: message.accountId, mailbox: message.mailbox,
      subject: message.subject || "(no subject)", status: "submitting",
    }]));
    const early = new Map();
    const receipt = { kind, rows, accept, settle, unknown, reversible };
    function matches(row, event) {
      return !!row.actionId && typeof row.generation === "number" &&
        event.actionId === row.actionId && event.generation === row.generation &&
        event.kind === kind;
    }
    function terminal(row, result) {
      row.status = ["completed", "failed", "not_attempted", "unknown"].includes(result.status) ? result.status : "unknown";
      if (kind === "read" && row.status === "completed" && result.projection?.unread === true) row.status = "unknown";
      row.undo = row.status === "completed" && (kind === "remove" ? !!result.opId
        : result.readUndoable === true && Number.isFinite(result.generation));
    }
    function accept(packet) {
      for (const result of packet || []) {
        const id = String(result.id || "");
        const row = rows.get(id);
        if (!row || row.status !== "submitting") continue;
        row.actionId = result.actionId;
        row.generation = result.generation;
        if (result.status === "skipped") row.status = "skipped";
        else if (result.phase === "accepted" || result.status === "pending") {
          row.status = "pending";
          const event = early.get(id)?.find((item) => matches(row, item));
          if (event) terminal(row, event);
        } else terminal(row, result);
      }
      unknown();
    }
    function unknown() {
      for (const row of rows.values()) if (row.status === "submitting") row.status = "unknown";
      early.clear();
      notify(receipt);
    }
    function settle(event) {
      const id = String(event?.id || "");
      const row = rows.get(id);
      if (!row || event.kind !== kind) return false;
      if (row.status === "submitting") {
        const events = early.get(id) || [];
        if (events.length < 8) events.push(event);
        early.set(id, events);
        return false;
      }
      if (row.status !== "pending" || !matches(row, event)) return false;
      terminal(row, event);
      notify(receipt);
      return true;
    }
    function reversible() {
      return [...rows.values()].filter((row) => row.undo);
    }
    return receipt;
  }

  function render(root, state, actions) {
    const doc = root.ownerDocument || document;
    const make = (tag, text, className) => {
      const node = doc.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const bind = (node, fn) => { node.onclick = fn; };
    const toolbar = root.querySelector("[data-agent-batch-toolbar]");
    const cards = root.querySelector("[data-agent-decision-cards]");
    const details = root.querySelector("[data-agent-batch-receipts]");
    if (!toolbar || !cards || !details) return;
    toolbar.hidden = state.selected === 0;
    toolbar.querySelector("[data-selection-scope]").textContent = state.selected + " selected · " + state.mailboxes + (state.mailboxes === 1 ? " mailbox" : " mailboxes");
    const read = toolbar.querySelector("[data-batch-read]");
    const archive = toolbar.querySelector("[data-batch-archive]");
    read.disabled = state.busy;
    // Do not disable the review control: a purposeful click on stale
    // results gives a clear reason rather than a silent inert button.
    archive.disabled = state.busy;
    toolbar.querySelector("[data-selection-scope]").title = state.stale ? "Agent results are out of date. Refresh before archiving." : "";
    cards.querySelector("[data-decision-stale]").hidden = !state.stale;
    bind(read, actions.read);
    bind(archive, actions.archive);
    bind(toolbar.querySelector("[data-batch-clear]"), actions.clear);
    cards.hidden = state.cards.length === 0;
    const catalog = cards.querySelector("[data-decision-list]");
    const stamp = JSON.stringify([state.stale, state.cards.map(({ key, mailbox, subject, read, decision, reason }) => [key, mailbox, subject, read, decision, reason])]);
    if (catalog.morrowDecisionStamp !== stamp) {
      const focus = doc.activeElement;
      if (focus && catalog.contains(focus)) cards.querySelector("h3")?.focus();
      catalog.replaceChildren();
      catalog.morrowDecisionStamp = stamp;
      for (const row of state.cards) {
        const card = make("article", "", "agent-decision-card");
        card.append(make("h4", row.subject || "(no subject)"), make("p", row.mailbox + " · " + (row.read ? "Read" : "Unread"), "hint"),
          make("p", row.reason.why + (row.reason.date ? " Subject deadline: " + row.reason.date + "." : "")));
        const status = row.decision === "own" ? "Recognized this time · no rule saved."
          : row.decision === "not-me" ? "Not me · still unresolved. Check the account directly."
            : row.reason.kind === "security" ? "Unresolved · check the account directly before deciding."
              : "Unresolved · review the source for your next step.";
        card.appendChild(make("p", status, "agent-decision-status"));
        const controls = make("div", "", "row");
        const button = (text, fn) => {
          const node = make("button", text, "ghost");
          node.type = "button";
          bind(node, fn);
          controls.appendChild(node);
        };
        button("Open source", () => actions.open(row));
        if (!state.stale && row.reason.kind === "security" && row.decision !== "own") {
          button("Recognize this time", () => actions.decide(row, "own"));
          if (!row.decision) button("Not me", () => actions.decide(row, "not-me"));
        }
        if (!state.stale && row.decision) button("Clear local decision", () => actions.decide(row, ""));
        card.appendChild(controls);
        catalog.appendChild(card);
      }
    }
    details.hidden = !state.receipt;
    if (!state.receipt) return;
    const outcomeList = details.querySelector("ul");
    const outcomes = [...state.receipt.rows.values()];
    const receiptKey = JSON.stringify([state.receipt.kind, outcomes]);
    if (outcomeList.morrowReceiptStamp === receiptKey) return;
    outcomeList.morrowReceiptStamp = receiptKey;
    const counts = new Map();
    for (const row of outcomes) counts.set(row.status, (counts.get(row.status) || 0) + 1);
    details.querySelector("summary").textContent = (state.receipt.kind === "read" ? "Mark as read" : "Archive") +
      " · " + [...counts].map(([key, value]) => value + " " + labels[key].split(" · ")[0].toLowerCase()).join(" · ");
    outcomeList.replaceChildren(...outcomes.map(row => make("li", row.mailbox + " — " + row.subject + ": " + (labels[row.status] || labels.unknown))));
    details.querySelector("p").textContent = state.receipt.reversible().length
      ? "Use the Mail Undo control when it is available for confirmed changes."
      : "No confirmed reversible changes yet. Unknown outcomes are not retried here.";
  }

  return { reasonFor, createReceipt, render };
});
