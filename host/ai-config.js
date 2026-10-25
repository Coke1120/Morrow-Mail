const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULTS = {
  baseUrl: "https://api.x.ai/v1",
  model: "grok-4.7",
  apiKey: "",
};

function userDataDir() {
  const override = (process.env.MORROW_AI_CONFIG_DIR || "").trim();
  if (override) return override;
  return require("./paths").userDataDir();
}

function configPath() {
  return path.join(userDataDir(), "ai.json");
}

function readFileConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl.trim() : "",
      model: typeof parsed.model === "string" ? parsed.model.trim() : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
      authMode: parsed.authMode === "chatgpt" ? "chatgpt" : "api_key",
      chatgptModel: typeof parsed.chatgptModel === "string" ? parsed.chatgptModel.trim() : "",
    };
  } catch {
    return {};
  }
}

function fromEnv() {
  return {
    baseUrl: (process.env.MORROW_AI_BASE_URL || "").trim(),
    model: (process.env.MORROW_AI_MODEL || "").trim(),
    apiKey: (process.env.MORROW_AI_API_KEY || process.env.XAI_API_KEY || "").trim(),
  };
}

function loadConfig() {
  const file = readFileConfig();
  const env = fromEnv();
  return {
    baseUrl: env.baseUrl || file.baseUrl || DEFAULTS.baseUrl,
    model: env.model || file.model || DEFAULTS.model,
    apiKey: env.apiKey || file.apiKey || "",
    authMode: file.authMode || "api_key",
    chatgptModel: file.chatgptModel || "",
  };
}

function publicConfig() {
  const cfg = loadConfig();
  const key = cfg.apiKey;
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasKey: key.length > 0,
    keyHint: key.length > 4 ? `••••${key.slice(-4)}` : key ? "••••" : "",
    authMode: cfg.authMode,
    chatgptModel: cfg.chatgptModel,
  };
}

function saveConfig(input) {
  if (input?.authMode !== undefined && !["api_key", "chatgpt"].includes(input.authMode)) throw new Error("Choose API key or ChatGPT authentication.");
  const current = readFileConfig();
  const next = {
    baseUrl: (input && input.baseUrl ? String(input.baseUrl) : current.baseUrl || DEFAULTS.baseUrl).trim(),
    model: (input && input.model ? String(input.model) : current.model || DEFAULTS.model).trim(),
    apiKey: input && typeof input.apiKey === "string" && input.apiKey.trim()
      ? input.apiKey.trim()
      : current.apiKey || "",
    authMode: input?.authMode || current.authMode || "api_key",
    chatgptModel: typeof input?.chatgptModel === "string" ? input.chatgptModel.trim() : current.chatgptModel || "",
  };
  if (!next.baseUrl) throw new Error("Base URL is required");
  if (!next.model) throw new Error("Model id is required");
  const dir = userDataDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = configPath();
  fs.writeFileSync(dest, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    // Some volumes ignore chmod. The file is still outside the renderer.
  }
  if (next.authMode !== (current.authMode || "api_key") || next.chatgptModel !== (current.chatgptModel || "")) {
    require("./chatgpt-auth").getAuth().invalidateRequests();
  }
  return publicConfig();
}

function completionsUrl(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

function modelsUrl(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/models$/.test(base)) return base;
  return `${base}/models`;
}

module.exports = {
  DEFAULTS,
  loadConfig,
  publicConfig,
  saveConfig,
  completionsUrl,
  modelsUrl,
  configPath,
  userDataDir,
};
