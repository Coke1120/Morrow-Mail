"use strict";

const fs = require("fs");
const path = require("path");

// Only literal first-party channel names are diagnostic data. A caller cannot
// smuggle payloads into the trace by supplying a channel-shaped string.
const channels = new Set();
try {
  const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "preload.js"), "utf8");
  for (const match of source.matchAll(/"([a-zA-Z][\w-]*:[^"\n]{1,180})"/g)) channels.add(match[1]);
} catch { /* missing catalog: fail closed to the fixed unknown label */ }

function number(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function shown(value) { return value == null ? "unknown" : value; }

function createDiagnostics(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const seen = new Set();
  function write(text) {
    fs.appendFileSync(logPath, text + "\n", { mode: 0o600 });
    return text;
  }
  return {
    ipc(kind, channel, argumentCount) {
      const event = kind === "send" ? "send" : "invoke";
      const name = typeof channel === "string" && channels.has(channel) ? channel : "unknown";
      const key = event + " " + name;
      if (seen.has(key)) return;
      seen.add(key);
      write(`${key} argc=${shown(number(argumentCount, 0, 1000000))}`);
    },
    console(level, line) {
      return write(`[console] level=${shown(number(level, 0, 3))} line=${shown(number(line, 0, 10000000))}`);
    },
    loadFailure(code) {
      return write(`[fail-load] code=${shown(number(code, -65535, 65535))}`);
    },
  };
}

function attachRendererDiagnostics(webContents, diagnostics, output = {}) {
  const error = output.error || (text => console.error(text));
  const note = output.note || ((source, text) => require("./debug-log").note(source, text));
  webContents.on("console-message", (_event, level, _message, line, _sourceId) => {
    const text = diagnostics.console(level, line);
    const severity = number(level, 0, 3);
    if (severity != null && severity >= 2) {
      error(text);
      try { note("console", text); } catch { /* the file trace already has metadata */ }
    }
  });
  webContents.on("did-fail-load", (_event, code, _description, _url) => {
    error(diagnostics.loadFailure(code));
  });
}

module.exports = { createDiagnostics, attachRendererDiagnostics };
