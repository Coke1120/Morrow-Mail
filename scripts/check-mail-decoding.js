// Generated MIME and in-memory credentials only. Real parsers, cache and renderer.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const iconv = require("iconv-lite");
const { simpleParser } = require("mailparser");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const { message } = require("./gmail-fixture");
const decoding = require("../host/mail/mime-decoding");
const textEncoding = require("../host/mail/text-encoding");
const { createSession } = require("../host/mail/gmail-session");
const remote = require("../host/mail/remote");
const tools = require(path.join(path.dirname(require.resolve("imapflow")), "tools.js"));
let serial = 0;
const invalidSocket = () => { throw new Error("Live sockets are forbidden in decoding fixtures"); };

function part(bytes, charset = "utf-8", type = "text/plain", contentType) {
  return { mimeType: type, headers: [{ name: "Content-Type", value: contentType || `${type}${charset ? "; charset=" + charset : ""}` }],
    body: { data: bytes.toString("base64url"), size: bytes.length } };
}
function source(bytes, charset = "utf-8", type = "text/plain", transfer = "base64", contentType) {
  const head = `From: Synthetic <sender@fixture.invalid>\r\nSubject: Synthetic mail\r\nContent-Type: ${contentType || type + (charset ? "; charset=" + charset : "")}\r\nContent-Transfer-Encoding: ${transfer}\r\n\r\n`;
  const body = transfer === "base64" ? Buffer.from(bytes.toString("base64")) : transfer === "quoted-printable"
    ? Buffer.from([...bytes].map(b => "=" + b.toString(16).toUpperCase().padStart(2, "0")).join("")) : bytes;
  return Buffer.concat([Buffer.from(head), body]);
}
function multipart(plain, html) {
  return Buffer.from("Content-Type: multipart/alternative; boundary=synthetic\r\n\r\n"
    + "--synthetic\r\n" + source(plain).toString() + "\r\n--synthetic\r\n" + source(html, "utf-8", "text/html").toString() + "\r\n--synthetic--\r\n");
}
function imapClient(raw, uid = 7) {
  return { mailbox: { uidValidity: 1 }, async getMailboxLock() { return { release() {} }; },
    async *fetch(_range, fields) { yield { uid, source: raw.subarray(0, fields.source.maxLength), envelope: { subject: "Synthetic mail" }, flags: new Set() }; } };
}
async function imap(raw) { return remote.fetchSource(imapClient(raw), "INBOX", 7, 1); }
function presented(value) {
  return decoding.presentation({ decoding_json: decoding.serialize(value.decoding), subject: value.subject }, textEncoding.presentMessage(value, {preserveDecoded:true}));
}

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-decoding-")), env = { ...process.env };
  const socket = require("node:net").Socket.prototype.connect;
  require("node:net").Socket.prototype.connect = invalidSocket;
  Object.assign(process.env, { MORROW_USER_DATA: directory, MORROW_MAIL_DIR: directory, MORROW_MAIL_SECRETS: "memory", MORROW_GMAIL_PACE: "0",
    MORROW_AI_CONFIG_DIR: directory, MORROW_GOOGLE_OAUTH_JSON: JSON.stringify({ installed: { client_id: "decoding-fixture.apps.googleusercontent.com", client_secret: "synthetic-only" } }) });
  const db = require("../host/mail/db"), engine = require("../host/mail/engine"), secrets = require("../host/mail/secrets");
  const original = remote.withClient;
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8"), { url: "https://fixture.invalid" });
  dom.window.morrow = { on() {} };
  const ui = renderer({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, Event: dom.window.Event, Node: dom.window.Node });
  ui.run("state.prefs.images=false");
  dom.window.morrowFeaturesCatalog = require("../renderer/features-catalog");
  function render(value) {
    ui.context.fixtureMail = value;
    return ui.run(`(() => { const pane=document.createElement('div'); renderBody(pane, fixtureMail); return pane; })()`);
  }
  try {
    await engine.init();
    db.insertAccount({ id: "gmail", email: "owner@fixture.invalid", username: "owner", profile: "gmail", authKind: "oauth2", createdAt: 1,
      imapHost: "imap.fixture.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.fixture.invalid", smtpPort: 465, smtpTls: true });
    db.enableGmail("gmail");
    db.replaceFolders("gmail", [{ path: "INBOX", name: "Inbox", wellKnown: "inbox", providerId: "INBOX" }]);
    const service = new Map(), fetches = [];
    const api = { getMessage: async (id, options) => { fetches.push({ id, options }); return structuredClone(service.get(id)); }, attachment: async () => Buffer.from("External 日本語") };
    const session = createSession(db.accountById("gmail"), "synthetic-only", { api });
    remote.withClient = async (_account, _secret, work) => work({ gmail: session });
    secrets.setPassword("gmail", JSON.stringify({ provider: "google", googleClientId: "decoding-fixture.apps.googleusercontent.com", purpose: "imap", accessToken: "synthetic-only", refreshToken: "synthetic-only", expiresAt: Date.now()+3600000,
      grantedScopes: require("../host/mail/oauth-config").SCOPES.google }));
    async function gmail(payload, name = "case-" + ++serial) {
      const data = message(name); data.snippet = ""; data.payload = { ...payload, headers: [...data.payload.headers, ...payload.headers] };
      service.set(name, data);
      return session.adopt(data, { full: true });
    }
    async function read(id, retry = false) {
      const reply = await engine.answer("mail:readEmail", [{ emailId: id, retry }]);
      assert.equal(reply.success, true, JSON.stringify(reply)); return reply.data;
    }
    const cases = [
      ["utf-8", Buffer.from("繁體 简体 日本語 한국어 العربية עברית Café e\u0301 😀 𠀀 49 15"), "繁體 简体 日本語 한국어 العربية עברית Café e\u0301 😀 𠀀 49 15"],
      ...[["big5", "繁體中文郵件 49 與 15"], ["gb18030", "简体中文邮件 😀 𠀀 49 15"], ["cp932", "日本語メール 49 と 15"], ["euc-jp", "日本語メール"], ["utf-7", "中文 日本語"]].map(([charset, text]) => [charset, iconv.encode(text, charset), text]),
      ["iso-2022-jp", Buffer.from([27,36,66,70,124,75,92,56,108,27,40,66]), "日本語"],
      ["windows-1252", Buffer.from([67,97,102,233,32,128]), "Café €"]
    ];
    for (const [charset, bytes, expected] of cases) {
      const g = await gmail(part(bytes, charset));
      assert.equal(g.textBody, expected); assert.equal(g.decoding.lossy, false); assert.equal(g.decoding.unsupported, false);
      const cached = db.gmailCopies("gmail", g.providerId)[0], loaded = await read(cached.id);
      assert.equal(loaded.textBody, expected); assert.equal(loaded.bodyWarning, ""); assert.equal(loaded.encodingWarning, ""); assert.equal(loaded.bodyComplete, true);
      for (const transfer of ["base64", "quoted-printable", "8bit"]) {
        const i = await imap(source(bytes, charset, "text/plain", transfer));
        assert.equal(i.textBody, expected, charset + "/" + transfer); assert.equal(i.decoding.lossy, false); assert.equal(i.decoding.unsupported, false);
      }
      const text = charset === "windows-1252" ? "Café €" : charset === "cp932" || charset === "euc-jp" || charset === "iso-2022-jp" ? "日本語" : "中文";
      const headerBytes = charset === "iso-2022-jp" ? bytes : iconv.encode(text, charset);
      const word = `=?${charset}?B?${headerBytes.toString("base64")}?=`;
      const tok = value => ({ value });
      const envelope = tools.parseEnvelope([null, tok(word), [[tok(word), null, tok("sender"), tok("fixture.invalid")]]]);
      const headerMail = await simpleParser(Buffer.from(`Subject: ${word}\r\nFrom: ${word} <sender@fixture.invalid>\r\n\r\n`));
      assert.equal(headerMail.subject, text); assert.equal(envelope.subject, text); assert.equal(envelope.from[0].name, text);
    }
    const text = "繁體中文郵件 49 與 15", big5 = iconv.encode(text, "big5");
    const literalLatin = "Ã©";
    const literalMail = await gmail(part(iconv.encode(literalLatin,"windows-1252"),"windows-1252"));
    assert.equal(literalMail.textBody,literalLatin); assert.equal((await read(db.gmailCopies("gmail",literalMail.providerId)[0].id)).textBody,literalLatin);
    assert.equal((await imap(source(iconv.encode(literalLatin,"windows-1252"),"windows-1252"))).textBody,literalLatin,"declared encodings are not guessed again as UTF-8");
    for (const contentType of ['text/plain; x-note="charset=utf-8"; charset=big5', "text/plain; charset*=us-ascii''big5", 'text/plain; charset*0="bi"; charset*1="g5"', 'text/plain; CHARSET = "Big5"']) {
      assert.equal((await gmail(part(big5, "big5", "text/plain", contentType))).textBody, text);
      assert.equal((await imap(source(big5, "big5", "text/plain", "base64", contentType))).textBody, text);
    }
    for (const [charset, bytes] of [["utf-8", big5], ["", big5], ["x-unknown", big5], ["utf-8", Buffer.from([0xc0,0xaf,0xff])]]) {
      for (const value of [await gmail(part(bytes, charset)), await imap(source(bytes, charset))]) {
        assert.equal(value.bodyComplete, true, "download completeness is independent of charset loss");
        assert.equal(value.decoding.lossy, true); assert.match(presented(value).warning, /losing characters/);
      }
    }
    const unsupported = await gmail(part(Buffer.from("Available ASCII"), "x-unknown"));
    assert.equal(unsupported.decoding.unsupported, true); assert.equal(unsupported.decoding.lossy, false);
    assert.match(presented(unsupported).warning, /unrecognized/);
    for (const bytes of [Buffer.from("Literal � 49 15"), Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), Buffer.from("Literal �")])]) {
      for (const value of [await gmail(part(bytes)), await imap(source(bytes))]) {
        assert.equal(value.decoding.lossy, false); assert.equal(presented(value).warning, "");
      }
    }
    for (const charset of ["gb18030", "utf-7", "utf-16le"]) assert.equal(decoding.decode(iconv.encode("Literal �",charset),charset).lossy,false);
    const external = part(Buffer.from("")); external.body = { attachmentId: "external-text", size: 20 };
    assert.equal((await gmail(external)).textBody, "External 日本語");
    for (const bad of ["A", "5Lit5p", "5Lit5paHAB", "!!"]) {
      const malformed = part(Buffer.from("中文")); malformed.body.data = bad;
      const value = await gmail({ mimeType: "multipart/alternative", headers: [], parts: [malformed, part(Buffer.from("Healthy sibling"))] });
      assert.equal(value.bodyComplete, false); assert.ok(value.bodyWarning); assert.equal(value.textBody, "Healthy sibling");
    }
    const wrongSize = part(Buffer.from("Healthy body")); wrongSize.body.size += 1;
    assert.equal((await gmail(wrongSize)).bodyComplete, false);
    const goodPlain = Buffer.from("正常純文字 49 與 15"), badHtml = Buffer.concat([Buffer.from("<p>"), big5, Buffer.from("</p>")]);
    const htmlValue = await gmail({ mimeType: "multipart/alternative", headers: [], parts: [part(goodPlain), part(badHtml, "utf-8", "text/html")] }, "broken-html");
    const rawHtml = await imap(multipart(goodPlain, badHtml));
    for (const value of [htmlValue, rawHtml]) {
      const p = presented(value); assert.equal(p.htmlBody, null); assert.equal(p.textBody, goodPlain.toString()); assert.match(p.warning, /plain-text version/);
    }
    const htmlCache = db.gmailCopies("gmail", "broken-html")[0];
    assert.ok(htmlCache.html_body, "original HTML remains cached");
    const loadedHtml = await read(htmlCache.id); assert.equal(loadedHtml.htmlBody, null); assert.equal(loadedHtml.textBody, goodPlain.toString());
    const pane = render(loadedHtml); assert.equal(pane.querySelector(".body").textContent, goodPlain.toString()); assert.match(pane.textContent, /losing characters/);
    const manualPane = render({ id: "legacy-alternative", accountId: "gmail", htmlBody: '<p>�49�15</p><script>window.leaked=true</script><img src="https://fixture.invalid/track">', textBody: goodPlain.toString() });
    const toggle = manualPane.querySelector('[data-action="plain-body"]');
    assert.ok(toggle); assert.equal(toggle.getAttribute("aria-pressed"), "false");
    toggle.click(); assert.equal(manualPane.querySelector(".body").textContent, goodPlain.toString()); assert.equal(toggle.getAttribute("aria-pressed"), "true");
    toggle.click(); assert.match(manualPane.querySelector(".body").textContent, /�49�15/); assert.equal(manualPane.querySelector("script, img"), null);
    // Legacy cache rows get an honest uncertainty notice, without a mailbox scan.
    const legacy = db.gmailCopies("gmail", htmlValue.providerId)[0];
    db.updateMessage(legacy.id, { text_body: "�49�15", html_body: null, from_addr:"� <sender@fixture.invalid>", from_display_name:"�", subject:"�", decoding_json: null, body_complete: 1, body_warning: null });
    const before = fetches.length, old = await read(legacy.id);
    assert.match(old.encodingWarning, /may already be/); assert.equal(old.bodyWarning, ""); assert.equal(fetches.length, before);
    const body = await engine.answer("mail:readCachedBody", [{ emailId: legacy.id, accountId: "gmail", bodyEpoch: old.bodyEpoch }]);
    assert.equal(body.data.email.encodingWarning, old.encodingWarning);
    // Explicit retry of a complete body must retrieve full parts, replace cached
    // loss and persist the newly checked diagnostics. Ordinary opens remain local.
    const fixed = message("broken-html"); fixed.payload = { ...part(big5, "big5"), headers: [...fixed.payload.headers, ...part(big5, "big5").headers] };
    service.set("broken-html", fixed);
    const repaired = await read(legacy.id, true);
    assert.equal(repaired.textBody, text); assert.equal(repaired.encodingWarning, ""); assert.equal(fetches.at(-1).options?.format || "full", "full");
    assert.equal(repaired.from,"sender@fixture.invalid"); assert.equal(repaired.subject,"Synthetic broken-html");
    const afterRetry = fetches.length; await read(legacy.id); assert.equal(fetches.length, afterRetry);
    const completeText = db.messageById(legacy.id).text_body;
    const shortResponse = structuredClone(fixed); shortResponse.payload.body.data = "A"; service.set("broken-html",shortResponse);
    const shortRetry = await engine.answer("mail:readEmail",[{emailId:legacy.id,retry:true}]);
    assert.equal(shortRetry.success,false); assert.equal(db.messageById(legacy.id).text_body,completeText);
    service.set("broken-html",fixed);
    const badAgain = service.get("broken-html"); badAgain.payload = { ...part(big5, "utf-8"), headers: [...fixed.payload.headers.filter(h=>h.name!=="Content-Type"), ...part(big5).headers] };
    await read(legacy.id, true); const afterBadRetry = fetches.length;
    const stillLossy = await read(legacy.id); assert.match(stillLossy.encodingWarning, /losing characters/); assert.equal(fetches.length, afterBadRetry);
    // A failed retry retains the prior cache and reports the failure.
    const savedGetter = api.getMessage; api.getMessage = async () => { throw new Error("Synthetic failure"); };
    const failed = await engine.answer("mail:readEmail", [{ emailId: legacy.id, retry: true }]);
    assert.equal(failed.success, false); assert.match(failed.error.message, /Cached content was retained/);
    api.getMessage = savedGetter;
    // Preserve complete content and diagnostics against a partial sync response.
    const previous = db.messageById(legacy.id), partial = message("broken-html");
    partial.payload.body = { attachmentId: "not-downloaded", size: 100 };
    await session.adopt(partial, { full: false });
    const retained = db.messageById(legacy.id); assert.equal(retained.text_body, previous.text_body); assert.equal(retained.decoding_json, previous.decoding_json);
    db.updateMessage(legacy.id,{draft_pending:1,is_draft:1});
    const beforeDraft = fetches.length, pending = await read(legacy.id,true);
    assert.equal(fetches.length,beforeDraft); assert.equal(pending.encodingWarning,""); assert.equal(pending.textBody,retained.text_body);
    db.updateMessage(legacy.id,{draft_pending:0,is_draft:0});
    db.insertAccount({id:"imap",email:"owner@imap.fixture.invalid",username:"owner",profile:"custom",createdAt:2,imapHost:"imap.fixture.invalid",imapPort:993,imapTls:true,smtpHost:"smtp.fixture.invalid",smtpPort:465,smtpTls:true});
    db.replaceFolders("imap",[{path:"INBOX",name:"Inbox",wellKnown:"inbox",uidValidity:1}]);
    const imapFull = await imap(source(Buffer.from("Complete checked body")));
    db.applyFolderSync("imap","INBOX",{validity:1,keepOthers:true,messages:[imapFull]});
    db.applyFolderSync("imap","INBOX",{validity:1,keepOthers:true,messages:[{...imapFull,textBody:"Truncated source",bodyComplete:false,decoding:{...decoding.quality(),lossy:true}}]});
    const imapRetained = db.messageByUid("imap","INBOX",7,1);
    assert.equal(imapRetained.text_body,"Complete checked body"); assert.equal(imapRetained.body_complete,1); assert.equal(JSON.parse(imapRetained.decoding_json).lossy,false);
    const long = "A".repeat(179) + "😀";
    assert.equal((await gmail(part(Buffer.from(long)))).snippet, "A".repeat(179)); assert.equal(remote.snippetOf(long), "A".repeat(179));
    for (const cap of [96*1024,3*1024*1024]) {
      const prefix = source(Buffer.alloc(0), "utf-8", "text/plain", "8bit");
      const raw = Buffer.concat([prefix, Buffer.alloc(cap-prefix.length-1, 0x41), Buffer.from("中 end")]);
      const client = imapClient(raw), value = cap === 96*1024 ? (await remote.fetchMessages(client,"INBOX",[7])).messages[0] : await remote.fetchSource(client,"INBOX",7,1);
      assert.equal(value.bodyComplete, false); assert.equal(value.bodySourceLimited, cap === 3*1024*1024);
    }
    for (const transfer of ["8bit","base64","quoted-printable"]) {
      const raw = source(cases[0][1], "utf-8", "text/plain", transfer);
      const parsed = await simpleParser(Readable.from([...raw].map(byte=>Buffer.from([byte])))); assert.equal(parsed.text, cases[0][2]);
    }
    const raw = await remote.buildRaw({ from: {name:"寄件人 😀",address:"sender@fixture.invalid"},to:"owner@fixture.invalid",subject:cases[0][2],text:cases[0][2] });
    const outbound = await simpleParser(raw); assert.equal(outbound.subject,cases[0][2]); assert.equal(outbound.text.trim(),cases[0][2]);
    // The same metadata survives an actual persistence close/reopen.
    const stored = db.messageById(legacy.id).decoding_json;
    await db.close(); await db.open(path.join(directory,"mail.sqlite")); assert.equal(db.messageById(legacy.id).decoding_json,stored);
    ui.run(`paintFeatureCatalog()`);
    assert.match(dom.window.document.getElementById("features-catalog").textContent, /Message text encoding/);
    assert.match(dom.window.document.getElementById("features-catalog").textContent, /already lost/);
    console.log("mail-decoding-ok: MIME parameters, provider parity, loss disclosure, cache/retry, safe plain text, boundaries and Features");
  } finally {
    remote.withClient = original; require("node:net").Socket.prototype.connect = socket;
    await engine.stopIdle(); await db.close(); dom.window.close();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env); fs.rmSync(directory, {recursive:true,force:true});
  }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode=1; });
