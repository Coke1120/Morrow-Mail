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
        to: ["owner@fixture.invalid", "teammate@fixture.invalid"], cc: ["reviewer@fixture.invalid"],
        subject: "Fictional delivery plan", textBody: text });
      globalThis.messages = [message("older", Array.from({ length: 45 }, (_, i) => "Earlier detail " + (i + 1) + ": retain the fictional proposal.").join("\n\n")),
        message("previous", "Previous answer: include the appendix."), message("source", "Please confirm the fictional plan."), message("later", "Later message must not be included.")];
      messages[1].htmlBody = '<p>Previous answer: <em>include the appendix.</em></p><ul><li>Earlier HTML item</li></ul>';
      messages[2].htmlBody = '<style>h2{color:#193c34} p{background-image:url(https://tracker.fixture.invalid/css)}</style>'
        + '<h2>Delivery plan</h2><p><strong>Please confirm the fictional plan.</strong></p><table border="1"><tr>\n  <th>Item</th>\n  <th>Amount</th>\n</tr><tr>\n  <td>Delivery</td>\n  <td>42</td>\n</tr></table>'
        + '<a href="https://docs.fixture.invalid/plan">Plan link</a><img alt="Embedded logo" width="20" height="20" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lvkAAAAASUVORK5CYII=">'
        + '<img src="https://tracker.fixture.invalid/pixel"><script>throw new Error("Untrusted mail executed")</script>';
      state.accounts = [{ id: "fixture", email: "owner@fixture.invalid", platform: "imap", bodyEpoch: 0, folders: { primary: [], more: [] } }];
      state.accountId = "fixture"; state.prefs.images = false; state.prefs.aiReply = false; state.prefs.scheduleDelay = 0;
      globalThis.ipcCalls = [];
      call = async (channel, payload) => {
        ipcCalls.push({ channel, payload });
        if (channel === "mail:listThreadMessages") return messages.map(({ textBody, htmlBody, ...row }) => row);
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
    assert.equal(await page.locator("#compose-to").inputValue(), "source <source@fixture.invalid>");
    assert.equal(await page.locator("#compose-cc").inputValue(), "");
    assert.equal(await page.locator("#compose-editing-help").evaluate(node => node.open), false);
    assert.equal(await page.locator(".compose-quote-message").count(), 3);
    assert.match(await page.locator("#compose-quote-body").innerText(), /Earlier detail 45/);
    assert.match(await page.locator("#compose-editor").innerText(), /Please confirm.*Previous answer.*Earlier detail 45/s);
    assert.equal(await page.locator("#compose-editor table td").count(), 2);
    assert.equal(await page.locator("#compose-editor img").count(), 1);
    assert.equal(await page.locator("#compose-editor h2").evaluate(node => getComputedStyle(node).color), "rgb(25, 60, 52)");
    assert.equal(await page.evaluate(() => composeSnapshot() === state.composeBaseline), true);
    await page.locator("#compose-editor").focus();
    await page.keyboard.press("Control+Home");
    await page.keyboard.insertText("Confirmed. I will include the appendix.");
    await page.locator("#compose-editor strong").evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.keyboard.insertText("Please confirm the fictional plan with inline changes.");
    const payload = await page.evaluate(() => composePayload(composeAccount()).body);
    assert.match(payload, /<(strong|b)>Please confirm the fictional plan with inline changes\.<\/\1>/);
    assert.doesNotMatch(await page.locator("#compose-body").inputValue(), /Earlier HTML item|Earlier detail|fictional plan/);
    assert.match(payload, /Earlier detail 45/);
    assert.match(payload, /Previous answer/);
    assert.doesNotMatch(payload, /Later message/);
    for (const [width, height] of [[1280, 900], [1000, 740], [800, 640], [720, 560]]) for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; syncComposeLayout(); }, theme);
      await page.waitForFunction(width => $("compose").dataset.layout === (width >= 900 ? "wide" : "narrow"), width);
      const layout = await page.evaluate(() => {
        const pane = $("compose-quote-body"), editor = $("compose-editor"), dialog = $("compose");
        const split = $("compose-split"), form = $("compose-form"), formStyle = getComputedStyle(form);
        const margins = node => { const s = getComputedStyle(node); return parseFloat(s.marginTop) + parseFloat(s.marginBottom); };
        const fixed = [...form.children].filter(node => node !== split && getComputedStyle(node).display !== "none")
          .reduce((height, node) => height + node.getBoundingClientRect().height + margins(node), 0);
        const availableSplit = form.clientHeight - parseFloat(formStyle.paddingTop) - parseFloat(formStyle.paddingBottom) - fixed - margins(split);
        return { availableSplit, paneHeight: pane.clientHeight, paneScroll: pane.scrollHeight,
          editorHeight: editor.getBoundingClientRect().height, editorScroll: editor.scrollHeight,
          dialogWidth: dialog.clientWidth, dialogScroll: dialog.scrollWidth,
          draftHeight: document.querySelector(".compose-draft").clientHeight,
          splitHeight: $("compose-split").clientHeight,
          quoteHeight: $("compose-quote").getBoundingClientRect().height };
      });
      assert.ok(layout.paneHeight > 20 && layout.editorHeight >= 180, "history scrolls and editor keeps its usable minimum");
      assert.ok(layout.paneScroll > layout.paneHeight, "long history scrolls inside its pane");
      assert.ok(layout.editorScroll > layout.editorHeight, "long editable quote scrolls inside Message");
      assert.ok(Math.abs(layout.splitHeight - layout.availableSplit) <= 2, "split uses the available window height");
      if (width < 900) {
        assert.ok(layout.quoteHeight <= 181 && layout.quoteHeight <= layout.splitHeight * 0.25 + 1, "stacked preview leaves the draft most of the height");
      } else {
        assert.ok(layout.draftHeight >= layout.splitHeight - 1, "wide draft fills the split");
      }
      assert.ok(layout.dialogScroll <= layout.dialogWidth + 2, "no horizontal compose overflow");
      const assertActions = async () => {
        for (const id of ["compose-send", "compose-save", "compose-close"]) {
          const action = await page.locator("#" + id).boundingBox();
          assert.ok(action.y >= 0 && action.y + action.height <= height + 1, id + " remains in the viewport");
        }
      };
      await assertActions();
      // Expanded optional controls use the draft's overflow, never the footer.
      await page.locator("#compose-editing-help").evaluate(node => { node.open = true; });
      await page.locator("#compose-schedule-tools").evaluate(node => { node.open = true; });
      await page.locator("#compose-schedule").scrollIntoViewIfNeeded();
      await assertActions();
      assert.ok(await page.locator("#compose-editor").evaluate(node => node.getBoundingClientRect().height >= 180));
      await page.locator("#compose-editing-help").evaluate(node => { node.open = false; });
      await page.locator("#compose-schedule-tools").evaluate(node => { node.open = false; });
      await page.locator(".compose-draft").evaluate(node => { node.scrollTop = 0; });
      const quoteLayout = await page.evaluate(() => {
        const editor = $("compose-editor"), quote = editor.querySelector("[data-compose-reply-html]");
        const readOnly = $("compose-quote-body").querySelector(".body.is-html");
        const defaults = body => {
          const wrap = getComputedStyle(body);
          return [wrap.whiteSpace, wrap.color, wrap.backgroundColor,
            getComputedStyle(body.querySelector("td")).boxSizing,
            getComputedStyle(body.querySelector("img")).maxWidth,
            getComputedStyle(body.querySelector("p")).marginBottom];
        };
        return { editable: defaults(quote), readOnly: defaults(readOnly),
          authoredWhiteSpace: getComputedStyle(editor.firstElementChild).whiteSpace };
      });
      assert.deepEqual(quoteLayout.editable, quoteLayout.readOnly, "quoted HTML uses reader layout in both themes and widths");
      assert.equal(quoteLayout.editable[0], "normal");
      assert.equal(quoteLayout.editable[3], "content-box");
      assert.equal(quoteLayout.authoredWhiteSpace, "pre-wrap");
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
    assert.equal(await page.locator("#compose-preview-body table td").count(), 2);
    assert.equal(await page.locator("#compose-preview-body :is(strong, b)").innerText(), "Please confirm the fictional plan with inline changes.");
    await page.evaluate(() => cancelComposePreview());
    await page.locator("#compose-editor [data-compose-reply-quote]").fill("Edited quoted excerpt <literal> & 中文");
    const edited = await page.evaluate(() => composePayload(composeAccount()).body);
    assert.match(edited, /Edited quoted excerpt &lt;literal&gt; &amp; 中文/);
    assert.doesNotMatch(edited, /Please confirm|Previous answer|Earlier detail/);
    await page.evaluate(() => openComposePreview(null));
    assert.match(await page.locator("#compose-preview-body").innerText(), /Edited quoted excerpt <literal> & 中文/);
    assert.doesNotMatch(await page.locator("#compose-preview-body").innerText(), /Please confirm|Earlier detail/);
    await page.screenshot({ path: path.join(output, "reply-edited-quote-preview.png") });
    await page.evaluate(() => cancelComposePreview());
    await page.locator("#compose-editor").fill("Replacement reply only.");
    const replacement = await page.evaluate(() => composePayload(composeAccount()).body);
    assert.doesNotMatch(replacement, /Please confirm|Previous answer|Earlier detail|Edited quoted/);
    await page.locator("#compose-quote-toggle").click();
    await page.locator("#compose-quote-toggle").click();
    assert.equal(await page.evaluate(() => composePayload(composeAccount()).body), replacement, "reference hiding never restores deleted quoted text");
    await page.evaluate(() => { globalThis.closing = requestComposeClose(); });
    await page.locator("#draft-close-keep").click();
    assert.equal(await page.evaluate(() => closing), false);
    assert.equal(await page.locator("#compose").evaluate(node => node.open), true);
    await page.evaluate(() => { globalThis.closing = requestComposeClose(); });
    await page.locator("#draft-close-discard").click();
    assert.equal(await page.evaluate(() => closing), true);
    await page.evaluate(async () => { await openCompose(composeSeed(messages[2], "all", "owner@fixture.invalid")); });
    assert.equal(await page.locator("#compose-to").inputValue(), "source <source@fixture.invalid>");
    assert.match(await page.locator("#compose-cc").inputValue(), /teammate@fixture.invalid/);
    assert.match(await page.locator("#compose-cc").inputValue(), /reviewer@fixture.invalid/);
    assert.doesNotMatch(await page.locator("#compose-cc").inputValue(), /owner@fixture.invalid/);
    assert.equal(await page.locator(".compose-quote-message").count(), 3, "repeated open does not duplicate history");
    assert.equal(await page.locator("#compose-editor [data-compose-reply-quote]").count(), 1);
    assert.equal((await page.evaluate(() => composePayload(composeAccount()).body)).match(/Please confirm the fictional plan/g).length, 1);
    assert.equal(await page.evaluate(() => ipcCalls.some(row => /mail:(send|scheduleSend|upsertDraft|markRead|openEmail)|^ai/.test(row.channel))), false);
    await page.evaluate(() => {
      $("compose").close(); document.documentElement.dataset.window = "shell";
      showFeatures(); showFeaturesTab("catalog");
    });
    const feature = page.locator(".feature-card").filter({ has: page.locator("h4", { hasText: "Reply conversation history" }) });
    assert.match(await feature.innerText(), /edit or remove/);
    assert.match(await feature.innerText(), /only the edited Message/);
    assert.match(await feature.innerText(), /safe HTML formatting/);
    assert.match(await feature.innerText(), /layout defaults for tables, images and spacing/);
    assert.match(await feature.innerText(), /Remote images and CSS resources stay blocked/);
    const composeFeature = page.locator(".feature-card").filter({ has: page.locator("h4", { hasText: "Compose in its own window" }) });
    assert.match(await composeFeature.innerText(), /1200 × 900/);
    assert.match(await composeFeature.innerText(), /Editing and attachment help is a collapsed disclosure/);
    await feature.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "reply-editable-features.png") });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const result = { checks: ["HTML original and earlier history", "actual inline HTML editing and outgoing payload", "tables, computed colors and embedded images", "authored input excludes HTML history", "wide/narrow light/dark layout", "internal history scrolling", "collapse/hide/show", "rich and edited quote send preview/cancel", "deleted quote never restored", "close keep/discard/reopen", "rendered Features copy", "no external resource requests"], errors, external };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log("reply-history-browser-ok", JSON.stringify(result));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
