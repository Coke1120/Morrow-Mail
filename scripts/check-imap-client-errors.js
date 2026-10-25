// Offline IMAP lifecycle regression. Real ImapFlow, synthetic Duplex transport;
// no TCP/TLS sockets, OAuth, mailbox data, or wall-clock timeout waits.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { Duplex } = require("node:stream");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const immediate = () => new Promise(resolve => setImmediate(resolve));
const scenarios = ["success", "connect", "list", "fetch", "logout", "idle-connect",
  "idle-select", "idle-pending", "idle-after-done", "idle-logout", "processing-response",
  "quiet-lock", "repeated-error", "operation-failure", "client-isolation", "controller-retry"];

async function checkScenario(scenario) {
  // Fail closed if a future fixture change accidentally bypasses the transport.
  const forbidden = () => { throw new Error("IMAP fixture forbids real network connections"); };
  const net = require("node:net");
  net.connect = net.createConnection = net.Socket.prototype.connect = forbidden;
  require("node:tls").connect = forbidden;

  const { ImapFlow } = require("imapflow");
  const clients = [];
  const injections = [];
  const commands = [];
  let phase = "connect";
  let socket;
  let client;
  let fired = false;
  const operationError = Object.assign(new Error("Synthetic operation rejected"), { code: "SyntheticOperation" });

  function fireTimeout() {
    injections.push({ phase, command: client.currentRequest?.command,
      listeners: client.listenerCount("error"), timeout: socket.armedTimeout });
    // No catch here or process-wide exception listener: the old code exits this
    // child with an unhandled error even though the operation promise is caught.
    socket.emit("timeout");
    if (scenario === "repeated-error") client.emit("error", new Error("Later socket failure"));
  }

  class SyntheticSocket extends Duplex {
    constructor() { super(); this.authorized = true; this.buffer = ""; }
    _read() {}
    setKeepAlive() { return this; }
    setTimeout(ms) { this.armedTimeout = ms; return this; }
    getCipher() { return { name: "SYNTHETIC", version: "fixture" }; }
    reply(value) { setImmediate(() => { if (!this.destroyed) this.push(value); }); }
    _write(chunk, _encoding, callback) {
      this.buffer += chunk.toString();
      let end;
      while ((end = this.buffer.indexOf("\r\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        this.handle(line);
      }
      callback();
    }
    handle(line) {
      commands.push(line);
      if (line === "DONE") {
        if (scenario !== "idle-pending") this.reply(`${this.idleTag} OK IDLE finished\r\n`);
        return;
      }
      const [, tag, command] = /^(\S+)\s+(.+)$/.exec(line) || [];
      assert.ok(tag, "Expected tagged synthetic IMAP command");
      const kind = command.split(" ")[0];
      const stall = !fired && (
        (scenario.endsWith("connect") && kind === "CAPABILITY") ||
        (["list", "repeated-error", "client-isolation"].includes(scenario) && phase === "operation" && kind === "LIST") ||
        (scenario === "fetch" && kind === "UID") ||
        (["idle-select", "controller-retry"].includes(scenario) && kind === "SELECT") ||
        (["logout", "idle-logout", "operation-failure"].includes(scenario) && kind === "LOGOUT")
      );
      if (stall) { fired = true; setImmediate(fireTimeout); return; }
      if (kind === "CAPABILITY") this.reply(`* CAPABILITY IMAP4rev1 IDLE NAMESPACE\r\n${tag} OK CAPABILITY\r\n`);
      else if (kind === "NAMESPACE") this.reply(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE\r\n`);
      else if (kind === "LIST") this.reply(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK LIST\r\n`);
      else if (kind === "LSUB") this.reply(`${tag} OK LSUB\r\n`);
      else if (kind === "SELECT") this.reply(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* OK [UIDVALIDITY 1] UIDVALIDITY\r\n* OK [UIDNEXT 2] UIDNEXT\r\n${tag} OK [READ-WRITE] SELECT\r\n`);
      else if (kind === "IDLE") { this.idleTag = tag; this.reply("+ idling\r\n"); }
      else if (kind === "LOGOUT") this.reply(`* BYE synthetic logout\r\n${tag} OK LOGOUT\r\n`);
      else if (kind === "NOOP" && scenario === "quiet-lock") { /* stalled recovery */ }
      else this.reply(`${tag} OK ${kind}\r\n`);
    }
  }

  class FixtureImapFlow extends ImapFlow {
    constructor(options) {
      const transport = { connect(_options, onConnect) {
        assert.equal(client.listenerCount("error"), 1, "Listener must exist before connect starts");
        socket = new SyntheticSocket();
        setImmediate(() => {
          onConnect();
          socket.reply("* PREAUTH synthetic fixture\r\n");
        });
        return socket;
      } };
      super({ ...options, transport });
      client = this;
      clients.push(this);
    }
  }
  // Only replace the transport constructor. All command, timeout and close
  // behavior below comes from the installed ImapFlow and current remote.js.
  const filename = path.join(root, "host/mail/remote.js");
  const remoteRequire = createRequire(filename);
  const fixtureRequire = name => name === "imapflow" ? { ImapFlow: FixtureImapFlow } : remoteRequire(name);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, "utf8")}\n})`, { filename })(fixtureRequire, module, module.exports);
  const remote = module.exports;
  const account = { id: "fixture", platform: "imap", imap_host: "synthetic.invalid",
    imap_port: 993, imap_tls: 1, username: "fixture" };
  const observe = promise => promise.then(value => ({ value }), error => ({ error }));
  async function waitFor(test) {
    for (let turn = 0; turn < 200; turn++) { if (test()) return; await immediate(); }
    throw new Error(`Condition did not occur in ${scenario}`);
  }
  let result;

  if (scenario === "controller-retry") {
    const idle = require("../host/mail/idle");
    const timers = new Set();
    let now = 0;
    const controller = idle.createIdleController({
      listAccounts: () => [account], secretFor: () => "synthetic-placeholder",
      openClient: (...args) => remote.openIdleClient(...args), syncFolder() {}, now: () => now,
      setTimer(fn, ms) { const timer = { fn, ms }; timers.add(timer); return timer; },
      clearTimer(timer) { timers.delete(timer); },
    });
    controller.start();
    await waitFor(() => [...timers].some(timer => timer.ms === idle.IDLE_BACKOFF_BASE_MS));
    assert.equal(controller.healthy(account.id), false, "Failed SELECT must leave push unhealthy");
    assert.equal(clients[0].isClosed, true);
    const backoff = [...timers].find(timer => timer.ms === idle.IDLE_BACKOFF_BASE_MS);
    timers.delete(backoff); now += backoff.ms; backoff.fn();
    await waitFor(() => clients.length === 2 && client.idling);
    assert.equal(controller.healthy(account.id), true, "Normal backoff reconnects to IDLE");
    await controller.stop();
    assert.equal(timers.size, 0, "Stopping clears retry, renewal and cleanup timers");
    result = { value: "retried" };
  } else if (scenario.startsWith("idle-")) {
    if (scenario === "idle-connect") result = await observe(remote.openIdleClient(account, "synthetic-placeholder"));
    else {
      const wrapper = await remote.openIdleClient(account, "synthetic-placeholder");
      phase = "select";
      if (scenario === "idle-select") result = await observe(wrapper.select("INBOX"));
      else {
        await wrapper.select("INBOX");
        phase = "idle";
        const pending = observe(wrapper.idle());
        await waitFor(() => client.idling && client.currentRequest?.command === "IDLE" && !client._processingResponse);
        assert.equal(client.listenerCount("error"), 2, "Pending IDLE retains its rejection listener");
        if (scenario === "idle-pending") {
          fireTimeout();
          await immediate();
          fireTimeout();
          result = await pending;
        } else {
          await wrapper.done();
          assert.equal((await pending).value, "done");
          assert.equal(client.listenerCount("error"), 1, "Only temporary IDLE listener is removed");
          phase = "after-idle";
          if (scenario === "idle-after-done") {
            fireTimeout();
            result = { value: "already-done" };
          } else {
            phase = "logout";
            result = await observe(wrapper.logout());
          }
        }
      }
      wrapper.close();
    }
  } else {
    result = await observe(remote.withClient(account, "synthetic-placeholder", async imap => {
      phase = "operation";
      if (["success", "list", "repeated-error", "client-isolation"].includes(scenario)) return imap.list();
      if (scenario === "fetch") return remote.fetchSource(imap, "INBOX", 1, 1);
      if (scenario === "logout") return "operation-succeeded";
      if (scenario === "operation-failure") throw operationError;
      if (scenario === "processing-response") {
        imap._processingResponse = true;
        fireTimeout();
        imap._processingResponse = false;
        return "rearmed";
      }
      if (scenario === "quiet-lock") {
        const lock = await imap.getMailboxLock("INBOX");
        try {
          await waitFor(() => !imap._processingResponse && !imap.currentRequest);
          fireTimeout();
          await waitFor(() => imap.currentRequest?.command === "NOOP");
          fireTimeout();
          await immediate();
          return "finished-work";
        } finally { lock.release(); }
      }
      throw new Error(`Unexpected operation in ${scenario}`);
    }));
    if (scenario === "client-isolation") {
      assert.equal(result.error?.code, "ETIMEOUT");
      const previous = client;
      const nextError = Object.assign(new Error("Synthetic independent connection failure"), { code: "NoConnection" });
      const next = await observe(remote.withClient(account, "synthetic-placeholder", async () => {
        previous.emit("error", new Error("Late error on old client"));
        throw nextError;
      }));
      assert.equal(next.error, nextError, "A prior client must not replace this client's error");
    }
  }

  await immediate();
  assert.equal(clients.length, ["client-isolation", "controller-retry"].includes(scenario) ? 2 : 1);
  for (const imap of clients) {
    imap.close();
    assert.equal(imap.isClosed, true);
    assert.equal(imap.listenerCount("error"), 1, "Lifetime listener survives cleanup without accumulating");
    imap.emit("error", new Error("Late event after close"));
  }
  if (["connect", "list", "fetch", "repeated-error", "idle-connect", "idle-select", "idle-pending", "client-isolation"].includes(scenario)) {
    assert.equal(result.error?.code, "ETIMEOUT", "Pending operation must report the original timeout, not succeed");
    assert.equal(result.error.message, "Socket timeout");
    assert.equal(remote.explain(result.error), "Could not reach the mail server.");
    const retry = require("../shared/sync-retry").createRetryScheduler({ setTimer: () => 1, clearTimer() {} });
    assert.equal(retry.noteFailure(account.id, remote.explain(result.error)).delayMs, 5000);
  } else {
    assert.equal(result.error, scenario === "operation-failure" ? operationError : undefined,
      "Specific operation failures and completed results keep their owners through logout");
  }
  if (scenario === "success") assert.equal(result.value[0].path, "INBOX");
  if (scenario === "logout") assert.equal(result.value, "operation-succeeded");
  if (scenario === "processing-response") assert.equal(result.value, "rearmed");
  if (scenario === "quiet-lock") assert.equal(result.value, "finished-work");
  if (scenario === "idle-pending" || scenario === "quiet-lock") assert.equal(injections.length, 2);
  for (const injection of injections) assert.equal(injection.timeout, scenario.startsWith("idle-") || scenario === "controller-retry" ? 28 * 60 * 1000 : 45000);
  if (scenario === "fetch") assert.ok(commands.some(command => /UID FETCH/.test(command)), "Exercise the actual body-fetch command");
}

function checkHelp() {
  const { documentFor } = require("./check-chatgpt-ui");
  const { renderer } = require("./check-ux-workflows");
  const catalog = require("../renderer/features-catalog");
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  const document = documentFor(html);
  const ui = renderer({ document, window: { morrowFeaturesCatalog: catalog } });
  ui.run("paintFeatureCatalog()");
  assert.match(document.getElementById("features-catalog").textContent, /IMAP connection recovery/);
  assert.match(document.getElementById("features-catalog").textContent, /connection-error and retry status/);
  assert.match(document.getElementById("pref-sync-details").textContent, /IMAP timeout/);
}

function run() {
  for (const scenario of scenarios) {
    const child = spawnSync(process.execPath, [__filename, "--scenario", scenario], { encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 0, `${scenario} failed: ${child.error || ""}\n${child.stdout}\n${child.stderr}`);
    assert.equal(child.stderr, "", `${scenario}: unexpected unhandled error or listener warning`);
  }
  checkHelp();
  console.log(`imap-client-errors-ok: ${scenarios.length} offline lifecycle cases; synthetic Features/help DOM; no native/live validation`);
}
if (require.main === module) {
  if (process.argv[2] === "--scenario") checkScenario(process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
  else run();
}
module.exports = { run };
