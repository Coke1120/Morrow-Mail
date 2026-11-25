"use strict";

const assert = require("node:assert/strict");
const { promises: fs } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createAttachmentSaveList } = require("../host/mail/attachment-save-list");
const { LIMITS } = require("../host/mail/attachment-cache");

async function scratch(t) {
  const root = process.env.MORROW_SAVE_LIST_TEST_TMP || os.tmpdir();
  const directory = await fs.mkdtemp(path.join(root, "morrow-save-list-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function source(emailId, attachmentId, filename, bytes, assertCurrent = () => {}) {
  return { accountId: "mailbox-1", emailId, attachmentId, filename, size: bytes.length, assertCurrent };
}

function id({ accountId, emailId, attachmentId }) {
  return JSON.stringify([accountId, emailId, attachmentId]);
}

test("the photo and offline document reviews save twelve complete, exact attachments", async t => {
  let correct = 0;
  for (let round = 0; round < 4; round++) {
    const directory = await scratch(t);
    const docs = round % 2 === 1;
    const existing = docs ? "Instructions.pdf" : null;
    const baseline = Buffer.from("File already on disk");
    if (existing) await fs.writeFile(path.join(directory, existing), baseline);
    const incoming = docs
      ? ["Instructions.pdf", "instructions.PDF", "Checklist.txt"]
      : ["Album.jpg", "Holiday.jpg", "Pet.jpg"];
    const expected = docs
      ? ["Instructions-2.pdf", "instructions-3.PDF", "Checklist.txt"]
      : incoming;
    const bodies = incoming.map((_name, index) => Buffer.from([round, index, 0, 255, 13, 10]));
    const sources = incoming.map((name, index) => source("email-" + (docs ? index : index % 2), index === 2 ? "2" : "1", name, bodies[index]));
    const bytes = new Map(sources.map((item, index) => [id(item), bodies[index]]));
    const read = [];
    const list = createAttachmentSaveList({ readBytes: async target => {
      read.push(id(target));
      assert.ok(bytes.has(id(target)), "Never read an unselected part");
      return bytes.get(id(target));
    } });
    const preview = await list.prepare(directory, sources);
    assert.deepEqual(preview.files.map(row => row.filename), expected);
    assert.deepEqual(await fs.readdir(directory), existing ? [existing] : []);
    assert.deepEqual(read, []);
    const result = await list.save(preview);
    assert.deepEqual(result.map(row => [row.filename, row.status, row.bytes, row.cleanupFailed]),
      expected.map((name, index) => [name, "saved", bodies[index].length, false]));
    assert.deepEqual(read, sources.map(id));
    assert.deepEqual((await fs.readdir(directory)).sort(), expected.concat(existing ? [existing] : []).sort());
    for (const [index, name] of expected.entries()) {
      assert.deepEqual(await fs.readFile(path.join(directory, name)), bodies[index]);
      correct++;
    }
    if (existing) assert.deepEqual(await fs.readFile(path.join(directory, existing)), baseline);
  }
  assert.equal(correct, 12);
  t.diagnostic("12/12 actual file bytes, zero extra files, existing PDFs preserved");
});

test("a removed or changed source cannot prevent an independent valid file from saving", async t => {
  const directory = await scratch(t);
  const data = Buffer.from("attachment");
  let missing = false, changed = false;
  const incoming = [
    source("deleted-message", "1", "deleted.pdf", data, () => !missing),
    source("changed-message", "1", "changed.pdf", data, () => { if (changed) throw new Error("Stale snapshot"); }),
    source("untouched-message", "1", "untouched.pdf", data),
  ];
  const reads = [];
  const list = createAttachmentSaveList({ readBytes: async item => {
    reads.push(item.emailId);
    if (item.emailId === "changed-message") changed = true;
    return data;
  } });
  const preview = await list.prepare(directory, incoming);
  missing = true;
  await assert.rejects(list.save({ ...preview }), { code: "invalid-review" });
  const result = await list.save(preview);
  assert.deepEqual(result.map(row => row.status), ["source-unavailable", "source-unavailable", "saved"]);
  assert.deepEqual(reads, ["changed-message", "untouched-message"]);
  assert.deepEqual(await fs.readdir(directory), ["untouched.pdf"]);
  assert.deepEqual(await fs.readFile(path.join(directory, "untouched.pdf")), data);
  await assert.rejects(list.save(preview), { code: "invalid-review" });

  let changedWhileWriting = false;
  const controller = new AbortController();
  const open = fs.open;
  t.mock.method(fs, "open", async (filename, ...args) => {
    const handle = await open(filename, ...args);
    const write = handle.writeFile.bind(handle);
    t.mock.method(handle, "writeFile", async bytes => {
      if (path.basename(filename) === "disk-full.pdf") {
        const error = Object.assign(new Error("No space"), { code: "ENOSPC" });
        controller.abort();
        throw error;
      }
      await write(bytes);
      changedWhileWriting = true;
    });
    return handle;
  });
  const late = await list.prepare(directory, [
    source("fourth-message", "1", "changed-during-write.pdf", data, () => !changedWhileWriting),
    source("fifth-message", "1", "disk-full.pdf", data),
  ]);
  const lateResult = await list.save(late, { signal: controller.signal });
  assert.deepEqual(lateResult.map(file => [file.status, file.verification, file.cleanupFailed]),
    [["saved", "source-unavailable", false], ["write-failed", undefined, false]]);
  assert.deepEqual(await fs.readFile(path.join(directory, "changed-during-write.pdf")), data);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["changed-during-write.pdf", "untouched.pdf"]);
});

test("late collisions and two concurrent reviews preserve the first publisher's bytes", async t => {
  const directory = await scratch(t);
  const sentinel = Buffer.from("I arrived after review");
  const first = Buffer.from("First new attachment");
  const second = Buffer.from("Second new attachment");
  const list = createAttachmentSaveList({ readBytes: async ({ emailId }) => emailId === "first" ? first : second });
  const late = await list.prepare(directory, [source("first", "1", "Late.pdf", first)]);
  await fs.writeFile(path.join(directory, "Late.pdf"), sentinel, { flag: "wx" });
  assert.equal((await list.save(late))[0].status, "collision");
  assert.deepEqual(await fs.readFile(path.join(directory, "Late.pdf")), sentinel);

  const left = await list.prepare(directory, [source("first", "2", "Racing.pdf", first)]);
  const right = await list.prepare(directory, [source("second", "1", "Racing.pdf", second)]);
  const results = await Promise.all([list.save(left), list.save(right)]);
  assert.deepEqual(results.map(([file]) => file.status).sort(), ["collision", "saved"]);
  const winner = results[0][0].status === "saved" ? first : second;
  assert.deepEqual(await fs.readFile(path.join(directory, "Racing.pdf")), winner);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["Late.pdf", "Racing.pdf"]);
});

test("portable naming and existing per-file and combined transfer limits", async t => {
  const directory = await scratch(t);
  const tiny = Buffer.from("Small");
  const list = createAttachmentSaveList({ readBytes: async (_item, { maxBytes }) => {
    assert.equal(maxBytes, LIMITS.fileBytes);
    return tiny;
  } });
  const incoming = [
    source("a", "1", "../../CON.pdf", tiny),
    source("b", "1", "some\\other\\name?.txt. ", tiny),
    source("c", "1", "圖".repeat(70) + ".pdf", tiny),
    { ...source("d", "1", "huge.pdf", tiny), size: LIMITS.fileBytes + 1 },
    source("e", "1", "PRN" + " ".repeat(150) + "suffix.pdf", tiny),
    source("f", "1", "σ.pdf", tiny),
    source("g", "1", "ς.pdf", tiny),
  ];
  await assert.rejects(list.prepare(directory, [incoming[0], incoming[0]]), { code: "invalid-review" });
  const preview = await list.prepare(directory, incoming);
  assert.deepEqual(preview.files.map(row => row.filename),
    ["_CON.pdf", "name_.txt", "圖".repeat(38) + ".pdf", "huge.pdf", "_PRN.pdf", "σ.pdf", "ς-2.pdf"]);

  const sentinel = Buffer.from("Claimed after preview");
  await fs.writeFile(path.join(directory, "_CON.pdf"), sentinel, { flag: "wx" });
  const result = await list.save(preview);
  assert.deepEqual(result.map(row => row.status), ["collision", "saved", "saved", "too-large", "saved", "saved", "saved"]);
  assert.deepEqual(await fs.readFile(path.join(directory, "_CON.pdf")), sentinel);
  assert.deepEqual(await fs.readFile(path.join(directory, "name_.txt")), tiny);
  assert.deepEqual((await fs.readdir(directory)).sort(),
    ["_CON.pdf", "name_.txt", "圖".repeat(38) + ".pdf", "_PRN.pdf", "σ.pdf", "ς-2.pdf"].sort());

  // A read adapter must honor maxBytes. An oversized return still consumes
  // the remaining budget, even if the bytes cannot be saved.
  const MiB = 1024 * 1024;
  const budgetCalls = [];
  const limited = createAttachmentSaveList({ readBytes: async ({ emailId }, { maxBytes }) => {
    budgetCalls.push(maxBytes / MiB);
    return Buffer.alloc(Number(emailId) * MiB);
  } });
  const budget = await limited.prepare(directory,
    [64, 63, 2, 1].map(number => ({ ...source(String(number), "1", number + ".pdf", tiny), size: undefined })));
  await Promise.all([64, 63].map(number => fs.writeFile(path.join(directory, number + ".pdf"), sentinel)));
  const budgetResult = await limited.save(budget);
  assert.deepEqual(budgetResult.map(row => row.status), ["collision", "collision", "too-large", "too-large"]);
  assert.deepEqual(budgetCalls, [64, 64, 1]);
  for (const name of ["2.pdf", "1.pdf"]) await assert.rejects(fs.stat(path.join(directory, name)), { code: "ENOENT" });
});

test("a replaced directory or cancelled operation reports every item without further reads", async t => {
  const root = await scratch(t);
  const directory = path.join(root, "approved");
  await fs.mkdir(directory);
  const bytes = Buffer.from("attachment");
  const controller = new AbortController();
  let reads = 0;
  const list = createAttachmentSaveList({ readBytes: async () => {
    if (++reads === 2) controller.abort(null);
    return bytes;
  } });
  const incoming = [1, 2, 3].map(number => source("one", String(number), number + ".pdf", bytes));
  const stale = await list.prepare(directory, incoming);
  const old = path.join(root, "old");
  await fs.rename(directory, old);
  await fs.mkdir(directory);
  assert.deepEqual((await list.save(stale)).map(row => row.status),
    ["destination-changed", "destination-changed", "destination-changed"]);
  assert.equal(reads, 0);
  assert.deepEqual(await fs.readdir(old), []);
  assert.deepEqual(await fs.readdir(directory), []);

  const preview = await list.prepare(directory, incoming);
  assert.deepEqual((await list.save(preview, { signal: controller.signal })).map(row => row.status),
    ["saved", "cancelled", "cancelled"]);
  assert.equal(reads, 2);
  assert.deepEqual(await fs.readdir(directory), ["1.pdf"]);
  assert.deepEqual(await fs.readFile(path.join(directory, "1.pdf")), bytes);

  const racing = path.join(root, "racing");
  await fs.mkdir(racing);
  const duringOpen = await list.prepare(racing, [source("safe", "1", "reviewed.pdf", bytes)]);
  const open = fs.open;
  const moved = path.join(root, "racing-moved");
  t.mock.method(fs, "open", async (...args) => {
    await fs.rename(racing, moved);
    await fs.mkdir(racing);
    return open(...args);
  });
  const final = await list.save(duringOpen);
  assert.deepEqual(final.map(file => [file.status, file.cleanupFailed]), [["destination-changed", false]]);
  assert.deepEqual(await fs.readdir(moved), []);
  assert.deepEqual(await fs.readdir(racing), []);
});
