// Actual Chromium/renderer interaction with synthetic mail and mocked IPC only.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"), http = require("node:http"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.join(__dirname, "..");
const output = process.env.MORROW_UI_OUTPUT || path.join(require("node:os").tmpdir(), "morrow-message-menu-browser");

(async () => {
  const server = http.createServer((req, res) => {
    const target = path.resolve(root, "." + decodeURI(req.url.split("?")[0]));
    if (!target.startsWith(root + path.sep)) { res.statusCode = 403; res.end(); return; }
    try {
      let data = fs.readFileSync(target);
      if (target.endsWith("/renderer/app.js")) data = data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
      res.setHeader("content-type", target.endsWith(".css") ? "text/css" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".svg") ? "image/svg+xml" : "text/html");
      res.end(data);
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    await page.addInitScript(() => { window.morrow = { on() {} }; });
    await page.goto(origin + "/renderer/index.html");
    await page.evaluate(() => {
      state.view = "mail"; state.accountId = "b"; state.folderId = "INBOX"; state.listSyncDone = true;
      state.accounts = ["a", "b"].map(id => ({ id, email: id + "@fixture.invalid", platform: "imap", imapSmtpProfile: "custom",
        imapUsername: id + "@fixture.invalid", authKind: "password", mailTransport: "imap", bodyEpoch: 1, bodyVersion: 0,
        imapSmtpCustom: { imap: {host:"imap.fixture.invalid",port:993,tls:true}, smtp: {host:"smtp.fixture.invalid",port:465,tls:true} },
        folders: { primary: [{ id: "INBOX", name: "Inbox", wellKnownName: "inbox" }, { id: "Archive", name: "Archive", wellKnownName: "archive" }, { id: "Trash", name: "Trash", wellKnownName: "deleteditems" }], more: [] } }));
      state.localAccount = { id: LOCAL_ACCOUNT_ID, name: "Local Folders", folders: { primary: [{ id: "local-folder:archive", name: "Archive" }], more: [] } };
      state.emails = [{ id: "clicked", accountId: "a", folderId: "INBOX", subject: "Synthetic clicked message", from: "sender@fixture.invalid", unread: true },
        { id: "selected", accountId: "b", folderId: "INBOX", subject: "Unrelated selected message", from: "other@fixture.invalid", unread: false }];
      state.selectedIds = ["selected"]; state.email = state.emails[1];
      globalThis.menuCalls = []; globalThis.crossReviews = new Map(); globalThis.crossSequence = 0;
      globalThis.crossPhase = ""; globalThis.releaseCross = null; globalThis.crossOutcome = "copied";
      globalThis.crossReply = params => {
        if (params.action === "destinations") return { accountId: params.destinationAccountId, copyEnabled: true, copyReason: "", moveEnabled: false,
          moveReason: "Connected Move is unavailable. Sources stay in place.", maxBytes: 33554432, maxMessages: 50, maxTotalBytes: 268435456,
          folders: [{id:"Archive",name:"Archive",path:"Archive",enabled:true,reason:""}, {id:"Trash",name:"Trash",path:"Trash",enabled:false,reason:"Trash cannot receive verified imports."}], notices:["The provider may group copied messages."] };
        if (params.action === "review") {
          const review = {reviewId:"browser-review-"+(++crossSequence),accountId:params.destinationAccountId,folderId:params.folderId,
            sourceCount:params.items.length,sourceLabels:[...new Set(params.items.map(row=>row.accountId+"@fixture.invalid"))],
            destinationLabel:params.destinationAccountId+"@fixture.invalid / "+params.folderId,notices:[],expiresAt:Date.now()+60000,maxBytes:33554432,maxMessages:50,maxTotalBytes:268435456};
          crossReviews.set(review.reviewId,review); return review;
        }
        if (params.action === "cancelReview") return {cancelled:true};
        if (params.action === "copy") { const review = crossReviews.get(params.reviewId); return {status:crossOutcome,receiptId:"receipt-"+params.emailId,
          detail:"Synthetic provider verification.",destination:{accountId:review.accountId,folderId:review.folderId},sourceRetained:true}; }
        throw new Error("Unexpected synthetic cross-mailbox action");
      };
      call = async (channel, params) => {
        menuCalls.push({ channel, params }); if (channel === "mail:localFolders") return state.localAccount;
        if (channel === "mail:crossMailboxCopy") {
          if (params.action === crossPhase) return new Promise(resolve => { releaseCross = () => { releaseCross=null; resolve(crossReply(params)); }; });
          return crossReply(params);
        }
        return { outcomes: (params.items || []).map(item => ({id:item.emailId,status:"completed"})) };
      };
      bulkSetRead = async (isRead, rows) => { menuCalls.push({ action: "read", isRead, ids: rows.map(row => row.id), accounts: rows.map(row => row.accountId) }); };
      wire(); renderAccounts(); renderList(); document.documentElement.dataset.view = "mail";
      globalThis.baselineCrossAccounts = JSON.stringify(state.accounts);
      globalThis.baselineCrossMail = JSON.stringify(state.emails);
      globalThis.resetCrossFixture = () => {
        state.accounts=JSON.parse(baselineCrossAccounts);state.emails=JSON.parse(baselineCrossMail);
        state.accountId="b";state.selectedIds=["selected"];state.email=state.emails[1];
        crossPhase="";crossOutcome="copied";releaseCross=null;renderList();
      };
    });
    const row = page.locator('[data-email-id="clicked"] button.message');
    await row.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Message actions", exact: true });
    await menu.waitFor({ state: "visible", timeout: 3000 }).catch(async error => {
      throw new Error(error.message + " " + JSON.stringify({ errors, state: await page.evaluate(() => ({ menu: document.getElementById('organize-menu')?.outerHTML, active: document.activeElement?.outerHTML, selected: state.selectedIds, debug: menuCalls })) }));
    });
    assert.deepEqual(await page.evaluate(() => state.selectedIds), ["selected"]);
    assert.equal(await page.evaluate(() => state.email.id), "selected");
    await page.screenshot({ path: path.join(output, "wide-menu.png") });
    await page.getByRole("menuitem", { name: "Move to folder…", exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Move / Copy to other mailbox…");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Mark as read");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => menuCalls.some(row => row.action === "read"));
    assert.deepEqual(await page.evaluate(() => menuCalls.find(row => row.action === "read").ids), ["clicked"]);
    assert.deepEqual(await page.evaluate(() => menuCalls.find(row => row.action === "read").accounts), ["a"]);
    await row.focus(); await page.keyboard.press("Shift+F10");
    await menu.waitFor({ state: "visible" }); await page.keyboard.press("End");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Archive");
    await page.keyboard.press("Escape"); assert.equal(await row.evaluate(node => node === document.activeElement), true);
    await page.setViewportSize({ width: 760, height: 640 });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await row.click({ button: "right" }); await menu.waitFor({ state: "visible" });
    assert.equal(await menu.evaluate(node => { const r=node.getBoundingClientRect(); return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight; }), true);
    await page.screenshot({ path: path.join(output, "narrow-dark-menu.png") });
    await page.getByRole("menuitem", { name: "Move / Copy to other mailbox…", exact: true }).click();
    const dialog = page.locator("#local-transfer"); await dialog.waitFor({ state: "visible" });
    assert.equal(await page.locator("#local-transfer-account option:disabled").count(), 0);
    await page.locator("#local-transfer-mode").selectOption("move");
    assert.match(await page.locator("#local-transfer-help").textContent(), /verify a complete local copy first/);
    assert.match(await page.locator("#local-transfer-capability").textContent(), /Local Folders is available/);
    await page.waitForFunction(() => Number(getComputedStyle(document.getElementById("local-transfer")).opacity) >= 0.99);
    await page.screenshot({ path: path.join(output, "narrow-transfer.png") });
    await page.locator("#local-transfer-cancel").click();
    assert.equal(await page.evaluate(() => menuCalls.some(row => /transferToLocal|moveLocalMessage|mail:delete/.test(row.channel || ""))), false);
    await row.click({ button: "right" }); await menu.waitFor({ state: "visible" });
    await page.getByRole("menuitem", { name: "Move / Copy to other mailbox…", exact: true }).click(); await dialog.waitFor({ state: "visible" });
    await page.locator("#local-transfer-account").selectOption("b");
    await page.waitForFunction(() => !document.getElementById("local-transfer-ok").disabled);
    assert.equal(await page.locator('#local-transfer-mode option[value="move"]').isDisabled(), true);
    assert.match(await page.locator("#local-transfer-folder-reasons").textContent(), /Trash cannot receive verified imports/);
    assert.equal(await page.evaluate(() => menuCalls.filter(row=>row.params?.action==="copy").length), 0);
    await page.locator("#local-transfer-ok").click(); await page.locator("#confirm").waitFor({ state: "visible" });
    assert.match(await page.locator("#confirm-body").textContent(), /1 message from a@fixture.invalid.*b@fixture.invalid \/ Archive/);
    assert.match(await page.locator("#confirm-body").textContent(), /Every source message stays in place.*original valid Date header/);
    assert.equal(await page.evaluate(() => document.activeElement.id), "confirm-ok");
    await page.screenshot({ path: path.join(output, "cross-mailbox-review.png") });
    await page.locator("#confirm-cancel").click();
    await page.waitForFunction(() => document.getElementById("local-transfer-status").textContent.includes("No messages were uploaded"));
    assert.equal(await page.evaluate(() => menuCalls.filter(row=>row.params?.action==="copy").length), 0);
    await page.locator("#local-transfer-ok").click(); await page.locator("#confirm").waitFor({ state: "visible" });
    await page.locator("#confirm-ok").click(); await page.waitForFunction(() => document.getElementById("local-transfer-status").textContent.includes("1 copied"));
    assert.deepEqual(await page.evaluate(() => menuCalls.filter(row=>row.params?.action==="copy").map(row=>[row.params.emailId,row.params.accountId])), [["clicked","a"]]);
    await page.evaluate(() => commitLocalTransfer());
    assert.equal(await page.evaluate(() => menuCalls.filter(row=>row.params?.action==="copy").length), 1);
    await page.locator("#local-transfer-cancel").click(); await dialog.waitFor({state:"hidden"});

    // Account updates simulate provider/cache publications while native controls await IPC.
    const mutations = [
      () => { state.accounts[0]={...state.accounts[0],bodyEpoch:2}; },
      () => { state.accounts[0].imapSmtpCustom.imap.host="changed.fixture.invalid"; },
      () => { state.emails[0].folderId="Archive"; },
      () => { state.accounts[0].folders.primary.shift(); },
      () => { state.accounts[1]={...state.accounts[1],bodyEpoch:2}; },
      () => { state.accounts[1].imapSmtpCustom.imap.tls=false; },
      () => { state.accounts[1].folders.primary[1].name="Changed archive"; },
      () => { document.getElementById("local-transfer-folder").value="Trash"; },
      () => { const mode=document.getElementById("local-transfer-mode");mode.value="move";mode.dispatchEvent(new Event("change")); },
    ];
    for (const phase of ["destinations", "review", "confirmation", "copy"]) {
      for (let index=0;index<mutations.length;index++) {
        await page.evaluate(() => {resetCrossFixture();return openLocalTransfer([state.emails[0],{...state.emails[0],id:"second"}],"copy")});
        const copiesBefore = await page.evaluate(() => menuCalls.filter(row=>row.params?.action==="copy").length);
        if (phase === "destinations") await page.evaluate(value => {crossPhase=value}, phase);
        await page.locator("#local-transfer-account").selectOption("b");
        if (phase !== "destinations") {
          await page.waitForFunction(() => !document.getElementById("local-transfer-ok").disabled);
          await page.evaluate(value => {crossPhase=value}, phase === "confirmation" ? "" : phase);
          await page.locator("#local-transfer-ok").click();
          if (phase === "confirmation" || phase === "copy") {
            await page.locator("#confirm").waitFor({state:"visible"});
            if (phase === "copy") await page.locator("#confirm-ok").click();
          }
        }
        if (phase !== "confirmation") await page.waitForFunction(() => typeof releaseCross==="function");
        await page.evaluate(mutations[index]);
        if (phase === "confirmation") await page.locator("#confirm-ok").click();
        else await page.evaluate(() => {releaseCross()});
        await page.waitForFunction(() => !localTransfer?.loading && !localTransfer?.reviewing && !localTransfer?.running);
        assert.equal(await page.evaluate(() => menuCalls.filter(row=>row.params?.action==="copy").length), copiesBefore+(phase==="copy"?1:0), `${phase} mutation ${index}`);
        await page.locator("#local-transfer-cancel").click(); await dialog.waitFor({state:"hidden"});
      }
    }

    for (const hardAncestorChange of [false, true]) {
      await page.evaluate(() => {
        resetCrossFixture();crossPhase="copy";state.accounts[1].delimiter="/";
        Object.assign(state.accounts[1].folders.primary[1],{parentId:"Projects",path:"Projects/2026",providerId:"archive-provider",uidValidity:17,
          flags:["\\HasNoChildren"],selectable:true,readOnly:false});
        state.accounts[1].folders.more.push({id:"Projects",path:"Projects",name:"Projects",providerId:"projects-provider",flags:["\\HasChildren"],readOnly:false});
        return openLocalTransfer([state.emails[0],{...state.emails[0],id:"second"}],"copy");
      });
      const before = await page.evaluate(() => menuCalls.filter(row=>row.params?.action==="copy").length);
      await page.locator("#local-transfer-account").selectOption("b"); await page.locator("#local-transfer-ok").click();
      await page.locator("#confirm").waitFor({state:"visible"}); await page.locator("#confirm-ok").click();
      await page.waitForFunction(() => typeof releaseCross==="function");
      await page.evaluate(hardChange => {
        const destination=state.accounts[1];
        destination.folders.primary[1].unreadCount=42;destination.folders.primary[1].totalCount=99;
        destination.folders.more[0].unreadCount=21;destination.folders.more[0].totalCount=60;
        destination.folders.primary[2].name="Unrelated renamed folder";
        if(hardChange) destination.folders.more[0].flags.push("\\NoSelect");
        releaseCross();
      },hardAncestorChange);
      if (!hardAncestorChange) {
        await page.waitForFunction(count => menuCalls.filter(row=>row.params?.action==="copy").length===count+2,before);
        await page.waitForFunction(() => typeof releaseCross==="function");
        await page.evaluate(() => releaseCross());
      }
      await page.waitForFunction(() => !localTransfer?.running);
      assert.equal(await page.evaluate(() => menuCalls.filter(row=>row.params?.action==="copy").length),before+(hardAncestorChange?1:2));
      assert.match(await page.locator("#local-transfer-status").textContent(),hardAncestorChange?/changed during Copy.*Remaining messages were not copied/:/2 copied.*0 not confirmed or not attempted/);
      if (!hardAncestorChange) {
        const copied = await page.evaluate(count => menuCalls.filter(row=>row.params?.action==="copy").slice(count).map(row=>row.params),before);
        assert.deepEqual(copied.map(row=>row.emailId),["clicked","second"]); assert.equal(copied[0].reviewId,copied[1].reviewId);
        await page.screenshot({path:path.join(output,"cross-mailbox-count-refresh.png")});
      }
      await page.locator("#local-transfer-cancel").click(); await dialog.waitFor({state:"hidden"});
    }

    for (const phase of ["destinations", "review", "confirmation"]) {
      await page.evaluate(() => {resetCrossFixture();return openLocalTransfer([state.emails[0]],"copy")});
      if (phase === "destinations") await page.evaluate(() => {crossPhase="destinations"});
      await page.locator("#local-transfer-account").selectOption("b");
      if (phase !== "destinations") {
        await page.waitForFunction(() => !document.getElementById("local-transfer-ok").disabled);
        if (phase === "review") await page.evaluate(() => {crossPhase="review"});
        await page.locator("#local-transfer-ok").click();
      }
      if (phase === "confirmation") {
        await page.locator("#confirm").waitFor({state:"visible"});
        // Native modal confirmation prevents clicks on the underlying transfer dialog.
        await page.evaluate(() => {closeDialog("local-transfer")});
      } else {
        await page.waitForFunction(() => typeof releaseCross==="function");
        await page.locator("#local-transfer-cancel").click();
      }
      await dialog.waitFor({state:"hidden"});
      await page.evaluate(() => openLocalTransfer([state.emails[1]],"copy"));
      if (phase === "confirmation") await page.evaluate(() => finishConfirm({ok:true}));
      else await page.evaluate(() => {releaseCross()});
      await page.evaluate(() => {document.getElementById("local-transfer").dispatchEvent(new Event("close"))});
      assert.equal(await page.evaluate(() => localTransfer.messages[0].id), "selected");
      assert.equal(await page.locator("#local-transfer-status").textContent(), "");
      await page.locator("#local-transfer-cancel").click(); await dialog.waitFor({state:"hidden"});
    }

    // Unknown and Stop use actual native confirmation, Escape and disabled form controls.
    await page.setViewportSize({width:360,height:640});
    await page.evaluate(() => {resetCrossFixture();crossOutcome="unknown";return openLocalTransfer([state.emails[0],{...state.emails[0],id:"second"}],"copy")});
    await page.locator("#local-transfer-account").selectOption("b"); await page.locator("#local-transfer-ok").click();
    await page.locator("#confirm").waitFor({state:"visible"}); await page.locator("#confirm-ok").click();
    await page.waitForFunction(() => document.getElementById("local-transfer-status").textContent.includes("Automatic retry is blocked"));
    await page.waitForFunction(() => document.activeElement.id==="local-transfer-cancel");
    assert.match(await page.locator("#local-transfer-status").textContent(), /destination may contain a copy.*Automatic retry is blocked/);
    assert.equal(await page.locator("#local-transfer-ok").isDisabled(), true);
    assert.equal(await dialog.evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}),true);
    assert.equal(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
    await page.screenshot({path:path.join(output,"cross-mailbox-unknown-narrow.png")});
    await page.locator("#local-transfer-cancel").click(); await dialog.waitFor({state:"hidden"});
    await page.evaluate(() => {resetCrossFixture();crossPhase="copy";return openLocalTransfer([state.emails[0],{...state.emails[0],id:"second"}],"copy")});
    await page.locator("#local-transfer-account").selectOption("b"); await page.locator("#local-transfer-ok").click();
    await page.locator("#confirm").waitFor({state:"visible"}); await page.locator("#confirm-ok").click();
    await page.waitForFunction(() => typeof releaseCross==="function");
    const started = await page.evaluate(() => menuCalls.filter(row=>row.params?.action==="copy").length);
    await page.keyboard.press("Escape"); assert.equal(await dialog.isVisible(),true);
    await page.evaluate(() => releaseCross());
    await page.waitForFunction(() => document.getElementById("local-transfer-status").textContent.includes("Stopped after the current message"));
    assert.equal(await page.evaluate(() => menuCalls.filter(row=>row.params?.action==="copy").length),started);
    await page.locator("#local-transfer-cancel").click(); await dialog.waitFor({state:"hidden"});
    await page.evaluate(() => showFeatures());
    const help = page.locator(".feature-card").filter({ has: page.getByRole("heading", { name: "Local Folders", exact: true }) });
    await help.scrollIntoViewIfNeeded();
    assert.match(await help.textContent(), /Move \/ Copy to other mailbox/);
    assert.match(await help.textContent(), /Connected receiving mailboxes offer capability-checked Copy/);
    assert.match(await help.textContent(), /already-Trash sources are blocked and rechecked by the host/);
    await page.screenshot({ path: path.join(output, "features.png") });
    const crossHelp = page.locator(".feature-card").filter({ has: page.getByRole("heading", { name: "Cross-mailbox Copy", exact: true }) });
    await crossHelp.scrollIntoViewIfNeeded();
    assert.match(await crossHelp.textContent(), /Copy retains every source message.*separate reviewed Gmail Move.*50 messages and 32 MiB/);
    assert.match(await page.locator("#cli-unavailable").textContent(), /cross-mailbox Copy\/Move.*no bot or CLI command/);
    await page.screenshot({path:path.join(output,"cross-mailbox-features.png")});
    assert.deepEqual(errors, []);
    console.log("message-context-browser-ok: clicked identity, keyboard/focus, Local paths, connected capability/review/confirmation, 36 source/destination/folder/mode await races, two-source count refresh, hard ancestor change, late reopen callbacks, unknown/no replay, Escape stop, narrow bounds and rendered Features/CLI; synthetic IPC only");
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
