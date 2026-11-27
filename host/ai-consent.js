const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Historical disclosure versions are used only to verify and map legacy grants.
// Change the affected scope version when that data use expands; app versions do not participate.
const VERSION = 4;
const SCOPES = Object.freeze({ core: 1, timeline: 1, case: 1, background: 1 });
const MANUAL_SCOPES = Object.freeze(["core", "timeline", "case"]);
const LEGACY_VERSIONS = new Set([1, 2, 3, 4]);
const FORMAT = "scoped-ai-use-v1";
const BACKGROUND_FORMAT = "ai-background-v1";
const unmet = steps => `${steps[0][0].toUpperCase()}${steps[0].slice(1)}${steps.length > 1 ? ` and ${steps.slice(1).join(" and ")}` : ""} in Settings → AI.`;
const error = message => Object.assign(new Error(message), { code: "ai-consent-required" });
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function createConsent({ directory = () => require("./ai-config").userDataDir(), config = () => require("./ai-config").loadConfig(),
  account = () => require("./chatgpt-auth").getAuth().status(),
  background = value => require("./chatgpt-auth").getAuth().preferences({ backgroundConsent: value }), scopeVersions = SCOPES } = {}) {
  if (Object.keys(scopeVersions).length !== Object.keys(SCOPES).length || Object.keys(SCOPES).some(key => !Number.isSafeInteger(scopeVersions[key]) || scopeVersions[key] < 1)) throw new Error("Invalid AI scope versions");
  const nonce = crypto.randomUUID();
  const active = new Set();
  let epoch = 0;
  let blocked = false;
  const location = () => path.join(directory(), "ai-consent.json");
  function read() {
    try { return JSON.parse(fs.readFileSync(location(), "utf8")) || {}; } catch { return {}; }
  }
  function write(record) {
    fs.mkdirSync(directory(), { recursive: true });
    const temporary = `${location()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, location());
  }
  function target(cfg = config(), legacyVersion = null) {
    let destination, model, registration = "", label, ready, blocker = "", connectionRevision = 0;
    if (cfg.authMode === "chatgpt") {
      const status = account();
      registration = status.activeId || "";
      connectionRevision = status.connectionRevision ?? 0;
      destination = "https://api.openai.com/v1/responses";
      model = cfg.chatgptModel || "";
      label = `OpenAI · ChatGPT · ${(status.accounts || []).find(row => row.id === registration)?.label || "no account connected"}`;
      const steps = [];
      if (status.pending) steps.push("finish connecting ChatGPT");
      else if (!status.connected) steps.push("connect ChatGPT");
      else if (!status.planEnabled) steps.push("enable ChatGPT plan usage");
      if (!model) steps.push("save a ChatGPT model");
      ready = steps.length === 0;
      if (!ready) blocker = unmet(steps);
    } else {
      const url = new URL(require("./ai-config").completionsUrl(cfg.baseUrl));
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw error("Use an HTTP(S) AI endpoint without embedded login credentials or a fragment.");
      destination = url.href;
      model = cfg.model || "";
      label = `API / custom endpoint · ${url.host}`;
      const steps = [];
      if (!cfg.apiKey) steps.push("save an API key");
      if (!model) steps.push(steps.length ? "a model" : "save a model");
      ready = steps.length === 0;
      if (!ready) blocker = unmet(steps);
    }
    const url = new URL(destination);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return { fingerprint: hash(JSON.stringify([legacyVersion ?? FORMAT, cfg.authMode || "api_key", destination, model, registration, cfg.authMode === "chatgpt" ? "" : cfg.apiKey || ""])),
      destination: `${url.origin}${url.pathname}${url.search ? " (with query parameters)" : ""}`, model, label, ready, blocker, local, connectionRevision };
  }
  function state() {
    const selected = target(), record = read();
    let automatic = false;
    if (!blocked && selected.ready && record.background === true) {
      const sameTarget = record.fingerprint === selected.fingerprint;
      const currentScopes = record.scopes?.core === scopeVersions.core && record.scopes?.background === scopeVersions.background;
      if (record.format === BACKGROUND_FORMAT || (record.format === FORMAT && record.manual === true)) {
        automatic = sameTarget && currentScopes;
      } else if (!record.format && record.manual === true && LEGACY_VERSIONS.has(record.version)) {
        automatic = scopeVersions.core === 1 && scopeVersions.background === 1 &&
          record.fingerprint === target(config(), record.version).fingerprint;
      }
    }
    const token = hash(JSON.stringify([nonce, epoch, selected.fingerprint, selected.ready, selected.connectionRevision, record.id, automatic]));
    return { selected, automatic, token };
  }
  function status() {
    const { selected, automatic, token } = state();
    const { fingerprint, connectionRevision, ...destination } = selected;
    return { ...destination, token, background: automatic,
      locality: selected.local ? "A local endpoint receives the reviewed source and may forward it according to its configuration."
        : "The selected destination receives the reviewed source directly.",
      providerTerms: "Provider handling depends on its service and settings." };
  }
  function invalidate() {
    epoch++;
    for (const controller of active) controller.abort();
  }
  function revoke() {
    invalidate();
    blocked = true;
    write({ id: crypto.randomUUID(), format: BACKGROUND_FORMAT, background: false });
    return status();
  }
  function grant(input = {}) {
    const current = state();
    if (input.token !== current.token || !current.selected.ready) {
      throw error("The saved AI connection changed. Reopen AI settings and try again.");
    }
    if (input.background !== true) throw error("Choose automatic processing in AI settings first.");
    invalidate();
    blocked = true;
    if (config().authMode === "chatgpt") background(true);
    write({ id: crypto.randomUUID(), format: BACKGROUND_FORMAT, fingerprint: current.selected.fingerprint,
      scopes: { core: scopeVersions.core, background: scopeVersions.background }, background: true });
    blocked = false;
    return status();
  }
  function acquire(cfg, { signal, background: automatic = false, stamp, scope = "core" } = {}) {
    const initial = state();
    if (!initial.selected.ready) throw error(initial.selected.blocker);
    if (automatic && !initial.automatic) {
      throw error("Background AI is off. Change Automatic processing in Settings → AI to enable it.");
    }
    if (!MANUAL_SCOPES.includes(scope) || (automatic && scope !== "core")) throw error("This AI action must be started manually.");
    if (target(cfg).fingerprint !== initial.selected.fingerprint || stamp !== initial.token) {
      throw error("The saved AI connection or request changed. Save the connection if needed and start the action again.");
    }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const check = () => {
      if (combined.aborted || state().token !== initial.token) throw error("AI request cancelled because its settings changed.");
    };
    check();
    active.add(controller);
    return { signal: combined, check, release: () => active.delete(controller) };
  }
  return { status, grant, revoke, acquire, validate: target,
    stamp() { try { return state().token; } catch { return `${nonce}:${epoch}:unavailable`; } },
    configurationChanged(before, after) {
      let previous;
      try { previous = target(before).fingerprint; } catch { /* a saved invalid endpoint must be repairable */ }
      if (previous !== target(after).fingerprint) revoke();
    },
  };
}

let instance;
module.exports = { VERSION, SCOPES, createConsent, getConsent: () => instance || (instance = createConsent()) };
