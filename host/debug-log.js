const MAX = 200;
const rows = [];

function redactDebugText(text) {
  return String(text || "")
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(/\b(access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|authorization)\b\s*[:=]\s*\S+/gi, "$1 [redacted]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function note(source, text) {
  const line = redactDebugText(text);
  if (!line) return;
  rows.push({
    at: Date.now(),
    source: String(source || "host").slice(0, 40),
    text: line,
  });
  if (rows.length > MAX) rows.splice(0, rows.length - MAX);
}

function recent(limit) {
  const n = Math.max(1, Math.min(Number(limit) || MAX, MAX));
  return rows.slice(-n);
}

function answer(channel, args) {
  if (channel !== "host:getDebugLog") return undefined;
  const params = args && args[0];
  return { success: true, data: { lines: recent(params && params.limit) } };
}

module.exports = { note, recent, answer, redactDebugText };
