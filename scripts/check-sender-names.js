// Offline sender-identity regressions: production policy, SQL, host and DOM/IPC.
// MIME/provider submission is covered by check-compose-identity with CI deps.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const policy = require("../shared/compose-policy");
const clone = value => JSON.parse(JSON.stringify(value));
const account = { id: "gmail", email: "owner@fixture.invalid", senderName: "Old profile name", sendAs: [
  { email: "owner@fixture.invalid", name: "Gmail Owner", source: "gmail", verified: true, isPrimary: true },
  { email: "work@fixture.invalid", name: "Gmail Work", source: "gmail", verified: true, isDefault: true },
  { email: "blank@fixture.invalid", name: "", source: "gmail", verified: true },
  { email: "pending@fixture.invalid", name: "Pending", source: "gmail", verificationStatus: "pending" },
] };
const preferences = () => policy.normalizeSettings({ accounts: { gmail: { aliases: [{ address: "manual@fixture.invalid" }],
  senderNames: { "work@fixture.invalid": "陳美玲, \"Morrow\"", "manual@fixture.invalid": "Manual identity" } } } });

function decisions() {
  const prefs = preferences(), rows = policy.identities(account, prefs);
  const identity = email => rows.find(row => row.email === email + "@fixture.invalid");
  assert.equal(identity("owner").displayName, "Gmail Owner");
  assert.equal(identity("work").displayName, '陳美玲, "Morrow"');
  assert.equal(identity("work").defaultName, "Gmail Work");
  assert.equal(identity("manual").verified, false);
  assert.equal(identity("manual").displayName, "Manual identity");
  assert.equal(identity("blank").displayName, "Gmail Owner", "blank Gmail aliases inherit the provider's primary name");
  assert.equal(identity("pending"), undefined);
  for (const kind of ["new", "reply", "all", "forward"]) {
    const message = kind === "new" ? null : { to: ["work@fixture.invalid"] };
    const resolved = policy.resolve(account, message, prefs, kind);
    assert.equal(resolved.fromAddress, "work@fixture.invalid");
    assert.equal(resolved.fromDisplayName, '陳美玲, "Morrow"');
  }
  prefs.accounts.gmail.senderNames["owner@fixture.invalid"] = "";
  assert.equal(policy.resolve(account, null, prefs, "new", account.email).fromDisplayName, "", "an empty override is address-only");
  delete prefs.accounts.gmail.senderNames["owner@fixture.invalid"];
  assert.equal(policy.resolve(account, null, prefs, "new", account.email).fromDisplayName, "Gmail Owner");
  assert.equal(policy.resolve({ ...account, id: "another" }, null, prefs, "new").fromDisplayName, "Gmail Work", "names cannot cross account ids");
  assert.equal(policy.resolve({ id: "imap", email: account.email, senderName: "IMAP Owner" }, null, prefs, "new").fromDisplayName, "IMAP Owner");
  const refreshed = clone(account); refreshed.sendAs[1].name = "Changed in Gmail";
  assert.equal(policy.resolve(refreshed, null, prefs, "new").fromDisplayName, '陳美玲, "Morrow"');
  delete prefs.accounts.gmail.senderNames["work@fixture.invalid"];
  assert.equal(policy.resolve(refreshed, null, prefs, "new").fromDisplayName, "Changed in Gmail");
  for (const invalid of ["A\r\nBcc: thief@fixture.invalid", "\0A", "A\tB", "A\u0085B", "A\u2028B", "x".repeat(201), 7, null]) {
    assert.throws(() => policy.normalizeSettings({ accounts: { gmail: { senderNames: { [account.email]: invalid } } } }), /sender name/);
  }
  assert.throws(() => policy.normalizeSettings({ accounts: { gmail: { senderNames: { "Display <owner@fixture.invalid>": "No" } } } }), /exact email/);
  assert.equal(policy.displayName("  \"Name, Inc\" <display only>  "), '"Name, Inc" <display only>');
  assert.equal(policy.senderPreview(account.email, "<script>"), "<script> <owner@fixture.invalid>", "preview must be rendered as text, never HTML");
}

async function hostResolution() {
  const filename = require.resolve("../host/mail/compose-identity"), module = { exports: {} };
  let prefs = preferences(), rows = account.sendAs, writes = 0, hold;
  let stored = { id: account.id, email: account.email, profile: "gmail", auth_kind: "oauth2", created_at: 1, gmail_generation: 1,
    mail_transport: "gmail_api", display_name: "Profile", send_as_json: JSON.stringify({ email: account.email, identities: rows, updatedAt: 0 }) };
  const load = createRequire(filename);
  const replacements = { "./db": { accountById: () => stored, saveSendAs(_id, value) { writes++; stored.send_as_json = JSON.stringify(value); } },
    "../settings": { answer: () => prefs }, "./sidecar": { providerOf: () => "google", gmailSendAsToken: async () => ({ accessToken: "synthetic" }) },
    "./provider-api": { listSendAs: async () => { const result = rows; if (hold) await hold; return result; } } };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, exports: module.exports, require: name => replacements[name] || load(name), setTimeout, clearTimeout });
  const identity = module.exports;
  const context = await identity.context(stored, null, "new", "", true);
  assert.equal(context.fromDisplayName, '陳美玲, "Morrow"');
  assert.deepEqual(clone(identity.mimeFrom(stored, "work@fixture.invalid")), { address: "work@fixture.invalid", name: '陳美玲, "Morrow"' });
  assert.equal(identity.mimeFrom(stored, account.email, ""), account.email);
  assert.throws(() => identity.outgoingIdentity(stored, account.email, "Bad\nHeader"), /sender name/);
  assert.throws(() => identity.outgoingIdentity(stored, "stranger@fixture.invalid", "Authorized-looking name"), /no longer configured/);
  rows = rows.filter(row => row.email !== "work@fixture.invalid");
  await assert.rejects(identity.sendingFrom(stored, "work@fixture.invalid"), /no longer configured|Verify/);
  rows = account.sendAs;
  let release; hold = new Promise(resolve => { release = resolve; });
  const old = stored, before = writes, pending = identity.context(old, null, "new", "", true);
  stored = { ...stored, gmail_generation: 2, send_as_json: null };
  release(); await pending;
  assert.equal(writes, before, "a lookup from an obsolete connection cannot replace the new provider cache");
  hold = null;
  let releaseOld; hold = new Promise(resolve => { releaseOld = resolve; });
  const slow = identity.context(stored, null, "new", "", true);
  // Let the synthetic token promise reach its provider boundary first.
  await Promise.resolve(); await Promise.resolve();
  rows = clone(account.sendAs); rows[0].name = "Latest Gmail name"; hold = null;
  await identity.context(stored, null, "new", "", true);
  releaseOld(); await slow;
  assert.equal(JSON.parse(stored.send_as_json).identities[0].name, "Latest Gmail name", "late discovery cannot overwrite a newer result");
  let releaseRemoved; hold = new Promise(resolve => { releaseRemoved = resolve; });
  const removed = identity.context(stored, null, "new", "", true);
  const writesBeforeRemoval = writes; identity.invalidate(stored.id); stored = null;
  releaseRemoved(); await assert.rejects(removed, /no longer connected/);
  assert.equal(writes, writesBeforeRemoval);
  assert.equal(identity.savedName({ from_display_name: "Saved draft", from_addr: account.email }), "Saved draft");
  assert.equal(identity.savedName({ from_display_name: "", from_addr: account.email }), "");
}

// Existing HTML-parser DOM in CI; a bounded DOM fixture on dependency-free VMs.
function settingsDocument(html) {
  try { return require("./check-chatgpt-ui").documentFor(html); }
  catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
  const nodes = new Map();
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = new Map(); this.value = ""; this.disabled = false; this._text = ""; this.attrs = {}; this.classList = { toggle() {} }; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    setAttribute(key, value) { this.attrs[key] = value; if (key === "id") { this.id = value; nodes.set(value, this); } }
    appendChild(node) { this.children.push(node); return node; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    replaceChildren(...nodes) { this.children = nodes; this._text = ""; }
    addEventListener(type, work) { this.listeners.set(type, work); }
    async dispatch(type) { return this.listeners.get(type)?.({ preventDefault() {} }); }
    querySelectorAll() { return []; }
  }
  for (const match of html.matchAll(/<([a-z0-9-]+)[^>]*\bid="([^"]+)"[^>]*>/gi)) {
      const node = new Element(match[1]); node.setAttribute("id", match[2]);
  }
  return { getElementById: id => nodes.get(id), createElement: tag => new Element(tag) };
}

async function settingsUi() {
  const html = fs.readFileSync(require.resolve("../renderer/index.html"), "utf8"), document = settingsDocument(html);
  const get = id => document.getElementById(id), calls = [];
  const controls = () => {
    const result = [];
    const walk = node => { for (const child of node.children || []) { result.push(child); walk(child); } };
    walk(get("brain-compose-senders"));
    return result;
  };
  get("brain-compose-form").querySelectorAll = () => [...controls(), ...["account", "aliases", "from", "default-domain", "refresh", "domains", "bcc"].map(key => get("brain-compose-" + key))];
  let prefs = preferences(), accounts = [clone(account), { id: "other", email: "other@fixture.invalid", senderName: "IMAP Sender", sendAs: [] }], pendingRefresh;
  const api = { accounts: () => accounts, selectedId: () => "gmail", async call(channel, input) {
    calls.push({ channel, input: clone(input || {}) });
    if (channel === "emailBrain:getComposeSettings") return clone(prefs);
    if (channel === "emailBrain:saveComposeSettings") { prefs = clone(input); return clone(input); }
    if (channel === "mail:getComposeContext") { if (pendingRefresh) await pendingRefresh; const updated = clone(account); updated.sendAs[1].name = "Gmail changed"; return { sendAs: updated.sendAs }; }
    throw new Error(channel);
  } };
  const context = vm.createContext({ window: { morrowComposePolicy: policy }, document });
  vm.runInContext(fs.readFileSync(require.resolve("../renderer/brain-compose.js"), "utf8"), context);
  const component = context.window.morrowBrainCompose;
  component.wire(); await component.load(api);
  const dispatch = async (node, type) => {
    if (type === "click" && node.disabled) return;
    return node.listeners.get(type)?.({ target: node, preventDefault() {} });
  };
  const inputFor = email => controls().find(node => node.dataset.senderEmail === email);
  assert.match(get("brain-compose-senders").textContent, /Gmail-verified send-as.*Gmail default.*From for new mail/);
  assert.match(get("brain-compose-senders").textContent, /Manually configured — provider sending permission not checked/);
  assert.doesNotMatch(get("brain-compose-senders").textContent, /pending@/);
  inputFor("work@fixture.invalid").value = "Morrow <text> & 名稱";
  await dispatch(inputFor("work@fixture.invalid"), "input");
  assert.match(get("brain-compose-senders").textContent, /Recipients see: Morrow <text> & 名稱 <work@fixture.invalid>/);
  await dispatch(get("brain-compose-refresh"), "click");
  assert.equal(inputFor("work@fixture.invalid").value, "Morrow <text> & 名稱");
  assert.match(get("brain-compose-senders").textContent, /Gmail name: Gmail changed/);
  get("brain-compose-account").value = "other"; await dispatch(get("brain-compose-account"), "change");
  assert.equal(inputFor("other@fixture.invalid").value, "IMAP Sender");
  get("brain-compose-account").value = "gmail"; await dispatch(get("brain-compose-account"), "change");
  assert.equal(inputFor("work@fixture.invalid").value, "Morrow <text> & 名稱");
  await dispatch(get("brain-compose-form"), "submit");
  assert.equal(prefs.accounts.gmail.senderNames["work@fixture.invalid"], "Morrow <text> & 名稱");
  inputFor("work@fixture.invalid").value = ""; await dispatch(inputFor("work@fixture.invalid"), "input");
  await dispatch(get("brain-compose-form"), "submit");
  assert.equal(prefs.accounts.gmail.senderNames["work@fixture.invalid"], "");
  const reset = controls().find(node => node.dataset.senderReset === "work@fixture.invalid");
  await dispatch(reset, "click"); await dispatch(get("brain-compose-form"), "submit");
  assert.equal(Object.hasOwn(prefs.accounts.gmail.senderNames, "work@fixture.invalid"), false);
  assert.equal(inputFor("work@fixture.invalid").value, "Gmail changed");
  const count = calls.filter(row => row.channel === "emailBrain:saveComposeSettings").length;
  inputFor("work@fixture.invalid").value = "Bad\nHeader"; await dispatch(inputFor("work@fixture.invalid"), "input");
  await dispatch(get("brain-compose-form"), "submit");
  assert.equal(calls.filter(row => row.channel === "emailBrain:saveComposeSettings").length, count);
  assert.match(get("brain-compose-status").textContent, /control characters/);
  inputFor("work@fixture.invalid").value = "Valid"; await dispatch(inputFor("work@fixture.invalid"), "input");
  let release; pendingRefresh = new Promise(resolve => { release = resolve; });
  const oldInput = inputFor("work@fixture.invalid"), refresh = dispatch(get("brain-compose-refresh"), "click");
  accounts = [accounts[1]]; release(); await refresh;
  assert.equal(get("brain-compose-account").value, "other");
  assert.doesNotMatch(get("brain-compose-senders").textContent, /work@fixture/);
  oldInput.value = "Stale edit"; await dispatch(oldInput, "input"); await dispatch(get("brain-compose-form"), "submit");
  assert.equal(prefs.accounts.other?.senderNames?.["work@fixture.invalid"], undefined);
  assert.ok(calls.every(row => !/updateSendAs|oauth|connect|send$/.test(row.channel)));
  const { renderer } = require("./check-ux-workflows");
  const features = renderer({ document, window: { morrow: {}, morrowFeaturesCatalog: require("../renderer/features-catalog") } });
  features.run("paintFeatureCatalog()");
  assert.match(get("features-catalog").textContent, /Sender identities.*Morrow-only display name.*Drafts and scheduled mail retain/);
  assert.match(html, /id="cli-sender-names"[\s\S]*bridge has no display-name parameter/);
}

async function sqlSnapshots() {
  const { db } = require("./gmail-fixture").cacheRuntime();
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "morrow-sender-names-"));
  await db.open(path.join(directory, "mail.sqlite"));
  try {
    db.insertAccount({ id: "sender-names", email: account.email, username: account.email, profile: "custom", createdAt: 1,
      imapHost: "fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "fixture.invalid", smtpPort: 465, smtpTls: true });
    const row = { id: "named-draft", accountId: "sender-names", folderPath: "Drafts", from: account.email,
      fromDisplayName: "Snapshot 名稱", uid: 1, uidValidity: 1, isDraft: true, draftPending: true, bodyComplete: true,
      rfcMessageId: "<saved@fixture.invalid>", date: new Date().toISOString(), listSortTs: 1 };
    db.insertMessage(row);
    const proof = db.draftRevision(db.messageById(row.id));
    db.updateMessage(row.id, { from_display_name: "Different" });
    assert.notEqual(db.draftRevision(db.messageById(row.id)), proof);
    db.applyFolderSync(row.accountId, "Drafts", { validity: 1, keepOthers: true, messages: [{ ...row, uid: 1, fromDisplayName: "Server old" }] });
    assert.equal(db.messageById(row.id).from_display_name, "Different", "sync cannot overwrite a protected local edit");
    db.insertMessage({ ...row, id: "legacy-draft", draftPending: false, fromDisplayName: undefined });
    assert.equal(db.messageById("legacy-draft").from_display_name, null);
  } finally { await db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

async function run() {
  decisions(); await hostResolution(); await settingsUi(); await sqlSnapshots();
  console.log("sender-names-ok: defaults, overrides, validation, lookup lifecycle, Settings DOM and draft SQL snapshots");
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
