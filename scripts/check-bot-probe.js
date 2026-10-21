// Offline checks for the Tailscale address probe and grant deletion.
// No live network, no Tailscale process, and no provider calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MORROW_ERROR = {
  apiVersion: "1.0",
  requestId: null,
  installationId: null,
  ok: false,
  error: { code: "INVALID_REQUEST", message: "The request is not valid.", retryable: false },
  meta: { observedAt: "2026-10-20T00:00:00.000Z", source: "host" },
};

function html(title, body) {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function run() {
  const probe = require("../host/bot/probe");
  const catalog = require("../host/bot/catalog");
  const source = fs.readFileSync(require.resolve("../host/bot/probe.js"), "utf8");
  const app = fs.readFileSync(require.resolve("../renderer/app.js"), "utf8");
  assert.match(app, /tailscale serve --bg --https=\$\{port\} --accept-app-caps=com\.coke1120\.morrow-mail\/bot-access http:\/\/127\.0\.0\.1:47831/);
  assert.doesNotMatch(app, /child_process|execFile\(|spawn\(/);
  const manage = fs.readFileSync(require.resolve("../host/bot/manage.js"), "utf8");
  assert.match(manage, /bot:probeServe/);
  assert.match(manage, /bot:deleteGrant/);
  assert.match(manage, /probe\.probeServeHost\(auth\.serveHost\(\)\)/);
  assert.doesNotMatch(manage, /probeServeHost\(payload/);
  assert.equal(source.includes("child_process"), false);
  assert.equal(source.includes("spawn"), false);
  assert.equal(source.includes("execFile"), false);
  assert.equal(source.includes("tailscale"), false, "the probe must not run or embed a Tailscale command");

  const morrow = probe.classifyProbeResponse({
    statusCode: 405,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(MORROW_ERROR),
  });
  assert.equal(morrow.state, "morrow");
  assert.equal(morrow.statusCode, 405);
  assert.doesNotMatch(morrow.snippet, /configured|connected/i);

  const phase = probe.classifyProbeResponse({
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: html("Phase", "Open Source app"),
  });
  assert.equal(phase.state, "foreign");
  assert.match(phase.snippet, /HTTP 200/);
  assert.match(phase.snippet, /Phase/);
  assert.doesNotMatch(phase.snippet, /Open Source app/);

  const secretTitle = probe.classifyProbeResponse({
    statusCode: 200,
    headers: { "content-type": "text/html" },
    body: html("Bearer mmb_v1_abcdefgh.abcdefghijklmnopqrstuvwxyz0123456789AB", "nope"),
  });
  assert.equal(secretTitle.state, "foreign");
  assert.equal(secretTitle.snippet, "HTTP 200");
  assert.doesNotMatch(secretTitle.snippet, /mmb_v1_|Bearer/i);

  const gateway = probe.classifyProbeResponse({
    statusCode: 502,
    headers: { "content-type": "text/html" },
    body: html("502 Bad Gateway", "bad gateway"),
  });
  assert.equal(gateway.state, "not_checked");
  assert.equal(gateway.reason, "inconclusive");

  const otherJson = probe.classifyProbeResponse({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, app: "phase" }),
  });
  assert.equal(otherJson.state, "foreign");
  assert.equal(otherJson.snippet, "HTTP 200");
  assert.doesNotMatch(JSON.stringify(otherJson), /phase/);

  const command = catalog.serveCommands("leos-macbook-air.tail48056.ts.net:9443");
  assert.equal(command.port, 9443);
  assert.equal(command.status, "tailscale serve status");
  assert.equal(
    command.serve,
    "tailscale serve --bg --https=9443 --accept-app-caps=com.coke1120.morrow-mail/bot-access http://127.0.0.1:47831",
  );
  assert.equal(catalog.serveCommands("name.ts.net").port, 8443);
  assert.match(catalog.serveCommands("").serve, /--https=8443 /);

  let calls = 0;
  return probe.probeServeHost("app.example.ts.net:8443", {
    request(url, options) {
      calls += 1;
      assert.equal(url.protocol, "https:");
      assert.equal(url.hostname, "app.example.ts.net");
      assert.equal(url.port, "8443");
      assert.equal(url.pathname, "/api/bot/v1/call");
      assert.equal(url.search, "");
      assert.equal(options.method, "GET");
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.headers.authorization, undefined);
      assert.equal(options.headers.Authorization, undefined);
      return {
        okTransport: true,
        statusCode: 302,
        headers: { location: "https://other.example/secret?token=mmb_v1_abcdefghijklmnopqrst" },
        body: "",
      };
    },
  }).then(async (redirected) => {
    assert.equal(calls, 1, "redirects are not followed");
    assert.equal(redirected.state, "foreign");
    assert.match(redirected.snippet, /HTTP 302/);
    assert.doesNotMatch(JSON.stringify(redirected), /mmb_v1_|token=/);
    assert.match(redirected.commands.serve, /--https=8443 /);

    const foreign = await probe.probeServeHost("app.example.ts.net", {
      request() {
        return {
          okTransport: true,
          statusCode: 200,
          headers: { "content-type": "text/html" },
          body: html("Phase", "Open Source"),
        };
      },
    });
    assert.equal(foreign.state, "foreign");
    assert.match(foreign.snippet, /Phase/);
    assert.match(foreign.commands.serve, /--https=8443 /);
    assert.equal(foreign.commands.status, "tailscale serve status");

    const matched = await probe.probeServeHost("app.example.ts.net:8443", {
      request() {
        return {
          okTransport: true,
          statusCode: 405,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(MORROW_ERROR),
        };
      },
    });
    assert.equal(matched.state, "morrow");
    assert.doesNotMatch(JSON.stringify(matched), /configured Tailscale|Serve is configured/i);

    let unsafeCalls = 0;
    const unsafe = await probe.probeServeHost("127.0.0.1:8443", {
      request() { unsafeCalls += 1; return { okTransport: false, reason: "unreachable" }; },
    });
    assert.equal(unsafeCalls, 0);
    assert.equal(unsafe.state, "not_checked");
    assert.equal(unsafe.reason, "unsafe");

    const missing = await probe.probeServeHost("", {
      request() { throw new Error("should not request"); },
    });
    assert.equal(missing.state, "not_checked");
    assert.equal(missing.reason, "no_host");

    const timedOut = await probe.probeServeHost("app.example.ts.net:8443", {
      request() { return { okTransport: false, reason: "timeout" }; },
    });
    assert.equal(timedOut.state, "not_checked");
    assert.equal(timedOut.reason, "timeout");

    await checkDelete();
    console.log("bot-probe-ok");
  });
}

async function checkDelete() {
  const auth = require("../host/bot/auth");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-bot-delete-"));
  const previous = process.env.MORROW_USER_DATA;
  process.env.MORROW_USER_DATA = dir;
  const installationId = "6c2e1a40-1111-4222-8333-444455556666";
  const keepId = "11111111-1111-4111-8111-111111111111";
  const dropId = "22222222-2222-4222-8222-222222222222";
  const verifier = "a".repeat(64);
  const grant = (clientId, label) => ({
    clientId,
    label,
    keyId: clientId === keepId ? "keepkey12" : "dropkey12",
    verifier,
    accountIds: ["acct-a"],
    capabilities: ["accounts.read", "mail.headers.read"],
    installationId,
    createdAt: "2026-10-20T00:00:00.000Z",
    expiry: { kind: "finite", expiresAt: "2099-01-01T00:00:00.000Z" },
    revokedAt: null,
    revision: 1,
    lastUsedAt: null,
    bytesDay: "2026-10-20",
    bytesToday: 0,
    draftsDay: "2026-10-20",
    draftsToday: 0,
  });
  fs.writeFileSync(path.join(dir, "bot-access.json"), JSON.stringify({
    version: 2,
    enabled: true,
    installationId,
    serveHost: "app.example.ts.net:8443",
    grants: [grant(keepId, "Keep"), grant(dropId, "Drop")],
  }));
  try {
    const removed = auth.removeGrant(dropId);
    assert.equal(removed.grants.some((row) => row.clientId === dropId), false);
    assert.equal(removed.grants.some((row) => row.clientId === keepId), true);
    assert.equal(removed.enabled, true);
    assert.equal(removed.serveHost, "app.example.ts.net:8443");
    const stored = fs.readFileSync(path.join(dir, "bot-access.json"), "utf8");
    assert.equal(stored.includes(dropId), false);
    assert.equal(stored.includes("dropkey12"), false);
    assert.equal(stored.includes(keepId), true);
    assert.throws(() => auth.removeGrant(dropId), /not on this installation/);
    const revoked = auth.revoke(keepId);
    assert.equal(typeof revoked.revokedAt, "string");
    const afterRevoke = auth.removeGrant(keepId);
    assert.equal(afterRevoke.grants.length, 0);
  } finally {
    if (previous === undefined) delete process.env.MORROW_USER_DATA;
    else process.env.MORROW_USER_DATA = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };
if (require.main === module) {
  Promise.resolve(run()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
