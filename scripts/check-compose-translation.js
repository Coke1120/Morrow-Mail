"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { test } = require("node:test");
const { createComposeTranslation } = require("../host/compose-translation");
const { createConsent } = require("../host/ai-consent");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-compose-translate-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let cfg = { authMode: "api_key", baseUrl: "https://synthetic.invalid/v1", model: "synthetic-model", apiKey: "not-a-real-key" };
  const consent = createConsent({ directory: () => directory, config: () => cfg });
  const owner = {}, others = {}, calls = [];
  let finish, permit = true, now = 1000;
  const service = createComposeTranslation({
    now: () => now, reviewTime: 2000, status: consent.status,
    async complete(messages, { consentStamp, signal }) {
      const lease = consent.acquire(cfg, { stamp: consentStamp, signal });
      try {
        lease.check();
        calls.push({ messages, signal: lease.signal });
        const output = await new Promise(resolve => { finish = resolve; });
        lease.check();
        return output;
      } finally { lease.release(); }
    },
  });
  const whenCalled = async () => { for (let i = 0; i < 10 && !finish; i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(finish); };
  return {
    calls, owner, others, service, consent,
    review: (text, source = "en", target = "de", extra = {}) => service.answer(owner, { action: "prepare", text, source, target, ...extra }),
    invoke: (action, token, which = owner) => service.answer(which, { action, token }, async () => permit),
    later: () => { now += 2001; }, switch: () => { const before = cfg; cfg = { ...cfg, model: "other-model" }; consent.configurationChanged(before, cfg); },
    setCurrent(value) { permit = value; }, whenCalled, finish: output => finish(output),
  };
}

const text = "Enter at 17:30 with ref AB-0146.";

test("preparation is local, exact selection only, manual lease and one-time confirmation", async t => {
  const f = fixture(t);
  const review = await f.review(text, "en", "de", { recipient: "private@example.invalid", subject: "private subject", quote: "private history" });
  assert.equal(review.ok, true);
  assert.match(review.destination, /synthetic\.invalid/);
  assert.equal(review.model, "synthetic-model");
  assert.equal(f.calls.length, 0);
  assert.equal((await f.invoke("translate", review.token, f.others)).ok, false);
  assert.equal((await f.invoke("validate", review.token)).ok, false);
  const run = f.invoke("translate", review.token);
  assert.equal((await f.invoke("translate", review.token)).ok, false);
  await f.whenCalled();
  const { messages } = f.calls[0];
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content, text);
  assert.match(messages[0].content, /English into German/);
  assert.doesNotMatch(JSON.stringify(messages), /private|synthetic-model|not-a-real-key/);
  f.finish("Einlass um 17:30 mit Referenz AB-0146.");
  assert.match((await run).text, /Einlass/);
  assert.equal((await f.invoke("validate", review.token)).ok, true);
  assert.equal((await f.invoke("validate", review.token)).ok, false);
  assert.equal(f.calls.length, 1);
});

for (const name of ["wrong-selection", "changed-connection", "expired"]) test(`rejects ${name} before sending`, async t => {
  const f = fixture(t), review = await f.review(text);
  if (name === "wrong-selection") f.setCurrent(false);
  if (name === "changed-connection") f.switch();
  if (name === "expired") f.later();
  assert.equal((await f.invoke("translate", review.token)).ok, false);
  assert.equal(f.calls.length, 0);
});

for (const name of ["cancel", "model", "account/selection", "window"]) test(`discards pending output on ${name} change`, async t => {
  const f = fixture(t), review = await f.review(text);
  const run = f.invoke("translate", review.token);
  await f.whenCalled();
  if (name === "cancel") await f.invoke("cancel", review.token);
  if (name === "model") f.switch();
  if (name === "account/selection") f.setCurrent(false);
  if (name === "window") f.service.dispose(f.owner);
  assert.equal(f.calls[0].signal.aborted, name !== "account/selection");
  f.finish("test output");
  assert.equal((await run).ok, false);
  assert.equal((await f.invoke("validate", review.token)).ok, false);
});

test("saved destination and selection must still match at replacement, even after translated output", async t => {
  const f = fixture(t), review = await f.review(text, "en", "fr");
  const run = f.invoke("translate", review.token);
  await f.whenCalled();
  f.finish("test output");
  assert.equal((await run).ok, true);
  f.switch();
  assert.equal((await f.invoke("validate", review.token)).ok, false);
});

test("unusable selections never start a model", async t => {
  const f = fixture(t);
  for (const [source, from, to] of [["", "en", "de"], ["a".repeat(3001), "en", "de"], ["a", "en", "en"], ["a", "en", "invalid"]]) {
    assert.equal((await f.review(source, from, to)).ok, false);
  }
  assert.equal(f.calls.length, 0);
});
