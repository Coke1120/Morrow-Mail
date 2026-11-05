// Actual Settings/Features rendering and keyboard navigation; synthetic IPC only.
const { chromium } = require(process.env.MORROW_PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"), http = require("node:http"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), output = process.env.MORROW_UI_OUTPUT || path.join(os.tmpdir(), "morrow-brain-settings");
async function run() {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((request, response) => {
    const file = path.resolve(root, "." + request.url.split("?")[0]);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    try {
      let body = fs.readFileSync(file);
      if (file.endsWith("/renderer/app.js")) body = body.toString().replace(/boot\(\)\.catch\([^\n]+\);\s*$/, "");
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/html");
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.MORROW_CHROMIUM || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.requests = []; window.savedCadence = "daily"; window.backgroundAllowed = false;
      window.morrow = { on() {}, invoke: async (channel, input) => {
        requests.push({ channel, input });
        if (channel === "morrow:configSetBrainRefreshCadence") return savedCadence = input;
        if (channel === "emailBrain:getRefreshStatus") return { success: true, data: { cadence: savedCadence, backgroundAllowed,
          lastSuccessAt: "2026-11-05T10:00:00Z", nextEligibleAt: "2026-11-06T10:00:00Z", running: false } };
        if (/ConsentGrant|:refresh$|:rebuild$/.test(channel)) throw Error("Unexpected AI or consent write");
        if (channel.startsWith("mail:")) return { success: true, data: [] };
        return null;
      } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/renderer/index.html`);
    await page.evaluate(() => { wire(); openSettings(); revealSettingsFold("brain"); });
    await page.waitForFunction(() => settingsFoldLoaded.has("brain:"));
    assert.equal(await page.locator("#pref-brain-refresh").inputValue(), "daily");
    assert.match(await page.locator("#brain-refresh-permission").textContent(), /paused.*background AI/);
    assert.equal(await page.locator(".settings-account-context").isVisible(), false);
    await page.locator("#settings-tab-brain").focus(); await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator("#settings-tab-ai").getAttribute("aria-selected"), "true");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.locator("#settings-tab-brain").getAttribute("aria-selected"), "true");
    await page.locator("#pref-brain-refresh").selectOption("weekly");
    await page.waitForFunction(() => savedCadence === "weekly" && !document.getElementById("pref-brain-refresh").disabled);
    await page.locator("#pref-brain-refresh").selectOption("manual");
    await page.waitForFunction(() => document.getElementById("brain-refresh-next").textContent.includes("off"));
    await page.evaluate(() => { backgroundAllowed = true; });
    await page.locator("#pref-brain-refresh").selectOption("daily");
    await page.waitForFunction(() => document.getElementById("brain-refresh-permission").textContent.includes("is allowed"));
    const results = [];
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const overflow = await page.locator("#settings-brain").evaluate(node => node.scrollWidth > node.clientWidth);
        assert.equal(overflow, false, `${theme}/${width} Brain content must wrap`);
        const select = await page.locator("#pref-brain-refresh").boundingBox(); assert.ok(select.x >= 0 && select.x + select.width <= width);
        await page.screenshot({ path: path.join(output, `brain-${theme}-${width}.png`) });
        results.push({ theme, width, overflow });
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator("#brain-refresh-ai-settings").click();
    assert.equal(await page.locator("#settings-tab-ai").getAttribute("aria-selected"), "true");
    await page.evaluate(() => { document.getElementById("settings").close(); showFeatures(); });
    const catalog = await page.locator("#features-catalog").textContent();
    assert.match(catalog, /Daily \(default\), Weekly, or Manual only/);
    assert.match(catalog, /Reply and Reply All subjects add Re:; Forward adds Fwd:/);
    assert.equal(await page.evaluate(() => requests.some(row => /ConsentGrant|:refresh$|:rebuild$/.test(row.channel))), false);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ results, errors, syntheticOnly: true }, null, 2));
    console.log("brain-settings-browser-ok: keyboard tabs, saved cadence, permission disclosure, Features, light/dark and narrow/wide");
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
