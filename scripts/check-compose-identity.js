const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const policy = require("../shared/compose-policy");
const { recipientHeaders } = require("../host/mail/recipient-headers");

const account = { id: "aliases", email: "leo@gmail.com", sendAs: [
  { email: "leo@northstar.example", verified: true },
  { email: "leo@second.example", verified: true, isDefault: true },
] };
const prefs = policy.normalizeSettings({ ccByDomain: {
  "@NORTHSTAR.example": ["manager@northstar.example", "team@northstar.example", "MANAGER@northstar.example"],
  "second.example": ["ops@second.example"], "project.example": ["project@project.example"],
}, bccByDomain: {
  "@gmail.com": ["logs@gmail.com", "LOGS@gmail.com"],
  "northstar.example": ["audit@northstar.example"],
  "project.example": ["project-bcc@project.example"],
}, accounts: { aliases: { aliases: [{ address: "inbound@relay.example", domain: "northstar.example" }], defaultDomain: "project.example" } } });

function decisions() {
  assert.deepEqual(prefs.ccByDomain["northstar.example"], ["manager@northstar.example", "team@northstar.example"]);
  const gmail = { from: "client@client.example", to: ["Leo <leo@northstar.example>", "someone@second.example"],
    recipientHeaders: { deliveredTo: ["leo@gmail.com"] } };
  for (const kind of ["reply", "all", "forward"]) {
    const result = policy.resolve(account, gmail, prefs, kind);
    assert.equal(result.fromAddress, "leo@northstar.example", "visible business alias wins over Gmail's primary delivery hop");
    assert.equal(result.domain, "northstar.example");
    assert.deepEqual(result.defaultCc, prefs.ccByDomain["northstar.example"]);
  }
  const bcc = { to: ["undisclosed-recipients:;"], recipientHeaders: { originalTo: ["leo@second.example"] } };
  assert.equal(policy.resolve(account, bcc, prefs, "reply").fromAddress, "leo@second.example");
  const conflicting = { to: ["leo@northstar.example"], recipientHeaders: { originalTo: ["leo@second.example"] } };
  assert.equal(policy.resolve(account, conflicting, prefs, "reply").fromAddress, "leo@second.example");
  const relay = policy.resolve(account, { to: ["inbound@relay.example"] }, prefs, "reply");
  assert.equal(relay.fromAddress, "inbound@relay.example");
  assert.equal(relay.domain, "northstar.example", "an explicit CC mapping never rewrites From");
  assert.equal(policy.resolve(account, { to: ["stranger@northstar.example"] }, prefs, "reply").fallback, true);
  assert.equal(policy.resolve(account, { cc: ["leo@northstar.example"] }, prefs, "all").fromAddress, "leo@northstar.example");
  assert.equal(policy.resolve(account, { from: "leo@northstar.example", to: ["client@client.example"] }, prefs, "reply").fromAddress, "leo@northstar.example");
  assert.equal(policy.resolve(account, null, prefs, "new").fromAddress, "leo@second.example");
  assert.equal(policy.resolve(account, null, prefs, "new", "leo@northstar.example").domain, "northstar.example");
  const gmailNew = policy.resolve(account, null, prefs, "new", "leo@gmail.com");
  assert.equal(gmailNew.domain, "project.example");
  assert.equal(gmailNew.policyDomain, "gmail.com");
  assert.deepEqual(gmailNew.defaultCc, ["project@project.example"]);
  assert.deepEqual(gmailNew.defaultBcc, ["logs@gmail.com"]);
  assert.deepEqual(policy.recipientDefaults("leo@gmail.com", account, prefs, "new"), {
    policyDomain: "gmail.com", ccDomain: "project.example",
    cc: ["project@project.example"], bcc: ["logs@gmail.com"],
  });
  assert.equal(policy.resolve(account, gmail, prefs, "reply", "leo@gmail.com").domain, "gmail.com");
  assert.equal(policy.resolve(account, gmail, prefs, "reply", "leo@gmail.com").policyDomain, "gmail.com");
  assert.deepEqual(policy.resolve(account, gmail, prefs, "reply", "leo@gmail.com").defaultBcc, ["logs@gmail.com"]);
  assert.equal(policy.resolve({ id: "other", email: "other@example.com" }, gmail, prefs, "all").fromAddress, "other@example.com");
  const pending = { id: "p", email: "me@example.com", sendAs: [{ email: "pending@northstar.example", verificationStatus: "pending" }] };
  assert.equal(policy.resolve(pending, { to: ["pending@northstar.example"] }, prefs, "reply").fromAddress, pending.email);
  assert.equal(policy.seedRecipients("Manager <manager@northstar.example>", ["manager@northstar.example", "team@northstar.example", "leo@northstar.example"],
    ["TEAM@northstar.example", ""], ["leo@northstar.example"]), "Manager <manager@northstar.example>");
  assert.equal(policy.seedRecipients("", ["a@example.com", "b@example.com"], ["", "B@example.com"], []), "a@example.com");
  assert.equal(policy.seedRecipients("Team <team@northstar.example>", ["team@northstar.example"], ["team@northstar.example"], []), "Team <team@northstar.example>");
  const aliasPrefs = policy.normalizeSettings({
    ccByDomain: { "northstar.example": ["manager@northstar.example"], "gmail.com": ["ops@gmail.com"], "project.example": ["project@project.example"] },
    bccByDomain: { "northstar.example": ["audit@northstar.example"], "gmail.com": ["logs@gmail.com"], "project.example": ["project-bcc@project.example"] },
    accounts: { aliases: { aliases: [{ address: "leo@gmail.com", domain: "@NORTHSTAR.example" }], defaultDomain: "project.example" } },
  });
  for (const kind of [undefined, "new", "reply", "all", "forward"]) {
    const row = policy.recipientDefaults("Leo <leo@gmail.com>", account, aliasPrefs, kind);
    assert.equal(row.policyDomain, "northstar.example", kind || "missing kind");
    assert.equal(row.ccDomain, "northstar.example");
    assert.deepEqual(row.cc, ["manager@northstar.example"]);
    assert.deepEqual(row.bcc, ["audit@northstar.example"]);
  }
  const subdomain = policy.recipientDefaults("leo@mail.northstar.example", account, prefs, "new");
  assert.equal(subdomain.policyDomain, "mail.northstar.example");
  assert.equal(subdomain.ccDomain, "project.example");
  assert.deepEqual(subdomain.cc, ["project@project.example"]);
  assert.deepEqual(subdomain.bcc, []);
  const subdomainReply = policy.recipientDefaults("leo@mail.northstar.example", account, prefs, "reply");
  assert.equal(subdomainReply.policyDomain, "mail.northstar.example");
  assert.equal(subdomainReply.ccDomain, "mail.northstar.example");
  assert.deepEqual(subdomainReply.cc, []);
  assert.deepEqual(subdomainReply.bcc, []);
  const emptyRule = policy.normalizeSettings({
    ccByDomain: { "gmail.com": [] },
    bccByDomain: { "gmail.com": ["logs@gmail.com"], "project.example": ["project-bcc@project.example"] },
    accounts: { aliases: { defaultDomain: "project.example" } },
  });
  const blocked = policy.recipientDefaults("leo@gmail.com", account, emptyRule, "new");
  assert.equal(blocked.ccDomain, "gmail.com");
  assert.deepEqual(blocked.cc, []);
  assert.equal(blocked.policyDomain, "gmail.com");
  assert.deepEqual(blocked.bcc, ["logs@gmail.com"]);
  assert.deepEqual(policy.normalizeSettings({ ccByDomain: { "northstar.example": ["a@northstar.example"] } }).bccByDomain, {});
  assert.deepEqual(policy.normalizeSettings({ bccByDomain: { "@GMAIL.com": ["Logs@gmail.com", "logs@gmail.com"] } }).bccByDomain, { "gmail.com": ["logs@gmail.com"] });
  assert.deepEqual(prefs.ccByDomain["second.example"], ["ops@second.example"]);
  assert.throws(() => policy.normalizeSettings({ ccByDomain: { "bad domain": [] } }), /CC domain/);
  assert.throws(() => policy.normalizeSettings({ ccByDomain: { "a.example": ["bad\r\nBcc: hidden@example.com"] } }), /valid CC/);
  assert.throws(() => policy.normalizeSettings({ ccByDomain: { "gmail.com": [], "@gmail.com": [] } }), /Each CC domain can appear only once/);
  assert.throws(() => policy.normalizeSettings({ bccByDomain: { "gmail.com": ["not-an-email"] } }), /valid BCC/);
  assert.throws(() => policy.normalizeSettings({ bccByDomain: { "bad domain": ["a@b.co"] } }), /BCC domain/);
  assert.throws(() => policy.normalizeSettings({ bccByDomain: { "gmail.com": [], "@gmail.com": ["a@gmail.com"] } }), /Each BCC domain can appear only once/);
  assert.throws(() => policy.normalizeSettings({ accounts: JSON.parse('{"__proto__":{}}') }), /mapping/);
  const openSeeds = policy.openRecipientSeeds(false, "Pat <pat@example.com>", "Already <already@example.com>");
  const seeded = policy.applyRecipientSeeds(openSeeds, {
    cc: ["pat@example.com", "to@example.com", "already@example.com", "self@example.com", "cc@example.com", "both@example.com"],
    bcc: ["already@example.com", "to@example.com", "self@example.com", "cc@example.com", "both@example.com", "bcc@example.com"],
  }, { to: "To <to@example.com>", cc: "", bcc: "" }, ["self@example.com"]);
  assert.equal(seeded.cc, "Pat <pat@example.com>, cc@example.com, both@example.com");
  assert.equal(seeded.bcc, "Already <already@example.com>, bcc@example.com");
  assert.equal(seeded.to, "To <to@example.com>");
  const fresh = policy.openRecipientSeeds(false, "", "");
  const firstPass = policy.applyRecipientSeeds(fresh, { cc: ["a@one.example"], bcc: ["b@one.example"] }, { to: "", cc: "", bcc: "" }, []);
  const secondPass = policy.applyRecipientSeeds(fresh, { cc: ["c@two.example"], bcc: ["d@two.example"] }, { to: "", cc: firstPass.cc, bcc: firstPass.bcc }, []);
  assert.equal(secondPass.cc, "c@two.example");
  assert.equal(secondPass.bcc, "d@two.example");
  assert.deepEqual(policy.applyRecipientSeeds(fresh, { cc: ["c@two.example"], bcc: ["d@two.example"] }, secondPass, []), secondPass);
  const heldBcc = policy.openRecipientSeeds(false, "", "");
  heldBcc.bcc.locked = true;
  const held = policy.applyRecipientSeeds(heldBcc, { cc: ["shared@example.com", "cc@example.com"], bcc: ["new@example.com"] }, { to: "", cc: "old@example.com", bcc: "shared@example.com" }, []);
  assert.equal(held.cc, "cc@example.com");
  assert.equal(held.bcc, "shared@example.com");
  const heldCc = policy.openRecipientSeeds(false, "kept@example.com", "");
  heldCc.cc.locked = true;
  const ccStays = policy.applyRecipientSeeds(heldCc, { cc: ["other@example.com"], bcc: ["bcc@example.com"] }, { to: "", cc: "kept@example.com, typed@example.com", bcc: "" }, []);
  assert.equal(ccStays.cc, "kept@example.com, typed@example.com");
  assert.equal(ccStays.bcc, "bcc@example.com");
  const saved = policy.openRecipientSeeds(true, "", "draft-bcc@example.com");
  assert.equal(saved.cc.locked, true);
  assert.equal(saved.bcc.locked, true);
  const savedFields = policy.applyRecipientSeeds(saved, { cc: ["a@example.com"], bcc: ["b@example.com"] }, { to: "person@example.com", cc: "", bcc: "draft-bcc@example.com" }, []);
  assert.equal(savedFields.cc, "");
  assert.equal(savedFields.bcc, "draft-bcc@example.com");
  assert.deepEqual(policy.normalizeDomainKeys(["@NORTHSTAR.example", " Gmail.com "]), ["northstar.example", "gmail.com"]);
  assert.deepEqual(policy.normalizeDomainKeys(["mail.northstar.example"]), ["mail.northstar.example"]);
  assert.deepEqual(policy.normalizeDomainKeys([]), []);
  assert.deepEqual(policy.normalizeDomainKeys(undefined), []);
  assert.throws(() => policy.normalizeDomainKeys(["not a domain"]), /signature domain/);
  assert.throws(() => policy.normalizeDomainKeys(["northstar.example", "@northstar.example"]), /only once/);
  const headers = recipientHeaders("Delivered-To: leo@gmail.com\r\nX-Original-To:\r\n leo@northstar.example\r\nReceived: by mx.example for <leo@second.example>; Mon, 1 Jan\r\nX-Envelope-To: inbound@relay.example\r\n\r\nX-Original-To: body@evil.example");
  assert.deepEqual(headers, { originalTo: ["leo@northstar.example"], deliveredTo: ["leo@gmail.com"], envelopeTo: ["leo@second.example", "inbound@relay.example"], replyTo: [] });
}

async function hostRoundTrips() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-compose-identity-"));
  const env = Object.fromEntries(["MORROW_MAIL_DIR", "MORROW_USER_DATA", "MORROW_MAIL_SECRETS"].map((key) => [key, process.env[key]]));
  process.env.MORROW_MAIL_DIR = dir; process.env.MORROW_USER_DATA = dir; process.env.MORROW_MAIL_SECRETS = "memory";
  const engine = require("../host/mail/engine"), db = require("../host/mail/db");
  const remote = require("../host/mail/remote"), provider = require("../host/mail/provider-api");
  const sidecar = require("../host/mail/sidecar"), settings = require("../host/settings");
  const secrets = require("../host/mail/secrets");
  const saved = { withClient: remote.withClient, sendSmtp: remote.sendSmtp, appendRaw: remote.appendRaw, fetchSource: remote.fetchSource };
  const savedToken = sidecar.gmailSendAsToken, savedList = provider.listSendAs;
  const request = async (channel, params) => {
    const result = await engine.answer(channel, [params]);
    assert.equal(result.success, true, JSON.stringify(result.error)); return result.data;
  };
  try {
    await engine.init();
    db.insertAccount({ id: account.id, email: account.email, username: account.email, profile: "gmail", createdAt: Date.now(),
      imapHost: "imap.example.com", imapPort: 993, imapTls: true, smtpHost: "smtp.example.com", smtpPort: 587, smtpTls: true });
    secrets.setPassword(account.id, "fixture");
    db.replaceFolders(account.id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }, { path: "Drafts", name: "Drafts", wellKnown: "drafts" }, { path: "Sent", name: "Sent", wellKnown: "sentitems" }], "/");
    settings.answer("emailBrain:saveComposeSettings", [prefs]);
    settings.answer("config:setTheme", ["dark"]);
    assert.deepEqual(settings.answer("emailBrain:getComposeSettings", []), prefs, "ordinary settings writes retain Brain defaults");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"))).brainCompose.accounts.aliases.aliases[0].address, "inbound@relay.example");
    const providerResult = await savedList("fixture", async (url, init) => {
      assert.match(String(url), /\/settings\/sendAs$/); assert.equal(init.method, "GET");
      return { ok: true, status: 200, text: async () => JSON.stringify({ sendAs: [
        { sendAsEmail: account.email, isPrimary: true },
        { sendAsEmail: "leo@northstar.example", verificationStatus: "accepted" },
        { sendAsEmail: "pending@example.com", verificationStatus: "pending" },
      ] }) };
    });
    assert.deepEqual(providerResult.map((row) => row.email), [account.email, "leo@northstar.example"]);
    sidecar.gmailSendAsToken = async () => ({ accessToken: "fixture" });
    let fetches = 0;
    provider.listSendAs = async () => { fetches++; return account.sendAs; };
    const rawSource = Buffer.from("From: client@client.example\r\nTo: Leo <leo@northstar.example>\r\nDelivered-To: leo@gmail.com\r\nX-Original-To: leo@northstar.example\r\nSubject: Alias\r\n\r\nHello");
    const fetched = await remote.fetchSource({ getMailboxLock: async () => ({ release() {} }), mailbox: { uidValidity: 1 },
      fetch: async function* () { yield { uid: 1, source: rawSource, envelope: { from: [{ address: "client@client.example" }], to: [{ address: "leo@northstar.example" }] } }; }
    }, "INBOX", 1, 1);
    assert.deepEqual(fetched.recipientHeaders.originalTo, ["leo@northstar.example"]);
    db.applyFolderSync(account.id, "INBOX", { validity: 1, messages: [{ ...fetched, id: "alias-message" }], keepOthers: true });
    db.applyFolderSync(account.id, "INBOX", { validity: 1, messages: [fetched], keepOthers: true });
    assert.deepEqual((await request("mail:openEmail", { emailId: "alias-message" })).email.recipientHeaders.originalTo, ["leo@northstar.example"]);
    const context = await request("mail:getComposeContext", { accountId: account.id, sourceMessageId: "alias-message", kind: "reply" });
    assert.equal(context.fromAddress, "leo@northstar.example"); assert.equal(context.domain, "northstar.example");
    assert.equal(engine.accountViews()[0].preferredFromAddress, "leo@second.example");
    assert.equal(fetches, 1);
    await request("mail:getComposeContext", { accountId: account.id }); assert.equal(fetches, 1, "compose reuses a fresh Gmail alias cache");
    db.updateMessage("alias-message", { recipient_headers_json: null });
    let sourceFetches = 0;
    remote.withClient = async (_account, _secret, work) => work({});
    remote.fetchSource = async () => { sourceFetches++; return fetched; };
    await request("mail:openEmail", { emailId: "alias-message" });
    await request("mail:openEmail", { emailId: "alias-message" });
    assert.equal(sourceFetches, 1, "older complete bodies refresh recipient headers once");
    const badSource = await engine.answer("mail:getComposeContext", [{ accountId: account.id, sourceMessageId: "missing" }]);
    assert.equal(badSource.success, false);
    const appended = [], sent = [];
    remote.appendRaw = async (_client, _folder, raw) => { appended.push(String(raw)); return null; };
    remote.sendSmtp = async (_account, _secret, options) => { sent.push(options); return { messageId: "<sent@example.com>" }; };
    const payload = { accountId: account.id, fromAddress: context.fromAddress, to: "client@client.example", cc: "", body: "<p>Reviewed</p>" };
    const draft = await request("mail:upsertDraft", payload);
    assert.equal(db.messageById(draft.emailId).from_addr, "leo@northstar.example");
    assert.match(appended[0], /From: leo@northstar.example/);
    assert.doesNotMatch(appended[0], /Cc: manager/);
    await request("mail:send", payload);
    assert.equal(sent[0].from, "leo@northstar.example"); assert.deepEqual(sent[0].cc, [], "the host never restores cleared CC");
    const scheduled = await request("mail:scheduleSend", { ...payload, sendAt: new Date(Date.now() + 60000).toISOString() });
    assert.equal(JSON.parse(db.scheduledById(scheduled.id).payload_json).fromAddress, context.fromAddress);
    db.setScheduledSendAt(scheduled.id, Date.now() - 1000);
    await engine.pumpScheduled();
    assert.equal(sent[1].from, "leo@northstar.example");
    const editQueue = await request("mail:scheduleSend", { ...payload, sendAt: new Date(Date.now() + 60000).toISOString() });
    const edited = await request("mail:editScheduled", { id: editQueue.id });
    assert.equal(db.messageById(edited.emailId).from_addr, context.fromAddress);
    const changed = structuredClone(prefs);
    changed.accounts.aliases.aliases.push({ address: "pending@example.com", domain: "" });
    settings.answer("emailBrain:saveComposeSettings", [changed]);
    const rejected = await engine.answer("mail:send", [{ ...payload, fromAddress: "pending@example.com" }]);
    assert.equal(rejected.success, false); assert.match(rejected.error.message, /Verify/);
    assert.equal(sent.length, 2, "a known unverified Gmail alias must not fall back to primary");
    const before = settings.answer("emailBrain:getComposeSettings", []);
    assert.throws(() => settings.answer("emailBrain:saveComposeSettings", [{ ccByDomain: { "broken": [] } }]));
    assert.deepEqual(settings.answer("emailBrain:getComposeSettings", []), before);

    // Real MIME + production draft/queue paths. Every transport below remains
    // synthetic: raw bytes are parsed locally and no mailbox is contacted.
    const { simpleParser } = require("mailparser");
    const name = '陳美玲, "Morrow"';
    const namedPrefs = structuredClone(prefs);
    namedPrefs.accounts.aliases.senderNames = { "leo@northstar.example": name };
    settings.answer("emailBrain:saveComposeSettings", [namedPrefs]);
    provider.listSendAs = async () => [
      { email: account.email, name: "Gmail Primary", verified: true, source: "gmail", isPrimary: true },
      { email: "leo@northstar.example", name: "Gmail Business", verified: true, source: "gmail", isDefault: true },
    ];
    const namedContext = await request("mail:getComposeContext", { accountId: account.id, refresh: true });
    assert.equal(namedContext.fromDisplayName, name);
    const namedPayload = { ...payload, fromDisplayName: name };
    const namedDraft = await request("mail:upsertDraft", namedPayload);
    const namedRow = db.messageById(namedDraft.emailId);
    assert.equal(namedRow.from_display_name, name);
    const draftMime = await simpleParser(Buffer.from(appended.at(-1)));
    assert.equal(draftMime.from.value[0].name, name);
    assert.equal(draftMime.from.value[0].address, "leo@northstar.example");
    const opened = (await request("mail:openEmail", { emailId: namedDraft.emailId, full: true })).email;
    assert.equal(opened.fromDisplayName, name);
    const queued = await request("mail:scheduleSend", { ...namedPayload, sendAt: new Date(Date.now() + 60000).toISOString() });
    namedPrefs.accounts.aliases.senderNames["leo@northstar.example"] = "Changed later";
    settings.answer("emailBrain:saveComposeSettings", [namedPrefs]);
    const savedText = await request("mail:upsertDraft", { ...namedPayload, emailId: namedDraft.emailId, draftRevision: opened.draftRevision, body: "<p>Edited text</p>" });
    assert.equal(db.messageById(savedText.emailId).from_display_name, name, "editing text retains the selected snapshot");
    db.setScheduledSendAt(queued.id, Date.now() - 1000); await engine.pumpScheduled();
    assert.deepEqual(sent.at(-1).from, { address: "leo@northstar.example", name });
    const sentMime = await simpleParser(await remote.buildRaw(sent.at(-1)));
    assert.equal(sentMime.from.value[0].name, name);
    const cachedSent = db.selectMessages({ accountId: account.id, folderId: "Sent" });
    assert.ok(cachedSent.some(row => row.from_display_name === name));
    const recovering = await request("mail:scheduleSend", { ...namedPayload, sendAt: new Date(Date.now() + 60000).toISOString() });
    const recovered = await request("mail:editScheduled", { id: recovering.id });
    assert.equal(db.messageById(recovered.emailId).from_display_name, name);
    const count = sent.length;
    for (const channel of ["mail:upsertDraft", "mail:scheduleSend", "mail:send"]) {
      const invalid = await engine.answer(channel, [{ ...namedPayload, fromDisplayName: "Bad\r\nBcc: intruder@example.com", sendAt: new Date(Date.now() + 60000).toISOString() }]);
      assert.equal(invalid.success, false); assert.equal(invalid.error.code, "invalid_from");
    }
    assert.equal(sent.length, count);
    await request("mail:send", { ...namedPayload, fromDisplayName: "" });
    assert.equal(sent.at(-1).from, "leo@northstar.example", "address-only overrides do not inherit a name");
    db.insertMessage({ id: "legacy-named", accountId: account.id, folderPath: "Drafts", isDraft: true,
      from: '"Legacy, Name" <leo@northstar.example>', bodyComplete: true, textBody: "Legacy", date: new Date().toISOString(), listSortTs: Date.now() });
    assert.equal((await request("mail:openEmail", { emailId: "legacy-named", full: true })).email.fromDisplayName, "Legacy, Name");
    // Exercise actual draft hydration -> renderer payload -> transport MIME.
    // A primary default ensures reparsing the display label cannot accidentally
    // pass by falling back to the same alias under test.
    namedPrefs.accounts.aliases.preferredFromAddress = account.email;
    settings.answer("emailBrain:saveComposeSettings", [namedPrefs]);
    const { ui, get } = composeUi();
    ui.context.connectedAccounts = engine.accountViews(); ui.context.hostRequest = request;
    ui.run(`
      state.accounts=connectedAccounts; state.accountId='aliases';
      resetDraftWrite=()=>{}; syncScheduleFields=()=>{}; paintComposeChrome=()=>{};
      paintQuoteBody=()=>{}; scheduleComposeLayout=()=>{};
      fillSignatures=async()=>{}; loadScheduled=async()=>{}; showComposeSuggestions=async()=>{};
      call=async(channel,params)=>hostRequest(channel,params);
    `);
    for (const displayName of ['Operations <West>', '陳美玲, "Ops <香港>"']) {
      const outgoing = { ...payload, fromDisplayName: displayName };
      const savedAlias = await request("mail:upsertDraft", outgoing);
      const queuedAlias = await request("mail:scheduleSend", { ...outgoing, sendAt: new Date(Date.now() + 60000).toISOString() });
      const recoveredAlias = await request("mail:editScheduled", { id: queuedAlias.id });
      for (const id of [savedAlias.emailId, recoveredAlias.emailId]) {
        const hydrated = (await request("mail:openEmail", { emailId: id, full: true })).email;
        assert.equal(hydrated.fromAddress, payload.fromAddress);
        assert.equal(hydrated.fromDisplayName, displayName);
        assert.match(hydrated.from, /<West>|<香港>/);
        ui.context.toResume = { id, accountId: account.id };
        await ui.run("resumeDraft(toResume)");
        const resumed = ui.run("composePayload(composeAccount())");
        assert.equal(resumed.fromAddress, payload.fromAddress, "display-name brackets must never select the primary account");
        assert.equal(resumed.fromDisplayName, displayName);
        await request("mail:send", resumed);
        const parsed = await simpleParser(await remote.buildRaw(sent.at(-1)));
        assert.equal(parsed.from.value[0].address, payload.fromAddress);
        assert.equal(parsed.from.value[0].name, displayName);
        ui.run("state.composeBaseline=composeSnapshot()"); await ui.run("requestComposeClose()");
      }
    }
    console.log("sender-names-host-ok: MIME Unicode/quotes, draft resume/edit, scheduled snapshots/recovery, Sent and injection gates");
  } finally {
    Object.assign(remote, saved); sidecar.gmailSendAsToken = savedToken; provider.listSendAs = savedList;
    secrets.deletePassword(account.id); db.close();
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function composeUi() {
  const { renderer } = require("./check-ux-workflows");
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8"));
  const previewDocument = dom.window.document;
  for (const dialog of previewDocument.querySelectorAll("dialog")) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
  }
  const nodes = new Map();
  const get = (id) => {
    if (id.startsWith("compose-preview")) return previewDocument.getElementById(id);
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {},
      classList: { toggle() {} }, focus() {}, setSelectionRange() {}, replaceChildren() {}, appendChild() {},
      close() { this.open = false; }, showModal() { this.open = true; } });
    return nodes.get(id);
  };
  const ui = renderer({ document: { getElementById: get, querySelector: () => null,
    createElement: (tag) => previewDocument.createElement(tag), createTextNode: (text) => previewDocument.createTextNode(text) } });
  return { ui, get, close: () => dom.window.close() };
}

async function rendererFlows() {
  const { ui, get, close } = composeUi();
  ui.context.fixtureAccount = account; ui.context.fixturePrefs = prefs;
  ui.run(`
    state.accounts = [{...fixtureAccount, platform:'imap'}]; state.accountId='aliases'; state.prefs.undoSend=0;
    resetDraftWrite = () => {}; syncScheduleFields = () => {}; paintComposeChrome = () => {};
    paintQuoteBody = () => {}; scheduleComposeLayout = () => {};
    fillSignatures = async () => {}; loadScheduled = async () => {}; loadList = async () => {};
    globalThis.original = {id:'source',accountId:'aliases',from:'client@client.example',to:['leo@northstar.example','leo@gmail.com'],cc:['other@other.example'],subject:'Hello'};
    globalThis.calls=[]; globalThis.failed=false;
    call = async (channel, payload) => {
      calls.push({channel,payload});
      if(channel === 'mail:getComposeContext') {
        if(failed) throw new Error('IPC failed');
        return {...window.morrowComposePolicy.resolve(fixtureAccount, payload.sourceMessageId ? original : null, fixturePrefs, payload.kind, payload.fromAddress),settings:fixturePrefs};
      }
      if(channel === 'mail:upsertDraft') return {draftId:'saved'};
      return {};
    };
  `);
  for (const kind of ["reply", "all", "forward"]) {
    await ui.run(`openCompose(composeSeed(original, '${kind}', fixtureAccount.email))`);
    assert.equal(ui.run("composePayload(composeAccount()).sourceMessageId"), "source");
    assert.equal(ui.run("composePayload(composeAccount()).kind"), kind);
    assert.equal(get("compose-from").value, "leo@northstar.example");
    assert.match(get("compose-cc").value, /manager@northstar.example/);
    assert.match(get("compose-bcc").value, /audit@northstar.example/);
    assert.doesNotMatch(get("compose-cc").value, /leo@/);
    assert.equal(ui.run("state.composeIdentity.seeds.cc.locked || state.composeIdentity.seeds.bcc.locked"), false);
    if (kind === "all") assert.match(get("compose-cc").value, /other@other.example/);
    if (kind === "forward") assert.equal(get("compose-to").value, "");
    get("compose-from").value = "leo@second.example"; ui.run("changeComposeFrom()");
    assert.match(get("compose-cc").value, /ops@second.example/);
    assert.doesNotMatch(get("compose-cc").value, /manager@northstar.example/);
    assert.equal(get("compose-bcc").value, "");
    get("compose-cc").value = ""; ui.run("state.composeIdentity.seeds.cc.locked=true");
    get("compose-from").value = "leo@northstar.example"; ui.run("changeComposeFrom(); syncCompose(); paintComposeNote()");
    assert.equal(get("compose-cc").value, "", "From changes and repaint must respect a manual clear");
    assert.equal(get("compose-bcc").value, "audit@northstar.example");
    get("compose-to").value = "client@client.example";
    await ui.run("saveDraft()"); await ui.run("scheduleMail()");
    ui.run("state.composeQueued=false"); await ui.run("sendMail()");
  }
  const writes = ui.run("calls.filter(row => ['mail:upsertDraft','mail:scheduleSend','mail:send'].includes(row.channel))");
  assert.equal(writes.length, 9);
  assert.ok(writes.every(row => row.payload.sourceMessageId === "source"));
  assert.deepEqual(Array.from(writes, row => row.payload.kind), ["reply", "reply", "reply", "all", "all", "all", "forward", "forward", "forward"]);
  assert.ok(writes.every((row) => row.payload.fromAddress === "leo@northstar.example" && !row.payload.cc && row.payload.bcc === "audit@northstar.example"));
  await ui.run("openCompose({draftId:'saved',accountId:'aliases',fromAddress:'leo@northstar.example',cc:'',bcc:'secret@example.com',body:'Saved'})");
  assert.equal(get("compose-from").value, "leo@northstar.example");
  assert.equal(get("compose-cc").value, "");
  assert.equal(get("compose-bcc").value, "secret@example.com");
  assert.equal(ui.run("state.composeIdentity.seeds.cc.locked && state.composeIdentity.seeds.bcc.locked"), true);
  get("compose-from").value = "leo@second.example"; ui.run("changeComposeFrom()");
  assert.equal(get("compose-cc").value, "", "resumed drafts never acquire new recipients");
  assert.equal(get("compose-bcc").value, "secret@example.com");
  ui.run("state.composeBaseline=composeSnapshot()"); await ui.run("requestComposeClose()");
  await ui.run(`openCompose({accountId:'aliases',to:'client@client.example',cc:'kept@example.com',bcc:'secret@example.com',body:'Proposal',botDraft:{proposalId:'p',accountId:'aliases',to:'client@client.example',cc:'kept@example.com',bcc:'secret@example.com',subject:'',body:'Proposal'}})`);
  assert.equal(get("compose-cc").value, "kept@example.com");
  assert.equal(get("compose-bcc").value, "secret@example.com");
  get("compose-from").value = "leo@northstar.example"; ui.run("changeComposeFrom()");
  assert.equal(get("compose-cc").value, "kept@example.com");
  assert.equal(get("compose-bcc").value, "secret@example.com");
  ui.run("state.composeBaseline=composeSnapshot()"); await ui.run("requestComposeClose()");
  await ui.run("openCompose(composeSeed(original, 'reply', fixtureAccount.email))");
  ui.run("state.composeIdentity.seeds.bcc.locked=true");
  get("compose-bcc").value = "typed@example.com";
  get("compose-from").value = "leo@second.example"; ui.run("changeComposeFrom()");
  assert.equal(get("compose-bcc").value, "typed@example.com");
  assert.match(get("compose-cc").value, /ops@second.example/);
  assert.doesNotMatch(get("compose-cc").value, /manager@northstar.example/);
  ui.run("state.composeIdentity.seeds.cc.locked=true");
  get("compose-cc").value = "typed-cc@example.com";
  get("compose-from").value = "leo@northstar.example"; ui.run("changeComposeFrom()");
  assert.equal(get("compose-cc").value, "typed-cc@example.com");
  assert.equal(get("compose-bcc").value, "typed@example.com");
  ui.run("state.composeBaseline=composeSnapshot()"); await ui.run("requestComposeClose()");
  ui.run("state.composeBaseline=composeSnapshot()"); await ui.run("requestComposeClose()");
  await ui.run("openCompose()"); assert.equal(get("compose-from").value, "leo@second.example");
  assert.equal(get("compose-cc").value, "ops@second.example");
  assert.equal(get("compose-bcc").value, "");
  assert.doesNotMatch(get("compose-from-note").textContent, /Signature domain/);
  ui.run("state.composeBaseline=composeSnapshot()"); await ui.run("requestComposeClose()");
  await ui.run("openCompose({fromAddress:'leo@gmail.com'})");
  assert.equal(get("compose-cc").value, "project@project.example");
  assert.equal(get("compose-bcc").value, "logs@gmail.com");
  assert.match(get("compose-from-note").textContent, /CC domain: project\.example\./);
  assert.match(get("compose-from-note").textContent, /Signature domain: gmail\.com\./);
  ui.run("state.composeBaseline=composeSnapshot()"); await ui.run("requestComposeClose()");
  ui.run(`
    fixtureAccount = {...fixtureAccount, sendAs:[
      {email:'leo@gmail.com',name:'Gmail Owner',source:'gmail',verified:true},
      {email:'leo@northstar.example',name:'Business',source:'gmail',verified:true},
      {email:'leo@second.example',name:'Second',source:'gmail',verified:true,isDefault:true}]};
    fixturePrefs = {...fixturePrefs, accounts:{...fixturePrefs.accounts,aliases:{...fixturePrefs.accounts.aliases,
      senderNames:{'leo@northstar.example':'Morrow Business','leo@second.example':'Morrow Second'}}}};
  `);
  await ui.run("openCompose()");
  assert.equal(ui.run("composePayload(composeAccount()).fromDisplayName"), "Morrow Second");
  ui.run("fixturePrefs.accounts.aliases.senderNames['leo@second.example']='Newer default'");
  assert.equal(ui.run("composePayload(composeAccount()).fromDisplayName"), "Morrow Second", "an open composition retains its previewed name");
  get("compose-to").value = "client@client.example";
  ui.run("requestSendNowPreview()");
  assert.equal(get("compose-preview-from").textContent, "Morrow Second <leo@second.example>");
  ui.run("cancelComposePreview()");
  get("compose-from").value = "leo@gmail.com"; ui.run("changeComposeFrom()");
  assert.equal(ui.run("composePayload(composeAccount()).fromDisplayName"), "Gmail Owner");
  get("compose-from").value = "leo@northstar.example"; ui.run("changeComposeFrom()");
  assert.equal(ui.run("composePayload(composeAccount()).fromDisplayName"), "Morrow Business");
  ui.run("state.composeBaseline=composeSnapshot()"); await ui.run("requestComposeClose()");
  await ui.run("openCompose({draftId:'saved',fromAddress:'leo@northstar.example',fromDisplayName:'Saved draft name'})");
  assert.equal(ui.run("composePayload(composeAccount()).fromDisplayName"), "Saved draft name");
  assert.match(get("compose-from-note").textContent, /Recipients see: Saved draft name <leo@northstar.example>/);
  ui.run("state.composeBaseline=composeSnapshot()"); await ui.run("requestComposeClose()");
  ui.run(`
    const priorCall=call;
    call=async(channel,params)=>channel==='mail:openEmail' ? {email:restoredDraft} : priorCall(channel,params);
    askConfirm=async()=>({ok:true});
  `);
  for (const displayName of ['Operations <West>', '陳美玲, "Ops <香港>"']) {
    ui.context.restoredDraft = { id: "restored", isDraft: true, accountId: "aliases", fromAddress: "leo@northstar.example",
      fromDisplayName: displayName, from: displayName + " <leo@northstar.example>", to: ["client@client.example"], textBody: "Restored text", bodyComplete: true };
    await ui.run("resumeDraft({id:'restored',accountId:'aliases'})");
    assert.equal(ui.run("composePayload(composeAccount()).fromAddress"), "leo@northstar.example");
    assert.equal(ui.run("composePayload(composeAccount()).fromDisplayName"), displayName);
    ui.run("state.composeBaseline=composeSnapshot()"); await ui.run("requestComposeClose()");
  }
  ui.context.restoredDraft = { id: "missing-sender", isDraft: true, accountId: "aliases", from: "Ambiguous <West>" };
  await assert.rejects(ui.run("resumeDraft({id:'missing-sender',accountId:'aliases'})"), /sender address.*saved draft was retained/);
  ui.run("failed=true");
  await ui.run("openCompose()"); get("compose-to").value = "client@client.example";
  const count = ui.run("calls.length"); await ui.run("saveDraft(); scheduleMail(); sendMail()");
  assert.equal(ui.run("calls.length"), count, "identity failure blocks keyboard/programmatic send as well as buttons");
  assert.equal(get("compose-send").disabled, true);
  close();
}

function brainLines() {
  const context = vm.createContext({ window: { morrowComposePolicy: policy }, document: { getElementById() { return null; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/brain-compose.js"), "utf8"), context);
  const parse = (text, label) => JSON.parse(JSON.stringify(context.window.morrowBrainCompose.parseDomainLines(text, label)));
  assert.deepEqual(parse("@NORTHSTAR.example = Audit@northstar.example; audit@northstar.example", "BCC"), { "northstar.example": ["Audit@northstar.example", "audit@northstar.example"] });
  assert.throws(() => parse("@northstar.example = a@northstar.example\nnorthstar.example = b@northstar.example", "BCC"), /Each BCC domain can appear only once/);
  assert.throws(() => parse("@northstar.example = a@northstar.example\n@northstar.example = b@northstar.example", "CC"), /Each CC domain can appear only once/);
  assert.throws(() => parse("not a domain = a@northstar.example", "BCC"), /each BCC line/);
  const quoted = '@example.com = "Smith, John" <john@example.com>, jane@example.com';
  assert.deepEqual(parse(quoted, "CC"), { "example.com": ['"Smith, John" <john@example.com>', "jane@example.com"] });
  assert.throws(() => parse("@example.com = Smith, John <john@example.com>", "CC"), /valid CC email addresses/);
  const saved = [];
  function saveLike(text) {
    const ccByDomain = context.window.morrowBrainCompose.parseDomainLines(text, "CC");
    saved.push(policy.normalizeSettings({ ccByDomain, bccByDomain: {}, accounts: {} }));
  }
  saveLike(quoted);
  assert.deepEqual(saved[0].ccByDomain, { "example.com": ["john@example.com", "jane@example.com"] });
  assert.throws(() => saveLike("@example.com = not-an-email, jane@example.com"), /valid CC email addresses/);
  assert.equal(saved.length, 1);
  const advanced = context.window.morrowBrainCompose.advancedHasRules;
  assert.equal(advanced({}), false);
  assert.equal(advanced({ accounts: { a: { preferredFromAddress: "a@b.co", senderNames: { "a@b.co": "A" } } } }), false);
  assert.equal(advanced({ ccByDomain: { "ex.com": ["a@ex.com"] } }), true);
  assert.equal(advanced({ bccByDomain: { "ex.com": ["a@ex.com"] } }), true);
  assert.equal(advanced({ accounts: { a: { aliases: [{ address: "a@ex.com" }] } } }), true);
  assert.equal(advanced({ accounts: { a: { defaultDomain: " ex.com " } } }), true);
}

function disclosureDocument() {
  const nodes = new Map();
  function make() {
    return { value: "", textContent: "", disabled: false, open: false, dataset: {}, className: "",
      classList: { toggle() {} }, children: [],
      setAttribute() {}, addEventListener() {}, appendChild(child) { this.children.push(child); return child; },
      replaceChildren() { this.children = []; }, querySelectorAll() { return []; } };
  }
  return { getElementById(id) { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); }, createElement: make, nodes };
}

async function advancedDisclosure() {
  const closed = disclosureDocument();
  const open = disclosureDocument();
  async function load(document, settings) {
    const context = vm.createContext({ window: { morrowComposePolicy: policy }, document });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/brain-compose.js"), "utf8"), context);
    await context.window.morrowBrainCompose.load({
      accounts: () => [{ id: "a", email: "a@one.test" }],
      selectedId: () => "a",
      call: async () => settings,
    });
    return document.getElementById("brain-compose-advanced").open;
  }
  assert.equal(await load(closed, { ccByDomain: {}, bccByDomain: {}, accounts: {} }), false);
  assert.equal(await load(open, { ccByDomain: { "ex.com": ["a@ex.com"] }, bccByDomain: {}, accounts: {} }), true);
}

async function crossAccountFrom() {
  const nodes = new Map();
  function make(tag) {
    return { tag, value: "", textContent: "", label: "", hidden: false, disabled: false, open: false, dataset: {},
      classList: { toggle() {} }, children: [], style: {},
      appendChild(child) { this.children.push(child); return child; },
      replaceChildren() { this.children = []; },
      focus() {}, setSelectionRange() {}, close() { this.open = false; }, showModal() { this.open = true; },
      addEventListener() {}, setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  }
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, make(id)); return nodes.get(id); },
    createElement: make, querySelector: () => null, addEventListener() {},
  };
  const { renderer } = require("./check-ux-workflows");
  const ui = renderer({ document });
  const other = { id: "other", email: "ada@other.test", platform: "imap", sendAs: [
    { email: "ada@other.test", name: "Ada", displayName: "Ada", source: "account", verified: true },
    { email: "leo@gmail.com", name: "Shared", displayName: "Shared", verified: true },
  ] };
  ui.context.other = other;
  ui.context.fixtureAccount = account;
  ui.context.fixturePrefs = prefs;
  ui.run(`
    state.accounts = [{...fixtureAccount, platform:'imap'}, other, {id:'dead', email:'dead@x.test', sendAs:[{email:'ghost@x.test', verified:true}]}];
    state.accountId = 'aliases'; state.prefs.undoSend = 0;
    resetDraftWrite = () => {}; syncScheduleFields = () => {}; paintComposeChrome = () => {};
    paintQuoteBody = () => {}; scheduleComposeLayout = () => {};
    globalThis.signatureLoads = []; globalThis.calls = []; globalThis.denySwitch = false;
    fillSignatures = async (preserve) => { signatureLoads.push({ preserve, accountId: state.composeMeta.accountId }); };
    loadScheduled = async () => {};
    globalThis.original = {id:'source', accountId:'aliases', from:'client@client.example', to:['leo@northstar.example','leo@gmail.com'],
      cc:['other@other.example'], subject:'Hello', messageId:'<msg@test>', threadId:'thread-a'};
    call = async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel !== 'mail:getComposeContext') return {};
      if (denySwitch && payload.accountId === 'other') return { sendAs: [], fromAddress: payload.fromAddress, settings: fixturePrefs };
      const owner = payload.accountId === 'other' ? other : fixtureAccount;
      return { ...window.morrowComposePolicy.resolve(owner, payload.sourceMessageId ? original : null, fixturePrefs, payload.kind, payload.fromAddress), settings: fixturePrefs };
    };
  `);
  await ui.run("openCompose(composeSeed(original, 'reply', fixtureAccount.email))");
  const from = document.getElementById("compose-from");
  assert.equal(ui.run("state.composeMeta.accountId"), "aliases");
  assert.equal(from.value, "leo@northstar.example");
  assert.match(document.getElementById("compose-to").value, /client@client.example/);
  assert.match(document.getElementById("compose-from-note").textContent, /Mailbox: leo@gmail.com/);
  assert.deepEqual(from.children.map((group) => group.label), ["leo@gmail.com", "ada@other.test"]);
  const emails = from.children.flatMap((group) => group.children.map((option) => option.value));
  assert.equal(emails.filter((email) => email === "leo@gmail.com").length, 1);
  assert.ok(emails.includes("ada@other.test") && emails.includes("leo@northstar.example"));
  assert.ok(!emails.includes("ghost@x.test"));
  assert.equal(from.children[1].children[0].dataset.accountId, "other");
  from.value = "leo@second.example"; ui.run("changeComposeFrom()");
  assert.equal(ui.run("state.composeMeta.accountId"), "aliases");
  assert.match(document.getElementById("compose-cc").value, /ops@second.example/);
  assert.equal(ui.run("calls.filter(row => row.channel === 'mail:getComposeContext').length"), 1);
  ui.run("state.draftId = 'draft-a'; state.draftRevision = 'rev'; denySwitch = true;");
  from.value = "ada@other.test";
  await ui.run("changeComposeFrom()");
  assert.equal(ui.run("state.composeMeta.accountId"), "aliases");
  assert.equal(ui.run("state.draftId"), "draft-a");
  assert.equal(ui.run("state.composeMeta.threadId"), "thread-a");
  assert.match(document.getElementById("compose-from-note").textContent, /Could not switch mailbox/);
  ui.run("state.composeIdentity.signatureFollowsFrom = true; denySwitch = false;");
  from.value = "ada@other.test";
  await ui.run("changeComposeFrom()");
  assert.equal(ui.run("state.composeMeta.accountId"), "other");
  assert.equal(ui.run("state.draftId"), null);
  assert.equal(ui.run("state.composeMeta.threadId"), "");
  assert.equal(ui.run("state.composeMeta.inReplyTo"), "<msg@test>");
  assert.equal(ui.run("composePayload(composeAccount()).accountId"), "other");
  assert.equal(ui.run("composePayload(composeAccount()).fromAddress"), "ada@other.test");
  assert.equal(ui.run("composePayload(composeAccount()).draftId"), undefined);
  assert.doesNotMatch(document.getElementById("compose-cc").value, /manager@northstar.example|ops@second.example/);
  assert.match(document.getElementById("compose-to").value, /client@client.example/);
  assert.match(document.getElementById("compose-from-note").textContent, /Mailbox: ada@other.test/);
  const switched = ui.run("calls.filter(row => row.channel === 'mail:getComposeContext')").at(-1);
  assert.equal(switched.payload.accountId, "other");
  assert.equal(switched.payload.fromAddress, "ada@other.test");
  assert.equal(switched.payload.kind, "reply");
  assert.equal(switched.payload.sourceMessageId, undefined);
  assert.equal(ui.run("signatureLoads.at(-1).accountId"), "other");
  assert.equal(ui.run("signatureLoads.at(-1).preserve"), false);
  from.value = "leo@northstar.example";
  await ui.run("changeComposeFrom()");
  assert.equal(ui.run("state.composeMeta.accountId"), "aliases");
  assert.match(document.getElementById("compose-cc").value, /manager@northstar.example/);
  assert.equal(ui.run("composePayload(composeAccount()).accountId"), "aliases");
}

async function run() { decisions(); brainLines(); await advancedDisclosure(); await hostRoundTrips(); await rendererFlows(); await crossAccountFrom(); console.log("compose-identity-ok"); }
module.exports = { run, rendererFlows, composeUi };
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
