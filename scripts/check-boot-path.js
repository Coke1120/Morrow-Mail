const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");

const syntax = [
  "host/main.js",
  "host/asar.js",
  "host/ipc.js",
  "renderer/preload.js",
  "renderer/app.js",
];
for (const file of syntax) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

const asar = require("../host/asar");
delete process.env.GENMAIL_ASAR;
assert.strictEqual(asar.resolveAsarPath(), null);
assert.throws(() => asar.openAsar(), /GENMAIL_ASAR/);
process.env.GENMAIL_ASAR = "  /tmp/from-env.asar  ";
assert.strictEqual(asar.resolveAsarPath(), "/tmp/from-env.asar");
assert.strictEqual(asar.resolveAsarPath("/tmp/explicit.asar"), "/tmp/explicit.asar");
process.env.GENMAIL_ASAR = "";
assert.strictEqual(asar.resolveAsarPath(), null);

const forbidden = "Genspark Super App.app";
for (const file of ["host/main.js", "host/asar.js"]) {
  const text = fs.readFileSync(path.join(root, file), "utf8");
  assert.ok(!text.includes(forbidden), `${file} still hardcodes the external app path`);
}

const preload = fs.readFileSync(path.join(root, "renderer/preload.js"), "utf8");
const registered = new Set();
for (const match of preload.matchAll(/"([a-zA-Z][\w-]*:[^"\n]{1,180})"/g)) {
  registered.add(match[1]);
}
const appJs = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
const used = new Set();
for (const match of appJs.matchAll(/"((?:mail|app):[^"]+)"/g)) used.add(match[1]);
assert.ok(used.size >= 8, "renderer stopped calling mail IPC");
for (const channel of used) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
}
for (const channel of ["mail:accountsUpdated", "mail:emailsUpdated"]) {
  assert.ok(registered.has(channel), `preload does not listen for ${channel}`);
}

const main = fs.readFileSync(path.join(root, "host/main.js"), "utf8");
assert.ok(main.includes('path.join(__dirname, "..", "renderer")'));
assert.ok(main.includes("externalAsarPath"));
assert.ok(main.includes("loadFile(FIRST_PARTY_HTML)"));

const pkg = require("../package.json");
assert.ok(pkg.build.files.includes("renderer/**/*"));

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return new Function(`${source.slice(start, i + 1)}; return ${name};`)();
      }
    }
  }
  throw new Error(`unclosed ${name}`);
}

const senderName = extractFunction(appJs, "senderName");
assert.strictEqual(senderName(""), "(unknown sender)");
assert.strictEqual(senderName("charles@example.com"), "charles@example.com");
assert.strictEqual(senderName("Charles Babbage <charles@example.com>"), "Charles Babbage");
assert.strictEqual(senderName('"Ada Lovelace" <ada@example.com>'), "Ada Lovelace");

const nextRow = extractFunction(appJs, "nextRow");
assert.strictEqual(nextRow(0, -1, 1), -1);
assert.strictEqual(nextRow(3, -1, 1), 0);
assert.strictEqual(nextRow(3, -1, -1), 2);
assert.strictEqual(nextRow(3, 0, -1), 0);
assert.strictEqual(nextRow(3, 2, 1), 2);
assert.strictEqual(nextRow(3, 1, 1), 2);

assert.ok(appJs.includes('className = "when"'), "message list does not render a date");
assert.ok(appJs.includes("ArrowDown") && appJs.includes("moveCursor"), "message list has no arrow-key cursor");
const css = fs.readFileSync(path.join(root, "renderer/app.css"), "utf8");
assert.ok(css.includes(".list-title") && css.includes(".when"), "shell css missing dense list styles");
assert.ok(css.includes(".thread") && css.includes(".attachments"), "shell css missing thread or attachment styles");
const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
assert.ok(html.includes('id="search-query"'), "toolbar has no search box");

const threadMembers = extractFunction(appJs, "threadMembers");
assert.deepStrictEqual(threadMembers([{ id: "a" }, { id: "b" }], [{ id: "c" }]).map((row) => row.id), ["a", "b"]);
assert.deepStrictEqual(threadMembers([], [{ id: "a" }, { id: "b" }]).map((row) => row.id), ["a", "b"]);
assert.deepStrictEqual(threadMembers([{ id: "" }], null), []);
assert.deepStrictEqual(threadMembers(null, null), []);

const mailbox = require("../host/mailbox");
const opened = mailbox.answer("mail:openEmail", [{ emailId: "m-compiler" }]);
assert.strictEqual(opened.data.threadMessages.length, 0);
assert.strictEqual(opened.data.email.threadId, "t-compiler");
assert.strictEqual(opened.data.email.attachments[0].filename, "notes.txt");
assert.strictEqual(opened.data.email.attachments[0]._bytes, undefined);
const members = mailbox.answer("mail:listThreadMessages", [{ threadId: "t-compiler", accountId: "gmail-ada" }]);
assert.ok(members.data.filter((row) => row.threadId === "t-compiler").length >= 2);
const found = mailbox.answer("mail:search", [{ query: "compiler", limit: 10, filters: {} }]);
assert.ok(found.data.some((row) => row.id === "m-compiler" && row.attachments[0].filename === "notes.txt"));

const paneWidth = extractFunction(appJs, "paneWidth");
assert.strictEqual(paneWidth(200, -80, 140, 400), 140);
assert.strictEqual(paneWidth(200, 300, 140, 400), 400);
assert.strictEqual(paneWidth(200, 20, 140, 400), 220);

const folderIcon = extractFunction(appJs, "folderIcon");
assert.strictEqual(folderIcon("inbox"), "📥");
assert.strictEqual(folderIcon("archive"), "📦");
assert.strictEqual(folderIcon("deleteditems"), "🗑️");
assert.strictEqual(folderIcon(null), "📁");

const snoozeUntil = extractFunction(appJs, "snoozeUntil");
const afternoon = new Date("2026-10-16T15:00:00");
assert.strictEqual(snoozeUntil("1h", afternoon).getTime() - afternoon.getTime(), 60 * 60 * 1000);
assert.strictEqual(snoozeUntil("tonight", afternoon).getHours(), 18);
assert.strictEqual(snoozeUntil("tonight", new Date("2026-10-16T19:00:00")).getHours(), 22);
const pastTonight = snoozeUntil("tonight", new Date("2026-10-16T23:00:00"));
assert.strictEqual(pastTonight.getDate(), 17);
assert.strictEqual(pastTonight.getHours(), 18);
const morning = snoozeUntil("morning", afternoon);
assert.strictEqual(morning.getDate(), 17);
assert.strictEqual(morning.getHours(), 8);

const removalPayload = extractFunction(appJs, "removalPayload");
assert.deepStrictEqual(removalPayload({ accountId: "a", id: "e", threadId: "t" }, false), {
  accountId: "a",
  emailId: "e",
});
assert.deepStrictEqual(removalPayload({ accountId: "a", id: "e", threadId: "t" }, true), {
  accountId: "a",
  emailId: "e",
  threadId: "t",
});
const usesThread = extractFunction(appJs, "usesThread");
assert.strictEqual(usesThread({ id: "e" }, [{ id: "e" }]), false);
assert.strictEqual(usesThread({ id: "e" }, [{ id: "e" }, { id: "f" }]), true);

for (const channel of [
  "mail:toggleStar",
  "mail:archive",
  "mail:threadArchive",
  "mail:delete",
  "mail:threadTrash",
  "mail:moveToFolder",
  "mail:undoRemoval",
  "mail:snoozeThread",
  "mail:unsnoozeThread",
  "mail:listSnoozed",
]) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(appJs.includes('"Unstar"') && appJs.includes('"Archive"') && appJs.includes('"Trash"') && appJs.includes('"Unsnooze"'));
assert.ok(html.includes('id="undo"') && html.includes('class="split"'), "shell is missing undo or resize handles");
assert.ok(css.includes("--folders") && css.includes("--list") && css.includes(".split") && css.includes(".folder-icon") && css.includes(".reader-actions"));

function idsIn(accountId, folderId) {
  const listed = mailbox.answer("mail:listFromCache", [{ accountId, folderId, limit: 20 }]);
  assert.strictEqual(listed.success, true);
  return listed.data.emails.map((row) => row.id);
}

assert.ok(idsIn("gmail-ada", "starred").includes("m-compiler"));
const starred = mailbox.answer("mail:toggleStar", [{ emailId: "m-engine", accountId: "gmail-ada", isStarred: true }]);
assert.strictEqual(starred.success, true);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-engine"));
assert.ok(mailbox.answer("mail:listFromCache", [{ accountId: "gmail-ada", folderId: "gmail-ada:inbox", limit: 20 }]).data.emails.some((row) => row.id === "m-engine" && row.isStarred === true));
assert.ok(idsIn("gmail-ada", "starred").includes("m-engine"));
mailbox.answer("mail:toggleStar", [{ emailId: "m-engine", accountId: "gmail-ada", isStarred: false }]);

const archived = mailbox.answer("mail:archive", [{ emailId: "m-salon", accountId: "gmail-ada" }]);
assert.ok(archived.data.opIds.length === 1);
assert.ok(!idsIn("gmail-ada", "gmail-ada:inbox").includes("m-salon"));
assert.ok(idsIn("gmail-ada", "gmail-ada:archive").includes("m-salon"));
assert.strictEqual(mailbox.answer("mail:undoRemoval", [{ opIds: archived.data.opIds, kind: "move" }]).success, true);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-salon"));

const threaded = mailbox.answer("mail:threadArchive", [{ accountId: "gmail-ada", threadId: "t-compiler", emailId: "m-compiler" }]);
assert.ok(threaded.data.opIds.length === 1);
assert.ok(!idsIn("gmail-ada", "gmail-ada:inbox").some((id) => id === "m-compiler" || id === "m-compiler-2"));
assert.strictEqual(idsIn("gmail-ada", "gmail-ada:archive").filter((id) => id === "m-compiler" || id === "m-compiler-2").length, 2);
mailbox.answer("mail:undoRemoval", [{ opIds: threaded.data.opIds, kind: "move" }]);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-compiler"));

const trashed = mailbox.answer("mail:delete", [{ emailId: "m-trajectory", accountId: "outlook-grace" }]);
assert.ok(trashed.data.opIds.length === 1);
assert.ok(idsIn("outlook-grace", "outlook-grace:trash").includes("m-trajectory"));
mailbox.answer("mail:undoRemoval", [{ opIds: trashed.data.opIds, kind: "move" }]);
assert.ok(idsIn("outlook-grace", "outlook-grace:inbox").includes("m-trajectory"));

const threadTrash = mailbox.answer("mail:threadTrash", [{ accountId: "outlook-grace", threadId: "m-apollo", emailId: "m-apollo" }]);
assert.ok(threadTrash.data.opIds.length === 1);
assert.ok(idsIn("outlook-grace", "outlook-grace:trash").includes("m-apollo"));
mailbox.answer("mail:undoRemoval", [{ opIds: threadTrash.data.opIds, kind: "move" }]);
assert.ok(idsIn("outlook-grace", "outlook-grace:inbox").includes("m-apollo"));

const moved = mailbox.answer("mail:moveToFolder", [{
  emailId: "m-engine",
  accountId: "gmail-ada",
  targetFolderId: "gmail-ada:notes",
  folderId: "gmail-ada:inbox",
}]);
assert.ok(moved.data.opIds.length === 1);
assert.ok(idsIn("gmail-ada", "gmail-ada:notes").includes("m-engine"));
assert.ok(!idsIn("gmail-ada", "gmail-ada:inbox").includes("m-engine"));
mailbox.answer("mail:undoRemoval", [{ opIds: moved.data.opIds, kind: "move" }]);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-engine"));
const toStar = mailbox.answer("mail:moveToFolder", [{
  emailId: "m-engine",
  accountId: "gmail-ada",
  targetFolderId: "starred",
  folderId: "gmail-ada:inbox",
}]);
assert.ok(idsIn("gmail-ada", "starred").includes("m-engine"));
assert.ok(!idsIn("gmail-ada", "gmail-ada:inbox").includes("m-engine"));
mailbox.answer("mail:undoRemoval", [{ opIds: toStar.data.opIds, kind: "move" }]);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-engine"));

const snoozed = mailbox.answer("mail:snoozeThread", [{
  accountId: "gmail-ada",
  threadId: "m-salon",
  snoozedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
}]);
assert.strictEqual(snoozed.success, true);
assert.ok(!idsIn("gmail-ada", "gmail-ada:inbox").includes("m-salon"));
const snoozeList = mailbox.answer("mail:listSnoozed", [{ accountId: "gmail-ada" }]);
assert.ok(snoozeList.data.records.some((row) => row.threadId === "m-salon" && row.state === "snoozed"));
mailbox.answer("mail:unsnoozeThread", [{ accountId: "gmail-ada", threadId: "m-salon" }]);
assert.ok(idsIn("gmail-ada", "gmail-ada:inbox").includes("m-salon"));
assert.ok(!mailbox.answer("mail:listSnoozed", [{ accountId: "gmail-ada" }]).data.records.some((row) => row.threadId === "m-salon"));

const bodyNodes = extractFunction(appJs, "bodyNodes");
assert.deepStrictEqual(bodyNodes("One\n\nTwo"), [
  { node_id: "n0", text: "One" },
  { node_id: "n1", text: "Two" },
]);
assert.deepStrictEqual(bodyNodes("  "), []);
assert.deepStrictEqual(bodyNodes("Line"), [{ node_id: "n0", text: "Line" }]);

const applyTranslate = extractFunction(appJs, "applyTranslate");
const translationText = extractFunction(appJs, "translationText");
const view = {
  reqId: "t",
  nodes: [{ node_id: "n0", text: "Hi" }],
  texts: {},
  error: "",
  pending: true,
};
applyTranslate(view, { reqId: "other", type: "error", message: "nope" });
applyTranslate(view, { reqId: "t", type: "progress", current: 0, total: 1 });
applyTranslate(view, { reqId: "t", type: "node", nodeId: "n0", translatedText: "Hola", status: "success" });
applyTranslate(view, { reqId: "t", type: "done" });
assert.strictEqual(translationText(view), "Hola");
assert.strictEqual(view.pending, false);
assert.strictEqual(view.current, 0);
applyTranslate(view, { reqId: "t", type: "error", message: "late" });
assert.strictEqual(view.error, "");
const missingKey = {
  reqId: "t",
  nodes: [{ node_id: "n0", text: "Hi" }],
  texts: {},
  error: "",
  pending: true,
};
applyTranslate(missingKey, { reqId: "t", type: "error", message: "Add an API key in GenMail → AI Setup." });
assert.strictEqual(missingKey.pending, false);
assert.strictEqual(missingKey.error, "Add an API key in GenMail → AI Setup.");
assert.strictEqual(translationText(missingKey), "");

const signatureRows = extractFunction(appJs, "signatureRows");
const chosenSignatureId = extractFunction(appJs, "chosenSignatureId");
const signaturePlain = extractFunction(appJs, "signaturePlain");
const applySignature = extractFunction(appJs, "applySignature");
const pack = {
  signatures: [
    { id: "s1", name: "Work", html: "<p>Thanks,<br>Ada</p>" },
    { id: "s2", name: "Short", text: "— Ada" },
  ],
  defaultSignatureId: "s2",
  defaultSignaturePerAccount: { "gmail-ada": "s1" },
};
assert.strictEqual(chosenSignatureId(pack, "gmail-ada"), "s1");
assert.strictEqual(chosenSignatureId(pack, "other"), "s2");
assert.strictEqual(chosenSignatureId({ signatures: [] }, "a"), "");
assert.strictEqual(signaturePlain(pack.signatures[0]), "Thanks,\nAda");
assert.strictEqual(signaturePlain(pack.signatures[1]), "— Ada");
assert.strictEqual(applySignature("Hello", "", "— Ada"), "Hello\n\n— Ada");
assert.strictEqual(applySignature("Hello\n\n— Ada", "— Ada", "Thanks,\nAda"), "Hello\n\nThanks,\nAda");
assert.strictEqual(applySignature("— Ada", "— Ada", ""), "");
assert.deepStrictEqual(signatureRows({ signatures: [] }), []);
assert.deepStrictEqual(signatureRows(null), []);
const listedSignatures = mailbox.answer("mail:listSignatures", [{ accountId: "gmail-ada" }]);
assert.deepStrictEqual(listedSignatures.data, {
  signatures: [],
  defaultSignatureId: null,
  defaultSignaturePerAccount: {},
});
assert.deepStrictEqual(signatureRows(listedSignatures.data), []);

for (const channel of [
  "mail:listSignatures",
  "mail:translateStart",
  "mail:translateCancel",
  "mail:translate:event",
]) {
  assert.ok(registered.has(channel), `preload does not register ${channel}`);
  assert.ok(used.has(channel), `renderer does not call ${channel}`);
}
assert.ok(appJs.includes('"Translate"') && appJs.includes('"Cancel"') && appJs.includes('"No signatures."'));
assert.ok(html.includes('id="signature"') && html.includes("No signatures."));
assert.ok(css.includes(".translate") && css.includes(".translation") && css.includes(".body p"));

console.log("ui-path-ok");
