const { gate: updateGate } = require("./update-quiescence");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { userDataDir, loadConfig } = require("./ai-config");
const { complete, extractJson } = require("./openai-client");
const { writingBrief, identityBrief, taxonomy } = require("./brain");
const { triageSystemPrompt } = require("./brain-persona");

const KEY_ERROR = "Add an API key in Morrow Mail → AI Setup.";
const MAIL_ERROR = "Connect a mailbox. Sample mail is not used.";
const PERSON_ERROR = "Select a message or pass a contact email.";
const CAL_NOTE = "No calendar grant. This plan uses mail only.";
const SCHEDULE_NOTE = "Auto-run is off. This skill runs only when you ask.";
const MAX_CUSTOM_SKILLS = 40;
const MAX_SKILL_NAME = 80;
const MAX_SKILL_DESCRIPTION = 240;
const MAX_SKILL_INSTRUCTION = 4000;
const USER_SKILL_ID = /^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  "You are the local Morrow Mail assistant.",
  "Use only the JSON in the user message.",
  "Never invent messages, people, or events.",
  "Never send mail.",
  "Drafts and moves are proposals the user will review.",
  "Reply with JSON only, no markdown.",
  "Shape: {\"title\":string,\"summary\":string,\"sections\":[{\"title\":string,\"items\":[string]}],\"drafts\":[{\"messageId\":string,\"to\":string,\"subject\":string,\"body\":string}],\"moves\":[{\"messageId\":string,\"labelName\":string,\"reason\":string}],\"followUps\":[{\"messageId\":string,\"kind\":\"draft\"|\"open\"|\"flag-attachment\",\"label\":string,\"body\":string}]}.",
  "followUps.kind draft is a suggested reply, open means open the message, flag-attachment means an attachment is worth opening.",
].join(" ");

function systemFor(skill) {
  const moves = skill && skill.moves === true
    ? "movesAllowed is true. You may propose moves. Do not claim anything was moved."
    : "movesAllowed is false. Omit moves.";
  return `${SYSTEM} ${moves}`;
}

function storePath() {
  return path.join(userDataDir(), "agent.json");
}

function customSkillsPath() {
  return path.join(userDataDir(), "custom-skills.json");
}

const STALE_MS = 5 * 60 * 1000;

function emptyStore() {
  return { installedSkillIds: null, runs: [], triage: null, proposals: [], todos: {}, schedules: [] };
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
      schedules: normalizeSchedules(parsed.schedules),
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

function isUserSkillId(skillId) {
  return USER_SKILL_ID.test(String(skillId || "").trim());
}

function stripControls(value, keepNewlines) {
  const text = String(value || "");
  if (keepNewlines) return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return text.replace(/[\u0000-\u001F\u007F]/g, "");
}

function cleanName(value) {
  return stripControls(value, false).replace(/\s+/g, " ").trim();
}

function cleanDescription(value) {
  return stripControls(value, false).replace(/\s+/g, " ").trim();
}

function cleanInstruction(value) {
  return stripControls(value, true).replace(/\r\n/g, "\n").trim();
}

function readCustomDocument() {
  const file = customSkillsPath();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: true, missing: true, meta: {}, skills: [] };
    return { ok: false, error: "Custom skills could not be read. The file was left in place." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: true, missing: false, meta: {}, skills: [] };
  }
  const meta = Object.assign({}, parsed);
  delete meta.skills;
  return {
    ok: true,
    missing: false,
    meta,
    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
  };
}

function writeCustomDocument(meta, skills) {
  const dest = customSkillsPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const body = JSON.stringify(Object.assign({}, meta || {}, { skills: skills || [] }), null, 2);
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try {
    fs.renameSync(tmp, dest);
  } catch (error) {
    try {
      fs.copyFileSync(tmp, dest);
      fs.rmSync(tmp, { force: true });
    } catch (copyError) {
      throw error;
    }
  }
  try { fs.chmodSync(dest, 0o600); } catch { /* mode is best-effort on Windows */ }
}

function customEntryId(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  return String(raw.id || "").trim();
}

function activeCustom(raw) {
  if (!isUserSkillId(customEntryId(raw))) return false;
  const name = cleanName(raw.name);
  const description = cleanDescription(raw.description);
  const instruction = cleanInstruction(raw.instruction);
  if (!instruction || instruction.length > MAX_SKILL_INSTRUCTION * 4) return false;
  if (name.length > MAX_SKILL_NAME * 4) return false;
  if (description.length > MAX_SKILL_DESCRIPTION * 4) return false;
  return true;
}

function materializeCustom(raw) {
  const name = cleanName(raw.name);
  return {
    id: customEntryId(raw),
    name: name || "Custom skill",
    description: cleanDescription(raw.description),
    instruction: cleanInstruction(raw.instruction),
    moves: raw.moves === true,
    calendar: raw.calendar === true,
    person: raw.person === true,
    source: "user",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

function listCustomSkills() {
  const doc = readCustomDocument();
  if (!doc.ok) return [];
  const seen = new Set();
  const skills = [];
  for (const raw of doc.skills) {
    if (!activeCustom(raw)) continue;
    const skill = materializeCustom(raw);
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    skills.push(skill);
  }
  return skills;
}

function skillById(skillId) {
  const id = String(skillId || "").trim();
  if (!id) return null;
  if (isUserSkillId(id)) return listCustomSkills().find((skill) => skill.id === id) || null;
  return CATALOG.find((skill) => skill.id === id) || null;
}

function validateCustomInput(params) {
  const name = cleanName(params && params.name);
  const description = cleanDescription(params && params.description);
  const instruction = cleanInstruction(params && params.instruction);
  if (!name) return { error: "A skill needs a name." };
  if (name.length > MAX_SKILL_NAME) return { error: "Use a name of 80 characters or fewer." };
  if (description.length > MAX_SKILL_DESCRIPTION) return { error: "Use a description of 240 characters or fewer." };
  if (!instruction) return { error: "A skill needs an instruction." };
  if (instruction.length > MAX_SKILL_INSTRUCTION) return { error: "Use an instruction of 4000 characters or fewer." };
  return {
    name,
    description,
    instruction,
    moves: !!(params && params.moves === true),
    calendar: !!(params && params.calendar === true),
    person: !!(params && params.person === true),
  };
}

function countCustomEntries(skills) {
  return (Array.isArray(skills) ? skills : []).filter((raw) => raw && typeof raw === "object" && !Array.isArray(raw)).length;
}

function saveCustomSkill(params) {
  try {
    const doc = readCustomDocument();
    if (!doc.ok) return fail(new Error(doc.error));
    const draft = validateCustomInput(params);
    if (draft.error) return fail(new Error(draft.error));
    const requested = params && typeof params.skillId === "string" ? params.skillId.trim() : "";
    const now = new Date().toISOString();
    const skills = doc.skills.slice();
    if (!requested) {
      if (countCustomEntries(skills) >= MAX_CUSTOM_SKILLS) {
        return fail(new Error("You can save up to 40 custom skills."));
      }
      let id = "";
      const taken = new Set(skills.map(customEntryId));
      do { id = `user:${crypto.randomUUID()}`; } while (taken.has(id));
      skills.push({
        id,
        name: draft.name,
        description: draft.description,
        instruction: draft.instruction,
        moves: draft.moves,
        calendar: draft.calendar,
        person: draft.person,
        createdAt: now,
        updatedAt: now,
      });
      writeCustomDocument(doc.meta, skills);
      const store = readStore();
      const ids = installedIds(store);
      if (!ids.includes(id)) ids.push(id);
      store.installedSkillIds = ids;
      writeStore(store);
      const skill = skillById(id);
      if (!skill) return fail(new Error("That custom skill could not be saved."));
      return ok({ skill: publicSkill(skill, null), skills: listHomeSkills(), library: listLibrarySkills() });
    }
    if (!isUserSkillId(requested)) return fail(new Error("Built-in skills stay in the catalog."));
    let replaced = false;
    const next = skills.map((raw) => {
      if (replaced || customEntryId(raw) !== requested) return raw;
      replaced = true;
      const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      return Object.assign({}, base, {
        id: requested,
        name: draft.name,
        description: draft.description,
        instruction: draft.instruction,
        moves: draft.moves,
        calendar: draft.calendar,
        person: draft.person,
        createdAt: typeof base.createdAt === "string" && base.createdAt ? base.createdAt : now,
        updatedAt: now,
      });
    });
    if (!replaced) return fail(new Error("That custom skill is not on this computer."));
    writeCustomDocument(doc.meta, next);
    const skill = skillById(requested);
    if (!skill) return fail(new Error("That custom skill could not be saved."));
    return ok({
      skill: publicSkill(skill, scheduleFor(requested)),
      skills: listHomeSkills(),
      library: listLibrarySkills(),
    });
  } catch (error) {
    return fail(error);
  }
}

function deleteCustomSkill(params) {
  try {
    const skillId = params && typeof params.skillId === "string" ? params.skillId.trim() : "";
    if (!isUserSkillId(skillId)) return fail(new Error("Built-in skills stay in the catalog."));
    const doc = readCustomDocument();
    if (!doc.ok) return fail(new Error(doc.error));
    let found = false;
    const next = [];
    for (const raw of doc.skills) {
      if (customEntryId(raw) === skillId) {
        found = true;
        continue;
      }
      next.push(raw);
    }
    if (!found) return fail(new Error("That custom skill is not on this computer."));
    writeCustomDocument(doc.meta, next);
    const store = readStore();
    store.installedSkillIds = installedIds(store).filter((id) => id !== skillId);
    store.schedules = (store.schedules || []).filter((row) => row.skillId !== skillId);
    writeStore(store);
    return ok({ deleted: true, skillId, skills: listHomeSkills(), library: listLibrarySkills() });
  } catch (error) {
    return fail(error);
  }
}

function scheduleFor(skillId) {
  const store = readStore();
  return (store.schedules || []).find((row) => row.skillId === skillId) || null;
}

function scheduleNoteFor(schedule) {
  if (!schedule) return SCHEDULE_NOTE;
  if (schedule.paused) return "Paused. This skill runs only when you ask.";
  if (schedule.kind === "interval") {
    return `Every ${schedule.everyMinutes} minutes while Morrow Mail is open. Nothing is sent.`;
  }
  return `Cron ${schedule.cron} while Morrow Mail is open. Nothing is sent.`;
}

function publicSkill(skill, schedule) {
  const active = !!(schedule && schedule.paused !== true);
  let scheduleMode = "disabled";
  if (schedule) scheduleMode = schedule.paused ? "paused" : schedule.kind;
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source === "user" ? "user" : "catalog",
    custom: skill.source === "user",
    instruction: skill.source === "user" ? skill.instruction : "",
    moves: skill.moves === true,
    calendar: skill.calendar === true,
    person: skill.person === true,
    runMode: active && schedule ? "scheduled" : "on_demand",
    schedule: scheduleMode,
    kind: schedule ? schedule.kind : "",
    everyMinutes: schedule && schedule.kind === "interval" ? schedule.everyMinutes : null,
    cron: schedule && schedule.kind === "cron" ? schedule.cron : "",
    paused: !!(schedule && schedule.paused),
    nextRunAt: schedule ? schedule.nextRunAt || null : null,
    lastRunAt: schedule ? schedule.lastRunAt || null : null,
    lastError: schedule ? schedule.lastError || "" : "",
    contactEmail: schedule ? schedule.contactEmail || "" : "",
    scheduleNote: scheduleNoteFor(schedule),
  };
}

function installedIds(store) {
  const customIds = listCustomSkills().map((skill) => skill.id);
  const catalogIds = CATALOG.map((skill) => skill.id);
  const known = new Set(catalogIds.concat(customIds));
  const stored = Array.isArray(store.installedSkillIds)
    ? store.installedSkillIds.map((id) => String(id || "").trim()).filter(Boolean)
    : null;
  const out = [];
  const seen = new Set();
  const push = (id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  if (!stored) {
    for (const id of catalogIds.concat(customIds)) push(id);
    return out;
  }
  // Keep user: ids that this build does not recognize so a catalog change cannot drop them.
  for (const id of stored) {
    if (known.has(id) || isUserSkillId(id)) push(id);
  }
  for (const id of customIds) push(id);
  return out;
}

function listHomeSkills() {
  const store = readStore();
  const saved = new Map((store.schedules || []).map((row) => [row.skillId, row]));
  return installedIds(store).map((id) => skillById(id)).filter(Boolean).map((skill) => publicSkill(skill, saved.get(skill.id) || null));
}

function listLibrarySkills() {
  const installed = new Set(installedIds(readStore()));
  return CATALOG.filter((skill) => !isUserSkillId(skill.id) && !installed.has(skill.id)).map((skill) => publicSkill(skill, null));
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
  if (isUserSkillId(skillId)) return deleteCustomSkill(params);
  if (!skillById(skillId)) return fail(new Error("That skill is not on this host."));
  const store = readStore();
  store.installedSkillIds = installedIds(store).filter((id) => id !== skillId);
  store.schedules = (store.schedules || []).filter((row) => row.skillId !== skillId);
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
      accountId: ((ctx.messages || []).find((message) => message.id === messageId) || {}).accountId || "",
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
  const scheduledRun = params.source === "schedule";
  const runMode = scheduledRun ? "scheduled" : "on_demand";
  const scheduleState = scheduledRun ? "fired" : "disabled";
  const blocked = gate();
  if (blocked) return ok({ accepted: false, skillId, runMode, schedule: scheduleState, error: blocked.error });
  const ctx = contextForSkill(skill, params);
  if (ctx.error) return ok({ accepted: false, skillId, runMode, schedule: scheduleState, error: ctx.error });
  if (!ctx.messages.length) {
    return ok({ accepted: false, skillId, runMode, schedule: scheduleState, error: "The inbox cache is empty. Refresh mail, then run this skill again." });
  }
  const calendar = skill.calendar ? await calendarContext(accountIdFor(params)) : null;
  const note = calendar && !calendar.available ? calendar.note : "";
  try {
    const text = await complete([
      { role: "system", content: systemFor(skill) },
      {
        role: "user",
        content: JSON.stringify({
          skill: skill.name,
          instruction: clip(skill.instruction, MAX_SKILL_INSTRUCTION),
          movesAllowed: skill.moves === true,
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
      runMode,
      schedule: scheduleState,
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
    return ok({ accepted: false, skillId, runMode, schedule: scheduleState, error: message });
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
    const brief = identityBrief();
    const user = {
      instruction: "Assign each message to one categoryId.",
      categories,
      writingRules: writingBrief(),
      notes: readMemory().notes,
      messages,
    };
    if (brief) user.identity = brief;
    const text = await complete([
      { role: "system", content: triageSystemPrompt(brief) },
      { role: "user", content: JSON.stringify(user) },
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
  "You are the local Morrow Mail assistant.",
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
  return turns
    .filter((turn) => turn && (turn.role === "user" || turn.role === "agent"))
    .map((turn) => ({ ...turn, reply: normalizeReply(turn.reply) }));
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
    reply: normalizeReply(turn && turn.reply),
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

const LIST_PAGE = 5;
const LIST_CAP = 15;
const INBOX_SCAN = 40;
const NO_REPLY = /no-?reply|noreply|notifications?@|mailer-daemon/i;
const CONTINUE_TEXT = new Set(["any other", "any others", "and", "more", "another", "next", "还有", "还有呢", "其他"]);
const CHOICE_IDS = new Map([
  ["unread", "unread"],
  ["today", "today"],
  ["sender", "sender"],
  ["a sender", "sender"],
  ["未读", "unread"],
  ["今天", "today"],
  ["发件人", "sender"],
]);
const UNREAD_ASK = new Set(["what is unread", "what's unread", "unread", "any unread", "show unread", "unread mail", "未读", "有没有未读"]);
const TODAY_ASK = new Set(["today", "mail from today", "anything today", "今天", "今天的邮件"]);
const BROAD_ASK = new Set([
  "any email",
  "any emails",
  "any email address to me",
  "any email for me",
  "what's new",
  "what is new",
  "anything for me",
  "any mail",
  "emails for me",
  "what's in my inbox",
  "what is in my inbox",
  "有没有邮件",
  "有没有给我的邮件",
  "有什么新邮件",
]);

function foldedAsk(text) {
  return String(text || "").trim().toLowerCase().replace(/[?？]$/, "");
}

function usesChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function replyIsHonest(from) {
  return !NO_REPLY.test(String(from || ""));
}

function copyFilter(filter) {
  if (!filter || typeof filter !== "object") return null;
  if (filter.kind === "unread" || filter.kind === "today") return { kind: filter.kind };
  if (filter.kind === "sender") {
    const query = clip(filter.query, 80);
    return query ? { kind: "sender", query } : null;
  }
  return null;
}

function choicePlan(id) {
  if (id === "sender") return { type: "clarify", expect: "sender" };
  if (id === "unread" || id === "today") return { type: "list", filter: { kind: id } };
  return null;
}

function choiceFromPrior(folded, prior) {
  const reply = prior && prior.reply;
  if (!folded || !reply || reply.kind !== "clarify" || !Array.isArray(reply.choices)) return "";
  for (const choice of reply.choices) {
    const id = String(choice && choice.id || "").trim().toLowerCase();
    const label = String(choice && choice.label || "").trim().toLowerCase();
    if (folded === id || folded === label) return id;
  }
  return "";
}

function senderAskQuery(text) {
  const stripped = String(text || "").trim().replace(/[?？]$/, "");
  const en = stripped.match(/^from\s+(.+)$/i);
  if (en) return clip(en[1], 80);
  const zh = stripped.match(/^来自\s*(.+)$/);
  if (zh) return clip(zh[1], 80);
  return "";
}

function planChat(text, priorAgentTurn) {
  const folded = foldedAsk(text);
  if (CONTINUE_TEXT.has(folded)) {
    const reply = priorAgentTurn && priorAgentTurn.reply;
    if (reply && reply.kind === "list" && Array.isArray(reply.ids)) {
      const offset = Number(reply.offset) || 0;
      if (offset < reply.ids.length) return { type: "continue" };
      return { type: "list-end" };
    }
    return { type: "clarify", expect: "filter" };
  }
  const chosen = choicePlan(CHOICE_IDS.get(folded) || choiceFromPrior(folded, priorAgentTurn));
  if (chosen) return chosen;
  const query = senderAskQuery(text);
  if (query) return { type: "list", filter: { kind: "sender", query } };
  if (UNREAD_ASK.has(folded)) return { type: "list", filter: { kind: "unread" } };
  if (TODAY_ASK.has(folded)) return { type: "list", filter: { kind: "today" } };
  if (BROAD_ASK.has(folded)) return { type: "clarify", expect: "filter" };
  const prior = priorAgentTurn && priorAgentTurn.reply;
  if (prior && prior.kind === "clarify" && prior.expect === "sender" && String(text || "").trim()) {
    return { type: "list", filter: { kind: "sender", query: clip(text, 80) } };
  }
  return { type: "prose" };
}

function isLocalToday(value, now) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const day = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  return date.getFullYear() === day.getFullYear()
    && date.getMonth() === day.getMonth()
    && date.getDate() === day.getDate();
}

function matchesMailFilter(row, filter, now) {
  if (!row || !filter) return false;
  if (filter.kind === "unread") return !!row.unread;
  if (filter.kind === "today") return isLocalToday(row.date, now);
  if (filter.kind === "sender") {
    const query = String(filter.query || "").trim().toLowerCase();
    if (!query) return false;
    return String(row.from || "").toLowerCase().includes(query);
  }
  return false;
}

function cardFromRow(row) {
  const messageId = row && row.id ? String(row.id) : "";
  if (!messageId) return null;
  return {
    messageId,
    from: String(row.from || ""),
    subject: String(row.subject || ""),
    summary: String(row.snippet || "").slice(0, 180),
    date: String(row.date || ""),
    unread: !!row.unread,
    hasAttachments: !!row.hasAttachments,
  };
}

function indexInbox(inbox) {
  const byId = new Map();
  for (const row of Array.isArray(inbox) ? inbox : []) {
    const id = row && row.id ? String(row.id) : "";
    if (id && !byId.has(id)) byId.set(id, row);
  }
  return byId;
}

function freshIds(inbox, filter, now) {
  const ids = [];
  const seen = new Set();
  for (const row of Array.isArray(inbox) ? inbox : []) {
    const id = row && row.id ? String(row.id) : "";
    if (!id || seen.has(id) || !matchesMailFilter(row, filter, now)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids: ids.slice(0, LIST_CAP), capped: ids.length > LIST_CAP };
}

function pageIds(inbox, ids, offset) {
  const byId = indexInbox(inbox);
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const chosen = ids.slice(start, start + LIST_PAGE);
  const cards = [];
  for (const id of chosen) {
    const row = byId.get(id);
    if (!row) continue;
    const card = cardFromRow(row);
    if (card) cards.push(card);
  }
  return { cards, offset: Math.min(ids.length, start + chosen.length) };
}

function stampCards(cards, userText) {
  const zh = usesChinese(userText);
  const openLabel = zh ? "打开" : "Open";
  const draftLabel = zh ? "写回复" : "Draft";
  return cards.map((card) => {
    const followUps = [{ kind: "open", messageId: card.messageId, label: openLabel }];
    if (replyIsHonest(card.from)) {
      followUps.push({ kind: "draft", messageId: card.messageId, label: draftLabel });
    }
    return { ...card, followUps };
  });
}

function filterChoices(userText) {
  const zh = usesChinese(userText);
  return [
    { id: "unread", label: zh ? "未读" : "Unread" },
    { id: "today", label: zh ? "今天" : "Today" },
    { id: "sender", label: zh ? "发件人" : "A sender" },
  ];
}

function listSentence(total, filter, zh) {
  const n = Math.max(0, Number(total) || 0);
  const kind = filter && filter.kind;
  if (zh) {
    if (kind === "today") return `${n} 封今天的邮件。`;
    if (kind === "sender") return `${n} 封来自 ${filter.query} 的邮件。`;
    return `${n} 封未读邮件。`;
  }
  const noun = n === 1 ? "message" : "messages";
  if (kind === "today") return `${n} ${noun} from today.`;
  if (kind === "sender") return `${n} ${noun} from ${filter.query}.`;
  return `${n} unread ${noun}.`;
}

function phraseFor(userText, detail) {
  const zh = usesChinese(userText);
  if (detail && detail.type === "clarify" && detail.expect === "sender") {
    return zh ? "哪一位发件人？输入邮箱或姓名。" : "Which sender? Type an email address or a name.";
  }
  if (detail && detail.type === "clarify") {
    return zh
      ? "要看未读、今天的邮件，还是某一位发件人的邮件？"
      : "Do you want unread mail, mail from today, or mail from one sender?";
  }
  if (detail && detail.type === "list-end") {
    if (zh) return "这个列表到这里了。";
    return detail.capped ? "That's the last of these 15." : "That's the last of this list.";
  }
  let sentence = listSentence(detail && detail.total, detail && detail.filter, zh);
  if (detail && !detail.whole) {
    const start = (Number(detail.start) || 0) + 1;
    const end = Number(detail.end) || start;
    sentence += zh ? ` 显示 ${start} 到 ${end}。` : ` Showing ${start} to ${end}.`;
  }
  if (detail && detail.fresh && detail.capped) {
    sentence += zh ? " 只含前 15 封。" : " Only the first 15 are in this list.";
  }
  return sentence;
}

function normalizeChoices(raw) {
  const fallback = [["unread", "Unread"], ["today", "Today"], ["sender", "A sender"]];
  const incoming = Array.isArray(raw) ? raw : [];
  return fallback.map(([id, label]) => {
    const found = incoming.find((choice) => choice && choice.id === id);
    const kept = clip(found && found.label, 40);
    return { id, label: kept || label };
  });
}

function normalizeCards(raw) {
  if (!Array.isArray(raw)) return [];
  const cards = [];
  for (const item of raw) {
    const messageId = clip(item && item.messageId, 200);
    if (!messageId) continue;
    const followUps = [];
    const rows = Array.isArray(item.followUps) ? item.followUps : [];
    for (const follow of rows) {
      const id = clip(follow && follow.messageId, 200);
      if (id !== messageId) continue;
      const label = clip(follow && follow.label, 40);
      if (follow.kind === "open") followUps.push({ kind: "open", messageId, label: label || "Open" });
      if (follow.kind === "draft") followUps.push({ kind: "draft", messageId, label: label || "Draft" });
    }
    cards.push({
      messageId,
      from: clip(item.from, 500),
      subject: clip(item.subject, 300),
      summary: String(item.summary || "").slice(0, 180),
      date: clip(item.date, 40),
      unread: !!item.unread,
      hasAttachments: !!item.hasAttachments,
      followUps,
    });
  }
  return cards;
}

function normalizeReply(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.kind === "clarify") {
    if (raw.expect !== "filter" && raw.expect !== "sender") return null;
    if (raw.expect === "sender") return { kind: "clarify", expect: "sender", choices: [] };
    return { kind: "clarify", expect: "filter", choices: normalizeChoices(raw.choices) };
  }
  if (raw.kind !== "list") return null;
  const filter = copyFilter(raw.filter);
  if (!filter) return null;
  const ids = Array.isArray(raw.ids)
    ? raw.ids.map((id) => clip(id, 200)).filter(Boolean).slice(0, LIST_CAP)
    : [];
  const offset = Number.isFinite(Number(raw.offset)) ? Math.max(0, Math.floor(Number(raw.offset))) : 0;
  const total = Number.isFinite(Number(raw.total)) ? Math.max(0, Math.floor(Number(raw.total))) : ids.length;
  return {
    kind: "list",
    filter,
    topic: clip(raw.topic, 200),
    ids,
    offset,
    total,
    capped: !!raw.capped,
    cards: normalizeCards(raw.cards),
  };
}

function latestAgentTurn() {
  const turns = readTurns();
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === "agent") return turns[i];
  }
  return null;
}

function listReply(filter, topic, ids, offset, total, capped, cards) {
  return {
    kind: "list",
    filter: copyFilter(filter),
    topic: topic || "",
    ids: ids.slice(),
    offset,
    total,
    capped: !!capped,
    cards,
  };
}

async function answerChat(text) {
  const prior = latestAgentTurn();
  const plan = planChat(text, prior);
  if (plan.type === "prose") {
    const answer = await answerQuestion(text);
    return { text: answer.text, error: !!answer.error, reply: null };
  }
  if (plan.type === "clarify") {
    const expect = plan.expect === "sender" ? "sender" : "filter";
    return {
      text: phraseFor(text, { type: "clarify", expect }),
      error: false,
      reply: {
        kind: "clarify",
        expect,
        choices: expect === "sender" ? [] : filterChoices(text),
      },
    };
  }
  const stored = prior && prior.reply;
  if (plan.type === "list-end") {
    return {
      text: phraseFor(text, { type: "list-end", capped: !!(stored && stored.capped) }),
      error: false,
      reply: listReply(stored.filter, stored.topic, stored.ids, stored.offset, stored.total, stored.capped, []),
    };
  }
  const inbox = inboxMessages(INBOX_SCAN);
  if (plan.type === "continue") {
    const page = pageIds(inbox, stored.ids, stored.offset);
    const cards = stampCards(page.cards, text);
    return {
      text: phraseFor(text, {
        type: "list",
        filter: stored.filter,
        total: stored.ids.length,
        fresh: false,
        capped: false,
        whole: stored.offset === 0 && page.offset === stored.ids.length,
        start: stored.offset,
        end: page.offset,
      }),
      error: false,
      reply: listReply(stored.filter, stored.topic, stored.ids, page.offset, stored.total, stored.capped, cards),
    };
  }
  const built = freshIds(inbox, plan.filter, new Date());
  const page = pageIds(inbox, built.ids, 0);
  const cards = stampCards(page.cards, text);
  return {
    text: phraseFor(text, {
      type: "list",
      filter: plan.filter,
      total: built.ids.length,
      fresh: true,
      capped: built.capped,
      whole: page.offset === built.ids.length,
      start: 0,
      end: page.offset,
    }),
    error: false,
    reply: listReply(plan.filter, clip(text, 200), built.ids, page.offset, built.ids.length, built.capped, cards),
  };
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
        accountId: selected && selected.accountId || "",
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
    if (data && !data.name) data.name = intent.name || "";
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
  const answer = await answerChat(text);
  const turn = appendChat({
    role: "agent",
    kind: "chat",
    text: answer.text,
    error: answer.error,
    reply: answer.reply,
  });
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

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 10080;
const inflightSkills = new Set();
let skillTimer = null;

function fieldValid(field, min, max) {
  if (field === "*") return true;
  const bits = String(field || "").split(",");
  if (!bits.length || bits.some((bit) => bit === "")) return false;
  return bits.every((bit) => {
    const step = bit.match(/^\*\/(\d+)$/);
    if (step) return Number(step[1]) >= 1;
    const range = bit.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const stride = range[3] ? Number(range[3]) : 1;
      return stride >= 1 && start >= min && end <= max && start <= end;
    }
    if (!/^\d+$/.test(bit)) return false;
    const value = Number(bit);
    return value >= min && value <= max;
  });
}

function fieldMatch(field, value, min = 0) {
  if (field === "*") return true;
  return String(field || "").split(",").some((bit) => {
    const step = bit.match(/^\*\/(\d+)$/);
    if (step) return (value - min) % Number(step[1]) === 0;
    const range = bit.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const stride = range[3] ? Number(range[3]) : 1;
      return value >= start && value <= end && (value - start) % stride === 0;
    }
    return Number(bit) === value;
  });
}

function parseCron(expr) {
  const parts = String(expr || "").trim().replace(/\s+/g, " ").split(" ");
  if (parts.length !== 5) return null;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  for (let i = 0; i < ranges.length; i += 1) {
    if (!fieldValid(parts[i], ranges[i][0], ranges[i][1])) return null;
  }
  return { minute: parts[0], hour: parts[1], dom: parts[2], month: parts[3], dow: parts[4] };
}

function dowMatch(field, date) {
  const dow = date.getDay();
  if (fieldMatch(field, dow)) return true;
  return dow === 0 && fieldMatch(field, 7);
}

function cronMatches(expr, date) {
  const fields = typeof expr === "string" || expr == null ? parseCron(expr) : expr;
  if (!fields || !(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  if (!fieldMatch(fields.minute, date.getMinutes())) return false;
  if (!fieldMatch(fields.hour, date.getHours())) return false;
  if (!fieldMatch(fields.month, date.getMonth() + 1, 1)) return false;
  const domRestricted = !fields.dom.startsWith("*");
  const dowRestricted = !fields.dow.startsWith("*");
  const domOk = fieldMatch(fields.dom, date.getDate(), 1);
  const dowOk = dowMatch(fields.dow, date);
  if (domRestricted && dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

function nextCron(expr, from) {
  const fields = parseCron(expr);
  if (!fields) return null;
  const cursor = new Date(from instanceof Date ? from.getTime() : Date.now());
  if (Number.isNaN(cursor.getTime())) return null;
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const end = cursor.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= end) {
    if (cronMatches(fields, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

function normalizeSchedules(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const rows = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const skillId = String(raw.skillId || "").trim();
    if (!skillId || seen.has(skillId)) continue;
    if (!skillById(skillId) && !isUserSkillId(skillId)) continue;
    const kind = raw.kind === "cron" || raw.kind === "interval" ? raw.kind : "";
    if (!kind) continue;
    const everyMinutes = Number(raw.everyMinutes);
    const cron = String(raw.cron || "").trim().replace(/\s+/g, " ");
    if (kind === "interval" && (!Number.isInteger(everyMinutes) || everyMinutes < MIN_INTERVAL_MINUTES || everyMinutes > MAX_INTERVAL_MINUTES)) continue;
    if (kind === "cron" && !parseCron(cron)) continue;
    seen.add(skillId);
    rows.push({
      skillId,
      kind,
      everyMinutes: kind === "interval" ? everyMinutes : null,
      cron: kind === "cron" ? cron : "",
      paused: raw.paused === true,
      nextRunAt: typeof raw.nextRunAt === "string" ? raw.nextRunAt : "",
      lastRunAt: typeof raw.lastRunAt === "string" ? raw.lastRunAt : "",
      lastError: typeof raw.lastError === "string" ? raw.lastError.slice(0, 300) : "",
      contactEmail: addressIn(raw.contactEmail),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    });
  }
  return rows;
}

function publicSchedule(row) {
  return {
    skillId: row.skillId,
    kind: row.kind,
    everyMinutes: row.kind === "interval" ? row.everyMinutes : null,
    cron: row.kind === "cron" ? row.cron : "",
    paused: row.paused === true,
    nextRunAt: row.nextRunAt || null,
    lastRunAt: row.lastRunAt || null,
    lastError: row.lastError || "",
    contactEmail: row.contactEmail || "",
  };
}

function nextSlot(schedule, from) {
  if (schedule.kind === "interval") {
    return new Date(from.getTime() + schedule.everyMinutes * 60 * 1000);
  }
  return nextCron(schedule.cron, from);
}

function setSkillSchedule(params) {
  const skillId = params && typeof params.skillId === "string" ? params.skillId.trim() : "";
  const skill = skillById(skillId);
  if (!skill) return fail(new Error("That skill is not on this host."));
  const store = readStore();
  if (!installedIds(store).includes(skillId)) return fail(new Error("Install the skill before scheduling it."));
  const schedules = store.schedules.slice();
  const index = schedules.findIndex((row) => row.skillId === skillId);
  const existing = index >= 0 ? schedules[index] : null;
  const hasKind = params && (params.kind != null || params.trigger != null || params.cron != null || params.everyMinutes != null);
  if (!hasKind) {
    if (!existing) return fail(new Error("That skill has no schedule to pause."));
    if (typeof params.paused !== "boolean") return fail(new Error("Say whether the schedule is paused."));
    existing.paused = params.paused;
    existing.updatedAt = new Date().toISOString();
    schedules[index] = existing;
    store.schedules = schedules;
    writeStore(store);
    return ok({ schedule: publicSchedule(existing), skills: listHomeSkills() });
  }
  const kind = String((params && (params.kind || params.trigger)) || "").trim();
  if (kind !== "interval" && kind !== "cron") return fail(new Error("Pick an interval or a cron schedule."));
  let everyMinutes = null;
  let cron = "";
  if (kind === "interval") {
    everyMinutes = Number(params.everyMinutes);
    if (!Number.isInteger(everyMinutes) || everyMinutes < MIN_INTERVAL_MINUTES || everyMinutes > MAX_INTERVAL_MINUTES) {
      return fail(new Error("Use 1 to 10080 minutes."));
    }
  } else {
    cron = String(params.cron || "").trim().replace(/\s+/g, " ");
    if (!parseCron(cron)) return fail(new Error("A cron schedule needs five fields."));
    if (!nextCron(cron, new Date())) return fail(new Error("That cron has no upcoming time."));
  }
  let contactEmail = existing ? existing.contactEmail : "";
  if (params && Object.prototype.hasOwnProperty.call(params, "contactEmail")) contactEmail = addressIn(params.contactEmail);
  if (skill.person && !contactEmail) return fail(new Error("A schedule for this skill needs a contact email."));
  const now = new Date();
  const row = {
    skillId,
    kind,
    everyMinutes,
    cron,
    paused: typeof params.paused === "boolean" ? params.paused : !!(existing && existing.paused),
    nextRunAt: "",
    lastRunAt: existing ? existing.lastRunAt || "" : "",
    lastError: "",
    contactEmail,
    updatedAt: now.toISOString(),
  };
  const upcoming = nextSlot(row, now);
  if (!upcoming) return fail(new Error("That cron has no upcoming time."));
  row.nextRunAt = upcoming.toISOString();
  if (index >= 0) schedules[index] = row;
  else schedules.push(row);
  store.schedules = schedules;
  writeStore(store);
  return ok({ schedule: publicSchedule(row), skills: listHomeSkills() });
}

function deleteSkillSchedule(params) {
  const skillId = params && typeof params.skillId === "string" ? params.skillId.trim() : "";
  if (!skillById(skillId)) return fail(new Error("That skill is not on this host."));
  const store = readStore();
  const next = (store.schedules || []).filter((row) => row.skillId !== skillId);
  if (next.length === (store.schedules || []).length) return fail(new Error("That skill has no schedule."));
  store.schedules = next;
  writeStore(store);
  return ok({ skills: listHomeSkills() });
}

function notifySchedule(payload) {
  try {
    require("./brain").emit("emailBrain:scheduleFired", payload);
  } catch {
    /* the window list is optional when the host is under test */
  }
}

async function runScheduled(skillId, contactEmail) {
  const params = { skillId, source: "schedule" };
  if (contactEmail) params.contactEmail = contactEmail;
  let result;
  try {
    result = await runSkill(params);
  } catch (error) {
    result = fail(error);
  }
  const data = result && result.success ? result.data : null;
  const accepted = !!(data && data.accepted !== false && !data.error);
  const errorText = accepted ? "" : String((data && data.error) || (result && result.error && result.error.message) || "That skill did not finish.").slice(0, 300);
  const store = readStore();
  const schedule = (store.schedules || []).find((row) => row.skillId === skillId);
  if (schedule) {
    schedule.lastRunAt = new Date().toISOString();
    schedule.lastError = errorText;
    writeStore(store);
  }
  const skill = skillById(skillId);
  notifySchedule({
    skillId,
    name: skill ? skill.name : skillId,
    accepted,
    summary: accepted ? String((data && data.summary) || "").slice(0, 240) : "",
    error: errorText,
    runMode: "scheduled",
  });
}

function pumpDueSkills(now) {
  return updateGate.run(() => pumpDueSkillsAdmitted(now));
}

function pumpDueSkillsAdmitted(now) {
  const clock = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const store = readStore();
  const installed = new Set(installedIds(store));
  let queued = 0;
  let changed = false;
  for (const schedule of store.schedules || []) {
    if (!schedule || schedule.paused || !installed.has(schedule.skillId)) continue;
    if (!skillById(schedule.skillId)) continue;
    const due = Date.parse(schedule.nextRunAt);
    if (Number.isFinite(due) && due > clock.getTime()) continue;
    if (inflightSkills.has(schedule.skillId)) continue;
    const upcoming = nextSlot(schedule, clock);
    if (!upcoming) {
      schedule.paused = true;
      schedule.lastError = "That cron has no upcoming time.";
      changed = true;
      continue;
    }
    inflightSkills.add(schedule.skillId);
    schedule.nextRunAt = upcoming.toISOString();
    changed = true;
    queued += 1;
    const skillId = schedule.skillId;
    const contactEmail = schedule.contactEmail || "";
    // Admit before deferring: shutdown must include queued scheduled work.
    updateGate.run(() => new Promise(resolve => {
      setImmediate(() => {
        runScheduled(skillId, contactEmail).catch(() => {}).finally(() => {
          inflightSkills.delete(skillId);
          resolve();
        });
      });
    })).catch(() => {});
  }
  if (changed) writeStore(store);
  return { queued };
}

function startSkillScheduler() {
  if (skillTimer) return;
  const tick = () => {
    try {
      pumpDueSkills(new Date());
    } catch {
      /* the next tick reads the store again */
    }
  };
  const first = setTimeout(tick, 1500);
  if (first && first.unref) first.unref();
  skillTimer = setInterval(tick, 20000);
  if (skillTimer.unref) skillTimer.unref();
}

const BRIDGE_STORE_CAP = 2 * 1024 * 1024;

function readStoreForBridge() {
  const file = storePath();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return { proposals: [] };
    return { error: "STORE_UNAVAILABLE" };
  }
  if (!stat.isFile() || stat.size > BRIDGE_STORE_CAP) return { error: "STORE_UNAVAILABLE" };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { error: "STORE_UNAVAILABLE" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "STORE_UNAVAILABLE" };
  if (!Object.prototype.hasOwnProperty.call(parsed, "proposals")) return { proposals: [] };
  if (!Array.isArray(parsed.proposals)) return { error: "STORE_UNAVAILABLE" };
  return { proposals: parsed.proposals };
}

function bridgeListProposals(accountId, options) {
  const read = readStoreForBridge();
  if (read.error) return { error: read.error };
  const limit = options && options.limit ? options.limit : 20;
  const owns = options && options.owns;
  const items = [];
  let more = false;
  for (const row of read.proposals) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (row.status !== "pending") continue;
    if (row.accountId !== accountId) continue;
    const messageId = typeof row.messageId === "string" ? row.messageId : "";
    const proposalId = typeof row.id === "string" ? row.id : "";
    if (!messageId || !proposalId) continue;
    if (typeof owns === "function" && !owns(messageId, accountId)) continue;
    if (items.length >= limit) {
      more = true;
      break;
    }
    items.push({
      proposalId,
      accountId,
      messageId,
      kind: "organize",
      status: "pending",
      createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
      source: "morrow-agent",
      reviewInMorrow: true,
      detailsAvailable: false,
      detailsUnavailableReason: "SOURCE_SCOPE_UNVERIFIED",
    });
  }
  return {
    items,
    more,
    coverage: { kinds: ["organize"], draftAndTriageSuggestionsIncluded: false },
  };
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
  bridgeListProposals,
  triage,
  getTriage,
  routeChat,
  planChat,
  mailboxConnected,
  profileSample,
  liveProfileMail,
  groupTriage,
  refreshTaxonomy,
  setTodo,
  normalizeSkillResult,
  setSkillSchedule,
  deleteSkillSchedule,
  saveCustomSkill,
  deleteCustomSkill,
  customSkillsPath,
  pumpDueSkills,
  startSkillScheduler,
  cronMatches,
  nextCron,
  CATALOG,
};
