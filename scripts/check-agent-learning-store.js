const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-learning-store-"));
  const previous = process.env.MORROW_AI_CONFIG_DIR;
  process.env.MORROW_AI_CONFIG_DIR = directory;
  const learning = require("../host/agent-learning");
  const file = learning.storePath();
  const item = { messageId: "synthetic", from: "sender@example.test", threadId: "synthetic-thread" };
  const observe = (begunAt) => learning.observe({ kind: "action", action: "reply", begunAt, items: [item] });
  const sender = (view) => view.patterns.find((row) => row.match.scope === "sender");
  const reset = () => fs.writeFileSync(file, JSON.stringify({ version: 1, patterns: [], revoked: {} }));
  try {
    assert.equal(sender(observe(1)).count, 1);
    assert.equal(sender(observe(3)).count, 2);
    assert.equal(sender(observe(1)).count, 2);
    assert.equal(sender(learning.list()).learned, false);
    assert.equal(sender(observe(2)).count, 3);
    assert.equal(sender(observe(3)).count, 3);
    const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const row of legacy.patterns) delete row.begunAts;
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.equal(sender(observe(3)).count, 3);
    for (let begunAt = 4; begunAt < 270; begunAt++) observe(begunAt);
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).patterns.every((row) => row.begunAts.length <= 256));
    const beforeRetry = sender(learning.list()).count;
    assert.equal(sender(observe(268)).count, beforeRetry);

    for (const label of ["审阅建议".repeat(10), "审阅% /🧵".repeat(8)]) {
      reset();
      for (const begunAt of [10, 11, 12]) learning.observe({ kind: "suggestion", choice: "dismiss", className: label, begunAt });
      const view = learning.list();
      assert.equal(view.patterns[0].count, 3);
      assert.deepEqual(view.suppressed, [label]);
      const id = view.patterns[0].id;
      assert.ok(id.length > 240);
      assert.equal(learning.forget({ id }).patterns.length, 0);
      assert.equal(learning.observe({ kind: "suggestion", choice: "dismiss", className: label, begunAt: 12 }).patterns.length, 0);
      assert.equal(learning.observe({ kind: "suggestion", choice: "dismiss", className: label, begunAt: Date.now() + 1 }).patterns[0].count, 1);
    }

    reset();
    const splitSurrogate = "界".repeat(79) + "😀";
    for (const begunAt of [15, 16, 17]) learning.observe({ kind: "suggestion", choice: "dismiss", className: splitSurrogate, begunAt });
    assert.equal(learning.list().patterns[0].count, 3);
    assert.equal(learning.forget({ id: learning.list().patterns[0].id }).patterns.length, 0);

    for (const identity of [
      { from: "a%".repeat(100) + "@example.test", threadId: "审阅% /".repeat(24) },
      { from: "sender".repeat(400) + "@example.test", threadId: "hash-fallback" },
    ]) {
      reset();
      for (const begunAt of [20, 21, 22]) learning.observe({ kind: "action", action: "mark-read", begunAt, items: [{ messageId: "synthetic", ...identity }] });
      const rows = learning.list().patterns;
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.count === 3 && row.id.length <= 2048));
      for (const row of rows) learning.forget({ id: row.id });
      assert.equal(learning.list().patterns.length, 0);
    }

    reset();
    const valid = observe(30);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    const damaged = [
      "{", "null", "[]",
      JSON.stringify({ version: 1, patterns: "broken", revoked: {} }),
      JSON.stringify({ version: 2, patterns: [], revoked: {} }),
      JSON.stringify({ version: 1, patterns: [], revoked: [] }),
      JSON.stringify({ version: 1, patterns: [], revoked: { [valid.patterns[0].id]: "broken" } }),
      JSON.stringify({ ...stored, patterns: [stored.patterns[0], null] }),
      JSON.stringify({ ...stored, patterns: [{ ...stored.patterns[0], count: "broken" }] }),
      JSON.stringify({ ...stored, patterns: [{ ...stored.patterns[0], learned: true }] }),
      JSON.stringify({ ...stored, patterns: [{ ...stored.patterns[0], begunAts: [30, "broken"] }] }),
      JSON.stringify({ ...stored, patterns: [{ ...stored.patterns[0], key: {} }] }),
      JSON.stringify({ ...stored, patterns: [stored.patterns[0], stored.patterns[0]] }),
      JSON.stringify({ version: 1, patterns: [{ id: "category:needs-you:fyi", kind: "category", count: 1, learned: false, updatedAt: "", fromCategoryId: "needs-you", toCategoryId: "fyi", fromName: "Needs You", toName: "FYI", senders: "broken" }], revoked: {} }),
    ];
    for (const text of damaged) {
      fs.writeFileSync(file, text);
      assert.equal(learning.list(), null);
      assert.equal(observe(31), null);
      assert.equal(learning.forget({ id: valid.patterns[0].id }), null);
      assert.equal(fs.readFileSync(file, "utf8"), text);
    }
    reset();
    assert.deepEqual(learning.list(), { threshold: 3, patterns: [], suppressed: [] });
    assert.equal(sender(observe(40)).count, 1);
    console.log("agent-learning-store-ok: Unicode IDs, revoke, non-adjacent retries, out-of-order success, schema preservation");
  } finally {
    if (previous === undefined) delete process.env.MORROW_AI_CONFIG_DIR;
    else process.env.MORROW_AI_CONFIG_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { run };
if (require.main === module) run();
