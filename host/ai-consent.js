const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Bump this when the disclosed data categories, purposes or destinations change.
const VERSION = 1;
const DISCLOSURE = "AI can send mail sender addresses, subjects, dates, snippets and message metadata; selected message text and quoted history; draft text, signatures, selections and instructions; Brain profile, identity, categories and writing rules; Agent notes and recent conversation; and, for calendar-enabled skills and Agent questions, event titles, times and locations. It uses the context needed for translation, reply suggestions, writing, profile learning, triage, skills and answers. Attachment files are not included by these AI paths. Mail search, cached reading and ordinary mail/calendar operations do not use the AI provider.";
const BACKGROUND = "Separately allow automatic Brain profile refresh, triage when Agent opens, reply suggestions when a reply composition opens, and saved scheduled skills while Morrow Mail is open. These can send the same relevant context without another AI button press. Opening Brain may refresh a stale profile. With background permission off, use explicit AI actions instead.";
const error = message => Object.assign(new Error(message), { code: "ai-consent-required" });
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function createConsent({ directory = () => require("./ai-config").userDataDir(), config = () => require("./ai-config").loadConfig(),
  account = () => require("./chatgpt-auth").getAuth().status(),
  background = value => require("./chatgpt-auth").getAuth().preferences({ backgroundConsent: value }) } = {}) {
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
  function target(cfg = config()) {
    let destination, model, registration = "", label, ready;
    if (cfg.authMode === "chatgpt") {
      const status = account();
      registration = status.activeId || "";
      destination = "https://api.openai.com/v1/responses";
      model = cfg.chatgptModel || "";
      label = `OpenAI · ChatGPT · ${(status.accounts || []).find(row => row.id === registration)?.label || "no account connected"}`;
      ready = !!status.connected && !!status.planEnabled && !!model;
    } else {
      const url = new URL(require("./ai-config").completionsUrl(cfg.baseUrl));
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw error("Use an HTTP(S) AI endpoint without embedded login credentials or a fragment.");
      destination = url.href;
      model = cfg.model || "";
      label = `API / custom endpoint · ${url.host}`;
      ready = !!cfg.apiKey && !!model;
    }
    const url = new URL(destination);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return { fingerprint: hash(JSON.stringify([VERSION, cfg.authMode || "api_key", destination, model, registration, cfg.authMode === "chatgpt" ? "" : cfg.apiKey || ""])),
      destination: `${url.origin}${url.pathname}${url.search ? " (with query parameters)" : ""}`, model, label, ready, local };
  }
  function state() {
    const selected = target(), record = read();
    const manual = !blocked && selected.ready && record.version === VERSION && record.fingerprint === selected.fingerprint && record.manual === true;
    const token = hash(JSON.stringify([nonce, epoch, selected.fingerprint, record.id]));
    return { selected, record, manual, token };
  }
  function status() {
    const { selected, record, manual, token } = state();
    const { fingerprint, ...destination } = selected;
    return { ...destination, token, version: VERSION, manual, background: manual && record.background === true,
      disclosure: DISCLOSURE, backgroundDisclosure: BACKGROUND,
      locality: selected.local ? "This endpoint is a service on this computer. It receives AI context and may forward it according to its own configuration; Morrow cannot verify that it stays local."
        : "Remote AI: context leaves this computer and goes directly to the selected destination. The mail cache and ordinary local operations remain on this computer.",
      providerTerms: "Provider retention and training depend on its service, settings and your agreement. Morrow does not verify those terms. ChatGPT requests set store: false; this is not a guarantee of no retention or training.",
    };
  }
  function invalidate() {
    epoch++;
    for (const controller of active) controller.abort();
  }
  function revoke() {
    invalidate();
    blocked = true; // a failed disk write must still stop this process
    write({ id: crypto.randomUUID(), version: VERSION, manual: false, background: false });
    return status();
  }
  function grant(input = {}) {
    const current = state();
    if (input.token !== current.token || !current.selected.ready) throw error("AI destination, account or permission changed. Review the saved connection again.");
    if (input.manual !== true || typeof input.background !== "boolean") throw error("Affirmatively allow AI data use after reviewing the disclosure.");
    invalidate();
    blocked = true;
    if (config().authMode === "chatgpt") background(input.background);
    write({ id: crypto.randomUUID(), version: VERSION, fingerprint: current.selected.fingerprint, manual: true,
      background: input.background, grantedAt: new Date().toISOString() });
    blocked = false;
    return status();
  }
  function acquire(cfg, { signal, background: automatic = false, stamp } = {}) {
    const initial = state();
    if (!initial.manual || (automatic && initial.record.background !== true)) throw error(automatic
      ? "Background AI is off. Review and separately allow it in Settings → AI → AI data permission."
      : "AI data use is off. Review the destination and allow it in Settings → AI → AI data permission. Saving a key or signing in does not grant permission.");
    if (target(cfg).fingerprint !== initial.selected.fingerprint || (stamp && stamp !== initial.token)) throw error("AI settings or permission changed. Start the action again after reviewing AI data permission.");
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const check = () => {
      if (combined.aborted || state().token !== initial.token || !state().manual) throw error("AI request cancelled because its permission or destination changed.");
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
module.exports = { VERSION, DISCLOSURE, BACKGROUND, createConsent, getConsent: () => instance || (instance = createConsent()) };
