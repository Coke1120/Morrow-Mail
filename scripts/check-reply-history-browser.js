// Optional rendered QA: fresh Chromium profile, local files and synthetic IPC.
// MORROW_PLAYWRIGHT_MODULE=/path/to/playwright MORROW_CHROMIUM=/path/to/chrome node scripts/check-reply-history-browser.js
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"), http = require("node:http"), path = require("node:path"), os = require("node:os");
const root = path.join(__dirname, "..");
const output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-reply-history");

async function run() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") return response.writeHead(204).end();
    const target = path.resolve(root, "." + pathname);
    if (!target.startsWith(root + path.sep)) return response.writeHead(403).end();
    try {
      let content = fs.readFileSync(target);
      if (pathname === "/renderer/app.js") content = content.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
      response.setHeader("Content-Type", pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : pathname.endsWith(".svg") ? "image/svg+xml" : "text/html");
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || "/usr/bin/chromium", headless: true, chromiumSandbox: true });
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const errors = [], external = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1" && url.port === String(server.address().port)) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    await page.addInitScript(() => { window.morrow = { on() { return () => {}; }, invoke() { throw new Error("Real IPC forbidden"); } }; });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html?role=compose`);
    await page.evaluate(async () => {
      const message = (id, text) => ({ id, accountId: "fixture", threadId: "thread", bodyEpoch: 0,
        bodyComplete: true, hasBody: true, from: id + " <" + id + "@fixture.invalid>",
        to: ["owner@fixture.invalid"], subject: "Fictional delivery plan", textBody: text });
      globalThis.messages = [message("older", Array.from({ length: 45 }, (_, i) => "Earlier detail " + (i + 1) + ": retain the fictional proposal.").join("\n\n")),
        message("previous", "Previous answer: include the appendix."), message("source", "Please confirm the fictional plan."), message("later", "Later message must not be included.")];
      state.accounts = [{ id: "fixture", email: "owner@fixture.invalid", platform: "imap", bodyEpoch: 0, folders: { primary: [], more: [] } }];
      state.accountId = "fixture"; state.prefs.images = false; state.prefs.aiReply = false; state.prefs.scheduleDelay = 0;
      globalThis.ipcCalls = [];
      call = async (channel, payload) => {
        ipcCalls.push({ channel, payload });
        if (channel === "mail:listThreadMessages") return messages.map(({ textBody, ...row }) => row);
        if (channel === "mail:readCachedBody") return { email: messages.find(row => row.id === payload.emailId) };
        if (channel === "mail:getComposeContext") return { fromAddress: "owner@fixture.invalid", fromDisplayName: "Fixture Owner", selfAddresses: ["owner@fixture.invalid"],
          sendAs: [{ email: "owner@fixture.invalid" }], defaultCc: [], defaultBcc: [], settings: { ccByDomain: {}, bccByDomain: {}, accounts: {} } };
        if (channel === "mail:listSignatures") return { signatures: [], defaultSignaturePerAccount: {} };
        if (channel === "nativeAgent:home:replyTarget") return null;
        throw new Error("Unexpected IPC: " + channel);
      };
      showComposeSuggestions = async () => {};
      wire();
      await openCompose(composeSeed(messages[2], "reply", "owner@fixture.invalid"));
    });
    await page.waitForFunction(() => state.composeInitializing === false);
    assert.equal(await page.locator(".compose-quote-message").count(), 3);
    assert.match(await page.locator("#compose-quote-body").innerText(), /Earlier detail 45/);
    await page.locator("#compose-editor").fill("Confirmed. I will include the appendix.");
    const payload = await page.evaluate(() => composePayload(composeAccount()).body);
    assert.match(payload, /Earlier detail 45/);
    assert.match(payload, /Previous answer/);
    assert.doesNotMatch(payload, /Later message/);
    for (const width of [1280, 800, 720]) for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: width === 720 ? 700 : 900 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; syncComposeLayout(); }, theme);
      await page.waitForFunction(width => $("compose").dataset.layout === (width >= 900 ? "wide" : "narrow"), width);
      const layout = await page.evaluate(() => {
        const pane = $("compose-quote-body"), editor = $("compose-editor"), dialog = $("compose");
        return { paneHeight: pane.clientHeight, paneScroll: pane.scrollHeight,
          editorHeight: editor.getBoundingClientRect().height, dialogWidth: dialog.clientWidth, dialogScroll: dialog.scrollWidth };
      });
      assert.ok(layout.paneHeight > 30 && layout.editorHeight > 30, "history and editor remain usable");
      assert.ok(layout.paneScroll > layout.paneHeight, "long history scrolls inside its pane");
      assert.ok(layout.dialogScroll <= layout.dialogWidth + 2, "no horizontal compose overflow");
      await page.locator("#compose-quote-body").evaluate(node => { node.scrollTop = node.scrollHeight; });
      await page.screenshot({ path: path.join(output, `reply-history-${width}-${theme}.png`) });
      if (width < 900) {
        await page.locator("#compose-quote-collapse").click();
        assert.equal(await page.locator("#compose-quote-body").isVisible(), false);
        await page.locator("#compose-quote-collapse").click();
        assert.equal(await page.locator("#compose-quote-body").isVisible(), true);
      }
      await page.locator("#compose-quote-toggle").click();
      assert.equal(await page.locator("#compose-quote").isVisible(), false);
      await page.locator("#compose-quote-toggle").click();
      assert.equal(await page.evaluate(() => composePayload(composeAccount()).body), payload);
    }
    await page.evaluate(() => openComposePreview(null));
    assert.match(await page.locator("#compose-preview-body").innerText(), /Earlier detail 45/);
    await page.evaluate(() => cancelComposePreview());
    await page.evaluate(() => { globalThis.closing = requestComposeClose(); });
    await page.locator("#draft-close-keep").click();
    assert.equal(await page.evaluate(() => closing), false);
    assert.equal(await page.locator("#compose").evaluate(node => node.open), true);
    await page.evaluate(() => { globalThis.closing = requestComposeClose(); });
    await page.locator("#draft-close-discard").click();
    assert.equal(await page.evaluate(() => closing), true);
    await page.evaluate(async () => { await openCompose(composeSeed(messages[2], "all", "owner@fixture.invalid")); });
    assert.equal(await page.locator(".compose-quote-message").count(), 3, "repeated open does not duplicate history");
    assert.equal(await page.evaluate(() => ipcCalls.some(row => /mail:(send|scheduleSend|upsertDraft|markRead|openEmail)|^ai/.test(row.channel))), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const result = { checks: ["earlier history and outgoing payload", "wide/narrow light/dark layout", "internal history scrolling", "collapse/hide/show", "send preview/cancel", "close keep/discard/reopen"], errors, external };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log("reply-history-browser-ok", JSON.stringify(result));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
