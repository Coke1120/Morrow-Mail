const { loadConfig, completionsUrl, modelsUrl } = require("./ai-config");

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    const error = new Error("Add an API key in GenMail → AI Setup.");
    error.code = "ai-unconfigured";
    throw error;
  }
  return cfg;
}

async function readError(response) {
  const text = await response.text().catch(() => "");
  return text.replace(/\s+/g, " ").slice(0, 280) || `HTTP ${response.status}`;
}

function messageText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      return "";
    }).join("");
  }
  return "";
}

function deltaText(delta) {
  if (!delta) return "";
  const content = messageText(delta);
  if (content) return content;
  return typeof delta.text === "string" ? delta.text : "";
}

async function complete(messages, options = {}) {
  const cfg = requireConfig();
  const response = await fetch(completionsUrl(cfg.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: options.temperature ?? 0.4,
      stream: false,
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  const payload = await response.json();
  const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
  return messageText(message);
}

async function readSse(messages, onChunk, options) {
  const cfg = requireConfig();
  const response = await fetch(completionsUrl(cfg.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: options.temperature ?? 0.4,
      stream: true,
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  if (!response.body) throw new Error("The model returned an empty stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    buffer += decoder.decode(step.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
      const piece = deltaText(delta);
      if (piece) onChunk(piece);
    }
  }
}

async function stream(messages, onChunk, options = {}) {
  let count = 0;
  const forward = (piece) => {
    count += 1;
    onChunk(piece);
  };
  try {
    await readSse(messages, forward, options);
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error;
    if (count > 0) throw error;
    const text = await complete(messages, options);
    if (text) onChunk(text);
    return;
  }
  if (count === 0 && !(options.signal && options.signal.aborted)) {
    const text = await complete(messages, options);
    if (text) onChunk(text);
  }
}

function modelIds(payload) {
  const rows = payload && Array.isArray(payload.data) ? payload.data : [];
  const ids = [];
  for (const row of rows) {
    const id = row && typeof row.id === "string" ? row.id.trim() : "";
    if (!id || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

async function listModels(input) {
  const saved = loadConfig();
  const draft = input && typeof input === "object" ? input : {};
  const baseUrl = typeof draft.baseUrl === "string" && draft.baseUrl.trim()
    ? draft.baseUrl.trim()
    : saved.baseUrl;
  const apiKey = typeof draft.apiKey === "string" && draft.apiKey.trim()
    ? draft.apiKey.trim()
    : saved.apiKey;
  if (!apiKey) return { ok: false, message: "Add an API key in GenMail → AI Setup." };
  if (!baseUrl) return { ok: false, message: "Base URL is required" };
  let response;
  try {
    response = await fetch(modelsUrl(baseUrl), {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) return { ok: false, message: await readError(response) };
  try {
    return { ok: true, models: modelIds(await response.json()) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    const arrayStart = raw.indexOf("[");
    const arrayEnd = raw.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(raw.slice(arrayStart, arrayEnd + 1));
    }
    throw new Error("The model did not return JSON");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

module.exports = { complete, stream, extractJson, requireConfig, listModels, modelIds };
