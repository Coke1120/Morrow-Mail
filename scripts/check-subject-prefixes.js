// Real composer entrypoints, preview/payload and MIME; synthetic transports only.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { test } = require("node:test");
const { createRequire } = require("node:module");
const { simpleParser } = require("mailparser");
const { renderer } = require("./check-ux-workflows");
const { composeUi } = require("./check-compose-identity");
const { sanitizeComposeSeed } = require("../host/compose-window");
const root = path.join(__dirname, "..");
const source = { id: "synthetic-source", accountId: "synthetic-account", from: "sender@example.invalid", to: ["me@example.invalid"], cc: ["other@example.invalid"],
  subject: "回覆：Re[2]: 進度 日本語 ✉️", messageId: "<source@example.invalid>", threadId: "synthetic-thread", textBody: "Synthetic body", bodyComplete: true };

test("fresh subjects add Re:/Fwd: and safely deduplicate recognized leading prefixes", () => {
  const ui = renderer();
  for (const [input, prefix, expected] of [
    ["進度 日本語 ✉️", "Re:", "Re: 進度 日本語 ✉️"], ["進度 日本語 ✉️", "Fwd:", "Fwd: 進度 日本語 ✉️"],
    ["re: Kept", "Re:", "re: Kept"], ["rE : Kept", "Re:", "rE : Kept"], ["FW: Kept", "Fwd:", "FW: Kept"],
    ["Re: 回覆：回复: 返信: AW: Re[2]: Re(3): 計畫", "Re:", "Re: 計畫"],
    ["Fwd: 轉寄：转发: 転送: WG: Fw[2]: 計畫", "Fwd:", "Fwd: 計畫"],
    ["Re：全形", "Re:", "Re: 全形"], ["fwd(2)：全形", "Fwd:", "Fwd: 全形"],
    ["Fwd: Re: History", "Fwd:", "Fwd: Re: History"], ["Re: Fwd: History", "Re:", "Re: Fwd: History"],
    ["Fwd: Re: History", "Re:", "Re: Fwd: Re: History"], ["Re: History", "Fwd:", "Fwd: Re: History"],
    ["Project: AW: text", "Re:", "Re: Project: AW: text"], ["Regarding this", "Re:", "Re: Regarding this"],
    ["Reply: description", "Re:", "Re: Reply: description"], ["Re[abc]: literal", "Re:", "Re: Re[abc]: literal"],
    ["Re[1234567]: literal", "Re:", "Re: Re[1234567]: literal"], ["", "Re:", "Re:"], ["   ", "Fwd:", "Fwd:"],
  ]) {
    Object.assign(ui.context, { input, prefix });
    assert.equal(ui.run("prefixedSubject(input,prefix)"), expected, input);
  }
});

test("reader, list, Agent, draft-review and suggestion entrypoints preserve prefixed seeds across window serialization", async () => {
  const dom = new (require("jsdom").JSDOM)("<div id='reader'><div class='suggestions'><p data-role='suggest-status'></p><div class='suggest-list'></div></div></div>");
  const ui = renderer({ document: dom.window.document }); ui.context.source = source;
  ui.run(`state.accounts=[{id:'synthetic-account',email:'me@example.invalid',platform:'imap'}];state.accountId='synthetic-account';
    state.email=source;globalThis.seeds=[];
    window.morrow.openComposeWindow=async seed=>{seeds.push(seed);};
    call=async(channel,payload)=>{if(channel==='mail:openEmail')return {email:source};throw Error(channel);};`);
  for (const kind of ["reply", "all", "forward"]) {
    ui.context.kind = kind;
    await ui.run("openReaderCompose(kind,source)");
    await ui.run("replyFromList(source,kind)");
    ui.run("state.email=null"); await ui.run("replyFromList(source,kind)"); ui.run("state.email=source");
  }
  await ui.run("openReplyCompose(source.id)");
  for (const kind of ["reply", "all"]) {
    ui.context.kind = kind;
    await ui.run("replyToAgentItem({messageId:source.id,accountId:source.accountId},kind)");
  }
  await ui.run("reviewDraft({messageId:source.id,accountId:source.accountId,subject:'Untrusted model subject',body:'Synthetic reply'})");
  ui.run("state.suggestions={emailId:source.id,items:['Synthetic suggestion']};paintSuggestions(source)");
  dom.window.document.querySelector(".suggest-list button").click();
  dom.window.close();
  const seeds = ui.run("seeds"); assert.equal(seeds.length, 14);
  for (const raw of seeds) {
    const seed = sanitizeComposeSeed(raw);
    assert.equal(seed.subject, seed.kind === "forward" ? "Fwd: " + source.subject : "Re: 進度 日本語 ✉️");
    assert.equal(seed.inReplyTo, seed.kind === "forward" ? undefined : source.messageId);
    assert.equal(seed.threadId, seed.kind === "forward" ? undefined : source.threadId);
  }
});

function transportFunctions() {
  const take = (file, name) => {
    const match = fs.readFileSync(path.join(root, file), "utf8").match(new RegExp("(?:async )?function " + name + "\\([^]*?^}", "m"));
    assert.ok(match, name); return match[0];
  };
  const messages = [];
  const bindings = { Buffer, require: createRequire(path.join(root, "host/mail/remote.js")),
    MailComposer: require("nodemailer/lib/mail-composer"),
    composeIdentity: { mimeFrom: (_account, address) => address }, addrList: value => value ? String(value).split(",").map(item => item.trim()) : [], plainFromHtml: value => value,
    gmail: { migrated: account => account.mailTransport === "gmail_api", createSession: () => ({ alive() {}, api: { send: async ({ raw }) => { messages.push(raw); return { id: "synthetic-gmail-id" }; } } }) },
    transport: () => ({ close() {}, sendMail: async options => { messages.push(await functions.buildRaw(options)); return { messageId: "synthetic-smtp-id" }; } }),
  };
  const functions = vm.runInNewContext([take("host/mail/engine.js", "mimeOptions"), take("host/mail/remote.js", "buildRaw"), take("host/mail/remote.js", "sendSmtp"),
    "({mimeOptions,buildRaw,sendSmtp})"].join("\n"), bindings);
  return { functions, messages };
}

test("real composer initialization, reviewed payload, draft/schedule writes and Gmail/SMTP MIME retain subjects", async t => {
  const { ui, get, close } = composeUi(); t.after(close); ui.context.source = source;
  ui.run(`state.accounts=[{id:'synthetic-account',email:'me@example.invalid',platform:'imap'}];state.accountId='synthetic-account';state.prefs.undoSend=0;state.prefs.aiReply=false;
    resetDraftWrite=()=>{};syncScheduleFields=()=>{};paintComposeChrome=()=>{};paintQuoteBody=()=>{};scheduleComposeLayout=()=>{};
    fillSignatures=async()=>{};loadScheduled=async()=>{};loadList=async()=>{};showComposeSuggestions=async()=>{};
    globalThis.writes=[];globalThis.draft=null;
    call=async(channel,payload)=>{
      if(channel==='mail:getComposeContext')return {...window.morrowComposePolicy.resolve(state.accounts[0],null,{accounts:{},ccByDomain:{},bccByDomain:{}},payload.kind),settings:{accounts:{},ccByDomain:{},bccByDomain:{}}};
      if(channel==='mail:openEmail')return {email:draft};
      if(['mail:send','mail:upsertDraft','mail:scheduleSend'].includes(channel)){writes.push({channel,payload});return {emailId:'synthetic-draft'};}
      return {};
    };`);
  const { functions, messages } = transportFunctions();
  for (const kind of ["reply", "all", "forward"]) {
    ui.context.kind = kind;
    await ui.run("openCompose(composeSeed(source,kind,'me@example.invalid'))");
    const expected = kind === "forward" ? "Fwd: " + source.subject : "Re: 進度 日本語 ✉️";
    assert.equal(get("compose-subject").value, expected);
    get("compose-to").value = "recipient@example.invalid";
    let payload = ui.run("composePayload(composeAccount())");
    ui.context.payload = payload; ui.run("paintPreview({payload})");
    assert.equal(get("compose-preview-subject").textContent, expected);
    await ui.run("saveDraft()"); ui.run("state.composeQueued=false");
    await ui.run("scheduleMail()"); ui.run("state.composeQueued=false");
    await ui.run("sendMail()");
    const writes = ui.run("writes.slice(-3)");
    assert.deepEqual(Array.from(writes, row => row.channel), ["mail:upsertDraft", "mail:scheduleSend", "mail:send"]);
    for (const write of writes) assert.equal(write.payload.subject, expected);
    for (const mailTransport of ["gmail_api", "imap"]) {
      const account = { email: "me@example.invalid", mailTransport };
      await functions.sendSmtp(account, "synthetic-only", functions.mimeOptions(account, payload, []));
      const parsed = await simpleParser(messages.at(-1));
      assert.equal(parsed.subject, expected);
      assert.equal(parsed.inReplyTo, kind === "forward" ? undefined : source.messageId);
    }
    get("compose-subject").value = "User edited 回覆：Re[2]: subject";
    payload = ui.run("composePayload(composeAccount())"); assert.equal(payload.subject, get("compose-subject").value);
    ui.context.payload = payload; ui.run("paintPreview({payload});state.composeBaseline=composeSnapshot()");
    assert.equal(get("compose-preview-subject").textContent, payload.subject);
    await ui.run("requestComposeClose()");
  }
  // Neither ordinary draft hydration nor recovered snapshots normalize again.
  ui.run(`draft={id:'synthetic-draft',accountId:'synthetic-account',isDraft:true,bodyComplete:true,fromAddress:'me@example.invalid',
    to:['recipient@example.invalid'],subject:'Edited 回覆：Re[2]: saved',textBody:'Synthetic draft'};`);
  await ui.run("resumeDraft({id:'synthetic-draft',accountId:'synthetic-account'})");
  assert.equal(get("compose-subject").value, "Edited 回覆：Re[2]: saved");
  ui.run("state.composeBaseline=composeSnapshot()"); await ui.run("requestComposeClose()");
  await ui.run("openCompose({accountId:'synthetic-account',kind:'reply',recoveredSnapshot:true,subject:'回覆：Re[2]: Saved exactly',to:'recipient@example.invalid',body:'Synthetic'})");
  assert.equal(ui.run("composePayload(composeAccount()).subject"), "回覆：Re[2]: Saved exactly");
});
