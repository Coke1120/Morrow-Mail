// Optional rendered QA. Serve this checkout with synthetic state, disabled boot and no external network.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"), http = require("node:http"), path = require("node:path"), os = require("node:os");
const root = path.join(__dirname, "..");
const output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-send-previews");

async function run() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
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
  const browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const errors = [], external = [], checks = [];
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 960 }, reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.hostname === "127.0.0.1" && url.port === String(server.address().port)) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    await page.addInitScript(() => { window.morrow = { on() { return () => {}; }, invoke() { throw new Error("Real IPC forbidden"); } }; });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(() => {
      state.accounts = [{ id: "a", email: "sender@fixture.invalid", name: "Synthetic mailbox", platform: "imap", folders: { primary: [], more: [] } },
        { id: "b", email: "other@fixture.invalid", platform: "imap", folders: { primary: [], more: [] } }];
      state.accountId = "a"; state.composeMeta = { accountId: "a", fromAddress: "sender@fixture.invalid", fromDisplayName: "Fixture Sender" };
      state.composeSession = 1; state.composePending = false; state.composeQueued = false; state.composeInitializing = false;
      state.composeFileJobs = []; state.composeAttachments = []; state.composeQuote = null; state.signatureText = ""; state.signatureHtml = "";
      state.prefs.images = true; state.remoteAllowed = { queued: true }; state.thread = []; state.view = "mail";
      globalThis.ipcCalls = []; globalThis.confirmed = []; globalThis.queueRows = [];
      call = async (channel, params) => { ipcCalls.push({channel, params}); if (channel === "mail:listScheduled") return queueRows; throw new Error("Unexpected IPC " + channel); };
      sendMail = async payload => { confirmed.push(payload); };
      scheduleMail = async (_when, payload) => { confirmed.push(payload); };
      wire();
      globalThis.seedPreview = () => {
        $("compose-to").value = "recipient@fixture.invalid"; $("compose-cc").value = "copy@fixture.invalid";
        $("compose-bcc").value = "hidden@fixture.invalid"; $("compose-subject").value = "Launch review";
        state.composeAttachments = [{ id: "file", storageUrl: "local:file", filename: "review.pdf", size: 12 }];
        state.composeQuote = { text: "Ada wrote:\n> Previous <literal> & symbols" };
        writeComposeBody("", '<h2>Launch review</h2><p>Hello <strong>Ada</strong>, <a href="https://docs.fixture.invalid/plan">review the plan</a>.</p><ul><li>Design ready</li><li>Approve budget</li></ul><table border="1" cellpadding="6"><tr><th>Item</th><th>Cost</th></tr><tr><td>Launch</td><td>$120</td></tr></table><p style="color:#193c34">Regards,<br><b>Fixture Sender</b></p>');
        syncComposePlainFromEditor(); openComposePreview(null);
      };
      seedPreview();
    });
    assert.equal(await page.locator("#compose-preview-body strong").innerText(), "Ada");
    assert.equal(await page.locator("#compose-preview-body table").count(), 1);
    assert.match(await page.locator("#compose-preview-files").innerText(), /review.pdf/);
    assert.match(await page.locator("#compose-preview-body").innerText(), /Previous <literal> & symbols/);
    assert.equal(await page.locator("#compose-preview-confirm").evaluate(node => document.activeElement === node), true);
    checks.push("rich body and reviewed metadata, quote and initial confirmation focus");
    for (const width of [1400, 560, 320]) for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const layout = await page.evaluate(() => {
        const dialog = $("compose-preview"), body = $("compose-preview-body"), html = body.querySelector(".body");
        return { dialog: dialog.clientWidth, scroll: dialog.scrollWidth, whitespace: getComputedStyle(html).whiteSpace, background: getComputedStyle(html).backgroundColor };
      });
      assert.ok(layout.scroll <= layout.dialog + 2, JSON.stringify(layout));
      assert.equal(layout.whitespace, "normal"); assert.equal(layout.background, "rgb(255, 255, 255)");
      await page.locator("#compose-preview").screenshot({ path: path.join(output, `preview-${width}-${theme}.png`) });
      checks.push(`preview ${width}px ${theme}`);
    }
    await page.locator("#compose-preview-cancel").click();
    assert.equal(await page.evaluate(() => confirmed.length), 0);
    await page.setViewportSize({ width: 1400, height: 960 });
    await page.evaluate(() => { seedPreview(); $("compose-editor").appendChild(document.createTextNode("changed")); });
    await page.locator("#compose-preview-confirm").click();
    assert.equal(await page.evaluate(() => confirmed.length), 0);
    assert.match(await page.locator("#compose-status").textContent(), /Review a new preview/);
    await page.evaluate(() => seedPreview());
    const frozen = await page.evaluate(() => JSON.stringify(previewDraftState.payload));
    await page.locator("#compose-preview-confirm").click();
    assert.equal(await page.evaluate(() => JSON.stringify(confirmed[0])), frozen);
    checks.push("native Cancel and Confirm retain change detection and frozen payload");
    await page.evaluate(() => {
      writeComposeBody("First line\nLiteral <b>text</b> & symbols"); state.composeQuote = null; openComposePreview(null);
    });
    assert.equal(await page.locator("#compose-preview-body .body").innerText(), "First line\nLiteral <b>text</b> & symbols");
    await page.locator("#compose-preview-cancel").click();
    await page.evaluate(() => {
      writeComposeBody(Array.from({length: 60}, (_, index) => "Line " + index).join("\n"));openComposePreview(null);
    });
    const region = page.getByRole("region", { name: "Message preview", exact: true });
    await region.focus(); await page.keyboard.press("PageDown");
    await page.waitForFunction(() => document.getElementById("compose-preview-body").scrollTop > 0);
    await page.locator("#compose-preview-cancel").click();
    checks.push("literal plaintext and keyboard scrolling in labelled preview region");
    const hostile = '<style>@import "https://track.fixture.invalid/import.css";p{background-image:url("https://track.fixture.invalid/css.png")}</style><script>window.attack=1</script><iframe src="https://track.fixture.invalid/frame"></iframe><svg onload="window.attack=2"></svg><object data="https://track.fixture.invalid/object"></object><form action="https://track.fixture.invalid/form"><input><button>fake send</button></form><p onclick="window.attack=3">Safe text</p><a href="javascript:window.attack=4">unsafe</a><img src="https://track.fixture.invalid/pixel.png" onerror="window.attack=5" width="1" height="1"><table background="https://track.fixture.invalid/table.png"><tr><td>Cell</td></tr></table>';
    await page.evaluate(hostile => { paintPreview({payload:{body:hostile}});openDialog("compose-preview"); }, hostile);
    assert.equal(await page.locator("#compose-preview-body script, #compose-preview-body iframe, #compose-preview-body svg, #compose-preview-body input, #compose-preview-body button, #compose-preview-body img").count(), 0);
    assert.match(await page.locator("#compose-preview-body .preview-remote-note").innerText(), /Remote images are blocked/);
    await page.locator("#compose-preview-cancel").click();
    await page.evaluate(hostile => {
      const payload = confirmed[0]; state.outbox = true; state.email = null;
      queueRows = [{id:"queued",accountId:"a",outbox:true,status:"pending",subject:payload.subject,to:payload.to,cc:payload.cc,bcc:payload.bcc,
        htmlBody:payload.body + hostile,attachments:payload.attachments,fromAddress:payload.fromAddress}];
      state.emails = outboxEmails(queueRows); renderList(); return openMessage("queued", false);
    }, hostile);
    assert.equal(await page.locator(".outbox-body strong").innerText(), "Ada");
    assert.match(await page.locator(".outbox-files").innerText(), /review.pdf/);
    assert.match(await page.locator(".outbox-body .preview-remote-note").innerText(), /Remote images are blocked/);
    assert.equal(await page.locator("#reader button").count(), 1);
    assert.equal(await page.locator('[data-testid="outbox-undo"]').isEnabled(), true);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.locator("#reader").screenshot({ path: path.join(output, `outbox-${theme}.png`) });
    }
    await page.evaluate(() => { state.email = outboxEmails([{...queueRows[0],accountId:"b",status:"sending",htmlBody:"<p>Sending <b>other account</b></p>",attachments:[]}])[0];renderReader(false); });
    assert.equal(await page.getByRole("button", {name:"Sending…",exact:true}).isDisabled(), true);
    assert.equal(await page.locator(".outbox-body b").innerText(), "other account");
    assert.equal(await page.locator(".outbox-files").count(), 0);
    checks.push("Outbox saved content, queue-only read, account/status change and inert file metadata");
    await page.evaluate(() => { showFeatures(); });
    assert.equal(await page.getByRole("tab", {name:"Features",exact:true}).getAttribute("aria-selected"), "true");
    assert.match(await page.locator("#features-catalog").innerText(), /Preview Send and scheduled previews show safe HTML/);
    assert.match(await page.locator("#features-catalog").innerText(), /Attachment downloads are unavailable in Outbox/);
    await page.screenshot({path:path.join(output,"features.png")});
    checks.push("actual Features tab describes implemented behavior");
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => ipcCalls.map(row => row.channel)), ["mail:listScheduled"]);
    assert.equal(await page.evaluate(() => window.attack || 0), 0);
    assert.deepEqual(external, [], "no remote image, CSS, frame or other external request");
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output,"results.json"), JSON.stringify({checks,external,errors,queueReads:1,liveIpc:0},null,2));
    console.log("send-previews-browser-ok: " + checks.length + " groups, zero external requests; " + output);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
