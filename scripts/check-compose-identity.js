const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const policy = require("../shared/compose-policy");
const { recipientHeaders } = require("../host/mail/recipient-headers");

const account = { id: "aliases", email: "leo@gmail.com", sendAs: [
  { email: "leo@hkbscl.com", verified: true },
  { email: "leo@second.example", verified: true, isDefault: true },
] };
const prefs = policy.normalizeSettings({ ccByDomain: {
  "@HKBSCL.com": ["manager@hkbscl.com", "team@hkbscl.com", "MANAGER@hkbscl.com"],
  "second.example": ["ops@second.example"], "project.example": ["project@project.example"],
}, bccByDomain: {
  "@gmail.com": ["logs@gmail.com", "LOGS@gmail.com"],
  "hkbscl.com": ["audit@hkbscl.com"],
  "project.example": ["project-bcc@project.example"],
}, accounts: { aliases: { aliases: [{ address: "inbound@relay.example", domain: "hkbscl.com" }], defaultDomain: "project.example" } } });

function decisions() {
  assert.deepEqual(prefs.ccByDomain["hkbscl.com"], ["manager@hkbscl.com", "team@hkbscl.com"]);
  const gmail = { from: "client@client.example", to: ["Leo <leo@hkbscl.com>", "someone@second.example"],
    recipientHeaders: { deliveredTo: ["leo@gmail.com"] } };
  for (const kind of ["reply", "all", "forward"]) {
    const result = policy.resolve(account, gmail, prefs, kind);
    assert.equal(result.fromAddress, "leo@hkbscl.com", "visible business alias wins over Gmail's primary delivery hop");
    assert.equal(result.domain, "hkbscl.com");
    assert.deepEqual(result.defaultCc, prefs.ccByDomain["hkbscl.com"]);
  }
  const bcc = { to: ["undisclosed-recipients:;"], recipientHeaders: { originalTo: ["leo@second.example"] } };
  assert.equal(policy.resolve(account, bcc, prefs, "reply").fromAddress, "leo@second.example");
  const conflicting = { to: ["leo@hkbscl.com"], recipientHeaders: { originalTo: ["leo@second.example"] } };
  assert.equal(policy.resolve(account, conflicting, prefs, "reply").fromAddress, "leo@second.example");
  const relay = policy.resolve(account, { to: ["inbound@relay.example"] }, prefs, "reply");
  assert.equal(relay.fromAddress, "inbound@relay.example");
  assert.equal(relay.domain, "hkbscl.com", "an explicit CC mapping never rewrites From");
  assert.equal(policy.resolve(account, { to: ["stranger@hkbscl.com"] }, prefs, "reply").fallback, true);
  assert.equal(policy.resolve(account, { cc: ["leo@hkbscl.com"] }, prefs, "all").fromAddress, "leo@hkbscl.com");
  assert.equal(policy.resolve(account, { from: "leo@hkbscl.com", to: ["client@client.example"] }, prefs, "reply").fromAddress, "leo@hkbscl.com");
  assert.equal(policy.resolve(account, null, prefs, "new").fromAddress, "leo@second.example");
  assert.equal(policy.resolve(account, null, prefs, "new", "leo@hkbscl.com").domain, "hkbscl.com");
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
  const pending = { id: "p", email: "me@example.com", sendAs: [{ email: "pending@hkbscl.com", verificationStatus: "pending" }] };
  assert.equal(policy.resolve(pending, { to: ["pending@hkbscl.com"] }, prefs, "reply").fromAddress, pending.email);
  assert.equal(policy.seedRecipients("Manager <manager@hkbscl.com>", ["manager@hkbscl.com", "team@hkbscl.com", "leo@hkbscl.com"],
    ["TEAM@hkbscl.com", ""], ["leo@hkbscl.com"]), "Manager <manager@hkbscl.com>");
  assert.equal(policy.seedRecipients("", ["a@example.com", "b@example.com"], ["", "B@example.com"], []), "a@example.com");
  assert.equal(policy.seedRecipients("Team <team@hkbscl.com>", ["team@hkbscl.com"], ["team@hkbscl.com"], []), "Team <team@hkbscl.com>");
  const aliasPrefs = policy.normalizeSettings({
    ccByDomain: { "hkbscl.com": ["manager@hkbscl.com"], "gmail.com": ["ops@gmail.com"], "project.example": ["project@project.example"] },
    bccByDomain: { "hkbscl.com": ["audit@hkbscl.com"], "gmail.com": ["logs@gmail.com"], "project.example": ["project-bcc@project.example"] },
    accounts: { aliases: { aliases: [{ address: "leo@gmail.com", domain: "@HKBSCL.com" }], defaultDomain: "project.example" } },
  });
  for (const kind of [undefined, "new", "reply", "all", "forward"]) {
    const row = policy.recipientDefaults("Leo <leo@gmail.com>", account, aliasPrefs, kind);
    assert.equal(row.policyDomain, "hkbscl.com", kind || "missing kind");
    assert.equal(row.ccDomain, "hkbscl.com");
    assert.deepEqual(row.cc, ["manager@hkbscl.com"]);
    assert.deepEqual(row.bcc, ["audit@hkbscl.com"]);
  }
  const subdomain = policy.recipientDefaults("leo@mail.hkbscl.com", account, prefs, "new");
  assert.equal(subdomain.policyDomain, "mail.hkbscl.com");
  assert.equal(subdomain.ccDomain, "project.example");
  assert.deepEqual(subdomain.cc, ["project@project.example"]);
  assert.deepEqual(subdomain.bcc, []);
  const subdomainReply = policy.recipientDefaults("leo@mail.hkbscl.com", account, prefs, "reply");
  assert.equal(subdomainReply.policyDomain, "mail.hkbscl.com");
  assert.equal(subdomainReply.ccDomain, "mail.hkbscl.com");
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
  assert.deepEqual(policy.normalizeSettings({ ccByDomain: { "hkbscl.com": ["a@hkbscl.com"] } }).bccByDomain, {});
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
  assert.deepEqual(policy.normalizeDomainKeys(["@HKBSCL.com", " Gmail.com "]), ["hkbscl.com", "gmail.com"]);
  assert.deepEqual(policy.normalizeDomainKeys(["mail.hkbscl.com"]), ["mail.hkbscl.com"]);
  assert.deepEqual(policy.normalizeDomainKeys([]), []);
  assert.deepEqual(policy.normalizeDomainKeys(undefined), []);
  assert.throws(() => policy.normalizeDomainKeys(["not a domain"]), /signature domain/);
  assert.throws(() => policy.normalizeDomainKeys(["hkbscl.com", "@hkbscl.com"]), /only once/);
  const headers = recipientHeaders("Delivered-To: leo@gmail.com\r\nX-Original-To:\r\n leo@hkbscl.com\r\nReceived: by mx.example for <leo@second.example>; Mon, 1 Jan\r\nX-Envelope-To: inbound@relay.example\r\n\r\nX-Original-To: body@evil.example");
  assert.deepEqual(headers, { originalTo: ["leo@hkbscl.com"], deliveredTo: ["leo@gmail.com"], envelopeTo: ["leo@second.example", "inbound@relay.example"] });
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
    db.replaceFolders(account.id, [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }, { path: "Drafts", name: "Drafts", wellKnown: "drafts" }], "/");
    settings.answer("emailBrain:saveComposeSettings", [prefs]);
    settings.answer("config:setTheme", ["dark"]);
    assert.deepEqual(settings.answer("emailBrain:getComposeSettings", []), prefs, "ordinary settings writes retain Brain defaults");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"))).brainCompose.accounts.aliases.aliases[0].address, "inbound@relay.example");
    const providerResult = await savedList("fixture", async (url, init) => {
      assert.match(String(url), /\/settings\/sendAs$/); assert.equal(init.method, "GET");
      return { ok: true, status: 200, text: async () => JSON.stringify({ sendAs: [
        { sendAsEmail: account.email, isPrimary: true },
        { sendAsEmail: "leo@hkbscl.com", verificationStatus: "accepted" },
        { sendAsEmail: "pending@example.com", verificationStatus: "pending" },
      ] }) };
    });
    assert.deepEqual(providerResult.map((row) => row.email), [account.email, "leo@hkbscl.com"]);
    sidecar.gmailSendAsToken = async () => ({ accessToken: "fixture" });
    let fetches = 0;
    provider.listSendAs = async () => { fetches++; return account.sendAs; };
    const rawSource = Buffer.from("From: client@client.example\r\nTo: Leo <leo@hkbscl.com>\r\nDelivered-To: leo@gmail.com\r\nX-Original-To: leo@hkbscl.com\r\nSubject: Alias\r\n\r\nHello");
    const fetched = await remote.fetchSource({ getMailboxLock: async () => ({ release() {} }), mailbox: { uidValidity: 1 },
      fetch: async function* () { yield { uid: 1, source: rawSource, envelope: { from: [{ address: "client@client.example" }], to: [{ address: "leo@hkbscl.com" }] } }; }
    }, "INBOX", 1);
    assert.deepEqual(fetched.recipientHeaders.originalTo, ["leo@hkbscl.com"]);
    db.applyFolderSync(account.id, "INBOX", { validity: 1, messages: [{ ...fetched, id: "alias-message" }], keepOthers: true });
    db.applyFolderSync(account.id, "INBOX", { validity: 1, messages: [fetched], keepOthers: true });
    assert.deepEqual((await request("mail:openEmail", { emailId: "alias-message" })).email.recipientHeaders.originalTo, ["leo@hkbscl.com"]);
    const context = await request("mail:getComposeContext", { accountId: account.id, sourceMessageId: "alias-message", kind: "reply" });
    assert.equal(context.fromAddress, "leo@hkbscl.com"); assert.equal(context.domain, "hkbscl.com");
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
    assert.equal(db.messageById(draft.emailId).from_addr, "leo@hkbscl.com");
    assert.match(appended[0], /From: leo@hkbscl.com/);
    assert.doesNotMatch(appended[0], /Cc: manager/);
    await request("mail:send", payload);
    assert.equal(sent[0].from, "leo@hkbscl.com"); assert.deepEqual(sent[0].cc, [], "the host never restores cleared CC");
    const scheduled = await request("mail:scheduleSend", { ...payload, sendAt: new Date(Date.now() + 60000).toISOString() });
    assert.equal(JSON.parse(db.scheduledById(scheduled.id).payload_json).fromAddress, context.fromAddress);
    db.setScheduledSendAt(scheduled.id, Date.now() - 1000);
    await engine.pumpScheduled();
    assert.equal(sent[1].from, "leo@hkbscl.com");
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
  } finally {
    Object.assign(remote, saved); sidecar.gmailSendAsToken = savedToken; provider.listSendAs = savedList;
    secrets.deletePassword(account.id); db.close();
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function rendererFlows() {
  const { renderer } = require("./check-ux-workflows");
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", hidden: false, disabled: false, open: false, dataset: {},
      classList: { toggle() {} }, focus() {}, setSelectionRange() {}, replaceChildren() {}, appendChild() {},
      close() { this.open = false; }, showModal() { this.open = true; } });
    return nodes.get(id);
  };
  const ui = renderer({ document: { getElementById: get, querySelector: () => null, createElement: () => ({}) } });
  ui.context.fixtureAccount = account; ui.context.fixturePrefs = prefs;
  ui.run(`
    state.accounts = [{...fixtureAccount, platform:'imap'}]; state.accountId='aliases'; state.prefs.undoSend=0;
    resetDraftWrite = () => {}; syncScheduleFields = () => {}; paintComposeChrome = () => {};
    paintQuoteBody = () => {}; scheduleComposeLayout = () => {};
    fillSignatures = async () => {}; loadScheduled = async () => {}; loadList = async () => {};
    globalThis.original = {id:'source',accountId:'aliases',from:'client@client.example',to:['leo@hkbscl.com','leo@gmail.com'],cc:['other@other.example'],subject:'Hello'};
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
    assert.equal(get("compose-from").value, "leo@hkbscl.com");
    assert.match(get("compose-cc").value, /manager@hkbscl.com/);
    assert.match(get("compose-bcc").value, /audit@hkbscl.com/);
    assert.doesNotMatch(get("compose-cc").value, /leo@/);
    assert.equal(ui.run("state.composeIdentity.seeds.cc.locked || state.composeIdentity.seeds.bcc.locked"), false);
    if (kind === "all") assert.match(get("compose-cc").value, /other@other.example/);
    if (kind === "forward") assert.equal(get("compose-to").value, "");
    get("compose-from").value = "leo@second.example"; ui.run("changeComposeFrom()");
    assert.match(get("compose-cc").value, /ops@second.example/);
    assert.doesNotMatch(get("compose-cc").value, /manager@hkbscl.com/);
    assert.equal(get("compose-bcc").value, "");
    get("compose-cc").value = ""; ui.run("state.composeIdentity.seeds.cc.locked=true");
    get("compose-from").value = "leo@hkbscl.com"; ui.run("changeComposeFrom(); syncCompose(); paintComposeNote()");
    assert.equal(get("compose-cc").value, "", "From changes and repaint must respect a manual clear");
    assert.equal(get("compose-bcc").value, "audit@hkbscl.com");
    get("compose-to").value = "client@client.example";
    await ui.run("saveDraft()"); await ui.run("scheduleMail()");
    ui.run("state.composeQueued=false"); await ui.run("sendMail()");
  }
  const writes = ui.run("calls.filter(row => ['mail:upsertDraft','mail:scheduleSend','mail:send'].includes(row.channel))");
  assert.equal(writes.length, 9);
  assert.ok(writes.every((row) => row.payload.fromAddress === "leo@hkbscl.com" && !row.payload.cc && row.payload.bcc === "audit@hkbscl.com"));
  await ui.run("openCompose({draftId:'saved',accountId:'aliases',fromAddress:'leo@hkbscl.com',cc:'',bcc:'secret@example.com',body:'Saved'})");
  assert.equal(get("compose-from").value, "leo@hkbscl.com");
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
  get("compose-from").value = "leo@hkbscl.com"; ui.run("changeComposeFrom()");
  assert.equal(get("compose-cc").value, "kept@example.com");
  assert.equal(get("compose-bcc").value, "secret@example.com");
  ui.run("state.composeBaseline=composeSnapshot()"); await ui.run("requestComposeClose()");
  await ui.run("openCompose(composeSeed(original, 'reply', fixtureAccount.email))");
  ui.run("state.composeIdentity.seeds.bcc.locked=true");
  get("compose-bcc").value = "typed@example.com";
  get("compose-from").value = "leo@second.example"; ui.run("changeComposeFrom()");
  assert.equal(get("compose-bcc").value, "typed@example.com");
  assert.match(get("compose-cc").value, /ops@second.example/);
  assert.doesNotMatch(get("compose-cc").value, /manager@hkbscl.com/);
  ui.run("state.composeIdentity.seeds.cc.locked=true");
  get("compose-cc").value = "typed-cc@example.com";
  get("compose-from").value = "leo@hkbscl.com"; ui.run("changeComposeFrom()");
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
  ui.run("failed=true");
  await ui.run("openCompose()"); get("compose-to").value = "client@client.example";
  const count = ui.run("calls.length"); await ui.run("saveDraft(); scheduleMail(); sendMail()");
  assert.equal(ui.run("calls.length"), count, "identity failure blocks keyboard/programmatic send as well as buttons");
  assert.equal(get("compose-send").disabled, true);
}

function brainLines() {
  const context = vm.createContext({ window: { morrowComposePolicy: policy }, document: { getElementById() { return null; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/brain-compose.js"), "utf8"), context);
  const parse = (text, label) => JSON.parse(JSON.stringify(context.window.morrowBrainCompose.parseDomainLines(text, label)));
  assert.deepEqual(parse("@HKBSCL.com = Audit@hkbscl.com; audit@hkbscl.com", "BCC"), { "hkbscl.com": ["Audit@hkbscl.com", "audit@hkbscl.com"] });
  assert.throws(() => parse("@hkbscl.com = a@hkbscl.com\nhkbscl.com = b@hkbscl.com", "BCC"), /Each BCC domain can appear only once/);
  assert.throws(() => parse("@hkbscl.com = a@hkbscl.com\n@hkbscl.com = b@hkbscl.com", "CC"), /Each CC domain can appear only once/);
  assert.throws(() => parse("not a domain = a@hkbscl.com", "BCC"), /each BCC line/);
}

async function run() { decisions(); brainLines(); await hostRoundTrips(); await rendererFlows(); console.log("compose-identity-ok"); }
module.exports = { run };
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
