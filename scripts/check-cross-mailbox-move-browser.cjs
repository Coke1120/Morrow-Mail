"use strict";
// Real Chromium/renderer/CSS with synthetic gate and provider responses only.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"), http = require("node:http"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-cross-mailbox-move-browser");
(async () => {
  const server = http.createServer((req, res) => {
    const target = path.resolve(root, "." + decodeURI(req.url.split("?")[0]));
    if (!target.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      let data = fs.readFileSync(target);
      if (target.endsWith("/renderer/app.js")) data = data.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
      res.setHeader("content-type", target.endsWith(".css") ? "text/css" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".svg") ? "image/svg+xml" : "text/html"); res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.route("**/*", route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    await page.addInitScript(() => { window.morrow = { on() {} }; });
    await page.goto(origin + "/renderer/index.html");
    await page.evaluate(() => {
      state.accounts = ["a", "b"].map(id => ({ id, email: id + "@fixture.invalid", platform: "imap", bodyEpoch: 1,
        imapSmtpProfile: id === "a" ? "gmail" : "custom", mailTransport: id === "a" ? "gmail_api" : "imap", authKind: id === "a" ? "oauth" : "password",
        folders: { primary: [{ id: "INBOX", name: "Inbox", wellKnownName: "inbox" }, { id: "Archive", name: "Archive" }], more: [] } }));
      state.localAccount = { id: LOCAL_ACCOUNT_ID, folders: { primary: [{ id: "local:archive", name: "Archive" }], more: [] } };
      state.emails = ["one", "two"].map(id => ({ id, accountId: "a", folderId: "INBOX", subject: "Synthetic " + id, from: "sender@fixture.invalid", date: "2026-11-01T12:00:00Z" }));
      state.accountId = "a"; state.folderId = "INBOX"; state.view = "mail"; state.listSyncDone = true;
      window.moveGate = false; window.calls = []; window.sequence = 0; window.copyReviews = new Map(); window.moveReviews = new Map();
      window.holdMove = false; window.moveStatus = "moved";
      window.reply = (channel, p) => {
        if (channel === "mail:localFolders") return state.localAccount;
        if (channel === "mail:crossMailboxCopy") {
          if (p.action === "destinations") return { accountId: p.destinationAccountId, copyEnabled: true, moveEnabled: false, moveReason: "Copy retains sources; Gmail API Move needs its separate review.", folders: [{ id: "Archive", name: "Archive", path: "Archive", enabled: true }], notices: [] };
          if (p.action === "review") { const r = { reviewId: "copy-review-" + (++sequence), accountId: p.destinationAccountId, folderId: p.folderId, sourceCount: p.items.length,
            sourceLabels: ["a@fixture.invalid"], destinationLabel: "b@fixture.invalid / Archive", expiresAt: Date.now() + 60000 }; copyReviews.set(r.reviewId, r); return r; }
          if (p.action === "copy") return { status: "copied", receiptId: "copy-" + p.emailId, sourceRetained: true, destination: { accountId: "b", folderId: "Archive" } };
          if (p.action === "cancelReview") return { cancelled: true };
        }
        if (channel === "mail:crossMailboxMove") {
          if (p.action === "capabilities") return { moveEnabled: moveGate, sourceGmailOnly: true, moveReason: "Gmail source Move is unavailable under this synthetic disabled policy." };
          if (p.action === "review") { const r = { reviewId: "move-review-" + (++sequence), accountId: p.destinationAccountId, folderId: p.folderId, sourceCount: p.items.length,
            entries: p.items.map(item => ({ ...item, copyReceiptId: "copy-" + item.emailId })), sourceLabels: ["a@fixture.invalid"], destinationLabel: "b@fixture.invalid / Archive", expiresAt: Date.now() + 60000 }; moveReviews.set(r.reviewId, r); return r; }
          if (p.action === "move") { if (!p.confirmed || !moveReviews.has(p.reviewId)) throw Error("Missing separate Move confirmation");
            return { status: moveStatus, copyReceiptId: "copy-" + p.emailId, moveReceiptId: "move-" + p.emailId, destination: { accountId: "b", folderId: "Archive" },
              sourceRetained: moveStatus === "unknown" ? null : moveStatus !== "moved", sourceTrashed: moveStatus === "unknown" ? null : moveStatus === "moved" }; }
          if (p.action === "cancelReview") return { cancelled: true };
        }
        if (["mail:vacationGet", "mail:listProviderFolders"].includes(channel)) return {};
        throw Error("Unexpected synthetic invoke " + channel);
      };
      call = async (channel, params = {}) => {
        calls.push({ channel, params });
        if (channel === "mail:crossMailboxMove" && params.action === "move" && holdMove) return new Promise(resolve => { window.releaseMove = () => { releaseMove = null; resolve(reply(channel, params)); }; });
        return reply(channel, params);
      };
      loadList = async () => {}; showStatus = () => {};
      wire(); renderAccounts(); renderList();
    });
    const source = page.locator("button.message").first(); await source.focus();
    const open = async enabled => {
      await page.evaluate(async enabled => { window.moveGate = enabled; await openLocalTransfer(state.emails, "copy"); }, enabled);
      await page.locator("#local-transfer-account").selectOption("b");
      await page.waitForFunction(() => !localTransfer.loading && !localTransfer.moveLoading && localTransfer.moveCapabilityFolder === "Archive");
    };
    await open(false);
    assert.equal(await page.locator('#local-transfer-mode option[value="move"]').isDisabled(), true);
    assert.match(await page.locator("#local-transfer-move-capability").textContent(), /unavailable under this synthetic disabled policy/);
    assert.equal(await page.locator("#local-transfer-ok").isEnabled(), true);
    await page.locator("#local-transfer-cancel").click();
    await page.waitForFunction(() => !document.getElementById("local-transfer").open);
    assert.equal(await source.evaluate(node => document.activeElement === node), true);
    await open(true);
    await page.locator("#local-transfer-mode").selectOption("move");
    await page.waitForFunction(() => !localTransfer.moveLoading && !document.getElementById("local-transfer-ok").disabled);
    assert.equal(await page.locator("#local-transfer-ok").textContent(), "Copy, then review Gmail Trash");
    await page.locator("#local-transfer-ok").click();
    await page.waitForFunction(() => document.getElementById("confirm").open && document.getElementById("confirm-ok").textContent === "Copy messages");
    assert.equal(await page.evaluate(() => calls.filter(row => row.params.action === "move").length), 0);
    await page.locator("#confirm-ok").press("Enter");
    await page.waitForFunction(() => document.getElementById("confirm").open && document.getElementById("confirm-ok").textContent === "Move Gmail originals to Trash");
    assert.equal(await page.evaluate(() => calls.filter(row => row.params.action === "copy").length), 2);
    assert.equal(await page.evaluate(() => calls.filter(row => row.params.action === "move").length), 0);
    assert.match(await page.locator("#confirm-body").textContent(), /separate source action.*across all their labels.*not atomic.*No Undo/);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        assert.equal(await page.locator("#confirm").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
        await page.screenshot({ path: path.join(output, `separate-trash-review-${width}-${theme}.png`) });
      }
    }
    await page.locator("#confirm-cancel").press("Enter");
    await page.waitForFunction(() => document.getElementById("local-transfer-status").textContent.includes("sources were retained"));
    await page.waitForFunction(() => document.activeElement === document.getElementById("local-transfer-cancel"));
    assert.equal(await page.evaluate(() => calls.filter(row => row.params.action === "move").length), 0);
    await page.locator("#local-transfer-cancel").click();
    await page.waitForFunction(() => !document.getElementById("local-transfer").open);
    // Stop revokes the source ticket while the first source request is still awaiting its response.
    await open(true); await page.locator("#local-transfer-mode").selectOption("move");
    await page.waitForFunction(() => !localTransfer.moveLoading && !document.getElementById("local-transfer-ok").disabled);
    await page.evaluate(() => { window.holdMove = true; window.moveStatus = "source_retained"; });
    await page.locator("#local-transfer-ok").click(); await page.locator("#confirm-ok").click();
    await page.waitForFunction(() => document.getElementById("confirm-ok").textContent === "Move Gmail originals to Trash");
    await page.locator("#confirm-ok").click(); await page.waitForFunction(() => typeof window.releaseMove === "function");
    const beforeStop = await page.evaluate(() => calls.filter(row => row.channel === "mail:crossMailboxMove" && row.params.action === "cancelReview").length);
    await page.locator("#local-transfer-cancel").click();
    assert.equal(await page.evaluate(() => calls.filter(row => row.channel === "mail:crossMailboxMove" && row.params.action === "cancelReview").length), beforeStop + 1);
    await page.evaluate(() => releaseMove()); await page.waitForFunction(() => !localTransfer.running);
    assert.equal(await page.evaluate(() => calls.filter(row => row.params.action === "move").length), 1);
    await page.locator("#local-transfer-cancel").click(); await page.waitForFunction(() => !document.getElementById("local-transfer").open);
    // The real window-close listener dispatches revocation before a waiting source response settles.
    await open(true); await page.locator("#local-transfer-mode").selectOption("move");
    await page.waitForFunction(() => !localTransfer.moveLoading && !document.getElementById("local-transfer-ok").disabled);
    await page.evaluate(() => { window.holdMove = true; window.moveStatus = "source_retained"; });
    await page.locator("#local-transfer-ok").click(); await page.locator("#confirm-ok").click();
    await page.waitForFunction(() => document.getElementById("confirm-ok").textContent === "Move Gmail originals to Trash");
    await page.locator("#confirm-ok").click(); await page.waitForFunction(() => typeof window.releaseMove === "function");
    const beforeClose = await page.evaluate(() => calls.filter(row => row.channel === "mail:crossMailboxMove" && row.params.action === "cancelReview").length);
    const attemptsBeforeClose = await page.evaluate(() => calls.filter(row => row.params.action === "move").length);
    await page.evaluate(() => window.dispatchEvent(new Event("beforeunload")));
    assert.equal(await page.evaluate(() => calls.filter(row => row.channel === "mail:crossMailboxMove" && row.params.action === "cancelReview").length), beforeClose + 1);
    await page.evaluate(() => releaseMove()); await page.waitForFunction(() => !localTransfer.running);
    assert.equal(await page.evaluate(() => calls.filter(row => row.params.action === "move").length), attemptsBeforeClose);
    await page.locator("#local-transfer-cancel").click(); await page.waitForFunction(() => !document.getElementById("local-transfer").open);
    // An uncertain source result is displayed honestly and cannot be resubmitted.
    await open(true); await page.locator("#local-transfer-mode").selectOption("move");
    await page.waitForFunction(() => !localTransfer.moveLoading && !document.getElementById("local-transfer-ok").disabled);
    await page.evaluate(() => { window.holdMove = false; window.moveStatus = "unknown"; });
    await page.locator("#local-transfer-ok").click(); await page.locator("#confirm-ok").click();
    await page.waitForFunction(() => document.getElementById("confirm-ok").textContent === "Move Gmail originals to Trash");
    await page.locator("#confirm-ok").click(); await page.waitForFunction(() => !localTransfer.running);
    assert.match(await page.locator("#local-transfer-status").textContent(), /uncertain.*No automatic retry or Undo/);
    const attempts = await page.evaluate(() => calls.filter(row => row.params.action === "move").length);
    await page.evaluate(() => commitLocalTransfer()); assert.equal(await page.evaluate(() => calls.filter(row => row.params.action === "move").length), attempts);
    await page.locator("#local-transfer-cancel").click(); await page.waitForFunction(() => !document.getElementById("local-transfer").open);
    await page.evaluate(() => showFeatures());
    const feature = page.locator(".feature-card").filter({ has: page.getByRole("heading", { name: "Cross-mailbox Gmail Move", exact: true }) });
    await feature.scrollIntoViewIfNeeded(); assert.match(await feature.textContent(), /Gmail API sources only.*separate explicit source Trash review.*Copy confirmation never authorizes source Trash/);
    await page.screenshot({ path: path.join(output, "gmail-move-feature-narrow-dark.png") });
    assert.deepEqual(errors, []);
    console.log("cross-mailbox-move-browser-ok: disabled-policy negative, eligible Gmail-source flow, separate Copy/Trash confirmations, keyboard/focus, Stop/window-close revocation while pending, uncertain no replay, 390/1440 light/dark, rendered enabled Features; synthetic only");
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
