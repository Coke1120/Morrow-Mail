const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

function callback(url, denied) {
  const auth = new URL(url);
  const target = new URL(auth.searchParams.get("redirect_uri"));
  target.hostname = "127.0.0.1";
  target.searchParams.set("state", auth.searchParams.get("state"));
  target.searchParams.set(denied ? "error" : "code", denied ? "access_denied" : "fixture-code");
  return new Promise((resolve, reject) => {
    http.get(target, (res) => {
      let body = "";
      res.on("data", (part) => { body += part; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morrow-one-consent-"));
  const envKeys = ["MORROW_MAIL_DIR", "MORROW_MAIL_SECRETS", "MORROW_GOOGLE_OAUTH_JSON", "MORROW_GOOGLE_OAUTH_FILE", "GOOGLE_DESKTOP_OAUTH_JSON"];
  const env = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.MORROW_MAIL_DIR = dir;
  process.env.MORROW_MAIL_SECRETS = "memory";
  delete process.env.MORROW_GOOGLE_OAUTH_FILE;
  delete process.env.GOOGLE_DESKTOP_OAUTH_JSON;
  process.env.MORROW_GOOGLE_OAUTH_JSON = JSON.stringify({ installed: {
    client_id: "one-consent-fixture.apps.googleusercontent.com", client_secret: "fixture-only",
  } });
  const config = require("../host/mail/oauth-config");
  const oauth = require("../host/mail/oauth");
  const engine = require("../host/mail/engine");
  const db = require("../host/mail/db");
  const memory = require("../host/mail/memory-secrets");
  const remote = require("../host/mail/remote");
  const sidecar = require("../host/mail/sidecar");
  const original = { signIn: oauth.signIn, accessTokenFor: oauth.accessTokenFor, fetch: global.fetch, setPassword: memory.setPassword, update: db.updateAccountLogin, insert: db.insertAccount };
  const remoteOriginal = {};
  const opened = [], posts = [], pages = [], syncs = [], keys = new Set();
  let scenario = {};
  const json = (data, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => data, text: async () => JSON.stringify(data) });
  const fetchMock = async (url, init = {}) => {
    const href = String(url);
    if (href === config.ENDPOINTS.microsoft.token || href === config.ENDPOINTS.google.token) {
      const body = new URLSearchParams(init.body);
      const scope = body.get("scope") || "";
      posts.push({ provider: href === config.ENDPOINTS.microsoft.token ? "microsoft" : "google", scope, grant: body.get("grant_type") });
      assert.ok(!(scope.includes("outlook.office.com") && /User.Read|Calendars.ReadWrite/.test(scope)), "token requests must target one resource");
      if (body.get("grant_type") === "authorization_code") {
        assert.equal(body.get("code"), "fixture-code");
        assert.ok(body.get("code_verifier"));
      }
      const google = href === config.ENDPOINTS.google.token;
      const mail = scope.includes("outlook.office.com");
      if ((scenario.cancel && (mail || google)) || (scenario.graphCancel && !mail && !google)) oauth.cancelActive();
      if (scenario.refreshFailure || (scenario.graphFailure && !mail && !google)) return json({ error: "interaction_required" }, false);
      const granted = google ? (scenario.googleScopes ?? config.BUNDLE_SCOPES.google)
        : mail ? (scenario.mailScopes ?? config.SCOPES.microsoft) : (scenario.graphScopes ?? config.BUNDLE_SCOPES.microsoft);
      return json({
        access_token: google ? "fixture-google-both" : mail ? "fixture-outlook-mail" : "fixture-graph-calendar",
        ...(scenario.noRefresh || (scenario.graphNoRefresh && !mail && !google) ? {} : { refresh_token: mail ? "fixture-imap-refresh" : "fixture-api-refresh" }),
        expires_in: 3600,
        ...(scenario.omitScope ? {} : { scope: granted }),
      });
    }
    if (href.includes("openidconnect.googleapis.com")) {
      assert.equal(init.headers.authorization, "Bearer fixture-google-both");
      return json({ email: scenario.email || "google@example.invalid", name: "Google Fixture" });
    }
    if (href.includes("outlook.office.com/api/v2.0/me")) {
      assert.equal(init.headers.authorization, "Bearer fixture-outlook-mail");
      return json({ EmailAddress: scenario.email || "microsoft@example.invalid", DisplayName: "Microsoft Fixture" });
    }
    if (href.includes("graph.microsoft.com/v1.0/me?")) {
      assert.equal(init.headers.authorization, "Bearer fixture-graph-calendar");
      return json({ mail: scenario.graphEmail || scenario.email || "microsoft@example.invalid", displayName: "Microsoft Fixture" });
    }
    if (href.includes("www.googleapis.com/calendar/v3")) {
      assert.equal(init.headers.authorization, "Bearer fixture-google-both");
      return json({ items: href.includes("calendarList") ? [{ id: "primary", summary: "Fixture", primary: true }] : [] });
    }
    if (href.includes("graph.microsoft.com/v1.0/me/calendars")) {
      assert.equal(init.headers.authorization, "Bearer fixture-graph-calendar");
      return json({ value: href.includes("calendarView") ? [] : [{ id: "primary", name: "Fixture", isDefaultCalendar: true }] });
    }
    if (href.startsWith("https://gmail.googleapis.com/") || href.startsWith("https://graph.microsoft.com/")) {
      assert.equal(init.method || "GET", "GET", "consent must not perform provider writes");
      assert.equal(init.headers.authorization, href.includes("gmail.googleapis.com") ? "Bearer fixture-google-both" : "Bearer fixture-graph-calendar");
      if (href.includes("/settings/vacation")) return json({ enableAutoReply: false });
      if (href.includes("/mailboxSettings")) return json({ status: "disabled" });
      if (href.includes("/settings/filters")) return json({ filter: [] });
      if (href.includes("/labels")) return json({ labels: [] });
      if (href.includes("/mailFolders")) return json({ value: [] });
    }
    throw new Error(`Unexpected network call in one-consent check: ${href}`);
  };
  const mocks = {
    withClient: async (account, token, work) => {
      assert.equal(token, account.profile === "gmail" ? "fixture-google-both" : "fixture-outlook-mail");
      syncs.push(account.id);
      return work({});
    },
    listFolderRecords: async () => ({ folders: [{ path: "INBOX", name: "Inbox", wellKnown: "inbox" }], delimiter: "/" }),
    verifySmtp: async (account, token) => assert.equal(token, account.profile === "gmail" ? "fixture-google-both" : "fixture-outlook-mail"),
    searchUids: async () => ({ uids: [], validity: 1, exists: 0, unseen: 0 }),
    fetchMessages: async () => { throw new Error("No messages in fixture"); },
    openIdleClient: async () => { throw new Error("IDLE disabled in fixture"); },
  };
  for (const [name, mock] of Object.entries(mocks)) { remoteOriginal[name] = remote[name]; remote[name] = mock; }
  const read = (id) => JSON.parse(memory.getPassword(id));
  const remember = (id) => { for (const suffix of ["", ":bundle", ":calendar", ":organize", ":rules", ":vacation"]) keys.add(id + suffix); };
  const connect = async (provider, id, channel = "mail:addAccount") => {
    const result = await engine.answer(channel, [channel === "calendar:connect" ? { accountId: id } : { provider, expectedAccountId: id }]);
    if (result.success && result.data.id) remember(result.data.id);
    return result;
  };
  const calendarList = async (id) => {
    const result = await engine.answer("calendar:list", [{ accountId: id, timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-11-01T00:00:00Z" }]);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.data.api, true);
    assert.equal(result.data.calendars.length, 1);
  };
  try {
    global.fetch = fetchMock;
    oauth.signIn = (provider, purpose) => {
      assert.ok(purpose === "bundle" || (provider === "microsoft" && purpose === "imap"));
      return original.signIn(provider, purpose, {
        fetchImpl: fetchMock, timeoutMs: 3000,
        openBrowser: async (url) => {
          const auth = new URL(url);
          opened.push(auth);
          assert.equal(auth.searchParams.get("scope"), config.scopesFor(provider, purpose));
          assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
          assert.ok(auth.searchParams.get("state"));
          if (provider === "google") assert.equal(auth.searchParams.get("include_granted_scopes"), "true");
          if (provider === "microsoft") {
            const scope = auth.searchParams.get("scope");
            assert.equal(scope.includes("outlook.office.com"), purpose === "imap");
            if (purpose === "imap") assert.doesNotMatch(scope, /User.Read|Calendars|MailboxSettings|Mail.Read|Mail.Send/);
          }
          if (scenario.onOpen) await scenario.onOpen();
          pages.push(callback(url, scenario.denied || (scenario.graphDenied && purpose === "bundle")));
        },
      });
    };
    await engine.init();
    const channels = { calendar: "calendar:connect", organize: "mail:grantOrganize", rules: "mail:grantRules", vacation: "mail:grantVacation" };
    const feature = (id, purpose) => engine.answer(channels[purpose], [{ accountId: id }]);
    const granted = (id, purpose) => sidecar.gateAccount(db.accountById(id), purpose).ok;
    for (const provider of ["microsoft", "google"]) {
      const scopes = config.BUNDLE_SCOPES[provider];
      assert.doesNotMatch(scopes, /contacts|drive/i);
      for (const purpose of Object.keys(channels)) assert.equal(config.hasPurposeScopes(scopes, provider, purpose), true);
      const count = opened.length;
      scenario = { omitScope: provider === "microsoft" };
      const result = await connect(provider);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.data.grantWarning, "");
      const id = result.data.id;
      const dialogs = provider === "microsoft" ? 2 : 1;
      assert.equal(opened.length, count + dialogs);
      assert.equal((await pages.at(-1)).status, 200);
      const mail = read(id), api = provider === "microsoft" ? read(`${id}:bundle`) : mail;
      assert.equal(config.hasPurposeScopes(mail.grantedScopes, provider, "imap"), true);
      if (provider === "microsoft") {
        assert.equal(mail.accessToken, "fixture-outlook-mail");
        assert.equal(api.accessToken, "fixture-graph-calendar");
        assert.equal(mail.requestedScopes, config.SCOPES.microsoft);
        assert.equal(api.requestedScopes, config.BUNDLE_SCOPES.microsoft);
        assert.notEqual(mail.refreshToken, api.refreshToken);
        assert.deepEqual(posts.slice(-2).map((post) => post.grant), ["authorization_code", "authorization_code"]);
      }
      const status = engine.answer("mail:oauthStatus", []);
      for (const purpose of Object.keys(channels)) {
        assert.equal(status.data.accounts.find((row) => row.id === id)[purpose], true);
        assert.equal((await feature(id, purpose)).data.api, true);
      }
      assert.doesNotMatch(JSON.stringify({ result, status }), /fixture-api-refresh|fixture-imap-refresh|fixture-google-both|fixture-outlook-mail|fixture-graph-calendar/);
      assert.equal(opened.length, count + dialogs, "all granted features must reuse consent");
      await calendarList(id);
      for (const channel of ["mail:listProviderFolders", "mail:listInboxRules", "mail:vacationGet"]) {
        const listed = await engine.answer(channel, [{ accountId: id }]);
        assert.equal(listed.success, true, JSON.stringify(listed));
        assert.equal(channel === "mail:vacationGet" ? listed.data.canWrite : listed.data.api, true);
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.ok(syncs.includes(id));
      for (const blob of [mail, api]) {
        const refreshed = await oauth.accessTokenFor(db.accountById(id), JSON.stringify({ ...blob, expiresAt: 1 }));
        assert.equal(refreshed.token, blob.accessToken);
        assert.equal(JSON.parse(refreshed.store).requestedScopes, blob.requestedScopes);
      }
    }

    const ms = db.accountByEmail("microsoft@example.invalid");
    const primary = memory.getPassword(ms.id), bundle = memory.getPassword(`${ms.id}:bundle`);
    db.insertMessage({ id: "one-consent-cache", accountId: ms.id, folderPath: "INBOX", uid: 1, uidValidity: 1,
      subject: "Keep cached work", textBody: "Retained", bodyComplete: true, date: new Date().toISOString(), listSortTs: Date.now() });
    // A mail-only account adds all Graph features with one additional consent.
    memory.deletePassword(`${ms.id}:bundle`);
    scenario = {};
    let count = opened.length;
    assert.equal((await feature(ms.id, "calendar")).success, true);
    assert.equal(opened.length, count + 1);
    assert.equal(memory.getPassword(ms.id), primary);
    assert.equal(db.messageById("one-consent-cache").text_body, "Retained");

    // A calendar-only legacy grant remains usable. Mail reconnect adds Outlook
    // and one Graph bundle without changing account identity or cached work.
    memory.deletePassword(ms.id);
    memory.deletePassword(`${ms.id}:bundle`);
    memory.setPassword(`${ms.id}:calendar`, JSON.stringify({ ...JSON.parse(bundle), purpose: "calendar",
      grantedScopes: config.CALENDAR_SCOPES.microsoft, requestedScopes: config.CALENDAR_SCOPES.microsoft }));
    count = opened.length;
    assert.equal((await feature(ms.id, "calendar")).success, true);
    assert.equal(opened.length, count);
    await calendarList(ms.id);
    assert.equal((await connect("microsoft", ms.id)).data.id, ms.id);
    assert.equal(opened.length, count + 2);
    await new Promise((resolve) => setTimeout(resolve, 40));

    // Failures in IMAP cannot replace either saved resource token.
    for (const failure of [
      { mailScopes: "https://outlook.office.com/IMAP.AccessAsUser.All" },
      { noRefresh: true }, { refreshFailure: true }, { cancel: true }, { denied: true }, { email: "wrong@example.invalid" },
    ]) {
      scenario = failure;
      const before = [memory.getPassword(ms.id), memory.getPassword(`${ms.id}:bundle`)];
      const result = await connect("microsoft", ms.id);
      assert.equal(result.success, false, JSON.stringify(failure));
      assert.deepEqual([memory.getPassword(ms.id), memory.getPassword(`${ms.id}:bundle`)], before);
      assert.equal((await pages.at(-1)).status, 400);
      assert.equal(db.accountByEmail("wrong@example.invalid"), null);
    }

    // A declined, failed, or mismatched Graph dialog leaves the IMAP mailbox
    // connected. A retry from any feature requests only Graph.
    for (const failure of [{ graphDenied: true }, { graphCancel: true }, { graphFailure: true }, { graphNoRefresh: true }, { graphScopes: "User.Read" }, { graphEmail: "wrong@example.invalid" }]) {
      memory.deletePassword(`${ms.id}:bundle`);
      scenario = failure;
      count = opened.length;
      const result = await connect("microsoft", ms.id);
      assert.equal(result.success, true);
      assert.ok(result.data.grantWarning);
      assert.equal(opened.length, count + 2);
      assert.equal(read(ms.id).accessToken, "fixture-outlook-mail");
      assert.equal(memory.getPassword(`${ms.id}:bundle`), null);
      assert.equal((await pages.at(-1)).status, 400);
      scenario = {};
      count = opened.length;
      assert.equal((await feature(ms.id, "organize")).success, true);
      assert.equal(opened.length, count + 1);
    }

    // Partial Graph grants enable only complete features and preserve older
    // grants. Refresh requests use the actual granted scopes.
    memory.deletePassword(`${ms.id}:bundle`);
    scenario = { graphScopes: config.VACATION_SCOPES.microsoft };
    assert.equal((await feature(ms.id, "organize")).success, false);
    assert.equal(granted(ms.id, "vacation"), true);
    assert.equal(granted(ms.id, "rules"), false, "rules also need folder read access");
    assert.equal(granted(ms.id, "organize"), false);
    const partial = read(`${ms.id}:bundle`);
    await oauth.accessTokenFor(ms, JSON.stringify({ ...partial, expiresAt: 1 }));
    assert.equal(posts.at(-1).scope, config.VACATION_SCOPES.microsoft);
    scenario = { graphScopes: config.ORGANIZE_SCOPES.microsoft };
    assert.equal((await feature(ms.id, "organize")).success, true);
    assert.equal(granted(ms.id, "vacation"), true, "earlier settings grant survives a narrower bundle");
    assert.equal(read(`${ms.id}:vacation`).grantedScopes, config.VACATION_SCOPES.microsoft);
    scenario = {};
    count = opened.length;
    assert.equal((await feature(ms.id, "rules")).success, true);
    assert.equal(opened.length, count + 1);
    for (const purpose of Object.keys(channels)) assert.equal(granted(ms.id, purpose), true);

    const google = db.accountByEmail("google@example.invalid");
    for (const scopes of [config.SCOPES.google, config.CALENDAR_SCOPES.google,
      `${config.SCOPES.google} https://www.googleapis.com/auth/calendar.events`]) {
      scenario = { googleScopes: scopes };
      const before = memory.getPassword(google.id);
      assert.equal((await connect("google", google.id)).success, false);
      assert.equal(memory.getPassword(google.id), before);
      assert.equal((await pages.at(-1)).status, 400);
    }
    // A new partial Google connection can sync mail. Enabling a missing feature
    // requests the full bundle once, retaining the original primary secret.
    scenario = { email: "partial@example.invalid", googleScopes: config.SCOPES.google };
    const partialGoogle = await connect("google");
    assert.equal(partialGoogle.success, true);
    assert.ok(partialGoogle.data.grantWarning);
    const partialId = partialGoogle.data.id;
    const mailOnly = memory.getPassword(partialId);
    scenario = { email: "partial@example.invalid", googleScopes: config.VACATION_SCOPES.google };
    assert.equal((await feature(partialId, "rules")).success, false);
    assert.equal(granted(partialId, "vacation"), true);
    assert.equal(granted(partialId, "rules"), false, "Gmail rules also need labels");
    assert.equal(memory.getPassword(partialId), mailOnly);
    scenario = { email: "partial@example.invalid" };
    count = opened.length;
    assert.equal((await feature(partialId, "calendar")).success, true);
    assert.equal(opened.length, count + 1);
    for (const purpose of Object.keys(channels)) assert.equal((await feature(partialId, purpose)).data.api, true);
    assert.equal(opened.length, count + 1);
    assert.equal(memory.getPassword(partialId), mailOnly);
    // Without mail permission a new mailbox cannot be created.
    scenario = { email: "no-mail@example.invalid", googleScopes: config.CALENDAR_SCOPES.google };
    assert.equal((await connect("google")).success, false);
    assert.equal(db.accountByEmail(scenario.email), null);

    // Roll back credentials if their write or the account save fails.
    scenario = {};
    memory.setPassword(ms.id, primary);
    const beforeBundle = memory.getPassword(`${ms.id}:bundle`);
    let failOnce = true;
    memory.setPassword = (key, value) => {
      original.setPassword(key, value);
      if (key === ms.id && failOnce) { failOnce = false; throw new Error("Fixture keychain failure"); }
    };
    assert.equal((await connect("microsoft", ms.id)).error.code, "keychain");
    assert.equal(memory.getPassword(ms.id), primary);
    assert.equal(memory.getPassword(`${ms.id}:bundle`), beforeBundle);
    memory.setPassword = original.setPassword;
    db.updateAccountLogin = () => { throw new Error("Fixture database failure"); };
    assert.equal((await connect("microsoft", ms.id)).error.code, "storage");
    assert.equal(memory.getPassword(ms.id), primary);
    db.updateAccountLogin = original.update;
    scenario = { email: "save-failed@example.invalid" };
    let failedId;
    db.insertAccount = (row) => { failedId = row.id; throw new Error("Fixture insert failure"); };
    assert.equal((await connect("microsoft")).error.code, "storage");
    assert.equal(memory.getPassword(failedId), null);
    assert.equal(db.accountByEmail(scenario.email), null);
    db.insertAccount = original.insert;

    // A failed shared-token save restores both the bundle and any archived
    // feature grants, including a write that changes storage before throwing.
    const keptBundle = memory.getPassword(`${ms.id}:bundle`);
    const keptVacation = memory.getPassword(`${ms.id}:vacation`);
    memory.setPassword(`${ms.id}:bundle`, JSON.stringify({ ...JSON.parse(bundle), grantedScopes: config.VACATION_SCOPES.microsoft }));
    const beforePartial = memory.getPassword(`${ms.id}:bundle`);
    scenario = { graphScopes: config.ORGANIZE_SCOPES.microsoft };
    failOnce = true;
    memory.setPassword = (key, value) => {
      original.setPassword(key, value);
      if (key === `${ms.id}:bundle` && failOnce) { failOnce = false; throw new Error("Fixture bundle write failure"); }
    };
    assert.equal((await feature(ms.id, "organize")).error.code, "keychain");
    assert.equal(memory.getPassword(`${ms.id}:bundle`), beforePartial);
    assert.equal(memory.getPassword(`${ms.id}:vacation`), keptVacation);
    assert.equal(memory.getPassword(ms.id), primary);
    memory.setPassword = original.setPassword;
    // A reconnect while the dialog is pending cannot overwrite newer secrets.
    scenario = { onOpen: () => memory.setPassword(ms.id, "newer-connection") };
    assert.equal((await feature(ms.id, "organize")).error.code, "conflict");
    assert.equal(memory.getPassword(`${ms.id}:bundle`), beforePartial);
    memory.setPassword(ms.id, primary);
    memory.setPassword(`${ms.id}:bundle`, keptBundle);
    // An older feature refresh cannot overwrite a newer shared consent.
    const newerBundle = JSON.stringify({ ...JSON.parse(keptBundle), refreshToken: "fixture-newer-consent" });
    oauth.accessTokenFor = async (_account, raw) => {
      memory.setPassword(`${ms.id}:bundle`, newerBundle);
      return { token: JSON.parse(raw).accessToken, store: raw };
    };
    const staleRefresh = await engine.answer("calendar:list", [{ accountId: ms.id, timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-11-01T00:00:00Z" }]);
    assert.equal(staleRefresh.error.code, "conflict");
    assert.equal(memory.getPassword(`${ms.id}:bundle`), newerBundle);
    oauth.accessTokenFor = original.accessTokenFor;
    memory.setPassword(`${ms.id}:bundle`, keptBundle);

    // Removing an account during consent must not resurrect its credentials.
    memory.setPassword(`${partialId}:bundle`, JSON.stringify({ ...read(`${partialId}:bundle`), grantedScopes: config.VACATION_SCOPES.google }));
    scenario = { email: "partial@example.invalid", onOpen: () => engine.answer("mail:removeAccount", [{ accountId: partialId }]) };
    assert.equal((await feature(partialId, "calendar")).error.code, "conflict");
    assert.equal(memory.getPassword(`${partialId}:bundle`), null);
    assert.equal(memory.getPassword(partialId), null);
    assert.equal(db.accountById(partialId), null);

    // Refuse mixed-resource token requests even if a malformed old record asks.
    const mixed = `${config.SCOPES.microsoft} User.Read`;
    await assert.rejects(() => oauth.refresh("microsoft", { clientId: "fixture" }, "fixture", mixed, mixed, fetchMock), /separate sign-ins/);
    await assert.rejects(() => oauth.exchange("microsoft", { clientId: "fixture" }, "code", "redirect", "verifier", mixed, fetchMock), /separate sign-ins/);
    scenario = {};
    await oauth.refresh("microsoft", { clientId: "fixture" }, "fixture", "offline_access,IMAP.AccessAsUser.All,SMTP.Send", "", fetchMock);
    assert.equal(posts.at(-1).scope, config.SCOPES.microsoft);
    await oauth.refresh("microsoft", { clientId: "fixture" }, "fixture", "User.Read%20Calendars.ReadWrite", "", fetchMock);
    assert.equal(posts.at(-1).scope, "User.Read Calendars.ReadWrite");
    await Promise.all(pages);
    console.log("mail-calendar-consent-ok");
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 60));
    oauth.signIn = original.signIn;
    oauth.accessTokenFor = original.accessTokenFor;
    global.fetch = original.fetch;
    memory.setPassword = original.setPassword;
    db.updateAccountLogin = original.update;
    db.insertAccount = original.insert;
    Object.assign(remote, remoteOriginal);
    for (const key of keys) memory.deletePassword(key);
    db.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };
if (require.main === module) run().catch((error) => { console.error(error); process.exitCode = 1; });
