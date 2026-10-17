const fs = require("fs");
const path = require("path");
const { userDataDir, loadConfig } = require("./ai-config");
const { complete, extractJson } = require("./openai-client");
const { writingBrief, taxonomy } = require("./brain");

const KEY_ERROR = "Add an API key in GenMail → AI Setup.";
const MAIL_ERROR = "Connect a mailbox. Sample mail is not used.";
const PERSON_ERROR = "Select a message or pass a contact email.";
const CAL_NOTE = "No calendar grant. This plan uses mail only.";
const SCHEDULE_NOTE = "Auto-run is off. This skill runs only when you ask.";

const CATALOG = [
  {
    id: "morning-brief",
    name: "Morning Brief",
    description: "What needs you this morning.",
    instruction: "Summarize what the user should deal with this morning. Prioritize unread mail that needs a reply. Do not invent messages.",
  },
  {
    id: "catch-me-up",
    name: "Catch Me Up",
    description: "Summarize recent inbox mail.",
    instruction: "Catch the user up on recent inbox mail they have not handled. Group by sender or topic. Do not invent messages.",
  },
  {
    id: "organize-inbox",
    name: "Organize Inbox",
    description: "Propose label or folder moves for you to confirm.",
    instruction: "Propose a label or folder name for messages that should move, using the category names. Put those in moves. Do not claim anything was moved.",
    moves: true,
  },
  {
    id: "plan-my-week",
    name: "Plan My Week",
    description: "Plan the week from calendar or mail.",
    instruction: "Build a week plan. Use calendar events when they are present. If calendarNote says mail only, do not invent events.",
    calendar: true,
  },
  {
    id: "newsletter-digest",
    name: "Newsletter Digest",
    description: "Summarize newsletters in the inbox.",
    instruction: "Summarize only messages that look like newsletters, promotions, or bulk mail. If none qualify, say so and leave sections empty.",
  },
  {
    id: "brief-this-person",
    name: "Brief This Person",
    description: "A short brief on one sender.",
    instruction: "Write a short brief about the person in the person field, using only the messages provided.",
    person: true,
  },
  {
    id: "meeting-prep",
    name: "Meeting Prep",
    description: "Prep from upcoming events and related mail.",
    instruction: "Prepare the user for upcoming meetings using calendar events and mail that relates to them. If there are no events, say calendar is unavailable and do not invent meetings.",
    calendar: true,
  },
];

const SYSTEM = [
  "You are the local GenMail assistant.",
  "Use only the JSON in the user message.",
  "Never invent messages, people, or events.",
  "Never send mail.",
  "Drafts and moves are proposals the user will review.",
  "Reply with JSON only, no markdown.",
  "Shape: {\"title\":string,\"summary\":string,\"sections\":[{\"title\":string,\"items\":[string]}],\"drafts\":[{\"messageId\":string,\"to\":string,\"subject\":string,\"body\":string}],\"moves\":[{\"messageId\":string,\"labelName\":string,\"reason\":string}],\"followUps\":[{\"messageId\":string,\"kind\":\"draft\"|\"open\"|\"flag-attachment\",\"label\":string,\"body\":string}]}.",
  "followUps.kind draft is a suggested reply, open means open the message, flag-attachment means an attachment is worth opening.",
  "Omit moves unless the skill is Organize Inbox.",
].join(" ");

const TRIAGE_SYSTEM = [
  "You sort inbox mail into the user's categories.",
  "Use only the messages and categories in the user JSON.",
  "Do not invent messages.",
  "Do not send mail.",
  "Reply with JSON only, no markdown.",
  "Shape: {\"items\":[{\"messageId\":string,\"categoryId\":string,\"summary\":string,\"followUps\":[{\"messageId\":string,\"kind\":\"draft\"|\"open\"|\"flag-attachment\",\"label\":string,\"body\":string}]}]}.",
  "Assign each message exactly once. summary is one short sentence from that message.",
].join(" ");

function storePath() {
  return path.join(userDataDir(), "agent.json");
}

const STALE_MS = 5 * 60 * 1000;

function emptyStore() {
  return { installedSkillIds: null, runs: [], triage: null, proposals: [], todos: {} };
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    return {
      installedSkillIds: Array.isArray(parsed.installedSkillIds) ? parsed.installedSkillIds : null,
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      triage: parsed.triage && typeof parsed.triage === "object" ? parsed.triage : null,
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      todos: parsed.todos && typeof parsed.todos === "object" && !Array.isArray(parsed.todos) ? parsed.todos : {},
    };
  } catch {
    return emptyStore();
  }
}

function writeStore(store) {
  const dest = storePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(store, null, 2));
}

function ok(data) {
  return { success: true, data };
}

function fail(error) {
  return { success: false, error: { message: error instanceof Error ? error.message : String(error), code: error.code || "ai-error" } };
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function clip(value, max) {
  return String(value || "").trim().slice(0, max);
}

function skillById(skillId) {
  return CATALOG.find((skill) => skill.id === skillId) || null;
}

function publicSkill(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    runMode: "on_demand",
    schedule: "disabled",
    scheduleNote: SCHEDULE_NOTE,
  };
}

function installedIds(store) {
  if (!Array.isArray(store.installedSkillIds)) return CATALOG.map((skill) => skill.id);
  const known = new Set(CATALOG.map((skill) => skill.id));
  return store.installedSkillIds.map((id) => String(id || "").trim()).filter((id) => known.has(id));
}

function listHomeSkills() {
  const ids = installedIds(readStore());
  return ids.map((id) => skillById(id)).filter(Boolean).map(publicSkill);
}

function listLibrarySkills() {
  const installed = new Set(installedIds(readStore()));
  return CATALOG.filter((skill) => !installed.has(skill.id)).map(publicSkill);
}

function installSkill(params) {
  const skillId = params && typeof params.skillId === "string" ? params.skillId.trim() : "";
  if (!skillById(skillId)) return fail(new Error("That skill is not on this host."));
  const store = readStore();
  const ids = installedIds(store);
  if (!ids.includes(skillId)) ids.push(skillId);
  store.installedSkillIds = ids;
  writeStore(store);
  return ok({ skills: listHomeSkills(), library: listLibrarySkills() });
}

function removeSkill(params) {
  const skillId = params && typeof params.skillId === "string" ? params.skillId.trim() : "";
  if (!skillById(skillId)) return fail(new Error("That skill is not on this host."));
  const store = readStore();
  store.installedSkillIds = installedIds(store).filter((id) => id !== skillId);
  writeStore(store);
  return ok({ skills: listHomeSkills(), library: listLibrarySkills() });
}

function mailboxConnected() {
  try {
    const db = require("./mail/db");
    return db.hasAccounts() === true;
  } catch {
    return false;
  }
}

function cachedMessage(id) {
  if (!id) return null;
  try {
    const db = require("./mail/db");
    if (!db.hasAccounts()) return null;
    const row = db.messageById(id);
    if (!row || !row.id) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      from: row.from_addr || "",
      subject: row.subject || "",
      snippet: String(row.snippet || "").slice(0, 280),
      date: row.date_iso || "",
      unread: row.unread === 1,
      starred: row.starred === 1,
      hasAttachments: row.has_attachments === 1,
      threadId: row.thread_id || "",
      folderPath: row.folder_path || "",
    };
  } catch {
    return null;
  }
}

function inboxMessages(limit) {
  if (!mailboxConnected()) return [];
  try {
    const db = require("./mail/db");
    if (typeof db.recentInbox !== "function") return [];
    const rows = db.recentInbox(limit);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function profileRow(message, folder) {
  return {
    id: message && message.id || "",
    from: message && message.from || "",
    subject: message && message.subject || "",
    snippet: String(message && message.snippet || "").slice(0, 280),
    date: message && message.date || "",
    folder,
    voice: folder === "sent",
  };
}

function profileSample(mode) {
  const rebuild = mode === "rebuild";
  const sentLimit = rebuild ? 16 : 8;
  const inboxLimit = rebuild ? 8 : 4;
  let sent = [];
  let inbox = [];
  try {
    const db = require("./mail/db");
    if (!db.hasAccounts()) return { messages: [], sentCount: 0, inboxCount: 0 };
    if (typeof db.recentInWellKnown === "function") {
      sent = db.recentInWellKnown("sentitems", sentLimit).map((message) => profileRow(message, "sent"));
    }
    if (typeof db.recentInbox === "function") {
      inbox = db.recentInbox(inboxLimit).map((message) => profileRow(message, "inbox"));
    }
    if (!sent.length && !inbox.length && typeof db.recentForAi === "function") {
      const rows = db.recentForAi(inboxLimit);
      inbox = (Array.isArray(rows) ? rows : []).map((message) => profileRow(message, "inbox"));
    }
  } catch {
    return { messages: [], sentCount: 0, inboxCount: 0 };
  }
  const cap = rebuild ? 24 : 12;
  const messages = sent.concat(inbox).slice(0, cap);
  const sentCount = messages.filter((message) => message.folder === "sent").length;
  return { messages, sentCount, inboxCount: messages.length - sentCount };
}

function liveProfileMail(limit) {
  return profileSample("refresh").messages.slice(0, limit || 8);
}

function addressIn(value) {
  const match = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : "";
}

function contactEmail(params) {
  const explicit = params && (params.contactEmail || params.person);
  return addressIn(explicit);
}

function trustedSelection(params) {
  const email = params && params.email;
  const id = email && String(email.id || email.emailId || "").trim();
  return cachedMessage(id);
}

function blankSections(categories) {
  return (categories || []).map((category) => ({
    id: category.id,
    name: category.name,
    description: category.description || "",
    collapseView: category.collapseView === true,
    items: [],
  }));
}

function triageItems(snapshot) {
  if (!snapshot) return [];
  if (Array.isArray(snapshot.items)) return snapshot.items;
  const items = [];
  for (const section of snapshot.sections || []) {
    for (const item of section.items || []) {
      if (item && item.messageId) items.push(Object.assign({ categoryId: section.id }, item));
    }
  }
  return items;
}

function projectSections(categories, items, todos) {
  const sections = blankSections(categories);
  const byId = new Map(sections.map((section) => [section.id, section]));
  const other = sections.find((section) => section.id === "other" || /^other$/i.test(section.name)) || sections[sections.length - 1];
  const hidden = todos && typeof todos === "object" ? todos : {};
  for (const item of items || []) {
    if (!item || !item.messageId) continue;
    const mark = hidden[item.messageId];
    if (mark && (mark.status === "done" || mark.status === "dismissed")) continue;
    const bucket = byId.get(item.categoryId) || other;
    if (bucket) bucket.items.push(item);
  }
  return sections;
}

function triageStale(snapshot) {
  if (!snapshot || snapshot.stale === true || !snapshot.updatedAt) return true;
  const at = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(at)) return true;
  return Date.now() - at > STALE_MS;
}

function sanitizeFollowUps(list, allowed) {
  const kinds = new Set(["draft", "open", "flag-attachment"]);
  return (Array.isArray(list) ? list : []).slice(0, 4).map((item) => {
    const messageId = clip(item && item.messageId, 120);
    if (!allowed.has(messageId)) return null;
    const kind = String(item && item.kind || "");
    if (!kinds.has(kind)) return null;
    return {
      messageId,
      kind,
      label: clip(item && item.label, 80) || (kind === "draft" ? "Review reply" : kind === "open" ? "Open" : "Attachment"),
      body: clip(item && item.body, 2000),
    };
  }).filter(Boolean);
}

function triageItem(message, summary, followUps) {
  return {
    messageId: message.id,
    accountId: message.accountId || "",
    from: message.from || "",
    subject: message.subject || "",
    summary: summary || "",
    date: message.date || "",
    unread: message.unread === true,
    hasAttachments: message.hasAttachments === true,
    followUps: followUps || [],
  };
}

function itemsFromSections(sections) {
  const items = [];
  for (const section of sections || []) {
    for (const item of section.items || []) {
      if (!item || !item.messageId) continue;
      items.push(Object.assign({}, item, { categoryId: item.categoryId || section.id }));
    }
  }
  return items;
}

function triageSnapshot(reason, sections) {
  return {
    reason,
    updatedAt: new Date().toISOString(),
    stale: false,
    items: itemsFromSections(sections),
    sections,
  };
}

function groupTriage(categories, messages, assignments) {
  const sections = blankSections(categories);
  const byId = new Map(sections.map((section) => [section.id, section]));
  const other = sections.find((section) => section.id === "other" || /^other$/i.test(section.name)) || sections[sections.length - 1];
  const messageById = new Map((messages || []).map((message) => [message.id, message]));
  const seen = new Set();
  for (const row of assignments || []) {
    const message = messageById.get(row && row.messageId);
    if (!message || seen.has(message.id)) continue;
    seen.add(message.id);
    const bucket = byId.get(row.categoryId) || other;
    if (!bucket) continue;
    bucket.items.push(triageItem(
      message,
      clip(row.summary, 280) || clip(message.snippet, 280),
      sanitizeFollowUps(row.followUps, new Set([message.id])),
    ));
  }
  for (const message of messages || []) {
    if (!message || seen.has(message.id)) continue;
    const bucket = other || sections[0];
    if (!bucket) continue;
    bucket.items.push(triageItem(message, clip(message.snippet, 280), []));
  }
  return sections;
}

function normalizeSkillResult(skill, parsed, ctx) {
  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const allowed = new Set((ctx.messages || []).map((message) => message.id).filter(Boolean));
  const sections = (Array.isArray(source.sections) ? source.sections : []).slice(0, 6).map((section) => ({
    title: clip(section && section.title, 80) || "Notes",
    items: (Array.isArray(section && section.items) ? section.items : []).slice(0, 8).map((item) => clip(item, 400)).filter(Boolean),
  })).filter((section) => section.title);
  const drafts = (Array.isArray(source.drafts) ? source.drafts : []).slice(0, 3).map((draft) => {
    const messageId = clip(draft && draft.messageId, 120);
    if (messageId && !allowed.has(messageId)) return null;
    const body = clip(draft && draft.body, 2000);
    if (!body) return null;
    return {
      messageId,
      to: clip(draft && draft.to, 200),
      subject: clip(draft && draft.subject, 200),
      body,
    };
  }).filter(Boolean);
  const followUps = sanitizeFollowUps(source.followUps, allowed);
  const moves = skill && skill.moves
    ? (Array.isArray(source.moves) ? source.moves : []).slice(0, 20).map((move) => {
      const messageId = clip(move && move.messageId, 120);
      const labelName = clip(move && move.labelName, 80);
      if (!messageId || !allowed.has(messageId) || !labelName) return null;
      return { messageId, labelName, reason: clip(move && move.reason, 240) };
    }).filter(Boolean)
    : [];
  return {
    title: clip(source.title, 120) || (skill && skill.name) || "Skill",
    summary: clip(source.summary, 600) || "The model returned no summary.",
    sections,
    drafts,
    followUps,
    moves,
  };
}

function plainText(result) {
  const lines = [];
  if (result.title) lines.push(result.title);
  if (result.summary) lines.push(result.summary);
  if (result.note) lines.push(result.note);
  for (const section of result.sections || []) {
    if (section.title) lines.push(section.title);
    for (const item of section.items || []) lines.push(`- ${item}`);
  }
  return lines.join("\n").slice(0, 4000);
}

function remember(entry) {
  const store = readStore();
  store.runs.unshift(entry);
  store.runs = store.runs.slice(0, 40);
  writeStore(store);
  return store;
}

function hasKey() {
  return !!loadConfig().apiKey;
}

function gate() {
  if (!hasKey()) return { reason: "needs_key", error: KEY_ERROR };
  if (!mailboxConnected()) return { reason: "needs_mailbox", error: MAIL_ERROR };
  return null;
}

function homePayload(extra) {
  const categories = taxonomy();
  const store = readStore();
  const blocked = gate();
  const snapshot = !blocked && store.triage ? store.triage : null;
  const sections = snapshot
    ? projectSections(categories, triageItems(snapshot), store.todos)
    : blankSections(categories);
  const base = {
    accepted: !blocked,
    reason: blocked ? blocked.reason : (snapshot ? snapshot.reason || "ready" : "idle"),
    error: blocked ? blocked.error : "",
    updatedAt: snapshot && snapshot.updatedAt || null,
    stale: !blocked && triageStale(snapshot),
    runMode: "on_demand",
    schedule: "disabled",
    scheduleNote: SCHEDULE_NOTE,
    sections,
    proposals: store.proposals.filter((item) => item.status === "pending"),
    runs: store.runs.slice(0, 30),
  };
  return Object.assign(base, extra || {});
}

function accountIdFor(params) {
  const explicit = params && typeof params.accountId === "string" ? params.accountId.trim() : "";
  if (explicit) return explicit;
  try {
    const db = require("./mail/db");
    if (!db.hasAccounts()) return "";
    const rows = db.listAccountRows();
    return rows[0] && rows[0].id ? rows[0].id : "";
  } catch {
    return "";
  }
}

function slimEvents(events) {
  return (Array.isArray(events) ? events : []).slice(0, 20).map((event) => ({
    title: clip(event && event.title, 160),
    start: clip(event && event.start, 40),
    end: clip(event && event.end, 40),
    location: clip(event && event.location, 160),
  })).filter((event) => event.title || event.start);
}

async function calendarContext(accountId) {
  if (!accountId) return { available: false, note: CAL_NOTE, events: [] };
  try {
    const sidecar = require("./mail/sidecar");
    const start = new Date();
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    const listed = await sidecar.answer("calendar:list", [{
      accountId,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
    }]);
    if (!listed || listed.success === false) {
      return { available: false, note: "Calendar could not be read. This plan uses mail only.", events: [] };
    }
    const data = listed.data || {};
    if (data.api !== true) return { available: false, note: CAL_NOTE, events: [] };
    return { available: true, note: "", events: slimEvents(data.events) };
  } catch {
    return { available: false, note: "Calendar could not be read. This plan uses mail only.", events: [] };
  }
}

function contextForSkill(skill, params) {
  const messages = inboxMessages(24);
  const selected = trustedSelection(params);
  let person = contactEmail(params);
  if (!person && selected) person = addressIn(selected.from);
  let scoped = messages;
  if (skill.person) {
    if (!person) return { error: PERSON_ERROR };
    scoped = messages.filter((message) => `${message.from} ${message.subject} ${message.snippet}`.toLowerCase().includes(person));
    if (selected && !scoped.some((message) => message.id === selected.id)) scoped.unshift(selected);
    if (!scoped.length) return { error: "No cached mail for that address." };
  } else if (selected && !scoped.some((message) => message.id === selected.id)) {
    scoped = [selected, ...scoped].slice(0, 24);
  }
  return { messages: scoped, person };
}

async function runSkill(params) {
  const skillId = params && typeof params.skillId === "string" ? params.skillId.trim() : "";
  if (!skillId) return fail(new Error("A skill id is required."));
  const skill = skillById(skillId);
  if (!skill) return fail(new Error("That skill is not on this host."));
  const blocked = gate();
  if (blocked) return ok({ accepted: false, skillId, runMode: "on_demand", error: blocked.error });
  const ctx = contextForSkill(skill, params);
  if (ctx.error) return ok({ accepted: false, skillId, runMode: "on_demand", error: ctx.error });
  if (!ctx.messages.length) {
    return ok({ accepted: false, skillId, runMode: "on_demand", error: "The inbox cache is empty. Refresh mail, then run this skill again." });
  }
  const calendar = skill.calendar ? await calendarContext(accountIdFor(params)) : null;
  const note = calendar && !calendar.available ? calendar.note : "";
  try {
    const text = await complete([
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          skill: skill.name,
          instruction: skill.instruction,
          categories: taxonomy(),
          writingRules: writingBrief(),
          notes: readMemory().notes,
          person: ctx.person || "",
          calendarNote: note,
          events: calendar ? calendar.events : [],
          messages: ctx.messages,
        }),
      },
    ], { temperature: 0.2 });
    const normalized = normalizeSkillResult(skill, extractJson(text), ctx);
    const result = {
      accepted: true,
      skillId,
      name: skill.name,
      runMode: "on_demand",
      schedule: "disabled",
      title: normalized.title,
      summary: normalized.summary,
      note,
      sections: normalized.sections,
      drafts: normalized.drafts,
      followUps: normalized.followUps,
      proposals: [],
    };
    result.text = plainText(result);
    const runId = newId("run");
    if (normalized.moves.length) {
      const store = readStore();
      const byId = new Map(ctx.messages.map((message) => [message.id, message]));
      for (const move of normalized.moves) {
        const message = byId.get(move.messageId);
        store.proposals.unshift({
          id: newId("prop"),
          runId,
          messageId: move.messageId,
          accountId: message && message.accountId || "",
          subject: message && message.subject || "",
          labelName: move.labelName,
          reason: move.reason,
          status: "pending",
          createdAt: new Date().toISOString(),
        });
      }
      store.proposals = store.proposals.slice(0, 40);
      writeStore(store);
      result.proposals = store.proposals.filter((item) => item.runId === runId);
    }
    remember({
      id: runId,
      kind: "skill",
      skillId,
      name: skill.name,
      summary: result.summary,
      note,
      at: new Date().toISOString(),
      accepted: true,
      sections: result.sections,
      drafts: result.drafts,
      followUps: result.followUps,
    });
    return ok(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    remember({
      id: newId("run"),
      kind: "skill",
      skillId,
      name: skill.name,
      summary: message,
      at: new Date().toISOString(),
      accepted: false,
    });
    return ok({ accepted: false, skillId, runMode: "on_demand", error: message });
  }
}

async function triage() {
  const blocked = gate();
  if (blocked) return ok(homePayload());
  const messages = inboxMessages(24);
  const categories = taxonomy();
  if (!messages.length) {
    const snapshot = triageSnapshot("empty", blankSections(categories));
    const store = readStore();
    store.triage = snapshot;
    writeStore(store);
    remember({
      id: newId("run"),
      kind: "triage",
      name: "Inbox triage",
      summary: "The inbox cache is empty.",
      at: snapshot.updatedAt,
      accepted: true,
    });
    return ok(homePayload());
  }
  try {
    const text = await complete([
      { role: "system", content: TRIAGE_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          instruction: "Assign each message to one categoryId.",
          categories,
          writingRules: writingBrief(),
          notes: readMemory().notes,
          messages,
        }),
      },
    ], { temperature: 0.2 });
    const parsed = extractJson(text);
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : [];
    const sections = groupTriage(categories, messages, items);
    const snapshot = triageSnapshot("ready", sections);
    const store = readStore();
    store.triage = snapshot;
    writeStore(store);
    const count = sections.reduce((sum, section) => sum + section.items.length, 0);
    remember({
      id: newId("run"),
      kind: "triage",
      name: "Inbox triage",
      summary: `Sorted ${count} inbox messages.`,
      at: snapshot.updatedAt,
      accepted: true,
      sections,
    });
    return ok(homePayload());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    remember({
      id: newId("run"),
      kind: "triage",
      name: "Inbox triage",
      summary: message,
      at: new Date().toISOString(),
      accepted: false,
    });
    return ok(homePayload({ accepted: false, reason: "error", error: message }));
  }
}

function getTriage() {
  return ok(homePayload());
}

function refreshTaxonomy() {
  const store = readStore();
  if (store.triage) {
    store.triage = Object.assign({}, store.triage, { stale: true });
    writeStore(store);
  }
  return ok(homePayload());
}

function setTodo(params) {
  const messageId = clip(params && params.messageId, 120);
  const status = String(params && params.status || "");
  if (!messageId || (status !== "open" && status !== "done" && status !== "dismissed")) {
    return fail(new Error("That todo needs a message and a status."));
  }
  const store = readStore();
  if (status === "open") delete store.todos[messageId];
  else store.todos[messageId] = { status, at: new Date().toISOString() };
  writeStore(store);
  return ok(homePayload());
}

function history() {
  return ok({ runs: readStore().runs.slice(0, 30) });
}

async function confirmProposal(params) {
  const proposalId = params && typeof params.proposalId === "string" ? params.proposalId.trim() : "";
  const store = readStore();
  const proposal = store.proposals.find((item) => item.id === proposalId);
  if (!proposal || proposal.status !== "pending") return fail(new Error("That proposal is not waiting for confirmation."));
  const message = cachedMessage(proposal.messageId);
  if (!message) {
    return ok({
      accepted: false,
      proposalId,
      error: "That message is not in the local mailbox. Nothing was moved.",
      proposals: store.proposals.filter((item) => item.status === "pending"),
    });
  }
  const labelName = clip(proposal.labelName, 80);
  try {
    const applied = await applyMove(message, labelName);
    if (!applied.ok) {
      return ok({
        accepted: false,
        proposalId,
        error: applied.error,
        proposals: store.proposals.filter((item) => item.status === "pending"),
      });
    }
    proposal.status = "confirmed";
    proposal.confirmedAt = new Date().toISOString();
    writeStore(store);
    return ok({
      accepted: true,
      proposalId,
      detail: applied.detail,
      proposals: store.proposals.filter((item) => item.status === "pending"),
    });
  } catch (error) {
    return ok({
      accepted: false,
      proposalId,
      error: error instanceof Error ? error.message : String(error),
      proposals: store.proposals.filter((item) => item.status === "pending"),
    });
  }
}

async function applyMove(message, labelName) {
  if (!labelName) return { ok: false, error: "That proposal has no folder name. Nothing was moved." };
  const sidecar = require("./mail/sidecar");
  const listed = await sidecar.answer("mail:listProviderFolders", [{ accountId: message.accountId }]);
  const data = listed && listed.success ? listed.data : null;
  if (data && data.api === true && Array.isArray(data.folders)) {
    const match = data.folders.find((folder) => String(folder.name || "").toLowerCase() === labelName.toLowerCase());
    if (match && data.provider === "google") {
      const result = await sidecar.answer("mail:modifyMessageLabels", [{
        emailId: message.id,
        accountId: message.accountId,
        addLabelIds: [match.id],
        removeLabelIds: [],
      }]);
      if (!result || result.success === false) {
        const err = result && result.error;
        return { ok: false, error: (err && err.message) || "Gmail did not apply that label. Nothing else was changed." };
      }
      return { ok: true, detail: `Labeled “${labelName}”.` };
    }
    if (match && data.provider === "microsoft") {
      const result = await sidecar.answer("mail:moveProviderMessage", [{
        emailId: message.id,
        accountId: message.accountId,
        destinationId: match.id,
      }]);
      if (!result || result.success === false) {
        const err = result && result.error;
        return { ok: false, error: (err && err.message) || "Outlook did not move that message." };
      }
      return { ok: true, detail: `Moved to “${labelName}”.` };
    }
  }
  const db = require("./mail/db");
  const folders = db.foldersFor(message.accountId) || [];
  const imap = folders.find((folder) => {
    const name = String(folder.name || "").toLowerCase();
    const folderPath = String(folder.path || "").toLowerCase();
    const wanted = labelName.toLowerCase();
    return name === wanted || folderPath === wanted;
  });
  if (!imap) {
    return {
      ok: false,
      error: `No folder named “${labelName}” is available. Grant organize access or create that folder, then confirm again. Nothing was moved.`,
    };
  }
  const engine = require("./mail/engine");
  const moved = await engine.answer("mail:moveToFolder", [{
    emailId: message.id,
    accountId: message.accountId,
    targetFolderId: imap.path,
    folderId: message.folderPath,
  }]);
  if (!moved || moved.success === false) {
    const err = moved && moved.error;
    return { ok: false, error: (err && err.message) || "The mailbox did not move that message." };
  }
  return { ok: true, detail: `Moved to “${labelName}”.` };
}

const CHAT_SYSTEM = [
  "You are the local GenMail assistant.",
  "Use only the JSON in the user message.",
  "Never invent messages, people, or events.",
  "Never send mail. Never claim a message was sent.",
  "Drafts are proposals the user reviews in compose.",
  "If messages is empty, say there is no cached inbox mail.",
  "Reply in plain text.",
].join(" ");

const CHAT_KEEP = 40;

function chatPath() {
  return path.join(userDataDir(), "agent-chat.json");
}

function memoryPath() {
  return path.join(userDataDir(), "agent-memory.json");
}

function readJsonFile(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readTurns() {
  const parsed = readJsonFile(chatPath(), { turns: [] });
  const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
  return turns.filter((turn) => turn && (turn.role === "user" || turn.role === "agent"));
}

function writeTurns(turns) {
  const dest = chatPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify({ version: 1, turns: turns.slice(-CHAT_KEEP) }, null, 2));
}

function readMemory() {
  const parsed = readJsonFile(memoryPath(), { notes: "" });
  return { notes: clip(parsed.notes, 2000) };
}

function writeMemory(params) {
  const notes = clip(params && params.notes, 2000);
  const dest = memoryPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify({ notes }, null, 2));
  return ok({ notes });
}

function appendChat(turn) {
  const turns = readTurns();
  const next = {
    id: newId("turn"),
    at: new Date().toISOString(),
    role: turn && turn.role === "user" ? "user" : "agent",
    kind: clip(turn && turn.kind, 20) || "chat",
    text: clip(turn && turn.text, 4000),
    error: !!(turn && turn.error),
    name: clip(turn && turn.name, 120),
    skillId: clip(turn && turn.skillId, 80),
    note: clip(turn && turn.note, 400),
    sections: Array.isArray(turn && turn.sections) ? turn.sections : [],
    drafts: Array.isArray(turn && turn.drafts) ? turn.drafts : [],
    followUps: Array.isArray(turn && turn.followUps) ? turn.followUps : [],
    proposals: Array.isArray(turn && turn.proposals) ? turn.proposals : [],
    triage: turn && turn.triage && typeof turn.triage === "object" ? turn.triage : null,
  };
  turns.push(next);
  writeTurns(turns);
  return next;
}

function publicTurns() {
  return readTurns().slice(-CHAT_KEEP);
}

function routeChat(text, skills) {
  const raw = clip(text, 2000);
  const folded = raw.toLowerCase();
  if (!folded) return { kind: "empty" };
  if (/^(triage|triage inbox|sort inbox|sort my inbox|sort the inbox)$/.test(folded)) {
    return { kind: "triage" };
  }
  const rows = Array.isArray(skills) ? skills : [];
  const contact = addressIn(raw);
  let best = null;
  for (const row of rows) {
    const name = String(row && row.name || "").trim().toLowerCase();
    const id = String(row && row.id || "").trim().toLowerCase();
    const named = name && (folded === name || folded === `run ${name}` || (name.length > 3 && folded.includes(name)));
    const ident = id && (folded === id || folded === `run ${id}`);
    if (named || ident) {
      if (!best || name.length > String(best.name || "").length) best = row;
    }
  }
  if (best) return { kind: "skill", skillId: best.id, name: best.name || best.id, contact };
  if (/^(draft|draft a reply|write a reply|reply to this|draft reply)$/.test(folded) || /^(draft a reply|write a reply|draft reply)\b/.test(folded)) {
    return { kind: "draft" };
  }
  return { kind: "chat" };
}

function turnFromSkill(data) {
  const accepted = !!(data && data.accepted !== false && !data.error);
  const text = accepted
    ? (data.summary || data.text || data.title || "Done.")
    : ((data && data.error) || "That skill did not run.");
  return {
    role: "agent",
    kind: "skill",
    text,
    error: !accepted,
    name: data && data.name || "",
    skillId: data && data.skillId || "",
    note: accepted ? (data && data.note) || "" : "",
    sections: accepted && Array.isArray(data && data.sections) ? data.sections : [],
    drafts: accepted && Array.isArray(data && data.drafts) ? data.drafts : [],
    followUps: accepted && Array.isArray(data && data.followUps) ? data.followUps : [],
    proposals: accepted && Array.isArray(data && data.proposals) ? data.proposals : [],
  };
}

function triageCopy(data) {
  if (!data) return { text: "Triage did not finish.", error: true };
  if (data.reason === "needs_key") return { text: data.error || KEY_ERROR, error: true };
  if (data.reason === "needs_mailbox") return { text: data.error || MAIL_ERROR, error: true };
  if (data.reason === "empty") return { text: data.error || "The inbox cache is empty. Refresh mail, then triage again.", error: false };
  if (data.accepted === false && data.error) return { text: data.error, error: true };
  if (data.updatedAt) return { text: "Updated " + data.updatedAt, error: false };
  return { text: "Triage finished.", error: false };
}

function turnFromTriage(data) {
  const copy = triageCopy(data);
  return {
    role: "agent",
    kind: "triage",
    text: copy.text,
    error: copy.error,
    name: "Inbox triage",
    triage: copy.error ? null : {
      reason: data && data.reason || "",
      sections: data && Array.isArray(data.sections) ? data.sections : [],
    },
    proposals: data && Array.isArray(data.proposals) ? data.proposals : [],
  };
}

function turnFromRun(run) {
  const triage = run && run.kind === "triage";
  return {
    role: "agent",
    kind: triage ? "triage" : "skill",
    text: (run && (run.summary || run.name)) || "Run",
    error: !!(run && run.accepted === false),
    name: run && run.name || "",
    skillId: run && run.skillId || "",
    note: run && run.note || "",
    sections: !triage && Array.isArray(run && run.sections) ? run.sections : [],
    drafts: Array.isArray(run && run.drafts) ? run.drafts : [],
    followUps: Array.isArray(run && run.followUps) ? run.followUps : [],
    triage: triage ? { reason: "ready", sections: Array.isArray(run.sections) ? run.sections : [] } : null,
  };
}

const DRAFT_SYSTEM = [
  "Draft one reply the user will review in compose.",
  "Never send mail. Never claim a message was sent.",
  "Use only the JSON in the user message. Do not invent people.",
  "Reply with JSON only, no markdown.",
  "Shape: {\"to\":string,\"subject\":string,\"body\":string,\"summary\":string}.",
].join(" ");

async function draftReply(params) {
  const blocked = gate();
  if (blocked) return ok({ accepted: false, error: blocked.error, drafts: [] });
  const selected = trustedSelection(params);
  try {
    const text = await complete([
      { role: "system", content: DRAFT_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          draftReply: true,
          instruction: "Draft a reply for review in compose. Do not send.",
          email: selected ? {
            id: selected.id,
            from: selected.from,
            subject: selected.subject,
            snippet: selected.snippet,
          } : null,
          messages: inboxMessages(4).map((message) => ({
            id: message.id,
            from: clip(message.from, 120),
            subject: clip(message.subject, 160),
            snippet: clip(message.snippet, 180),
          })),
          writingRules: writingBrief(),
        }),
      },
    ], { temperature: 0.2 });
    const parsed = extractJson(text) || {};
    const body = clip(parsed.body, 2000);
    if (!body) return ok({ accepted: false, error: "The model did not return a draft.", drafts: [] });
    return ok({
      accepted: true,
      summary: clip(parsed.summary, 400) || "Draft ready for review in compose.",
      drafts: [{
        messageId: selected && selected.id || "",
        to: clip(parsed.to, 200) || (selected && addressIn(selected.from)) || "",
        subject: clip(parsed.subject, 200) || (selected && selected.subject ? `Re: ${selected.subject}` : ""),
        body,
      }],
    });
  } catch (error) {
    return ok({
      accepted: false,
      error: error instanceof Error ? error.message : String(error),
      drafts: [],
    });
  }
}

async function answerQuestion(text) {
  if (!hasKey()) return { text: KEY_ERROR, error: true };
  const prior = readTurns().slice(-9, -1).map((turn) => ({
    role: turn.role,
    text: clip(turn.text, 500),
  }));
  const mail = inboxMessages(8).map((message) => ({
    from: clip(message.from, 120),
    subject: clip(message.subject, 160),
    snippet: clip(message.snippet, 180),
    date: clip(message.date, 40),
  }));
  let events = [];
  let calendarNote = mailboxConnected() ? "" : MAIL_ERROR;
  if (mailboxConnected()) {
    const calendar = await calendarContext(accountIdFor({}));
    events = calendar.events || [];
    calendarNote = calendar.note || "";
  }
  try {
    const reply = await complete([
      { role: "system", content: CHAT_SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          memory: readMemory().notes,
          history: prior,
          question: text,
          messages: mail,
          events,
          calendarNote,
        }),
      },
    ], { temperature: 0.2 });
    return { text: clip(reply, 4000) || "I don't have an answer from the cached mail.", error: false };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), error: true };
  }
}

async function chat(params) {
  const text = clip(params && params.text, 2000);
  if (!text) return fail(new Error("Write a message first."));
  const intent = routeChat(text, listHomeSkills());
  appendChat({ role: "user", kind: intent.kind, text });
  if (intent.kind === "skill") {
    const result = await runSkill({
      skillId: intent.skillId,
      contactEmail: intent.contact || (params && params.contactEmail) || "",
      accountId: params && params.accountId,
      email: params && params.email,
    });
    const data = result && result.success ? result.data : {
      accepted: false,
      skillId: intent.skillId,
      error: (result && result.error && result.error.message) || "That skill did not run.",
    };
    const turn = appendChat(turnFromSkill(data));
    return ok({ intent: "skill", turn, turns: publicTurns(), result: data });
  }
  if (intent.kind === "triage") {
    const result = await triage();
    const data = result && result.success ? result.data : { accepted: false, reason: "error", error: "Triage did not finish." };
    const turn = appendChat(turnFromTriage(data));
    return ok({ intent: "triage", turn, turns: publicTurns(), triage: data });
  }
  if (intent.kind === "draft") {
    const result = await draftReply(params);
    const data = result && result.success ? result.data : { accepted: false, error: "That draft did not finish.", drafts: [] };
    const accepted = data.accepted !== false && !data.error;
    const turn = appendChat({
      role: "agent",
      kind: "draft",
      text: accepted ? (data.summary || "Draft ready for review in compose.") : (data.error || "That draft did not finish."),
      error: !accepted,
      drafts: accepted && Array.isArray(data.drafts) ? data.drafts : [],
    });
    return ok({ intent: "draft", turn, turns: publicTurns(), result: data });
  }
  const answer = await answerQuestion(text);
  const turn = appendChat({ role: "agent", kind: "chat", text: answer.text, error: answer.error });
  return ok({ intent: "chat", turn, turns: publicTurns() });
}

function chatHistory() {
  return ok({ turns: publicTurns(), memory: readMemory() });
}

function chatShow(params) {
  const runId = clip(params && params.runId, 80);
  const run = readStore().runs.find((item) => item && item.id === runId);
  if (!run) return fail(new Error("That run is not in history."));
  const turn = appendChat(turnFromRun(run));
  return ok({ intent: "history", turn, turns: publicTurns() });
}

function dismissProposal(params) {
  const proposalId = params && typeof params.proposalId === "string" ? params.proposalId.trim() : "";
  const store = readStore();
  const proposal = store.proposals.find((item) => item.id === proposalId && item.status === "pending");
  if (!proposal) return fail(new Error("That proposal is not waiting for confirmation."));
  proposal.status = "dismissed";
  writeStore(store);
  return ok({
    accepted: true,
    proposalId,
    proposals: store.proposals.filter((item) => item.status === "pending"),
  });
}

function answer(channel, args) {
  const params = args && args.length ? args[0] : undefined;
  switch (channel) {
    case "nativeAgent:home:skills":
      return ok(listHomeSkills());
    case "nativeAgent:home:librarySkills":
      return ok(listLibrarySkills());
    case "nativeAgent:home":
    case "nativeAgent:home:todosCached":
    case "nativeAgent:getTriage":
      return getTriage();
    case "nativeAgent:home:refreshTaxonomy":
      return refreshTaxonomy();
    case "nativeAgent:home:todoUpdate":
      return setTodo(params);
    case "nativeAgent:triage":
      return triage();
    case "nativeAgent:history":
      return history();
    case "nativeAgent:chat":
      return chat(params);
    case "nativeAgent:chatHistory":
      return chatHistory();
    case "nativeAgent:chatShow":
      return chatShow(params);
    case "nativeAgent:memoryGet":
      return ok(readMemory());
    case "nativeAgent:memorySet":
      return writeMemory(params);
    default:
      return undefined;
  }
}

module.exports = {
  answer,
  listHomeSkills,
  listLibrarySkills,
  installSkill,
  removeSkill,
  runSkill,
  confirmProposal,
  dismissProposal,
  triage,
  getTriage,
  routeChat,
  mailboxConnected,
  profileSample,
  liveProfileMail,
  groupTriage,
  refreshTaxonomy,
  setTodo,
  normalizeSkillResult,
  CATALOG,
};
