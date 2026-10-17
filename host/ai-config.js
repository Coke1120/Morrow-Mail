const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULTS = {
  baseUrl: "https://api.x.ai/v1",
  model: "grok-4.7",
  apiKey: "",
};

function userDataDir() {
  const override = (process.env.GENMAIL_AI_CONFIG_DIR || "").trim();
  if (override) return override;
  return require("./paths").userDataDir("genmail-exact");
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
    };
  } catch {
    return {};
  }
}

function fromEnv() {
  return {
    baseUrl: (process.env.GENMAIL_AI_BASE_URL || "").trim(),
    model: (process.env.GENMAIL_AI_MODEL || "").trim(),
    apiKey: (process.env.GENMAIL_AI_API_KEY || process.env.XAI_API_KEY || "").trim(),
  };
}

function loadConfig() {
  const file = readFileConfig();
  const env = fromEnv();
  return {
    baseUrl: env.baseUrl || file.baseUrl || DEFAULTS.baseUrl,
    model: env.model || file.model || DEFAULTS.model,
    apiKey: env.apiKey || file.apiKey || "",
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
  };
}

function saveConfig(input) {
  const current = readFileConfig();
  const next = {
    baseUrl: (input && input.baseUrl ? String(input.baseUrl) : current.baseUrl || DEFAULTS.baseUrl).trim(),
    model: (input && input.model ? String(input.model) : current.model || DEFAULTS.model).trim(),
    apiKey: input && typeof input.apiKey === "string" && input.apiKey.trim()
      ? input.apiKey.trim()
      : current.apiKey || "",
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
