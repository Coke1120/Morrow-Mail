const fs = require("fs");
const path = require("path");
const { BrowserWindow } = require("electron");
const { loadConfig, userDataDir } = require("./ai-config");
const { complete, extractJson } = require("./openai-client");
const { messagesForAi } = require("./mailbox");

const DEFAULT_CATEGORIES = [
  { id: "cat-primary", name: "Primary", description: "People and conversations that need a reply.", collapseView: false },
  { id: "cat-updates", name: "Updates", description: "Receipts, notices, and automated mail.", collapseView: true },
  { id: "cat-social", name: "Social", description: "Invitations and personal notes.", collapseView: true },
];

// shortcut: static sample list, replace when a skill write channel exists
const HOME_SKILLS = [
  { id: "skill-tone", name: "Match my tone", description: "Replies follow your writing rules." },
  { id: "skill-sort", name: "Sort new mail", description: "Files messages with your categories." },
];

const LIBRARY_SKILLS = [
  { id: "lib-follow-up", name: "Follow up", description: "Threads still waiting on a reply." },
  { id: "lib-digest", name: "Morning digest", description: "What arrived overnight." },
];

function storePath() {
  return path.join(userDataDir(), "brain.json");
}

function emptyStore() {
  return { userRules: [], generated: null, categories: DEFAULT_CATEGORIES.map((row) => ({ ...row })) };
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    return {
      userRules: Array.isArray(parsed.userRules) ? parsed.userRules : [],
      generated: parsed.generated && typeof parsed.generated === "object" ? parsed.generated : null,
      categories: Array.isArray(parsed.categories) && parsed.categories.length
        ? parsed.categories
        : DEFAULT_CATEGORIES.map((row) => ({ ...row })),
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

function personaFrom(store) {
  const cfg = loadConfig();
  const generated = store.generated;
  const mail = messagesForAi();
  const writingRows = [
    ...store.userRules.map((rule, index) => row("how-you-write", index, {
      id: rule.id,
      value: rule.value,
      source: "user",
    })),
    ...((generated && generated.writing) || []).map((value, index) => row("how-you-write", index, { value, source: "auto" })),
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
  if (!cfg.apiKey) {
    sections.push({
      id: "ai-setup",
      title: "AI endpoint",
      kind: "rows",
      rows: [row("ai-setup", 0, {
        label: "Not configured",
        value: "Open GenMail → AI Setup and enter an OpenAI-compatible base URL, API key, and model id.",
        source: "auto",
      })],
    });
  } else if (!generated) {
    sections.push({
      id: "recent-mail",
      title: "Recent mail",
      kind: "rows",
      rows: mail.map((message, index) => row("recent-mail", index, {
        label: message.from,
        value: `${message.subject} — ${message.snippet}`,
      })),
    });
  }
  return {
    status: "ready",
    updatedAt: (generated && generated.updatedAt) || new Date().toISOString(),
    recentActivity: null,
    profile: {
      meta: {
        ownerName: (generated && generated.ownerName) || "",
        emailsAnalyzed: generated ? generated.emailsAnalyzed || mail.length : 0,
        factsLearned: writingRows.length + learned.reduce((n, section) => n + (section.rows || []).length, 0),
        updatedAt: (generated && generated.updatedAt) || null,
      },
      sections,
    },
  };
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

async function rebuildFromMail() {
  const mail = messagesForAi(16);
  emit("emailBrain:refreshState", { refreshing: true, error: null });
  emit("emailBrain:rebuildState", { rebuilding: true, phase: "rebuilding", percent: 15, error: null });
  try {
    const text = await complete([
      {
        role: "system",
        content: [
          "You summarize a mailbox into a writing profile.",
          "Reply with JSON only, no markdown.",
          "Shape: {\"ownerName\":string,\"writing\":string[],\"sections\":[{\"id\":string,\"title\":string,\"rows\":[{\"label\":string,\"value\":string}]}]}.",
          "writing is 3 to 6 short rules about tone. sections cover identity and priorities. Do not invent private facts that are not in the mail.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify(mail),
      },
    ]);
    emit("emailBrain:rebuildState", { rebuilding: true, phase: "rebuilding", percent: 70, error: null });
    const parsed = extractJson(text);
    const store = readStore();
    store.generated = {
      ownerName: typeof parsed.ownerName === "string" ? parsed.ownerName : "You",
      writing: Array.isArray(parsed.writing) ? parsed.writing.map((item) => String(item)).filter(Boolean).slice(0, 8) : [],
      sections: Array.isArray(parsed.sections) ? parsed.sections.slice(0, 6).map((section) => ({
        id: String(section.id || "section").slice(0, 40),
        title: String(section.title || "Notes").slice(0, 80),
        rows: Array.isArray(section.rows) ? section.rows.slice(0, 8).map((item) => ({
          label: String(item.label || "").slice(0, 80),
          value: String(item.value || "").slice(0, 400),
        })) : [],
      })) : [],
      emailsAnalyzed: mail.length,
      updatedAt: new Date().toISOString(),
    };
    writeStore(store);
    emit("emailBrain:rebuildState", { rebuilding: false, phase: "ready", percent: 100, error: null });
    emit("emailBrain:refreshState", { refreshing: false, error: null });
    emit("emailBrain:updated", {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit("emailBrain:rebuildState", { rebuilding: false, phase: "failed", percent: null, error: message });
    emit("emailBrain:refreshState", { refreshing: false, error: message });
  }
}

function liveMailbox() {
  try {
    return require("./mail/db").hasAccounts() === true;
  } catch {
    return false;
  }
}

function skillById(skillId) {
  return HOME_SKILLS.find((row) => row.id === skillId) || LIBRARY_SKILLS.find((row) => row.id === skillId) || null;
}

function toneText(email) {
  const subject = email && typeof email.subject === "string" ? email.subject.trim() : "";
  const from = email && typeof email.from === "string" ? email.from.trim() : "";
  const who = from.replace(/<[^>]*>/g, "").trim();
  const hello = who ? `Hi ${who} - ` : "";
  if (subject) return `${hello}Thanks for "${subject}". I'll keep this short.`;
  return `${hello}Thanks - I'll keep this short.`;
}

function sortText() {
  const names = readStore().categories.map((row) => String(row.name || "").trim()).filter(Boolean);
  return names.length ? `New mail filed under ${names.join(", ")}.` : "New mail is filed. No categories are set.";
}

function digestText(heading) {
  const lines = messagesForAi(3).map((row) => `- ${String((row && row.subject) || "").trim() || "(no subject)"}`);
  if (!lines.length) lines.push("- Nothing new.");
  return `${heading}\n${lines.join("\n")}`;
}

// shortcut: canned sample text, upgrade when a live skill runner exists
function runSkill(params) {
  const skillId = params && typeof params.skillId === "string" ? params.skillId.trim() : "";
  if (!skillId) return fail(new Error("A skill id is required."));
  if (!skillById(skillId)) return fail(new Error("That skill is not on this host."));
  if (liveMailbox()) {
    const error = loadConfig().apiKey
      ? "This host does not run skills on a connected mailbox."
      : "Add an API key in GenMail → AI Setup.";
    return ok({ accepted: false, skillId, error });
  }
  const email = params && params.email;
  let text = "";
  if (skillId === "skill-tone") text = toneText(email);
  else if (skillId === "skill-sort") text = sortText();
  else if (skillId === "lib-follow-up") text = digestText("Still waiting");
  else if (skillId === "lib-digest") text = digestText("Overnight");
  return ok({ accepted: true, skillId, draft: skillId === "skill-tone", text });
}

function answer(channel, args) {
  const params = args && args.length ? args[0] : undefined;
  switch (channel) {
    case "emailBrain:getCached":
      return ok(snapshot());
    case "emailBrain:refresh":
    case "emailBrain:rebuild":
      if (!loadConfig().apiKey) {
        emit("emailBrain:refreshState", { refreshing: false, error: null });
        emit("emailBrain:rebuildState", { rebuilding: false, phase: "ready", percent: null, error: null });
        return ok({ accepted: false });
      }
      setImmediate(() => {
        rebuildFromMail().catch(() => {});
      });
      return ok({ accepted: true });
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
        store.generated.writing = store.generated.writing.map((text, index) => (
          `how-you-write:${index}` === itemId ? nextText : text
        ));
      }
      writeStore(store);
      emit("emailBrain:updated", {});
      return ok(snapshot());
    }
    case "emailBrain:deleteWritingRule":
    case "emailBrain:forgetItem": {
      const itemId = params && params.itemId;
      const store = readStore();
      store.userRules = store.userRules.filter((item) => item.id !== itemId);
      if (store.generated && Array.isArray(store.generated.writing)) {
        store.generated.writing = store.generated.writing.filter((_value, index) => `how-you-write:${index}` !== itemId);
      }
      if (store.generated && Array.isArray(store.generated.sections)) {
        for (const section of store.generated.sections) {
          section.rows = (section.rows || []).filter((item, index) => (item.id || `${section.id}:${index}`) !== itemId);
        }
      }
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
      return ok(HOME_SKILLS);
    case "emailBrain:getLibrarySkills":
      return ok(LIBRARY_SKILLS);
    case "emailBrain:runSkill":
      return runSkill(params);
    case "emailBrain:getAiDraftEditLog":
      return ok({ entries: [] });
    case "emailBrain:recordAiDraftEdit":
    case "emailBrain:setLearningToastSilenced":
      return ok(true);
    case "emailBrain:previewRuleMatches":
      return ok({ applied: false, samples: [] });
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
  const rule = store.userRules.find((item) => item.id === itemId);
  if (rule) {
    rule.value = value;
    return;
  }
  if (store.generated && Array.isArray(store.generated.writing)) {
    store.generated.writing = store.generated.writing.map((text, index) => (
      `how-you-write:${index}` === itemId ? value : text
    ));
  }
  if (store.generated && Array.isArray(store.generated.sections)) {
    for (const section of store.generated.sections) {
      section.rows = (section.rows || []).map((item, index) => {
        const id = item.id || `${section.id}:${index}`;
        return id === itemId ? { ...item, value } : item;
      });
    }
  }
}

async function fixItem(params) {
  try {
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
    persistItemValue(store, params && params.itemId, value);
    writeStore(store);
    emit("emailBrain:updated", {});
    return ok({ value });
  } catch (error) {
    return fail(error);
  }
}

module.exports = { answer, personaFrom, writingBrief };
