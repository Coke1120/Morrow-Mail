"use strict";

// Intercept dispatch; exercise the real diagnostic writers with synthetic data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-ipc-diagnostics-"));
  const file = path.join(dir, "ipc.log");
  const seen = [], result = { success: true, data: { body: "PRIVATE_RESPONSE_SENTINEL" } };
  const failure = new Error("PRIVATE_ERROR_SENTINEL");
  const original = Module._load;
  let createIpc;
  try {
    Module._load = function(request, parent, ...rest) {
      if (parent?.filename === require.resolve("../host/ipc")) {
        if (request === "./mail/engine") return { answer(channel, args) {
          seen.push({ channel, args });
          if (channel === "mail:searchLocal") throw failure;
          return result;
        } };
        if (["./draft-write", "./brain", "./agent", "./translate", "./settings"].includes(request)) return { answer() {} };
      }
      return original.call(this, request, parent, ...rest);
    };
    ({ createIpc } = require("../host/ipc"));
  } finally { Module._load = original; }
  try {
    const ipc = createIpc(file);
    const payload = { accountId: "PRIVATE_ACCOUNT_SENTINEL", to: ["PRIVATE_RECIPIENT@example.test"],
      cc: ["PRIVATE_CC@example.test"], bcc: ["PRIVATE_BCC@example.test"], subject: "PRIVATE_SUBJECT_SENTINEL",
      body: "PRIVATE_BODY_SENTINEL", html: "PRIVATE_HTML_SENTINEL", query: "PRIVATE_SEARCH_SENTINEL",
      password: "PRIVATE_PASSWORD_SENTINEL", accessToken: "PRIVATE_ACCESS_TOKEN_SENTINEL",
      nested: { arbitrary: "PRIVATE_UNLABELLED_CREDENTIAL_SENTINEL" }, filename: "PRIVATE_FILENAME_SENTINEL" };
    assert.equal(ipc.handle({}, "mail:send", payload), result);
    assert.equal(seen[0].args[0], payload, "diagnostics cannot rewrite dispatch data");
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!text.includes("PRIVATE_"), "no request values, response or credentials may enter IPC diagnostics");
    assert.match(text, /invoke mail:send.*argc=1/);
    ipc.handle({}, "mail:send", payload, "PRIVATE_POSITIONAL_SENTINEL");
    ipc.send({}, "mail:send", "PRIVATE_SEND_SENTINEL");
    ipc.send({}, "mail:send", payload);
    assert.equal(fs.readFileSync(file, "utf8").match(/invoke mail:send/g).length, 1);
    assert.equal(fs.readFileSync(file, "utf8").match(/send mail:send/g).length, 1);
    assert.throws(() => ipc.handle({}, "mail:searchLocal", payload), error => error === failure);
    const injected = "mail:PRIVATE_CHANNEL_SENTINEL\nBearer PRIVATE_TOKEN_SENTINEL";
    assert.equal(ipc.handle({}, injected, payload), result);
    assert.equal(seen.at(-1).channel, injected, "channel normalization is diagnostic-only");
    let inspected = 0;
    const hostile = { toJSON() { inspected++; throw new Error("PRIVATE_TOJSON_SENTINEL"); } };
    Object.defineProperty(hostile, "unknown", { enumerable: true, get() { inspected++; return "PRIVATE_GETTER_SENTINEL"; } });
    hostile.circular = hostile;
    assert.equal(ipc.handle({}, "mail:upsertDraft", hostile), result);
    assert.equal(inspected, 0, "logging must not traverse payloads, getters or toJSON");
    assert.ok(!fs.readFileSync(file, "utf8").includes("PRIVATE_"));

    const { createDiagnostics, attachRendererDiagnostics } = require("../host/ipc-diagnostics");
    const emitter = new EventEmitter(), stderr = [], support = [];
    const diagnostics = createDiagnostics(file);
    attachRendererDiagnostics(emitter, diagnostics, {
      error: text => stderr.push(text), note: (source, text) => support.push({ source, text }),
    });
    emitter.emit("console-message", {}, 2, "PRIVATE_CONSOLE_SENTINEL", 42,
      "https://example.test/PRIVATE_SOURCE_SENTINEL?token=PRIVATE_QUERY_SENTINEL");
    emitter.emit("did-fail-load", {}, -105, "PRIVATE_DESCRIPTION_SENTINEL",
      "https://example.test/PRIVATE_LOAD_SENTINEL?access_token=PRIVATE_TOKEN_SENTINEL", true);
    emitter.emit("console-message", {}, "PRIVATE_LEVEL_SENTINEL", "PRIVATE_MESSAGE_SENTINEL", "PRIVATE_LINE_SENTINEL", "PRIVATE_SOURCE_SENTINEL");
    emitter.emit("did-fail-load", {}, "PRIVATE_CODE_SENTINEL", "PRIVATE_DESCRIPTION_SENTINEL", "PRIVATE_URL_SENTINEL");
    const all = fs.readFileSync(file, "utf8") + JSON.stringify(stderr) + JSON.stringify(support);
    assert.ok(!all.includes("PRIVATE_"), "renderer free text must not leak into file, stderr or support copies");
    assert.match(all, /console.*level=2.*line=42/);
    assert.match(all, /fail-load.*code=-105/);
    assert.equal(stderr.length, 3);
    assert.equal(support.length, 1);
    const main = fs.readFileSync(require.resolve("../host/main"), "utf8");
    assert.ok(main.includes("attachRendererDiagnostics(win.webContents"));
    assert.ok(!main.includes('win.webContents.on("console-message"'));
    assert.ok(!main.includes("[fail-load]"), "load failures use the shared metadata writer; unrelated zoom listeners remain");
    assert.ok(!main.includes("fs.appendFileSync(LOG, text"));
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    console.log("ipc-diagnostics-ok (payloads, credentials, malformed channels, console/load copies; dispatch and dedup preserved)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { run };
if (require.main === module) run();
