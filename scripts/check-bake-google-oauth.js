"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const dest = path.join(root, "resources", "google-oauth.json");
const script = path.join(__dirname, "bake-google-desktop-oauth.js");
const secret = "test-desktop-secret";
const clientId = "bake-test.apps.googleusercontent.com";
const leak = "ZZBAKELEAK9f3c";

function bake(raw) {
  const env = { ...process.env };
  if (raw === undefined) delete env.GOOGLE_DESKTOP_OAUTH_JSON;
  else env.GOOGLE_DESKTOP_OAUTH_JSON = raw;
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
  };
}

function assertQuiet(result, label) {
  assert.equal(result.error, null, `${label} failed to start`);
  for (const stream of ["stdout", "stderr"]) {
    assert.equal(result[stream].includes(secret), false, `${label} ${stream} included the client secret`);
    assert.equal(result[stream].includes(clientId), false, `${label} ${stream} included the client id`);
    assert.equal(result[stream].includes(leak), false, `${label} ${stream} included the invalid payload`);
  }
}

function validJson(extra) {
  return JSON.stringify({
    installed: {
      client_id: clientId,
      client_secret: secret,
      redirect_uris: ["http://localhost"],
      ...extra,
    },
  });
}

function run() {
  const existed = fs.existsSync(dest);
  const previous = existed ? fs.readFileSync(dest) : null;
  const previousMode = existed ? fs.statSync(dest).mode & 0o777 : null;
  try {
    fs.rmSync(dest, { force: true });

    const missing = bake("");
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /not set/);
    assert.equal(fs.existsSync(dest), false);
    assertQuiet(missing, "missing");

    const unset = bake(undefined);
    assert.notEqual(unset.status, 0);
    assert.match(unset.stderr, /not set/);
    assertQuiet(unset, "unset");

    fs.writeFileSync(dest, "keep-me");
    const blank = bake("   ");
    assert.notEqual(blank.status, 0);
    assert.equal(fs.readFileSync(dest, "utf8"), "keep-me");
    assertQuiet(blank, "blank");
    fs.rmSync(dest, { force: true });

    const invalid = bake(`{"installed":${leak}`);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /not valid JSON/);
    assert.equal(fs.existsSync(dest), false);
    assertQuiet(invalid, "invalid");

    const web = bake(JSON.stringify({ web: { client_id: clientId, client_secret: secret } }));
    assert.notEqual(web.status, 0);
    assert.match(web.stderr, /Desktop/);
    assert.equal(fs.existsSync(dest), false);
    assertQuiet(web, "web");

    const both = bake(JSON.stringify({
      web: { client_id: clientId, client_secret: secret },
      installed: { client_id: clientId, client_secret: secret },
    }));
    assert.notEqual(both.status, 0);
    assert.equal(fs.existsSync(dest), false);
    assertQuiet(both, "web-and-installed");

    const flat = bake(JSON.stringify({ client_id: clientId, client_secret: secret }));
    assert.notEqual(flat.status, 0);
    assert.match(flat.stderr, /installed/);
    assert.equal(fs.existsSync(dest), false);
    assertQuiet(flat, "flat");

    const badId = bake(JSON.stringify({ installed: { client_id: `not-a-google-client-${leak}`, client_secret: secret } }));
    assert.notEqual(badId.status, 0);
    assert.match(badId.stderr, /client_id/);
    assert.equal(fs.existsSync(dest), false);
    assertQuiet(badId, "bad-id");

    const noSecret = bake(JSON.stringify({ installed: { client_id: clientId, client_secret: "  " } }));
    assert.notEqual(noSecret.status, 0);
    assert.match(noSecret.stderr, /client_secret/);
    assert.equal(fs.existsSync(dest), false);
    assertQuiet(noSecret, "no-secret");

    fs.writeFileSync(dest, "keep-me");
    const ok = bake(`\uFEFF  ${validJson()}  `);
    assert.equal(ok.status, 0, "valid Desktop JSON should be written");
    assert.match(ok.stdout, /Wrote resources\/google-oauth\.json/);
    assert.equal(ok.stderr, "");
    assertQuiet(ok, "valid");
    const text = fs.readFileSync(dest, "utf8");
    assert.equal(text.startsWith("\uFEFF"), false);
    assert.equal(text.endsWith("\n"), true);
    const written = JSON.parse(text);
    assert.equal(written.installed.client_id, clientId);
    assert.equal(written.installed.client_secret, secret);
    if (process.platform !== "win32") assert.equal(fs.statSync(dest).mode & 0o777, 0o600);
    const parsed = require("../host/mail/oauth-config").parseGoogleDesktopJson(text);
    assert.equal(parsed.clientId, clientId);
    assert.equal(parsed.clientSecret, secret);

    const release = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
    for (const job of ["windows", "macos"]) {
      const start = release.indexOf(`\n  ${job}:`);
      assert.ok(start >= 0, job);
      const rest = release.slice(start + 1);
      const next = rest.indexOf("\n  macos:");
      const body = job === "windows" ? rest.slice(0, next) : rest;
      const bakeAt = body.indexOf("node scripts/bake-google-desktop-oauth.js");
      const distAt = body.indexOf(job === "windows" ? "npm run dist:win" : "npm run dist:mac");
      assert.ok(bakeAt > 0 && distAt > bakeAt, `${job} bakes Google OAuth before dist`);
      const stepStart = body.lastIndexOf("\n      - name: Bake Google Desktop OAuth client", bakeAt);
      const stepEnd = body.indexOf("\n      - name:", bakeAt);
      const step = body.slice(stepStart, stepEnd);
      assert.match(step, /shell: bash/);
      assert.match(step, /GOOGLE_DESKTOP_OAUTH_JSON: \$\{\{ secrets\.GOOGLE_DESKTOP_OAUTH_JSON \}\}/);
      assert.match(step, /node scripts\/bake-google-desktop-oauth\.js/);
    }

    const copy = require("../package.json").build.extraResources.find((item) => item && item.from === "resources/" && item.to === ".");
    assert.ok(copy, "extraResources ships resources/ to process.resourcesPath");
    assert.deepEqual(copy.filter, ["**/*", "!**/.gitkeep"]);

    const doc = fs.readFileSync(path.join(root, "docs/OAUTH.md"), "utf8");
    assert.match(doc, /Release Actions bake the GitHub secret `GOOGLE_DESKTOP_OAUTH_JSON`/);
    assert.match(doc, /Never commit `resources\/google-oauth\.json`/);
    assert.equal(/"client_secret"\s*:/.test(doc), false);
    assert.equal(doc.includes("ya29."), false);

    const ignored = spawnSync("git", ["check-ignore", "-q", "resources/google-oauth.json"], { cwd: root });
    assert.equal(ignored.status, 0, "resources/google-oauth.json must stay gitignored");
  } finally {
    if (existed) {
      fs.writeFileSync(dest, previous, { mode: previousMode });
      fs.chmodSync(dest, previousMode);
    } else fs.rmSync(dest, { force: true });
  }
}

module.exports = { run };

if (require.main === module) run();
