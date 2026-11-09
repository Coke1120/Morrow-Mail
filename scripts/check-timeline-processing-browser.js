// Optional rendered QA: fresh Chromium profile, local files and synthetic IPC.
// MORROW_PLAYWRIGHT_MODULE=/path/to/playwright MORROW_CHROMIUM=/path/to/chrome node scripts/check-timeline-processing-browser.js
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"), http = require("node:http"), path = require("node:path"), os = require("node:os");
const root = path.join(__dirname, "..");
const output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-timeline-processing");

const { preparePlan, LIMITS } = require("../host/timeline/extract");
const body = "The fictional project update records a date, an amount and uncertainty.\n".repeat(6).trimEnd();
const common = { source_thread_id: "00000000-0000-4000-8000-000000000010", from: { name: "Ada", address: "ada@example.org" }, occurred_at: "2026-11-09T09:00:00Z", date_source: "header", attachments: [] };
const sources = [body, "Review this.\n" + body.split("\n").map(line => "> " + line).join("\n"), "x".repeat(146586)].map((text, index) => ({ ...common, text, source_message_id: `00000000-0000-4000-8000-00000000000${index + 1}`, subject: index === 2 ? "S".repeat(500) : "Fictional project update" }));
const plan = preparePlan(sources);
assert.equal(plan.processing.sharedQuotes, 1);
const prepared = { manifestToken: "synthetic-source-proof", optionsDigest: "synthetic-options", accounts: ["owner@example.org"], threads: 1,
  coverage: { selected_message_count: 3, included_message_count: 3, omitted_message_count: 0 }, chunks: plan.chunks.length,
  estimatedInputBytes: plan.estimatedInputBytes, processing: plan.processing, limits: LIMITS,
  provider: "Synthetic provider", destination: "https://ai.example.invalid/v1", model: "synthetic", allowed: true };

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
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html?role=main`);
    await page.evaluate(async prepared => {
      globalThis.timelineCalls = [];
      const api = { on() {}, async invoke(channel, payload) {
        timelineCalls.push({ channel, payload });
        if (channel === "timeline:prepare") return { success: true, data: prepared };
        if (channel === "timeline:list") return { success: true, data: [] };
        if (channel === "timeline:check") return { success: true, data: { valid: true } };
        throw new Error("Unexpected IPC: " + channel);
      } };
      globalThis.timelineEmail = { id: "mail-1", accountId: "synthetic-account", subject: "Fictional case timeline", from: "Ada <ada@example.org>", to: ["owner@example.org"] };
      globalThis.timeline = morrowTimeline.mount({ api });
      await timeline.open(timelineEmail);
    }, prepared);
    assert.equal(await page.locator("#timeline-generate").isEnabled(), true);
    assert.match(await page.locator("#timeline-processing-counts").textContent(), /147,\d{3} bytes/);
    assert.equal(await page.locator("#timeline-processing-sources li").count(), 3);
    await page.locator("#timeline-processing summary").click();
    for (const width of [1280, 720, 390]) for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const dimensions = await page.locator("#timeline-dialog").evaluate(dialog => ({ width: dialog.clientWidth, scroll: dialog.scrollWidth }));
      assert.ok(dimensions.scroll <= dimensions.width + 2, "processing sources do not overflow horizontally");
      await page.locator("#timeline-processing").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `timeline-processing-${width}-${theme}.png`) });
    }
    await page.locator("#timeline-contacts").fill("updated@example.org");
    assert.equal(await page.locator("#timeline-processing").isVisible(), false, "focus edits hide stale counts");
    await page.locator("#timeline-close").click();
    assert.equal(await page.locator("#timeline-dialog").evaluate(dialog => dialog.open), false);
    await page.evaluate(() => timeline.open(timelineEmail));
    assert.equal(await page.locator("#timeline-processing").isVisible(), true);
    assert.equal(await page.locator("#timeline-processing-sources li").count(), 3, "reopen replaces source rows");
    await page.locator("#timeline-mode").selectOption("case");
    assert.equal(await page.locator("#timeline-processing").isVisible(), false, "case selection requires a new review");
    assert.equal(await page.locator("#timeline-generate").isEnabled(), false);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#timeline-dialog").evaluate(dialog => dialog.open), false);
    assert.equal(await page.evaluate(() => timelineCalls.some(call => /generate|download|mail:|^ai/.test(call.channel))), false);
    await page.evaluate(() => { document.getElementById("features-panel").hidden = false; paintFeatureCatalog(); showFeaturesTab("catalog"); });
    const feature = page.locator(".feature-card").filter({ has: page.getByRole("heading", { name: "Selected-mail timeline", exact: true }) });
    assert.match(await feature.innerText(), /512,000 UTF-8 bytes/);
    assert.match(await feature.innerText(), /Sources and text processing/);
    await page.setViewportSize({ width: 720, height: 900 });
    await feature.screenshot({ path: path.join(output, "timeline-features-720.png") });
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const result = { checks: ["real planner byte/source counts", "wide/narrow/mobile light/dark layout", "inert long source metadata", "focus edit hides stale counts", "close/reopen replaces rows", "Case mode invalidates processing review", "Escape dismissal", "no generation or external requests"], errors, external };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log("timeline-processing-browser-ok", JSON.stringify(result));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
