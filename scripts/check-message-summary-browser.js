// Rendered QA with synthetic mail/IPC only. Optional Playwright/axe dependencies live outside the checkout.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"), http = require("node:http"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.join(__dirname, ".."), output = process.env.MORROW_UI_OUTPUT || path.join(require("node:os").tmpdir(), "morrow-message-summary");

async function run() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/axe.js") { response.setHeader("Content-Type", "text/javascript"); response.end(fs.readFileSync(require.resolve(process.env.MORROW_AXE_MODULE || "axe-core/axe.min.js"))); return; }
    const target = path.resolve(root, "." + pathname);
    if (!target.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    try {
      let content = fs.readFileSync(target);
      if (pathname === "/renderer/app.js") content = content.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
      response.setHeader("Content-Type", pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : pathname.endsWith(".svg") ? "image/svg+xml" : "text/html");
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
  const failures = [];
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on("pageerror", value => failures.push(value.message));
    await page.addInitScript(() => { window.morrow = { on() {}, invoke: async () => ({ success: true, data: {} }) }; });
    await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(() => {
      refreshMailVacation = () => { $("mail-ooo").hidden = true; };
      wire(); setNavCollapsed(true);
      state.accounts = [{ id: "alpha", email: "leo@fixture.invalid", name: "Demo mailbox", platform: "imap", bodyEpoch: 0,
        folders: { primary: [{ id: "INBOX", name: "Inbox", wellKnownName: "inbox", unreadCount: 2 }], more: [] } }];
      state.accountId = "alpha"; state.folderId = "INBOX"; state.view = "mail"; state.prefs.conversation = false; state.prefs.images = false;
      state.emails = [
        { id: "one", accountId: "alpha", folderId: "INBOX", bodyEpoch: 0, bodyComplete: true, subject: "Launch review — decisions for Friday", from: "Ada Chen <ada@fixture.invalid>", to: ["leo@fixture.invalid"], date: "2026-11-03T08:00:00Z", snippet: "Please review the launch plan before Friday.", textBody: "Hi Leo,\n\nThe product launch is planned for November 12. Please review the final checklist and send your approval by Friday at 3 pm.\n\nThe design is ready. The operations team is still checking delivery dates. If those dates change, we will discuss the launch timing again.\n\nThanks,\nAda" },
        { id: "two", accountId: "alpha", folderId: "INBOX", bodyEpoch: 0, bodyComplete: true, subject: "Team lunch", from: "Ben <ben@fixture.invalid>", date: "2026-11-02T08:00:00Z", snippet: "Lunch next week", textBody: "Would Tuesday work for lunch?" },
      ];
      state.email = state.emails[0]; state.thread = [];
      window.requests = []; window.replies = []; window.reviewMode = false;
      call = async (channel, input) => { requests.push({ channel, input }); if (channel === "mail:prepareSummary") return { ...input, planId: "fixture-review", needsReview: window.reviewMode || state.email.bodyComplete !== true, characters: 40000, destination: "https://summary-fixture.invalid/v1/chat/completions", model: "fixture", full: { available: true, calls: 5, reason: "" }, excerpt: { characters: 12000, omitted: 28000 }, warnings: state.email.bodyComplete !== true ? ["The download may be incomplete. This summary covers downloaded text only."] : [] }; if (channel === "mail:summarizeEmail") return new Promise((resolve, reject) => replies.push({ input, resolve, reject }));
        if (channel === "mail:openEmail") return { email: state.emails.find(row => row.id === input.emailId), threadMessages: [] }; return {}; };
      renderAccounts(); renderList(); renderReader(false); $("mail-ooo").hidden = true;
    });
    const summary = () => page.getByRole("button", { name: "Summary", exact: true });
    assert.equal(await page.evaluate(() => requests.filter(row => row.channel === "mail:summarizeEmail").length), 0);
    for (const name of ["Reply", "Reply All", "Suggest a reply", "Forward", "Star", "Translate", "Archive", "Delete", "Move to folder", "Organize"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 1, name);
    await summary().focus(); await page.keyboard.press("Enter");
    await page.getByText("Summarizing this message…", { exact: true }).waitFor();
    assert.equal(await summary().isDisabled(), true);
    await page.screenshot({ path: path.join(output, "summary-loading.png") });
    await page.getByRole("button", { name: "Cancel summary", exact: true }).click();
    await page.getByText("Summary cancelled. Choose Summary to try again.", { exact: true }).waitFor();
    await summary().click();
    await page.evaluate(() => { replies[0].resolve({ ...replies[0].input, summary: { mainPoint: "OLD CANCELLED", bullets: [] }, warnings: [] }); replies[1].resolve({ ...replies[1].input,
      summary: { mainPoint: "The launch is planned for November 12.", bullets: ["Ada asks for approval by Friday at 3 pm.", "Operations is checking delivery dates.", "The team will review the launch date if delivery dates change."] }, warnings: [], coverage: { included: 430, downloaded: 430, parts: 1, calls: 1 } }); });
    await page.getByText("The launch is planned for November 12.", { exact: true }).waitFor();
    assert.equal(await page.locator(".message-summary-text li").count(), 3);
    assert.equal(await page.locator(".message-summary details").getAttribute("open"), null);
    assert.equal(await page.getByText("OLD CANCELLED", { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(output, "summary-main.png") });
    await page.addScriptTag({ url: "/axe.js" });
    const audit = () => page.evaluate(async () => (await axe.run(document.querySelector("#reader"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } })).violations.map(row => ({ id: row.id, nodes: row.nodes.map(node => node.target) })));
    assert.deepEqual(await audit(), []);
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    assert.deepEqual(await audit(), []);
    await page.screenshot({ path: path.join(output, "summary-dark.png") });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await page.evaluate(() => { state.providerFolders = { accountId: "alpha", api: true, source: "gmail", folders: [{ id: "Label_1", name: "Work", editable: true }] }; renderReader(false); });
    assert.equal(await page.getByRole("button", { name: "Labels", exact: true }).count(), 1);
    assert.equal(await summary().isVisible(), true);
    await page.screenshot({ path: path.join(output, "summary-gmail-labels.png") });
    for (const layout of ["right", "bottom", "separate"]) {
      await page.evaluate(value => { state.prefs.mailView = { layout: value === "separate" ? "right" : value, listHeight: 240 }; applyMailView(); renderReader(false); }, layout);
      if (layout === "separate") await page.evaluate(() => { document.documentElement.dataset.window = "reader"; renderReader(false); });
      assert.equal(await summary().isVisible(), true, layout);
      assert.equal(await page.locator(".message-summary").isVisible(), true, layout);
      await page.screenshot({ path: path.join(output, `summary-${layout}.png`) });
    }
    await page.setViewportSize({ width: 560, height: 720 });
    const overflow = await page.evaluate(() => { const pane = document.getElementById("reader"); return pane.scrollWidth > pane.clientWidth + 2; });
    assert.equal(overflow, false, "narrow reader wraps the toolbar and summary");
    await page.screenshot({ path: path.join(output, "summary-reader-narrow.png") });
    assert.deepEqual(await audit(), []);
    await summary().click();
    await page.evaluate(() => replies.at(-1).reject(Object.assign(new Error("AI data use is off. Review the destination and allow it in Settings → AI → AI data permission."), { code: "ai-consent-required" })));
    await page.getByRole("button", { name: "Review AI settings", exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "summary-permission-required.png") });
    assert.deepEqual(await audit(), []);
    await page.evaluate(() => { state.email.bodyComplete = false; renderReader(false); });
    await summary().click();
    await page.getByText("The download may be incomplete. This summary covers downloaded text only.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Summarize first 12,000 characters only", exact: true }).click();
    await page.evaluate(() => replies.at(-1).resolve({ ...replies.at(-1).input, summary: { mainPoint: "Summary of the available text only.", bullets: [] },
      warnings: ["The downloaded message may be incomplete. Missing content is not included.", "Excerpt only: 12,000 of 40,000 downloaded characters. Later text is not included."] }));
    await page.getByText("Summary of the available text only.", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "summary-partial.png") });
    await page.evaluate(() => { state.email.bodyComplete = true; window.reviewMode = true; renderReader(false); });
    const beforeReview = await page.evaluate(() => replies.length);
    await summary().click();
    await page.getByRole("button", { name: "Summarize all downloaded text", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => replies.length), beforeReview, "review sends no text");
    await page.screenshot({ path: path.join(output, "summary-long-review.png") });
    assert.deepEqual(await audit(), []);
    await page.getByRole("button", { name: "Summarize all downloaded text", exact: true }).click();
    assert.equal(await page.evaluate(() => replies.at(-1).input.accepted), true);
    await page.evaluate(() => replies.at(-1).resolve({ ...replies.at(-1).input, summary: { mainPoint: "All reviewed parts were included.", bullets: ["Ada requests USD 125.40 by December 18; payment is unconfirmed."] }, warnings: [], coverage: { included: 40000, downloaded: 40000, parts: 3, calls: 5 } }));
    await page.getByText("All reviewed parts were included.", { exact: true }).waitFor();
    await page.evaluate(() => { window.reviewMode = false; });
    // Reuse the actual navigation handler with a delayed summary in flight.
    await summary().click();
    await page.evaluate(async () => { const old = replies.at(-1); await openMessage("two", false); old.resolve({ ...old.input, summary: { mainPoint: "WRONG MESSAGE", bullets: [] }, warnings: [] }); });
    assert.equal(await page.locator(".message-summary").isVisible(), false);
    assert.equal(await page.getByText("WRONG MESSAGE", { exact: true }).count(), 0);
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.evaluate(() => { document.documentElement.dataset.window = ""; showFeatures(); });
    await page.getByText("Message summary", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "summary-features.png") });
    assert.deepEqual(failures, []);
    console.log("message-summary-browser-ok: keyboard, cancel/retry/late results, layouts, narrow reader, permission error, rendered Features, axe WCAG A/AA; screenshots: " + output);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
if (require.main === module) run().catch(value => { console.error(value); process.exitCode = 1; });
module.exports = { run };
