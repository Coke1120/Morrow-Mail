"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");
const { MAX_RESPONSE_BYTES } = require("../host/bot/constants");

// Execute the actual CLI with synthetic credentials and intercepted transports.
// The bridge suite separately exercises its real loopback HTTP transport.
function invoke(endpoint, scenario = {}) {
  const script = path.join(__dirname, "morrow-bot-call.js");
  const token = "synthetic-client-token";
  const result = { status: null, stdout: "", stderr: "", requests: [], tokenReads: 0 };
  const argv = scenario.argv || ["--endpoint", endpoint, "--token-file", "/synthetic-token",
    "--installation", "synthetic-installation", "--operation", "bridge.describe"];
  const exited = {};
  let deadline;
  function transport(protocol) {
    return {
      request(options, callback) {
        result.requests.push({ protocol, options });
        const req = new EventEmitter();
        req.destroy = (error) => { if (error) req.emit("error", error); };
        req.end = (body) => {
          if (scenario.timeout) {
            assert.ok(deadline, "the call needs an overall deadline");
            deadline();
            return;
          }
          const request = JSON.parse(body);
          result.requests.at(-1).body = request;
          assert.strictEqual(options.headers.authorization, `Bearer ${token}`);
          const res = new EventEmitter();
          res.statusCode = scenario.status || 200;
          res.headers = { "content-type": "application/json" };
          res.destroy = () => {};
          callback(res);
          const envelope = {
            apiVersion: "1.0", requestId: request.requestId,
            installationId: request.installationId, ok: true, data: {},
          };
          const text = scenario.raw == null ? JSON.stringify(envelope) : scenario.raw;
          res.emit("data", Buffer.from(text));
          res.emit("end");
        };
        return req;
      },
    };
  }
  const context = {
    Buffer, URL,
    setTimeout(fn, ms) {
      assert.strictEqual(ms, argv[argv.indexOf("--operation") + 1] === "mail.send" ? 30000 : 5000);
      deadline = fn;
      return { unref() {} };
    },
    clearTimeout() {},
    require(id) {
      if (id === "http" || id === "https") return transport(id);
      if (id === "fs") return {
        readFileSync(file) {
          if (file === "/synthetic-params") return JSON.stringify(scenario.params || {});
          assert.strictEqual(file, "/synthetic-token");
          result.tokenReads += 1;
          return `${token}\n`;
        },
      };
      return require(id);
    },
    process: {
      argv: ["node", script, ...argv],
      stdout: { write(text) { result.stdout += text; } },
      stderr: { write(text) { result.stderr += text; } },
      exit(status) { result.status = status; throw exited; },
    },
  };
  try { vm.runInNewContext(fs.readFileSync(script, "utf8"), context, { filename: script }); }
  catch (error) { if (error !== exited) throw error; }
  assert.ok(!result.stdout.includes(token));
  assert.ok(!result.stderr.includes(token));
  return result;
}

function run() {
  const api = "/api/bot/v1/call";
  const secure = invoke(`https://mba.tailnet.ts.net:8443${api}`);
  assert.strictEqual(secure.status, 0, secure.stderr);
  assert.strictEqual(secure.requests[0].protocol, "https");
  assert.strictEqual(secure.requests[0].options.hostname, "mba.tailnet.ts.net");
  assert.strictEqual(Number(secure.requests[0].options.port), 8443);
  assert.notStrictEqual(secure.requests[0].options.rejectUnauthorized, false);
  assert.strictEqual(invoke(`https://mba.tailnet.ts.net${api}`).requests[0].options.port, 443);
  const local = invoke(`http://127.0.0.1:47831${api}`);
  assert.strictEqual(local.status, 0, local.stderr);
  assert.strictEqual(local.requests[0].protocol, "http");
  for (const endpoint of [
    `http://mba.tailnet.ts.net:8443${api}`, `http://192.0.2.1${api}`,
    `http://localhost:47831${api}`, `https://user:pass@mba.tailnet.ts.net${api}`,
    `https://mba.tailnet.ts.net${api}?token=no`, `https://mba.tailnet.ts.net${api}#other`,
  ]) {
    const denied = invoke(endpoint);
    assert.strictEqual(denied.status, 2, endpoint);
    assert.strictEqual(denied.requests.length, 0, endpoint);
    assert.strictEqual(denied.tokenReads, 0, "invalid endpoints must be rejected before loading credentials");
  }
  for (const scenario of [
    { timeout: true }, { status: 302 }, { raw: "<html>proxy failure</html>" },
    { raw: "x".repeat(MAX_RESPONSE_BYTES + 1) },
  ]) {
    const failed = invoke(`https://mba.tailnet.ts.net${api}`, scenario);
    assert.strictEqual(failed.status, 1);
    assert.strictEqual(failed.stdout, "", "transport failures must not print raw proxy content");
    assert.strictEqual(failed.requests.length, 1, "the client must not follow redirects or retry writes");
  }
  console.log("bot-client-ok");
}

module.exports = { run, invoke };
