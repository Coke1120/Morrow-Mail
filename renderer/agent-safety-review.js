(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.morrowAgentSafetyReview = api;
})(globalThis, function () {
  "use strict";

  // These cues surface messages for human review. They establish neither
  // authenticity nor authority, and a miss is not evidence of safety.
  const reviewCue = /\b(?:new (?:sign[ -]?in|log[ -]?in|device)|security (?:alert|notice)|(?:sign[ -]?in|log[ -]?in) (?:alert|notification)|unusual (?:activity|sign[ -]?in)|verification code|one[- ]time (?:code|password)|password (?:reset|chang(?:e|ed))|payment (?:failed|declined)|(?:build|ci|deploy(?:ment)?) fail(?:ed|ure)|deadline|action required|reply requested)\b|新裝置|登入通知|驗證碼|付款失敗|限期|需要回覆|新しい端末|認証コード|支払い失敗/i;
  const routineCue = /\b(?:newsletter|promotional offer|flash sale|limited[- ]time offer|clearance sale)\b|電子報|優惠推廣|限時優惠|ニュースレター/i;
  const tiers = [
    ["review", "Needs attention"],
    ["ordinary", "Ordinary mail"],
    ["cleanup", "Possible cleanup"],
  ];

  function str(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function tierFor(item, categoryId, categoryName) {
    const subject = str(item.subject);
    if (reviewCue.test(subject) || ["needs-you", "upcoming-today"].includes(categoryId)
        || /^(?:needs you|upcoming today)$/i.test(categoryName)) return "review";
    if (item.hasAttachments === false && routineCue.test(subject)) return "cleanup";
    return "ordinary";
  }

  function snapshotRows(sections) {
    const keys = new Set();
    const rows = [];
    for (const section of Array.isArray(sections) ? sections : []) {
      if (!section || !Array.isArray(section.items)) continue;
      for (const item of section.items) {
        if (!item) continue;
        const accountId = str(item.accountId);
        const messageId = str(item.messageId);
        if (!accountId || !messageId) continue;
        const key = JSON.stringify([accountId, messageId]);
        if (keys.has(key)) continue;
        keys.add(key);
        rows.push({
          accountId,
          messageId,
          threadId: str(item.threadId),
          sender: str(item.from),
          subject: str(item.subject),
          date: str(item.date),
          tier: tierFor(item, str(section.id), str(section.name)),
        });
      }
    }
    return rows;
  }

  function groupedThreads(rows) {
    const byThread = new Map();
    const weight = { review: 3, ordinary: 2, cleanup: 1 };
    for (const row of rows) {
      // Never combine similarly named threads across mailboxes, or a thread ID
      // with an unrelated message whose ID happens to be the same string.
      const key = JSON.stringify([row.accountId, row.threadId ? "thread" : "message", row.threadId || row.messageId]);
      if (!byThread.has(key) || weight[row.tier] > weight[byThread.get(key).tier]) byThread.set(key, row);
    }
    return [...byThread.values()];
  }

  function previewExact(rows, scope) {
    const accountId = str(scope?.accountId);
    const sender = str(scope?.sender);
    const subject = str(scope?.subject);
    if (!accountId || !sender || !subject) return { valid: false, candidates: [], held: [] };
    const matches = rows.filter(row => row.accountId === accountId && row.sender === sender && row.subject === subject);
    const protectedThreads = new Set(rows.filter(row => row.tier !== "cleanup" && row.threadId)
      .map(row => JSON.stringify([row.accountId, row.threadId])));
    const candidates = matches.filter(row => row.tier === "cleanup"
      && (!row.threadId || !protectedThreads.has(JSON.stringify([row.accountId, row.threadId]))));
    const candidateIds = new Set(candidates.map(row => row.messageId));
    return { valid: true, candidates, held: matches.filter(row => !candidateIds.has(row.messageId)) };
  }

  function paint(panel, payload, accounts) {
    if (!panel) return;
    // Commit only snapshot views; no mail service, storage, or AI invocation.
    const accountMap = new Map((Array.isArray(accounts) ? accounts : []).filter(account => account?.id)
      .map(account => [String(account.id), String(account.email || account.name || "Mailbox")]));
    const rows = payload?.accepted === false ? [] : snapshotRows(payload?.sections).filter(row => accountMap.has(row.accountId));
    const mailboxes = [...new Set(rows.map(row => row.accountId))].filter(id => accountMap.has(id));
    const stale = payload?.stale === true;
    const revision = JSON.stringify([rows, stale, mailboxes.map(id => [id, accountMap.get(id)])]);
    if (panel.snapshotRevision === revision) return;
    panel.snapshotRevision = revision;
    const document = panel.ownerDocument;
    const select = panel.querySelector("select");
    const items = panel.querySelector("[data-review-tiers]");
    const form = panel.querySelector("form");
    const result = panel.querySelector("[data-review-result]");
    const entries = groupedThreads(rows);
    items.replaceChildren();
    if (stale && entries.length) {
      const note = document.createElement("p");
      note.textContent = "These todos are out of date. Refresh todos before previewing a scope.";
      items.append(note);
    }
    if (!entries.length) items.textContent = "No recent cached Agent todos available for review.";
    for (const [id, label] of entries.length ? tiers : []) {
      const heading = document.createElement("p");
      const members = entries.filter(row => row.tier === id);
      heading.textContent = label + " · " + members.length;
      items.append(heading);
      if (members.length) {
        const list = document.createElement("ul");
        for (const row of members) {
          const entry = document.createElement("li");
          entry.textContent = (accountMap.get(row.accountId) || "Mailbox") + " · " + (row.sender || "(Unknown sender)") + " · " + (row.subject || "(No subject)");
          list.append(entry);
        }
        items.append(list);
      }
    }
    const previous = select.value;
    select.replaceChildren();
    for (const [id, label] of [["", "Choose a mailbox"], ...mailboxes.map(id => [id, accountMap.get(id)])]) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      select.append(option);
    }
    if (mailboxes.includes(previous)) select.value = previous;
    result.textContent = "";
    form.hidden = stale || mailboxes.length === 0;
    const sender = form.querySelector("[name=sender]");
    const subject = form.querySelector("[name=subject]");
    form.oninput = () => { result.textContent = ""; };
    form.onsubmit = (event) => {
      event.preventDefault();
      if (stale) return;
      const matching = previewExact(rows, { accountId: select.value, sender: sender.value, subject: subject.value });
      result.textContent = !matching.valid
        ? "Choose a mailbox and enter the exact displayed sender and subject."
        : matching.candidates.length + " possible cleanup; " + matching.held.length + " matching held for review. No messages changed.";
      if (!matching.valid || !matching.candidates.length && !matching.held.length) return;
      const list = document.createElement("ul");
      for (const [classification, bucket] of [["Possible cleanup", matching.candidates], ["Held", matching.held]]) {
        for (const row of bucket) {
          const item = document.createElement("li");
          item.textContent = classification + " · " + (row.date || "Date unavailable") + " · " + row.subject;
          list.append(item);
        }
      }
      result.append(list);
    };
  }

  return { snapshotRows, groupedThreads, previewExact, paint };
});
