const { gate: updateGate } = require("./update-quiescence");
const fs = require("fs");
const path = require("path");
const { BrowserWindow } = require("electron");
const { loadConfig, userDataDir } = require("./ai-config");
const { complete, extractJson } = require("./openai-client");
const {
  personaSystemPrompt,
  applyGenerated,
  identityPriorForPrompt,
  identityBriefFrom,
  forgetIdentity,
  identityFixTarget,
  rewriteIdentityItem,
  collectIdentityEmails,
} = require("./brain-persona");

const DEFAULT_CATEGORIES = [
  { id: "needs-you", name: "Needs You", description: "Messages that need a reply or a decision from you.", collapseView: false },
  { id: "upcoming-today", name: "Upcoming Today", description: "Meetings, deadlines, and mail tied to today.", collapseView: false },
  { id: "worth-a-look", name: "Worth a look", description: "Useful mail that can wait a little.", collapseView: false },
  { id: "fyi", name: "FYI", description: "Newsletters, receipts, and notices to skim.", collapseView: true },
  { id: "other", name: "Other", description: "Everything else.", collapseView: true },
];

function storePath() {
  return path.join(userDataDir(), "brain.json");
}

function emptyStore() {
  return { userRules: [], generated: null, categories: DEFAULT_CATEGORIES.map((row) => ({ ...row })), activity: [] };
}

function legacyCategories(categories) {
  if (!Array.isArray(categories) || categories.length !== 3) return false;
  return categories.map((row) => row && row.id).join(",") === "cat-primary,cat-updates,cat-social";
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    const stored = Array.isArray(parsed.categories) ? parsed.categories : [];
    return {
      userRules: Array.isArray(parsed.userRules) ? parsed.userRules : [],
      generated: parsed.generated && typeof parsed.generated === "object" ? parsed.generated : null,
      categories: stored.length && !legacyCategories(stored)
        ? stored
        : DEFAULT_CATEGORIES.map((row) => ({ ...row })),
      activity: Array.isArray(parsed.activity) ? parsed.activity : [],
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

function emit(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

function row(sectionId, index, partial) {
  return {
    id: partial.id || `${sectionId}:${index}`,
    label: partial.label || "",
    value: partial.value || "",
    source: partial.source || "auto",
  };
}

function writingKey(item, index) {
  if (item && typeof item === "object" && item.id) return item.id;
  return `how-you-write:${index}`;
}

function personaFrom(store) {
  const cfg = loadConfig();
  const generated = store.generated;
  const writingRows = [
    ...store.userRules.map((rule, index) => row("how-you-write", index, {
      id: rule.id,
      value: rule.value,
      source: "user",
    })),
    ...((generated && generated.writing) || []).map((item, index) => row("how-you-write", index, {
      id: writingKey(item, index),
      value: item && typeof item === "object" ? item.value : item,
      source: "auto",
    })),
  ];
  const learned = (generated && generated.sections) || [];
  const sections = [
    {
      id: "how-you-write",
      title: "How you write",
      kind: "rows",
      rows: writingRows,
    },
      ...learned.map((section) => ({
      id: section.id,
      title: section.title,
      kind: "rows",
      rows: (section.rows || []).map((item, index) => row(section.id, index, item)),
    })),
  ];
  const quotes = generated && Array.isArray(generated.voiceQuotes) ? generated.voiceQuotes : [];
  if (quotes.length) {
    sections.push({
      id: "voice",
      title: "Voice from sent mail",
      kind: "rows",
      rows: quotes.map((value, index) => row("voice", index, { value, source: "auto" })),
    });
  }
  if (!cfg.apiKey) {
    sections.push({
      id: "ai-setup",
      title: "AI endpoint",
      kind: "rows",
      rows: [row("ai-setup", 0, {
        label: "Not configured",
        value: "Open Morrow Mail → AI Setup and enter an OpenAI-compatible base URL, API key, and model id.",
        source: "auto",
      })],
    });
  } else if (!generated) {
    sections.push({
      id: "recent-mail",
      title: "Recent mail",
      kind: "rows",
      rows: recentMailSection(),
    });
  }
  const profile = {
    meta: {
      ownerName: (generated && generated.ownerName) || "",
      emailsAnalyzed: generated ? generated.emailsAnalyzed || 0 : 0,
      factsLearned: writingRows.length + learned.reduce((n, section) => n + (section.rows || []).length, 0),
      updatedAt: (generated && generated.updatedAt) || null,
    },
    sections,
  };
  if (generated && generated.identity && typeof generated.identity === "object" && !Array.isArray(generated.identity)) {
    profile.identity = generated.identity;
  }
  return {
    status: "ready",
    updatedAt: (generated && generated.updatedAt) || new Date().toISOString(),
    recentActivity: (store.activity || []).slice(0, 12),
    profile,
  };
}

function recentMailSection() {
  let agent;
  try {
    agent = require("./agent");
  } catch {
    agent = null;
  }
  if (!agent || !agent.mailboxConnected()) {
    return [row("recent-mail", 0, {
      label: "No mailbox",
      value: "Connect a mailbox. Sample mail is not used for this profile.",
    })];
  }
  const mail = agent.liveProfileMail(8);
  if (!mail.length) {
    return [row("recent-mail", 0, {
      label: "Empty cache",
      value: "Refresh the inbox, then rebuild.",
    })];
  }
  return mail.map((message, index) => row("recent-mail", index, {
    label: message.from,
    value: `${message.subject} — ${message.snippet}`,
  }));
}

function writingBrief() {
  try {
    const store = readStore();
    const rules = [
      ...store.userRules.map((rule) => rule.value),
      ...((store.generated && store.generated.writing) || []),
    ].map((value) => String(value || "").trim()).filter(Boolean).slice(0, 8);
    return rules.length ? rules.map((rule) => `- ${rule}`).join("\n") : "";
  } catch {
    return "";
  }
}

function identityBrief() {
  try {
    return identityBriefFrom(readStore().generated);
  } catch {
    return null;
  }
}

function collectAccountEmails(priorEmails) {
  try {
    const db = require("./mail/db");
    if (!db.isReady()) return null;
    const accounts = db.listAccountRows();
    if (!Array.isArray(accounts)) return null;
    const settings = require("./settings").answer("emailBrain:getComposeSettings", []);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
    return collectIdentityEmails(accounts, settings, priorEmails);
  } catch {
    return null;
  }
}

function snapshot() {
  const store = readStore();
  return { persona: personaFrom(store), fetchedAt: new Date().toISOString() };
}

function ok(data) {
  return { success: true, data };
}

function fail(error) {
  return { success: false, error: { message: error instanceof Error ? error.message : String(error), code: error.code || "ai-error" } };
}

const FRESH_MS = 30 * 60 * 1000;
let livingTimer = null;

function pushActivity(store, kind, detail) {
  const list = Array.isArray(store.activity) ? store.activity : [];
  list.unshift({
    id: `act-${Date.now().toString(36)}-${list.length + 1}`,
    kind,
    at: new Date().toISOString(),
    detail: String(detail || "").slice(0, 240),
  });
  store.activity = list.slice(0, 30);
}

function failJob(mode, message) {
  if (mode === "refresh") {
    emit("emailBrain:refreshState", { refreshing: false, error: message });
    return;
  }
  emit("emailBrain:rebuildState", { rebuilding: false, phase: "failed", percent: null, error: message });
}

function generatedIsFresh(store) {
  const at = store.generated && Date.parse(store.generated.updatedAt);
  return Number.isFinite(at) && Date.now() - at < FRESH_MS;
}

async function runPersona(mode, sample, prior) {
  const rebuilding = mode === "rebuild";
  const system = personaSystemPrompt(mode);
  const text = await complete([
    { role: "system", content: system },
    {
      role: "user",
      content: JSON.stringify({
        personaMode: mode,
        sentCount: sample.sentCount,
        inboxCount: sample.inboxCount,
        prior: rebuilding ? null : {
          ownerName: prior && prior.ownerName || "",
          writing: prior && prior.writing || [],
          sections: prior && prior.sections || [],
          voiceQuotes: prior && prior.voiceQuotes || [],
          identity: identityPriorForPrompt(prior),
        },
        messages: sample.messages,
      }),
    },
  ], { temperature: 0.2 });
  return extractJson(text);
}

async function analyzeMail(mode) {
  return updateGate.run(() => analyzeMailAdmitted(mode));
}

async function analyzeMailAdmitted(mode) {
  const refresh = mode === "refresh";
  if (refresh) emit("emailBrain:refreshState", { refreshing: true, error: null });
  else emit("emailBrain:rebuildState", { rebuilding: true, phase: "reading", percent: 15, error: null });
  const agent = require("./agent");
  if (!agent.mailboxConnected()) {
    failJob(mode, refresh
      ? "Connect a mailbox before refreshing. Sample mail is not used."
      : "Connect a mailbox before rebuilding. Sample mail is not used.");
    return;
  }
  const sample = typeof agent.profileSample === "function"
    ? agent.profileSample(mode)
    : { messages: agent.liveProfileMail(16), sentCount: 0, inboxCount: 0 };
  if (!sample.messages.length) {
    failJob(mode, "The mailbox cache is empty. Refresh the inbox, then rebuild.");
    return;
  }
  try {
    if (!refresh) emit("emailBrain:rebuildState", { rebuilding: true, phase: "rebuilding", percent: 55, error: null });
    const store = readStore();
    const parsed = await runPersona(mode, sample, store.generated);
    if (!refresh) emit("emailBrain:rebuildState", { rebuilding: true, phase: "saving", percent: 85, error: null });
    const priorEmails = store.generated && store.generated.identity && store.generated.identity.emails;
    applyGenerated(store, parsed, sample, mode, collectAccountEmails(priorEmails));
    pushActivity(store, mode, refresh
      ? `Distilled from ${sample.sentCount} sent and ${sample.inboxCount} inbox messages.`
      : `Rebuilt a distilled persona from ${sample.sentCount} sent and ${sample.inboxCount} inbox messages.`);
    writeStore(store);
    if (refresh) emit("emailBrain:refreshState", { refreshing: false, error: null });
    else emit("emailBrain:rebuildState", { rebuilding: false, phase: "ready", percent: 100, error: null });
    emit("emailBrain:updated", {});
  } catch (error) {
    failJob(mode, error instanceof Error ? error.message : String(error));
  }
}

function refreshFromMail() {
  return analyzeMail("refresh");
}

function rebuildFromMail() {
  return analyzeMail("rebuild");
}

function scheduleLivingRefresh() {
  if (livingTimer) return;
  livingTimer = setInterval(() => {
    if (!loadConfig().apiKey) return;
    if (generatedIsFresh(readStore())) return;
    refreshFromMail().catch(() => {});
  }, 60 * 60 * 1000);
  if (livingTimer.unref) livingTimer.unref();
}

function onDemandRefusal() {
  return ok({
    accepted: false,
    runMode: "on_demand",
    error: "That action runs only when you ask. Auto-execute stays off, and a schedule never sends mail.",
  });
}

function taxonomy() {
  return readStore().categories.map((category) => ({
    id: category.id,
    name: category.name,
    description: category.description,
    collapseView: category.collapseView === true,
  }));
}

function answer(channel, args) {
  const params = args && args.length ? args[0] : undefined;
  switch (channel) {
    case "emailBrain:getComposeSettings":
    case "emailBrain:saveComposeSettings":
      try { return ok(require("./settings").answer(channel, args)); }
      catch (error) { return fail(error); }
    case "emailBrain:getCached":
      return ok(snapshot());
    case "emailBrain:refresh":
      if (!loadConfig().apiKey) {
        emit("emailBrain:refreshState", { refreshing: false, error: null });
        return ok({ accepted: false, mode: "refresh" });
      }
      if ((params && params.source) !== "manual" && generatedIsFresh(readStore())) {
        emit("emailBrain:refreshState", { refreshing: false, error: null });
        return ok({ accepted: true, mode: "refresh", cached: true });
      }
      updateGate.run(() => new Promise(resolve => {
        setImmediate(() => { refreshFromMail().catch(() => {}).finally(resolve); });
      })).catch(() => {});
      return ok({ accepted: true, mode: "refresh" });
    case "emailBrain:rebuild":
      if (!loadConfig().apiKey) {
        emit("emailBrain:rebuildState", { rebuilding: false, phase: "ready", percent: null, error: null });
        return ok({ accepted: false, mode: "rebuild" });
      }
      updateGate.run(() => new Promise(resolve => {
        setImmediate(() => { rebuildFromMail().catch(() => {}).finally(resolve); });
      })).catch(() => {});
      return ok({ accepted: true, mode: "rebuild" });
    case "emailBrain:addWritingRule": {
      const text = params && typeof params.text === "string" ? params.text.trim() : "";
      if (!text) return fail(new Error("A writing rule needs text"));
      const store = readStore();
      store.userRules.push({ id: `how-you-write:user:${Date.now().toString(36)}`, value: text });
      writeStore(store);
      emit("emailBrain:updated", {});
      return ok(snapshot());
    }
    case "emailBrain:setWritingRule": {
      const store = readStore();
      const itemId = params && params.itemId;
      const rule = store.userRules.find((item) => item.id === itemId);
      const nextText = params && typeof params.text === "string" ? params.text.trim() : null;
      if (rule && nextText !== null) rule.value = nextText;
      if (rule && params && typeof params.enabled === "boolean") rule.enabled = params.enabled;
      if (!rule && nextText !== null && store.generated && Array.isArray(store.generated.writing)) {
        store.generated.writing = store.generated.writing.map((item, index) => {
          if (writingKey(item, index) !== itemId) return item;
          if (item && typeof item === "object") return { ...item, value: nextText };
          return nextText;
        });
      }
      writeStore(store);
      emit("emailBrain:updated", {});
      return ok(snapshot());
    }
    case "emailBrain:deleteWritingRule":
    case "emailBrain:forgetItem": {
      const itemId = params && params.itemId;
      const store = readStore();
      const before = JSON.stringify({ rules: store.userRules, generated: store.generated });
      store.userRules = store.userRules.filter((item) => item.id !== itemId);
      if (store.generated && Array.isArray(store.generated.writing)) {
        store.generated.writing = store.generated.writing.filter((item, index) => writingKey(item, index) !== itemId);
      }
      if (store.generated && Array.isArray(store.generated.sections)) {
        for (const section of store.generated.sections) {
          section.rows = (section.rows || []).filter((item, index) => (item.id || `${section.id}:${index}`) !== itemId);
        }
      }
      if (store.generated && Array.isArray(store.generated.voiceQuotes)) {
        store.generated.voiceQuotes = store.generated.voiceQuotes.filter((_value, index) => `voice:${index}` !== itemId);
      }
      if (store.generated && store.generated.identity) {
        const forgotten = forgetIdentity(store.generated.identity, itemId);
        if (forgotten.removed) store.generated.identity = forgotten.identity;
      }
      const removed = before !== JSON.stringify({ rules: store.userRules, generated: store.generated });
      if (removed && channel === "emailBrain:forgetItem") pushActivity(store, "forget", "Forgot one profile row.");
      writeStore(store);
      emit("emailBrain:updated", {});
      return ok(true);
    }
    case "emailBrain:getCategories":
      return ok({
        categories: readStore().categories,
        isDefault: false,
        defaultCategories: DEFAULT_CATEGORIES,
      });
    case "emailBrain:saveCategories": {
      const store = readStore();
      const incoming = params && Array.isArray(params.categories) ? params.categories : params;
      store.categories = (Array.isArray(incoming) ? incoming : []).map((category, index) => ({
        id: category.id || `cat-${index + 1}`,
        name: String(category.name || "").slice(0, 80),
        description: String(category.description || "").slice(0, 400),
        collapseView: category.collapseView === true,
      }));
      writeStore(store);
      return ok(store.categories);
    }
    case "emailBrain:addCategoryViaPrompt":
      return addCategory(params);
    case "emailBrain:fixCategory":
      return fixCategory(params);
    case "emailBrain:fixItem":
      return fixItem(params);
    case "emailBrain:getSkills":
      return ok(require("./agent").listHomeSkills());
    case "emailBrain:getLibrarySkills":
      return ok(require("./agent").listLibrarySkills());
    case "emailBrain:installSkill":
      return require("./agent").installSkill(params);
    case "emailBrain:removeSkill":
      return require("./agent").removeSkill(params);
    case "emailBrain:runSkill":
      return require("./agent").runSkill(params);
    case "emailBrain:confirmProposal":
      return require("./agent").confirmProposal(params);
    case "emailBrain:dismissProposal":
      return require("./agent").dismissProposal(params);
    case "emailBrain:getAiDraftEditLog":
    case "emailBrain:recordAiDraftEdit":
    case "emailBrain:setLearningToastSilenced":
    case "emailBrain:previewRuleMatches":
    case "emailBrain:setSkillAutoExecute":
      return onDemandRefusal();
    case "emailBrain:setSkillSchedule":
    case "emailBrain:setSkillTrigger":
      return require("./agent").setSkillSchedule(params);
    case "emailBrain:deleteSkillSchedule":
      return require("./agent").deleteSkillSchedule(params);
    default:
      if (channel.startsWith("emailBrain:")) {
        return fail(new Error("This Email Brain action is not available on a local model."));
      }
      return undefined;
  }
}

async function addCategory(params) {
  try {
    const text = await complete([
      {
        role: "system",
        content: "Turn the user's sentence into one mail category. Reply with JSON only: {\"name\":string,\"description\":string,\"collapseView\":boolean}.",
      },
      { role: "user", content: String((params && params.prompt) || "") },
    ]);
    const parsed = extractJson(text);
    return ok({
      command: {
        kind: "add_category",
        name: String(parsed.name || "New category"),
        description: String(parsed.description || ""),
        collapseView: parsed.collapseView === true,
      },
    });
  } catch (error) {
    return fail(error);
  }
}

async function fixCategory(params) {
  try {
    const text = await complete([
      {
        role: "system",
        content: "Rewrite one mail category. Reply with JSON only: {\"name\":string,\"description\":string,\"collapseView\":boolean}.",
      },
      { role: "user", content: JSON.stringify({ itemId: params && params.itemId, prompt: params && params.prompt }) },
    ]);
    const parsed = extractJson(text);
    return ok({
      category: {
        id: params && params.itemId,
        name: String(parsed.name || ""),
        description: String(parsed.description || ""),
        collapseView: parsed.collapseView === true,
      },
    });
  } catch (error) {
    return fail(error);
  }
}

function persistItemValue(store, itemId, value) {
  const target = identityFixTarget(itemId);
  if (target === "emails") throw new Error("Account addresses stay with the connected mailbox.");
  if (target === "auto") {
    if (!store.generated || !store.generated.identity) return false;
    const result = rewriteIdentityItem(store.generated.identity, itemId, value);
    if (result.error) throw new Error(result.error);
    if (!result.wrote) return false;
    store.generated.identity = result.identity;
    return true;
  }
  const rule = store.userRules.find((item) => item.id === itemId);
  if (rule) {
    rule.value = value;
    return true;
  }
  if (store.generated && Array.isArray(store.generated.writing)) {
    store.generated.writing = store.generated.writing.map((item, index) => {
      if (writingKey(item, index) !== itemId) return item;
      if (item && typeof item === "object") return { ...item, value };
      return value;
    });
  }
  if (store.generated && Array.isArray(store.generated.sections)) {
    for (const section of store.generated.sections) {
      section.rows = (section.rows || []).map((item, index) => {
        const id = item.id || `${section.id}:${index}`;
        return id === itemId ? { ...item, value } : item;
      });
    }
  }
  return true;
}

async function fixItem(params) {
  try {
    const itemId = params && params.itemId;
    if (identityFixTarget(itemId) === "emails") {
      return fail(new Error("Account addresses stay with the connected mailbox."));
    }
    const text = await complete([
      {
        role: "system",
        content: "Rewrite this profile row. Reply with the new row text only.",
      },
      { role: "user", content: JSON.stringify(params || {}) },
    ]);
    const value = text.trim();
    if (!value) return fail(new Error("The model returned an empty rewrite."));
    const store = readStore();
    const wrote = persistItemValue(store, itemId, value);
    if (wrote === false) return ok({ value });
    pushActivity(store, "fix", "Rewrote one profile row.");
    writeStore(store);
    emit("emailBrain:updated", {});
    return ok({ value });
  } catch (error) {
    return fail(error);
  }
}

module.exports = { answer, emit, personaFrom, writingBrief, identityBrief, taxonomy, scheduleLivingRefresh, refreshFromMail, rebuildFromMail };
