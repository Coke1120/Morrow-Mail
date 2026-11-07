"use strict";
// Actual preload, Settings renderer and host snapshot; synthetic profile only.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { JSDOM } = require("jsdom");
const { renderer } = require("./check-ux-workflows");
const root = path.join(__dirname, "..");
const source = file => fs.readFileSync(path.join(root, file), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-mcp-ui-"));
  const envKeys = ["MORROW_USER_DATA", "MORROW_MAIL_DIR", "MORROW_AI_CONFIG_DIR", "MORROW_MAIL_SECRETS"];
  const env = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { MORROW_USER_DATA: dir, MORROW_MAIL_DIR: dir, MORROW_AI_CONFIG_DIR: dir, MORROW_MAIL_SECRETS: "memory" });
  const Module = require("node:module"), originalRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "electron") return { app: null, BrowserWindow: { getAllWindows() { return []; } } };
    return originalRequire.apply(this, arguments);
  };
  const db = require("../host/mail/db"), auth = require("../host/bot/auth"), manage = require("../host/bot/manage");
  const catalog = require("../host/bot/catalog");
  const dom = new JSDOM(source("renderer/index.html"));
  try {
    await db.open(path.join(dir, "mail.sqlite"));
    db.insertAccount({ id: "alpha", email: "synthetic@example.test", username: "synthetic", profile: "custom", authKind: "password", createdAt: 10,
      imapHost: "imap.invalid", imapPort: 993, imapTls: true, smtpHost: "smtp.invalid", smtpPort: 465, smtpTls: true });
    const grant = auth.mint({ label: "Synthetic MCP", platform: "mcp_agent", accountIds: ["alpha"], capabilities: catalog.DEFAULT_CAPABILITIES });
    const event = { sender: { getURL: () => pathToFileURL(path.join(root, "renderer", "index.html")).href } };
    const exposed = {}, calls = [];
    vm.runInNewContext(source("renderer/preload.js"), { require(id) {
      assert.equal(id, "electron");
      return { contextBridge: { exposeInMainWorld(key, value) { exposed[key] = value; } },
        ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke(channel, payload) {
          calls.push(channel); assert.ok(channel.startsWith("bot:")); return manage.answer(channel, payload, event);
        } } };
    } });
    let copied = "";
    const ui = renderer({ document: dom.window.document, window: { morrow: exposed.morrow }, URL,
      navigator: { clipboard: { async writeText(text) { copied = text; } } } });
    const $ = id => dom.window.document.getElementById(id);
    ui.run("wireBot()"); await ui.run("loadBotAccess()");
    assert.equal($("settings-tab-bot").textContent, "Agent access / MCP");
    assert.equal($("settings-bot-title").textContent, "Agent access / MCP");
    assert.equal($("bot-platform").value, "mcp_agent");
    assert.equal($("bot-mcp-copy").disabled, true);
    assert.match($("bot-mcp-launcher").textContent, /Source-checkout adapter.*npm ci.*Node.js 20\+/);
    assert.equal($("bot-legacy-setup").open, false);
    assert.equal($("bot-grants").querySelector('[data-notify-field="allow"]').checked, false);
    const before = fs.readFileSync(path.join(dir, "bot-access.json"), "utf8");
    $("bot-secret-value").textContent = grant.secret;
    $("bot-mcp-node").value = process.execPath;
    const tokenFile = path.join(dir, "private file with spaces.txt");
    $("bot-mcp-token-file").value = tokenFile;
    $("bot-mcp-token-file").dispatchEvent(new dom.window.Event("input"));
    assert.equal($("bot-mcp-copy").disabled, false);
    const config = JSON.parse($("bot-mcp-config").textContent).mcpServers["morrow-mail"];
    assert.equal(config.command, process.execPath);
    assert.deepEqual(config.args, [path.join(root, "scripts", "morrow-mcp.js"), "--token-file", tokenFile, "--installation", auth.installationId()]);
    assert.equal(fs.existsSync(tokenFile), false, "configuration does not read, create or validate a credential file");
    $("bot-mcp-copy").click(); await tick();
    assert.equal(copied, $("bot-mcp-config").textContent); assert.ok(!copied.includes(grant.secret));
    assert.match($("bot-mcp-status").textContent, /not the secret|never the secret/);
    assert.deepEqual(calls, ["bot:getAccess"], "typing and copying make no host mutation or connection attempt");
    assert.equal(fs.readFileSync(path.join(dir, "bot-access.json"), "utf8"), before);
    $("bot-mcp-token-file").value = grant.secret; ui.run("paintBotMcp()");
    assert.equal($("bot-mcp-copy").disabled, true); assert.equal($("bot-mcp-config").textContent, "");
    $("bot-mcp-token-file").value = tokenFile; ui.run("paintBotMcp()");
    ui.run("clearBotSecret()"); assert.equal($("bot-secret-value").textContent, "");
    $("bot-legacy-setup").open = true; $("bot-copy-setup").click(); await tick(); await tick();
    assert.match(copied, /MCP agent.*Morrow Mail bot/); assert.match(copied, /same HTTP contract/); assert.ok(!copied.includes(grant.secret));
    auth.revoke(grant.grant.clientId); await ui.run("loadBotAccess()");
    assert.equal($("bot-mcp-copy").disabled, true); assert.equal($("bot-mcp-config").textContent, "");
    for (const version of require("../host/bot/mcp-client").PROTOCOLS) assert.ok($("cli-mcp").textContent.includes(version));
    for (const phrase of ["no remote MCP endpoint", "Node.js 20+", "never the secret", "existing", "requestId"])
      assert.ok($("cli-mcp").textContent.toLowerCase().includes(phrase.toLowerCase()), phrase);
    assert.equal((await manage.answer("bot:getAccess", {}, { sender: { getURL: () => "https://untrusted.invalid" } })).success, false);
    await assert.rejects(exposed.morrow.invoke("bot:unknownMcpConfiguration", {}), /Unsupported channel/);
    const input = JSON.stringify({ ...manage.snapshot(), grants: [grant.grant], mcp: { launcherAvailable: true, launcherPath: "C:\\Program Files\\Morrow Mail\\resources\\morrow-mcp.cjs", platform: "win32" } });
    const windows = ui.run(`botMcpConfiguration(${input}, ${JSON.stringify(grant.grant.clientId)}, "node", "C:\\\\Users\\\\Synthetic\\\\private token")`);
    assert.equal(JSON.parse(JSON.stringify(windows)).mcpServers["morrow-mail"].args[0], "C:\\Program Files\\Morrow Mail\\resources\\morrow-mcp.cjs");
    console.log("mcp-ui-ok (actual preload/Settings/host snapshot, secret isolation, compatibility; synthetic only)");
  } finally {
    dom.window.close(); await db.close(); Module.prototype.require = originalRequire;
    for (const key of envKeys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
module.exports = { run };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
