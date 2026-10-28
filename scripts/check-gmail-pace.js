// Gmail read spacing and quota-pause schedule. No network, mailbox, or credentials.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("../host/mail/provider-http");
const pace = require("../host/mail/gmail-pace");
const { createGmailMailApi } = require("../host/mail/gmail-mail-api");

const CAP = 15 * 60 * 1000;

function testPauseSchedule() {
  assert.equal(http.RATE_LIMIT_PAUSE_MS, 30000);
  assert.equal(http.RATE_LIMIT_CAP_MS, CAP);
  assert.equal(http.quotaPauseMs(1, null), 30000);
  assert.equal(http.quotaPauseMs(1, undefined), 30000);
  assert.equal(http.quotaPauseMs(2, null), 30000);
  assert.equal(http.quotaPauseMs(1, 0), 0);
  assert.equal(http.quotaPauseMs(2, 0), 0);
  assert.equal(http.quotaPauseMs(1, 5000), 5000);
  assert.equal(http.quotaPauseMs(1, 60000), 60000);
  assert.equal(http.quotaPauseMs(1, 60 * 60 * 1000), CAP);
  assert.equal(http.quotaPauseMs(3, null), 120000);
  assert.equal(http.quotaPauseMs(3, 0), 120000);
  assert.equal(http.quotaPauseMs(3, 10000), 120000);
  assert.equal(http.quotaPauseMs(3, 10 * 60 * 1000), 10 * 60 * 1000);
  assert.equal(http.quotaPauseMs(4, null), 240000);
  assert.equal(http.quotaPauseMs(5, null), 480000);
  assert.equal(http.quotaPauseMs(6, null), CAP);
  assert.equal(http.quotaPauseMs(9, null), CAP);
  assert.equal(http.quotaPauseMs(3, 20 * 60 * 1000), CAP);
  assert.equal(http.isRateLimit({ status: 403, message: "rateLimitExceeded", gmailDiagnostic: { category: "permission" } }), false);
  assert.equal(http.isRateLimit({ status: 403, message: "rateLimitExceeded", gmailDiagnostic: { category: "quota" } }), true);
  assert.equal(http.isRateLimit({ status: 401, code: "auth", message: "rateLimitExceeded", gmailDiagnostic: { category: "auth" } }), false);
}

function testSpacingMath() {
  assert.equal(pace.USER_UNITS_PER_MIN, 6000);
  assert.equal(pace.READ_UNITS_PER_MIN, 4500);
  assert.equal(pace.SYNC_PAGE, 20);
  assert.ok(pace.READ_UNITS_PER_MIN < pace.USER_UNITS_PER_MIN);
  assert.equal(pace.readUnits("messages.get", { format: "full" }), 60);
  assert.equal(pace.readUnits("messages.get", { format: "raw" }), 60);
  assert.equal(pace.readUnits("messages.get", { format: "metadata" }), 20);
  assert.equal(pace.readUnits("messages.get", {}), 60);
  assert.equal(pace.readUnits("messages.list", {}), 5);
  assert.equal(pace.readUnits("history.list", {}), 2);
  assert.equal(pace.readUnits("attachments.get", {}), 20);
  assert.equal(pace.readUnits("profile.get", {}), 1);
  assert.equal(pace.gapMs(60), 800);
  assert.equal(pace.gapMs(20), 267);
  assert.equal(pace.gapMs(5), 67);
  assert.equal(pace.SYNC_PAGE * pace.readUnits("messages.get", { format: "full" }), 1200);
  const frozen = pace.createReadPacer({ now: () => 1000 });
  assert.equal(frozen(60), 0);
  assert.equal(frozen(60), 800);
  assert.equal(frozen(5), 1600);
  const other = pace.createReadPacer({ now: () => 1000 });
  assert.equal(other(60), 0, "a second mailbox does not inherit the first mailbox wait");
}

function testWiring() {
  const root = path.join(__dirname, "..");
  const session = fs.readFileSync(path.join(root, "host/mail/gmail-session.js"), "utf8");
  const engine = fs.readFileSync(path.join(root, "host/mail/engine.js"), "utf8");
  const api = fs.readFileSync(path.join(root, "host/mail/gmail-mail-api.js"), "utf8");
  const catalog = fs.readFileSync(path.join(root, "renderer/features-catalog.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8");
  assert.match(session, /accountKey:\s*account\.id/);
  assert.match(engine, /gmailPace\.SYNC_PAGE/);
  assert.match(engine, /http\.quotaPauseMs/);
  assert.match(engine, /gmailPace\.reset\(id\)/);
  assert.match(engine, /item\.kind !== "open" && !gateOpen\(row\.account_id\)/);
  assert.match(api, /method === "GET"/);
  assert.match(api, /gmailPace\.reserve\(accountKey/);
  assert.doesNotMatch(api, /messages\.send[\s\S]{0,80}gmailPace\.reserve/);
  for (const text of [catalog, html]) {
    assert.match(text, /per-user quota/);
    assert.match(text, /20 Gmail messages per folder pass/);
    assert.match(text, /first two pauses are 30 seconds/);
    assert.match(text, /Writes are not|writes are not/);
  }
  assert.match(catalog, /Gmail API body downloads use the same per-user read spacing as sync/);
}

async function testApiSpacesReadsOnly() {
  const prior = process.env.MORROW_GMAIL_PACE;
  delete process.env.MORROW_GMAIL_PACE;
  pace.reset("pace-ada");
  pace.reset("pace-meta");
  const waits = [];
  const original = pace.sleep;
  pace.sleep = (ms) => {
    waits.push(ms);
    return Promise.resolve();
  };
  const message = { id: "m1", threadId: "t1", labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: [], body: { data: "" } } };
  const fetchImpl = async () => new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const api = createGmailMailApi({ accountKey: "pace-ada", accessToken: async () => "synthetic-token", fetchImpl });
    await api.getMessage("m1");
    assert.equal(waits.length, 0, "the first full read in a quiet minute does not wait");
    await api.getMessage("m1");
    assert.equal(waits.length, 1);
    assert.ok(waits[0] <= 800 && waits[0] >= 700, `full-read gap ${waits[0]}`);
    const posts = waits.length;
    await api.modifyLabels("m1", ["STARRED"], []);
    assert.equal(waits.length, posts, "label writes are not spaced or retried");
    const quiet = createGmailMailApi({ accountKey: "pace-off", accessToken: async () => "synthetic-token", fetchImpl });
    process.env.MORROW_GMAIL_PACE = "0";
    await quiet.getMessage("m1");
    await quiet.getMessage("m1");
    assert.equal(waits.length, posts, "MORROW_GMAIL_PACE=0 is the fixture switch, not a second schedule");
    delete process.env.MORROW_GMAIL_PACE;
    const metaWaits = [];
    pace.sleep = (ms) => {
      metaWaits.push(ms);
      return Promise.resolve();
    };
    const meta = createGmailMailApi({ accountKey: "pace-meta", accessToken: async () => "synthetic-token", fetchImpl });
    await meta.getMessage("m1", { format: "metadata" });
    await meta.getMessage("m1", { format: "metadata" });
    assert.equal(metaWaits.length, 1);
    assert.ok(metaWaits[0] <= 267 && metaWaits[0] >= 200, `metadata gap ${metaWaits[0]}`);
    const bare = createGmailMailApi({ accessToken: async () => "synthetic-token", fetchImpl });
    await bare.getMessage("m1");
    await bare.getMessage("m1");
    assert.equal(metaWaits.length, 1, "callers without a mailbox key do not join a shared bucket");
  } finally {
    pace.sleep = original;
    pace.reset("pace-ada");
    pace.reset("pace-meta");
    pace.reset("pace-off");
    if (prior === undefined) delete process.env.MORROW_GMAIL_PACE;
    else process.env.MORROW_GMAIL_PACE = prior;
  }
}

async function run() {
  testPauseSchedule();
  testSpacingMath();
  testWiring();
  await testApiSpacesReadsOnly();
  console.log("gmail-pace-ok");
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { run };
