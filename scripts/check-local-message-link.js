"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { createLocalMessageLinks, parseLocalMessageLink } = require("../host/local-message-link");

const source = { accountId: "editorial@example.invalid", messageId: "canopy-approval" };
const decoy = { accountId: "design@example.invalid", messageId: "coast-approval" };
const digest = value => createHash("sha256").update(value).digest("hex");
const keyFile = "local-message-link.key";
const original = digest("editorial account / uid-validity 7 / uid 11");

function profile(t, label) {
  const base = process.env.MORROW_LINK_TEST_TMP || os.tmpdir();
  const directory = fs.mkdtempSync(path.join(base, "morrow-link-" + label + "-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function service(profileDir, readProof = () => original) {
  return createLocalMessageLinks({ profileDir, readProof });
}

test("an opaque link resolves through a new OS process with the same profile", t => {
  const dir = profile(t, "restart");
  const link = service(dir).mint(source);
  assert.match(link, /^morrow-message:\/\/open\/v1\/[\w-]+$/);
  assert.ok(!link.includes("editorial") && !link.includes("approval") && !link.includes("@"));
  assert.notEqual(link, service(dir).mint(source));
  assert.deepEqual(fs.readdirSync(dir), [keyFile]);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, keyFile)).mode & 0o777, 0o600);

  const code = [
    "const { createLocalMessageLinks } = require(process.argv[1]);",
    "const service = createLocalMessageLinks({ profileDir: process.argv[2], readProof: () => process.argv[3] });",
    "process.stdout.write(JSON.stringify(service.resolve(process.argv[4])));",
  ].join("\n");
  const child = spawnSync(process.execPath, ["-e", code, require.resolve("../host/local-message-link"), dir, original, link],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.deepEqual(JSON.parse(child.stdout), source);
});

test("invalid or tampered links never perform source lookup or create a key", t => {
  const dir = profile(t, "grammar");
  const canonical = service(profile(t, "known")).mint(source);
  let unexpectedLookups = 0;
  const reader = service(dir, () => { unexpectedLookups++; return original; });
  for (const input of [
    null, "https://example.invalid/mail", canonical + "=", canonical + "\n", canonical + "#anchor",
    canonical + "?sender=test", canonical.replace("://open/", "://name@open/"),
    canonical.replace("/v1/", "/v2/"), canonical.replace("/v1/", "/v1//"), canonical.toUpperCase(),
    canonical.slice(0, canonical.lastIndexOf("/") + 1) + "x".repeat(900),
  ]) {
    assert.equal(parseLocalMessageLink(input), null, String(input).slice(0, 80));
    assert.equal(reader.resolve(input), null);
  }
  assert.equal(reader.resolve(canonical), null);
  assert.equal(unexpectedLookups, 0);
  assert.deepEqual(fs.readdirSync(dir), []);

  const ownerDir = profile(t, "tamper");
  let lookups = 0;
  const owner = service(ownerDir, () => { lookups++; return original; });
  const link = owner.mint(source);
  const tokenAt = link.lastIndexOf("/") + 1;
  const altered = link.slice(0, tokenAt) + (link[tokenAt] === "A" ? "B" : "A") + link.slice(tokenAt + 1);
  assert.ok(parseLocalMessageLink(altered));
  assert.equal(owner.resolve(altered), null);
  assert.equal(lookups, 1);
});

test("a copied key in a second profile cannot open the same IDs", t => {
  const dir = profile(t, "first");
  const other = profile(t, "second");
  const link = service(dir).mint(source);
  fs.copyFileSync(path.join(dir, keyFile), path.join(other, keyFile));
  const wrong = service(other);
  assert.equal(wrong.resolve(link), null);
  assert.deepEqual(wrong.resolve(wrong.mint(source)), source);
  assert.deepEqual(service(dir).resolve(link), source);
});

test("changed or deleted source stays unavailable with a lookalike present", t => {
  const dir = profile(t, "identity");
  const exact = new Map([[source.messageId, original], [decoy.messageId, digest("decoy")]]);
  const calls = [];
  const links = service(dir, target => { calls.push(target); return exact.get(target.messageId); });
  const link = links.mint(source);
  assert.deepEqual(links.resolve(link), source);
  exact.set(source.messageId, digest("editorial account / uid-validity 8 / uid 11"));
  assert.equal(links.resolve(link), null);
  exact.delete(source.messageId);
  assert.equal(links.resolve(link), null);
  assert.equal(links.mint(source), null);
  assert.equal(calls.length, 5);
  assert.ok(calls.every(value => value.accountId === source.accountId && value.messageId === source.messageId));
});

test("missing proof or a corrupt existing key cannot produce a new reference", t => {
  const dir = profile(t, "key");
  assert.equal(service(dir, () => "").mint(source), null);
  assert.equal(service(dir, async () => { throw new Error("Non-synchronous proof"); }).mint(source), null);
  assert.equal(service(dir).mint(null), null);
  assert.equal(service(dir).mint({ ...source, messageId: "a\u0000b" }), null);
  assert.deepEqual(fs.readdirSync(dir), []);
  const badKey = path.join(dir, keyFile);
  const badBytes = Buffer.from("incomplete");
  fs.writeFileSync(badKey, badBytes, { mode: 0o600 });
  assert.equal(service(dir).mint(source), null);
  assert.deepEqual(fs.readFileSync(badKey), badBytes);
  const unsupported = profile(t, "unsupported");
  t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("Hard links unavailable"), { code: "ENOTSUP" }); });
  assert.throws(() => service(unsupported).mint(source), { code: "local-message-link-storage" });
  assert.deepEqual(fs.readdirSync(unsupported), []);
});
