const db = require("./db");
const secrets = require("./secrets");
const oauth = require("./oauth");
const config = require("./oauth-config");
const gmail = require("./provider-api");
const calendar = require("./calendar-api");
const inboxRules = require("./inbox-rules");
const vacationApi = require("./vacation-api");
const sieve = require("./sieve-vacation");
const crypto = require("node:crypto");

const CHANNELS = new Set([
  "mail:oauthStatus",
  "mail:grantOrganize",
  "mail:grantVacation",
  "mail:vacationGet",
  "mail:vacationPut",
  "mail:listProviderFolders",
  "mail:createProviderFolder",
  "mail:renameProviderFolder",
  "mail:deleteProviderFolder",
  "mail:moveProviderFolder",
  "mail:modifyMessageLabels",
  "mail:moveProviderMessage",
  "mail:listInboxRules",
  "mail:saveInboxRule",
  "mail:deleteInboxRule",
  "mail:grantRules",
  "calendar:status",
  "calendar:connect",
  "calendar:list",
  "calendar:createEvent",
]);

const MONTH_MS = 62 * 24 * 60 * 60 * 1000;

function ok(data) {
  return { success: true, data };
}

function fail(code, message) {
  return { success: false, error: { code, message, status: 0, retryable: false } };
}

function publicError(error) {
  const message = error instanceof Error ? error.message : String(error || "The provider rejected the request.");
  if (/client_secret|refresh_token|access_token|ya29\.|Bearer /i.test(message)) {
    return "The provider rejected the request.";
  }
  return message.slice(0, 300);
}

function failFrom(error) {
  const code = error && error.code;
  if (code === "provider_network") return fail("provider", publicError(error));
  if (code === "oauth_not_ready" || code === "scope_missing" || code === "needs_auth" || code === "invalid" || code === "not-found" || code === "too_many" || code === "account_mismatch" || code === "oauth" || code === "imap_only" || code === "no_account" || code === "collision" || code === "partial" || code === "conflict" || code === "unsupported") {
    return fail(code, publicError(error));
  }
  return fail("provider", publicError(error));
}

function handles(channel) {
  return CHANNELS.has(channel);
}

function providerOf(account) {
  return config.providerKey(account && account.profile) || "imap";
}

function sameEmail(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function readJson(key) {
  const raw = secrets.getPassword(key);
  if (!raw || typeof raw !== "string" || raw[0] !== "{") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

const API_PURPOSES = ["organize", "calendar", "rules", "vacation"];

function scopeText(account, purpose) {
  const blob = account && readJson(secretKey(account, purpose));
  return (blob && blob.grantedScopes) || "";
}

function secretKey(account, purpose) {
  if (purpose === "imap") return account.id;
  const provider = providerOf(account);
  // One shared API token avoids independent refresh-token rotation for each
  // feature. Legacy per-purpose grants remain fallbacks after partial consent.
  const candidates = [`${account.id}:bundle`, `${account.id}:${purpose}`];
  if (provider === "google") candidates.push(account.id);
  for (const key of candidates) {
    const grant = readJson(key);
    if (grant && grant.refreshToken && config.hasPurposeScopes(grant.grantedScopes, provider, purpose)) return key;
  }
  return `${account.id}:${purpose}`;
}

function gateMessage(reason, provider, purpose) {
  if (reason === "oauth_not_ready") return "Google Desktop OAuth is not configured.";
  if (reason === "imap_only") {
    return purpose === "calendar"
      ? "Calendar needs a Google or Microsoft account."
      : "Labels stay on IMAP for this account.";
  }
  if (reason === "needs_auth") return "Calendar needs a calendar grant.";
  if (purpose === "rules") {
    if (provider === "microsoft") return "Outlook rules need the MailboxSettings.ReadWrite grant.";
    return "Gmail filters need the gmail.settings.basic grant.";
  }
  if (purpose === "vacation") {
    if (provider === "microsoft") return "Automatic replies need the MailboxSettings.ReadWrite grant. The existing mailbox stays connected.";
    if (provider === "google") return "Automatic replies need the gmail.settings.basic grant. The existing mailbox stays connected.";
    return "This mailbox uses a server vacation script when the IMAP server offers one. Morrow will not send local automatic replies.";
  }
  if (purpose === "calendar") return "Calendar needs a calendar grant.";
  if (provider === "microsoft") return "Outlook folders need the Mail.ReadWrite grant. This mailbox stays on IMAP until then.";
  return "Gmail labels need the gmail.modify grant. This mailbox stays on IMAP until then.";
}

function missingGrantMessage(provider, purpose) {
  const key = config.providerKey(provider);
  if (purpose === "calendar") {
    if (key === "microsoft") return "Microsoft did not return the Calendars.ReadWrite grant.";
    return "Google did not return both calendar.events and calendar.calendarlist.readonly permissions.";
  }
  if (purpose === "rules") {
    if (key === "microsoft") return "Microsoft did not return MailboxSettings.ReadWrite and folder read access (Mail.Read or Mail.ReadWrite).";
    return "Google did not return both gmail.settings.basic and gmail.labels permissions.";
  }
  if (purpose === "vacation") {
    return key === "microsoft" ? "Microsoft did not return the MailboxSettings.ReadWrite grant." : "Google did not return the gmail.settings.basic grant.";
  }
  if (key === "microsoft") return "Microsoft did not return the Mail.ReadWrite grant. This mailbox stays on IMAP until then.";
  return "Google did not return the gmail.modify grant. This mailbox stays on IMAP until then.";
}

function gateAccount(account, purpose) {
  const provider = providerOf(account);
  const scopes = scopeText(account, purpose);
  if (provider !== "google" && provider !== "microsoft") {
    return { ok: false, reason: "imap_only", provider, scopes, message: gateMessage("imap_only", provider, purpose) };
  }
  if (!config.hasPurposeScopes(scopes, provider, purpose) || !readJson(secretKey(account, purpose))?.refreshToken) {
    const reason = purpose === "calendar" ? "needs_auth" : "scope_missing";
    let message = gateMessage(reason, provider, purpose);
    if (purpose === "organize" && account.auth_kind !== "oauth2") {
      message = "This mailbox uses a password. Grant the provider API to manage labels, or keep using IMAP folders.";
    }
    return { ok: false, reason, provider, scopes, message };
  }
  if (provider === "google" && !oauth.oauthReady().google) {
    return { ok: false, reason: "oauth_not_ready", provider, scopes, message: gateMessage("oauth_not_ready", provider, purpose) };
  }
  return { ok: true, reason: "", provider, scopes, message: "" };
}

function accountFrom(params) {
  const id = params && (params.accountId || params.id);
  if (!id) return null;
  return db.accountById(id);
}

function tokenBlob(signed) {
  return {
    provider: signed.provider,
    purpose: signed.purpose,
    refreshToken: signed.refreshToken,
    accessToken: signed.accessToken,
    expiresAt: signed.expiresAt,
    grantedScopes: signed.grantedScopes || "",
    requestedScopes: signed.requestedScopes || signed.grantedScopes || "",
  };
}

function monthWindow(timeMin, timeMax) {
  const start = Date.parse(timeMin);
  const end = Date.parse(timeMax);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MONTH_MS) return null;
  return { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() };
}

async function organizeToken(account) {
  if (!account) return null;
  const gate = gateAccount(account, "organize");
  if (!gate.ok) return null;
  try {
    const token = await tokenFor(account, "organize");
    if (!token || !token.accessToken) return null;
    return { accessToken: token.accessToken, provider: gate.provider };
  } catch {
    return null;
  }
}

async function gmailSendAsToken(account) {
  // sendAs.list uses the same settings scope as vacation. Read only; never consent here.
  if (providerOf(account) !== "google" || !gateAccount(account, "vacation").ok) return null;
  return tokenFor(account, "vacation");
}

async function tokenFor(account, purpose) {
  const key = secretKey(account, purpose);
  const raw = secrets.getPassword(key);
  const parsed = readJson(key);
  if (!raw || !parsed || !parsed.refreshToken) {
    const error = new Error(
      purpose === "calendar"
        ? "Calendar needs a calendar grant."
        : purpose === "rules"
          ? "Inbox rules need a provider grant."
          : "That mail API grant is not saved."
    );
    error.code = purpose === "calendar" || purpose === "rules" ? "needs_auth" : "scope_missing";
    throw error;
  }
  const result = await oauth.accessTokenFor(account, raw, purpose);
  if (secrets.getPassword(key) !== raw) {
    const error = new Error("This mailbox connection changed. Refresh the feature and try again.");
    error.code = "conflict";
    throw error;
  }
  if (typeof result === "string") return { accessToken: result, grantedScopes: parsed.grantedScopes || "" };
  if (result && result.token) {
    if (result.store) {
      try { secrets.setPassword(key, result.store); } catch { /* this call can still use the token */ }
    }
    let granted = parsed.grantedScopes || "";
    if (result.store) {
      try { granted = JSON.parse(result.store).grantedScopes || granted; } catch { /* keep the previous scopes */ }
    }
    if (!config.hasPurposeScopes(granted, providerOf(account), purpose)) {
      const error = new Error("The refreshed token is missing permissions. Enable this feature again.");
      error.code = "scope_missing";
      throw error;
    }
    return {
      accessToken: result.token,
      grantedScopes: granted,
      ...(purpose === "vacation" ? { vacationIdentity: vacationIdentity(account) } : {}),
    };
  }
  const error = new Error("Could not refresh OAuth access token.");
  error.code = "oauth";
  throw error;
}

function accountGrants() {
  return db.listAccountRows().map((row) => {
    const organize = gateAccount(row, "organize");
    const calendarGate = gateAccount(row, "calendar");
    const rulesGate = gateAccount(row, "rules");
    const vacationGate = gateAccount(row, "vacation");
    return {
      id: row.id,
      email: row.email,
      provider: providerOf(row),
      authKind: row.auth_kind || "password",
      organize: organize.ok,
      calendar: calendarGate.ok,
      rules: rulesGate.ok,
      vacation: vacationGate.ok,
      organizeReason: organize.reason,
      calendarReason: calendarGate.reason,
      rulesReason: rulesGate.reason,
      vacationReason: vacationGate.reason,
      grantedScopes: {
        imap: scopeText(row, "imap"),
        organize: scopeText(row, "organize"),
        calendar: scopeText(row, "calendar"),
        rules: scopeText(row, "rules"),
        vacation: scopeText(row, "vacation"),
      },
    };
  });
}

function oauthStatus() {
  const ready = oauth.oauthReady();
  return ok({
    google: ready.google === true,
    microsoft: ready.microsoft === true,
    purposes: {
      bundle: { ...config.BUNDLE_SCOPES },
      imap: { google: config.SCOPES.google, microsoft: config.SCOPES.microsoft },
      organize: { google: config.ORGANIZE_SCOPES.google, microsoft: config.ORGANIZE_SCOPES.microsoft },
      calendar: { google: config.CALENDAR_SCOPES.google, microsoft: config.CALENDAR_SCOPES.microsoft },
      rules: { google: config.RULES_SCOPES.google, microsoft: config.RULES_SCOPES.microsoft },
      vacation: { google: config.VACATION_SCOPES.google, microsoft: config.VACATION_SCOPES.microsoft },
    },
    redirects: {
      imap: {
        google: "/api/oauth/google/callback",
        microsoft: "/api/oauth/microsoft/callback",
      },
      calendar: {
        google: "/api/calendar-oauth/google/callback",
        microsoft: "/api/calendar-oauth/microsoft/callback",
      },
    },
    accounts: accountGrants(),
  });
}

function calendarStatus() {
  const ready = oauth.oauthReady();
  return ok({
    google: ready.google === true,
    microsoft: ready.microsoft === true,
    accounts: accountGrants(),
  });
}

function grantResult(account, purpose) {
  const missing = API_PURPOSES.filter((name) => !gateAccount(account, name).ok);
  return ok({ accountId: account.id, email: account.email, provider: providerOf(account), purpose,
    api: purpose === "bundle" ? missing.length === 0 : gateAccount(account, purpose).ok,
    missing, reason: "", grantedScopes: scopeText(account, purpose) });
}

function saveBundle(account, signed) {
  const provider = providerOf(account);
  if (signed.provider !== provider || !sameEmail(signed.email, account.email)) {
    return fail("account_mismatch", "Sign in with the selected mailbox. Existing credentials are unchanged.");
  }
  if (!signed.refreshToken || !signed.accessToken) return fail("oauth", "Provider did not return offline access. Existing credentials are unchanged.");
  const granted = signed.grantedScopes || "";
  if (!API_PURPOSES.some((purpose) => config.hasPurposeScopes(granted, provider, purpose))) {
    return fail("scope_missing", "The provider did not grant the requested feature permissions. Existing credentials are unchanged.");
  }
  const key = `${account.id}:bundle`;
  const previous = readJson(key);
  const blob = { ...tokenBlob(signed), purpose: "bundle" };
  const writes = [];
  // Retain an older shared token for any feature omitted from the new consent.
  // Never claim the union of two grants on either token or overwrite mail here.
  for (const purpose of API_PURPOSES) {
    if (previous && config.hasPurposeScopes(previous.grantedScopes, provider, purpose) && !config.hasPurposeScopes(granted, provider, purpose)) {
      writes.push([`${account.id}:${purpose}`, JSON.stringify(previous)]);
    }
  }
  writes.push([key, JSON.stringify(blob)]);
  const before = new Map();
  const written = [];
  try {
    for (const [name] of writes) before.set(name, secrets.getPassword(name));
    for (const [name, value] of writes) {
      written.push(name);
      secrets.setPassword(name, value);
    }
  } catch {
    let restored = true;
    for (const name of written.reverse()) {
      try {
        if (before.get(name) == null) secrets.deletePassword(name);
        else secrets.setPassword(name, before.get(name));
      } catch { restored = false; }
    }
    return fail("keychain", restored ? "Could not save permissions. Previous credentials were restored." : "Could not restore all credentials after a storage failure. Reconnect the affected features.");
  }
  return grantResult(account, "bundle");
}

async function grantPurpose(params, purpose) {
  const account = accountFrom(params);
  if (!account) return fail("no_account", "Connect the mailbox first.");
  const provider = providerOf(account);
  if (provider !== "google" && provider !== "microsoft") return fail("imap_only", "These permissions need a Google or Microsoft account.");
  if (provider === "google" && !oauth.oauthReady().google) return fail("oauth_not_ready", "Google Desktop OAuth is not configured.");
  const already = grantResult(account, purpose);
  if (already.data.api) return already;
  const identity = secrets.getPassword(account.id);
  const bundle = secrets.getPassword(`${account.id}:bundle`);
  let signed;
  try {
    signed = await oauth.signIn(provider, "bundle", { expectedEmail: account.email });
  } catch (error) {
    return failFrom(error);
  }
  let saved;
  try {
    const current = accountFrom(params);
    if (!current || !sameEmail(current.email, account.email) || secrets.getPassword(account.id) !== identity || secrets.getPassword(`${account.id}:bundle`) !== bundle) {
      saved = fail("conflict", "This mailbox connection changed. Try again for the selected account.");
    } else {
      saved = saveBundle(account, signed);
      if (!saved.success && saved.error.code === "scope_missing" && purpose !== "bundle") {
        saved = fail("scope_missing", missingGrantMessage(provider, purpose));
      }
      if (saved.success) {
        saved = grantResult(account, purpose);
        if (!saved.data.api) saved = fail("scope_missing", purpose === "bundle"
          ? "Some feature permissions were not granted. Mail and existing permissions were retained; enable the missing features to try again."
          : missingGrantMessage(provider, purpose));
      }
    }
  } catch (error) {
    saved = failFrom(error);
  }
  if (signed.complete) {
    try { signed.complete({ ok: saved.success, message: saved.error?.message || "" }); } catch { /* the browser already left */ }
  }
  return saved;
}

async function withPurpose(params, purpose) {
  const account = accountFrom(params);
  if (!account) return { error: fail("no_account", "Connect the mailbox first.") };
  const gate = gateAccount(account, purpose);
  if (!gate.ok) return { error: fail(gate.reason, gate.message) };
  try {
    const token = await tokenFor(account, purpose);
    return { account, provider: gate.provider, token };
  } catch (error) {
    return { error: failFrom(error) };
  }
}

async function listProviderFolders(params) {
  const account = accountFrom(params);
  if (!account) return ok({ api: false, reason: "no_account", folders: [], accountId: null, provider: "", source: "imap" });
  const gate = gateAccount(account, "organize");
  if (!gate.ok) {
    return ok({
      api: false,
      reason: gate.reason,
      message: gate.message,
      folders: [],
      provider: gate.provider,
      accountId: account.id,
      grantedScopes: gate.scopes || "",
      source: "imap",
    });
  }
  try {
    const token = await tokenFor(account, "organize");
    const folders = gate.provider === "google"
      ? await gmail.listLabels(token.accessToken)
      : await gmail.listMailFolders(token.accessToken);
    return ok({
      api: true,
      reason: "",
      folders,
      provider: gate.provider,
      accountId: account.id,
      grantedScopes: token.grantedScopes || gate.scopes,
      source: gate.provider === "google" ? "gmail" : "graph",
    });
  } catch (error) {
    return failFrom(error);
  }
}

async function createProviderFolder(params) {
  const ready = await withPurpose(params, "organize");
  if (ready.error) return ready.error;
  try {
    const created = ready.provider === "google"
      ? await gmail.createLabel(ready.token.accessToken, params && params.name)
      : await gmail.createMailFolder(ready.token.accessToken, params && params.name, params && params.parentId);
    return ok(created);
  } catch (error) {
    return failFrom(error);
  }
}

async function renameProviderFolder(params) {
  const ready = await withPurpose(params, "organize");
  if (ready.error) return ready.error;
  try {
    const renamed = ready.provider === "google"
      ? await gmail.renameLabel(ready.token.accessToken, params && params.folderId, params && params.name)
      : await gmail.renameMailFolder(ready.token.accessToken, params && params.folderId, params && params.name);
    return ok(renamed);
  } catch (error) {
    return failFrom(error);
  }
}

async function moveProviderFolder(params) {
  const ready = await withPurpose(params, "organize");
  if (ready.error) return ready.error;
  try {
    const moved = ready.provider === "google"
      ? await gmail.moveLabel(ready.token.accessToken, params && params.folderId, params && params.destinationId)
      : await gmail.moveMailFolder(ready.token.accessToken, params && params.folderId, params && params.destinationId);
    return ok(moved);
  } catch (error) {
    return failFrom(error);
  }
}

async function deleteProviderFolder(params) {
  const ready = await withPurpose(params, "organize");
  if (ready.error) return ready.error;
  try {
    const removed = ready.provider === "google"
      ? await gmail.deleteLabel(ready.token.accessToken, params && params.folderId)
      : await gmail.deleteMailFolder(ready.token.accessToken, params && params.folderId);
    return ok(removed);
  } catch (error) {
    return failFrom(error);
  }
}

function messageRfc(params) {
  const row = db.messageById(params && params.emailId);
  if (!row) return { error: fail("not-found", "That message is no longer in the mailbox.") };
  if (params && params.accountId && row.account_id !== params.accountId) {
    return { error: fail("not-found", "That message is no longer in the mailbox.") };
  }
  return { row, rfc: row.rfc_message_id || "" };
}

async function modifyMessageLabels(params) {
  const opened = messageRfc(params);
  if (opened.error) return opened.error;
  const ready = await withPurpose({ accountId: opened.row.account_id }, "organize");
  if (ready.error) return ready.error;
  if (ready.provider !== "google") return fail("invalid", "Outlook moves the message instead of editing Gmail labels.");
  if (!opened.rfc) return fail("invalid", "This message has no RFC Message-ID, so Gmail labels cannot be changed.");
  try {
    const result = await gmail.modifyLabels(
      ready.token.accessToken,
      opened.rfc,
      params && params.addLabelIds,
      params && params.removeLabelIds
    );
    return ok(result);
  } catch (error) {
    return failFrom(error);
  }
}

async function moveProviderMessage(params) {
  const opened = messageRfc(params);
  if (opened.error) return opened.error;
  const ready = await withPurpose({ accountId: opened.row.account_id }, "organize");
  if (ready.error) return ready.error;
  if (ready.provider !== "microsoft") return fail("invalid", "Gmail changes labels instead of moving an Outlook folder.");
  if (!opened.rfc) return fail("invalid", "This message has no RFC Message-ID, so Outlook cannot move it.");
  try {
    const result = await gmail.moveMessage(
      ready.token.accessToken,
      opened.rfc,
      params && params.destinationId
    );
    return ok(result);
  } catch (error) {
    return failFrom(error);
  }
}

async function listCalendar(params) {
  const account = accountFrom(params);
  if (!account) {
    return ok({ api: false, reason: "needs_auth", calendars: [], events: [], accountId: null, provider: "", truncated: false });
  }
  const gate = gateAccount(account, "calendar");
  if (!gate.ok) {
    return ok({
      api: false,
      reason: gate.reason,
      message: gate.message,
      calendars: [],
      events: [],
      accountId: account.id,
      provider: gate.provider,
      grantedScopes: gate.scopes || "",
      truncated: false,
    });
  }
  const range = monthWindow(params && params.timeMin, params && params.timeMax);
  if (!range) return fail("invalid", "Choose a month range.");
  try {
    const token = await tokenFor(account, "calendar");
    const calendars = await calendar.listCalendars(gate.provider, token.accessToken);
    const requested = params && params.calendarId ? String(params.calendarId) : "";
    const calendarId = calendars.some((item) => item.id === requested)
      ? requested
      : calendar.preferredCalendarId(calendars);
    if (!calendarId) {
      return ok({
        api: true,
        reason: "",
        calendars,
        events: [],
        calendarId: "",
        accountId: account.id,
        provider: gate.provider,
        timeMin: range.timeMin,
        timeMax: range.timeMax,
        grantedScopes: token.grantedScopes || gate.scopes,
        truncated: false,
      });
    }
    const listed = await calendar.listEvents(gate.provider, token.accessToken, calendarId, range);
    return ok({
      api: true,
      reason: "",
      calendars,
      events: listed.events,
      truncated: listed.truncated === true,
      calendarId,
      accountId: account.id,
      provider: gate.provider,
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      grantedScopes: token.grantedScopes || gate.scopes,
    });
  } catch (error) {
    return failFrom(error);
  }
}

const VACATION_LINKS = {
  google: "https://mail.google.com/mail/u/0/#settings/general",
  microsoft: "https://outlook.office.com/mail/options/mail/automaticReplies",
  "imap.gmail.com": "https://mail.google.com/mail/u/0/#settings/general",
  "imap.googlemail.com": "https://mail.google.com/mail/u/0/#settings/general",
  "outlook.office365.com": "https://outlook.office.com/mail/options/mail/automaticReplies",
  "imap-mail.outlook.com": "https://outlook.office.com/mail/options/mail/automaticReplies",
  "imap.mail.yahoo.com": "https://mail.yahoo.com/",
  "imap.mail.me.com": "https://www.icloud.com/mail",
};
const EMPTY_VACATION = {
  mode: "disabled",
  start: "",
  end: "",
  subject: "",
  message: "",
  externalMessage: "",
  audience: "all",
  restrictToDomain: false,
};
const vacationBusy = new Set();

function vacationLink(account) {
  const provider = providerOf(account);
  if (provider === "google" || provider === "microsoft") return VACATION_LINKS[provider];
  return VACATION_LINKS[String(account.imap_host || "").toLowerCase()] || "";
}

function vacationView(account, extra) {
  const provider = providerOf(account);
  const named = provider === "google" || provider === "microsoft" ? provider : "imap";
  return {
    accountId: account.id,
    email: account.email,
    provider: named,
    supported: false,
    canRead: false,
    canWrite: false,
    requiresReconnect: false,
    requiredScope: (config.MARKERS.vacation && config.MARKERS.vacation[provider]) || "",
    providerUrl: vacationLink(account),
    transport: "",
    extensions: [],
    detail: "",
    scheduleWarning: "",
    revision: "",
    settings: null,
    ...extra,
  };
}

function vacationIdentity(account) {
  const provider = providerOf(account);
  if (provider === "google" || provider === "microsoft") {
    const blob = readJson(secretKey(account, "vacation"));
    return blob ? `${blob.refreshToken || ""}\n${blob.grantedScopes || ""}` : "";
  }
  const password = imapPassword(account);
  return password ? crypto.createHash("sha256").update(password).digest("hex") : "";
}

function imapPassword(account) {
  if (!account || account.auth_kind === "oauth2") return "";
  const raw = secrets.getPassword(account.id);
  if (!raw || raw[0] === "{") return "";
  return raw;
}

function plainField(value, limit, name) {
  if (typeof value !== "string" || [...value].length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    const error = new Error(`Enter a plain-text ${name} of at most ${limit} characters.`);
    error.code = "invalid";
    throw error;
  }
  return value.replace(/\r\n?/g, "\n");
}

function sieveChange(body, extensions) {
  if (!body || typeof body !== "object" || body.confirmed !== true || !["save", "disable"].includes(body.action)) {
    const error = new Error("Review and confirm Save or Disable before changing provider settings.");
    error.code = "invalid";
    throw error;
  }
  if (body.action === "disable" || body.mode === "disabled") return { action: "disable" };
  if (!["always", "scheduled"].includes(body.mode)) {
    const error = new Error("Choose Disabled, Always, or Scheduled.");
    error.code = "invalid";
    throw error;
  }
  const subject = plainField(body.subject || "", 200, "subject");
  const message = plainField(body.message || "", 10000, "reply");
  if (subject.includes("\n")) {
    const error = new Error("The subject must fit on one line.");
    error.code = "invalid";
    throw error;
  }
  if (body.audience !== "all" || body.restrictToDomain !== false) {
    const error = new Error("IMAP vacation replies go to every sender. Contacts-only and domain limits are not available.");
    error.code = "invalid";
    throw error;
  }
  let start = "";
  let end = "";
  if (body.mode === "scheduled") {
    if (!extensions.includes("date") || !extensions.includes("relational")) {
      const error = new Error("This IMAP server cannot schedule vacation replies. Choose Always, or use your provider’s webmail settings.");
      error.code = "unsupported";
      throw error;
    }
    try {
      const schedule = vacationApi.scheduleOf(body, false);
      start = schedule.start;
      end = schedule.end;
    } catch (error) {
      error.code = "invalid";
      throw error;
    }
  }
  if (!message.trim()) {
    const error = new Error("Enter a reply message for each enabled audience.");
    error.code = "invalid";
    throw error;
  }
  return {
    action: "put",
    script: sieve.buildVacation({ subject, message, start, end, useDate: body.mode === "scheduled" }),
  };
}

function projectSieve(account, remote) {
  const parsed = remote.script ? sieve.parseVacation(remote.script) : { ...EMPTY_VACATION };
  const blocked = !!(remote.active && remote.active !== sieve.SCRIPT_NAME);
  return vacationView(account, {
    supported: true,
    canRead: true,
    canWrite: !blocked,
    transport: "sieve",
    extensions: remote.extensions || [],
    revision: vacationApi.revisionOf(remote.script || ""),
    detail: blocked
      ? "This IMAP server already has an active Sieve script. Morrow will not replace it."
      : "Best-effort ManageSieve vacation. Replies continue while Morrow is closed. IMAP dates use whole UTC days, and every sender can receive a reply.",
    scheduleWarning: remote.script && !parsed
      ? "The server has a vacation script Morrow cannot edit safely. Disable remains available."
      : "",
    settings: parsed
      ? { ...EMPTY_VACATION, ...parsed, mode: remote.active === sieve.SCRIPT_NAME ? parsed.mode : "disabled", externalMessage: "", audience: "all", restrictToDomain: false }
      : { ...EMPTY_VACATION },
  });
}

async function sieveCall(account, operation) {
  const password = imapPassword(account);
  if (!password) {
    const error = new Error("This mailbox has no password Morrow can use for a vacation script. Morrow will not send local automatic replies.");
    error.safe = true;
    throw error;
  }
  return sieve.manageSieve({
    email: account.username || account.email,
    password,
    imapHost: account.imap_host,
  }, operation);
}

function sieveFailure(error) {
  if (error && error.safe) {
    const code = error.status === 409 ? "conflict" : error.status === 403 ? "scope_missing" : "provider";
    return fail(code, error.message);
  }
  if (error && error.code === "invalid") return fail("invalid", error.message);
  if (error && error.code === "unsupported") return fail("unsupported", error.message);
  if (error && error.code === "conflict") return fail("conflict", error.message);
  return fail("provider", vacationApi.WRITE_FAILED);
}

async function withVacation(account, work) {
  if (vacationBusy.has(account.id)) {
    return fail("conflict", "Automatic reply settings are already being saved. Wait for that to finish.");
  }
  vacationBusy.add(account.id);
  try {
    return await work();
  } finally {
    vacationBusy.delete(account.id);
  }
}

async function providerVacation(account, body) {
  const gate = gateAccount(account, "vacation");
  if (!gate.ok) {
    if (body) return fail(gate.reason, gate.message);
    return ok(vacationView(account, {
      supported: true,
      requiresReconnect: gate.reason === "scope_missing",
      detail: gate.message,
    }));
  }
  let before = vacationIdentity(account);
  let token;
  try {
    token = await tokenFor(account, "vacation");
    // A normal refresh can rotate the token. Keep detecting new consents,
    // without treating the refresh performed by this request as a reconnect.
    if (token.vacationIdentity) before = token.vacationIdentity;
  } catch (error) {
    return failFrom(error);
  }
  if (vacationIdentity(account) !== before) {
    return fail("conflict", "This mailbox connection changed. Refresh settings.");
  }
  try {
    const described = body
      ? await vacationApi.apply(gate.provider, token.accessToken, body)
      : await vacationApi.read(gate.provider, token.accessToken);
    if (vacationIdentity(account) !== before) {
      return fail("conflict", "This mailbox connection changed. Refresh provider settings to check the result.");
    }
    return ok(vacationView(account, {
      supported: true,
      canRead: true,
      canWrite: true,
      transport: gate.provider === "google" ? "gmail" : "graph",
      ...described,
    }));
  } catch (error) {
    return failFrom(error);
  }
}

async function imapVacation(account, body) {
  const before = vacationIdentity(account);
  let current;
  try {
    current = await sieveCall(account, { action: "read" });
  } catch (error) {
    if (body) return sieveFailure(error);
    const detail = error && error.safe
      ? error.message
      : "This IMAP server does not offer server-managed vacation replies. Morrow will not send local automatic replies.";
    return ok(vacationView(account, { supported: false, detail }));
  }
  if (vacationIdentity(account) !== before) return fail("conflict", "This mailbox connection changed. Refresh settings.");
  const viewed = projectSieve(account, current);
  if (!body) return ok(viewed);
  if (typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)) {
    return fail("conflict", "Refresh provider settings before saving.");
  }
  if (vacationApi.revisionOf(current.script || "") !== body.revision) {
    return fail("conflict", "Provider settings changed since you opened this page. Refresh and review them before saving.");
  }
  let change;
  try {
    change = sieveChange(body, current.extensions || []);
  } catch (error) {
    return sieveFailure(error);
  }
  if (change.action !== "disable" && viewed.canWrite !== true) {
    return fail("conflict", viewed.detail || "This IMAP server already has an active Sieve script. Morrow will not replace it.");
  }
  let again;
  try {
    again = await sieveCall(account, { action: "read" });
  } catch (error) {
    return sieveFailure(error);
  }
  if (vacationApi.revisionOf(again.script || "") !== body.revision || vacationIdentity(account) !== before) {
    return fail("conflict", "Provider settings changed while you were saving. Refresh and review them before trying again.");
  }
  let updated;
  try {
    updated = await sieveCall(account, change.action === "disable" ? { action: "disable" } : { action: "put", script: change.script });
  } catch (error) {
    return sieveFailure(error);
  }
  if (vacationIdentity(account) !== before) {
    return fail("conflict", "This mailbox connection changed. Refresh provider settings to check the result.");
  }
  return ok(projectSieve(account, updated));
}

async function vacationGet(params) {
  const account = accountFrom(params);
  if (!account) return fail("no_account", "Choose a connected mailbox.");
  return withVacation(account, () => {
    const provider = providerOf(account);
    if (provider === "google" || provider === "microsoft") return providerVacation(account);
    return imapVacation(account);
  });
}

async function vacationPut(params) {
  const account = accountFrom(params);
  if (!account) return fail("no_account", "Choose a connected mailbox.");
  return withVacation(account, () => {
    const provider = providerOf(account);
    if (provider === "google" || provider === "microsoft") return providerVacation(account, params || {});
    return imapVacation(account, params || {});
  });
}

function rememberVacation(account, signed) {
  if (!account || !signed) return fail("no_account", "Choose a connected mailbox.");
  const provider = providerOf(account);
  if (provider !== "google" && provider !== "microsoft") {
    return fail("imap_only", "IMAP automatic replies use the server vacation script. There is no extra consent for this mailbox.");
  }
  if (!sameEmail(signed.email, account.email)) {
    return fail("account_mismatch", `That browser signed in ${signed.email}. This mailbox is ${account.email}.`);
  }
  const current = accountFrom({ accountId: account.id });
  if (!current || !sameEmail(current.email, account.email)) {
    return fail("account_mismatch", "The mailbox changed. Authorize automatic replies again for the original account.");
  }
  const previous = readJson(`${account.id}:vacation`);
  const granted = signed.grantedScopes || "";
  if (!config.hasMarker(granted, provider, "vacation")) {
    return fail("partial", "Automatic reply permissions were not fully granted. The existing mail connection was retained.");
  }
  if (!signed.refreshToken && !(previous && previous.refreshToken)) {
    return fail("oauth", "Provider did not return a refresh token. Approve offline access and try again.");
  }
  const blob = {
    provider,
    purpose: "vacation",
    refreshToken: signed.refreshToken || previous.refreshToken,
    accessToken: signed.accessToken || "",
    expiresAt: signed.expiresAt || 0,
    grantedScopes: granted,
    requestedScopes: signed.requestedScopes || config.VACATION_SCOPES[provider],
  };
  const mailboxSecret = secrets.getPassword(account.id);
  try {
    secrets.setPassword(`${account.id}:vacation`, JSON.stringify(blob));
  } catch (error) {
    return fail("keychain", error instanceof Error ? error.message : "Could not save OAuth tokens.");
  }
  if (secrets.getPassword(account.id) !== mailboxSecret) {
    secrets.setPassword(account.id, mailboxSecret);
    secrets.deletePassword(`${account.id}:vacation`);
    return fail("partial", "Automatic reply permissions were not fully granted. The existing mail connection was retained.");
  }
  return ok({
    accountId: account.id,
    email: account.email,
    provider,
    purpose: "vacation",
    api: true,
    reason: "",
    grantedScopes: granted,
  });
}

async function createCalendarEvent(params) {
  const ready = await withPurpose(params, "calendar");
  if (ready.error) return ready.error;
  try {
    const event = await calendar.createEvent(
      ready.provider,
      ready.token.accessToken,
      params && params.calendarId,
      params
    );
    return ok(event);
  } catch (error) {
    return failFrom(error);
  }
}

function rulesMessage(backend) {
  if (backend === "gmail") {
    return "Gmail stores these filters and applies them to mail that arrives after you save. Morrow Mail does not forward mail.";
  }
  if (backend === "microsoft") {
    return "Outlook stores these rules on the mailbox and applies them to mail that arrives after you save. Morrow Mail does not forward mail.";
  }
  return "These rules run in Morrow Mail when new Inbox mail is downloaded. They are not stored on the mail server. Mail already stored stays where it is.";
}

function destinationRows(rows) {
  return (rows || []).filter((row) => row && row.id && row.name).map((row) => ({
    id: row.id,
    name: row.name,
    wellKnown: row.wellKnown || "",
  }));
}

function imapDestinations(accountId) {
  return db.foldersFor(accountId)
    .filter((folder) => folder && folder.path && folder.well_known !== "inbox")
    .map((folder) => ({
      id: folder.path,
      name: folder.name || folder.path,
      wellKnown: folder.well_known || "",
    }));
}

function archiveFolderId(folders) {
  const found = (folders || []).find((folder) => folder && folder.wellKnown === "archive" && folder.id);
  return found ? found.id : "";
}

async function listInboxRules(params) {
  const account = accountFrom(params);
  if (!account) {
    return ok({
      api: false,
      backend: "",
      reason: "no_account",
      message: "Connect an account to add inbox rules.",
      rules: [],
      destinations: [],
      accountId: null,
    });
  }
  const backend = inboxRules.backendFor(account);
  if (backend === "imap") {
    return ok({
      api: true,
      backend,
      reason: "",
      message: rulesMessage(backend),
      rules: db.listInboxRules(account.id),
      destinations: imapDestinations(account.id),
      accountId: account.id,
    });
  }
  const gate = gateAccount(account, "rules");
  if (!gate.ok) {
    return ok({
      api: false,
      backend,
      reason: gate.reason,
      message: gate.message,
      rules: [],
      destinations: [],
      accountId: account.id,
      grantedScopes: gate.scopes || "",
    });
  }
  try {
    const token = await tokenFor(account, "rules");
    if (backend === "gmail") {
      const labels = await gmail.listLabels(token.accessToken);
      const rules = await inboxRules.listGmail(token.accessToken);
      return ok({
        api: true,
        backend,
        reason: "",
        message: rulesMessage(backend),
        rules,
        destinations: destinationRows(labels.filter((label) => label.editable)),
        accountId: account.id,
        grantedScopes: token.grantedScopes || gate.scopes,
      });
    }
    const folders = await gmail.listMailFolders(token.accessToken);
    const rules = await inboxRules.listGraph(token.accessToken, archiveFolderId(folders));
    return ok({
      api: true,
      backend,
      reason: "",
      message: rulesMessage(backend),
      rules,
      destinations: destinationRows(folders.filter((folder) => folder.wellKnown !== "inbox")),
      accountId: account.id,
      grantedScopes: token.grantedScopes || gate.scopes,
    });
  } catch (error) {
    return failFrom(error);
  }
}

async function saveInboxRule(params) {
  const account = accountFrom(params);
  if (!account) return fail("no_account", "Connect the mailbox first.");
  const backend = inboxRules.backendFor(account);
  let normalized;
  try {
    normalized = inboxRules.normalizeDraft(params && params.rule, backend);
  } catch (error) {
    return failFrom(error);
  }
  if (backend === "imap") {
    const existing = normalized.id ? db.inboxRuleById(account.id, normalized.id) : null;
    if (normalized.id && !existing) return fail("not-found", "That inbox rule is no longer on this computer.");
    if (!existing && db.countInboxRules(account.id) >= inboxRules.MAX_LOCAL) {
      return fail("too_many", "This mailbox already has 100 inbox rules.");
    }
    try {
      inboxRules.assertLocalDestination(normalized, db.foldersFor(account.id));
    } catch (error) {
      return failFrom(error);
    }
    return ok(db.saveInboxRule(account.id, { ...normalized, id: normalized.id || db.newInboxRuleId() }));
  }
  const ready = await withPurpose({ accountId: account.id }, "rules");
  if (ready.error) return ready.error;
  try {
    if (backend === "gmail") return ok(await inboxRules.saveGmail(ready.token.accessToken, normalized));
    const folders = await gmail.listMailFolders(ready.token.accessToken);
    return ok(await inboxRules.saveGraph(ready.token.accessToken, normalized, archiveFolderId(folders)));
  } catch (error) {
    return failFrom(error);
  }
}

async function deleteInboxRule(params) {
  const account = accountFrom(params);
  if (!account) return fail("no_account", "Connect the mailbox first.");
  const id = params && (params.ruleId || params.id);
  if (!id) return fail("invalid", "Choose a rule.");
  const backend = inboxRules.backendFor(account);
  if (backend === "imap") {
    if (!db.deleteInboxRule(account.id, id)) return fail("not-found", "That inbox rule is no longer on this computer.");
    return ok({ id, deleted: true });
  }
  const ready = await withPurpose({ accountId: account.id }, "rules");
  if (ready.error) return ready.error;
  try {
    if (backend === "gmail") await inboxRules.deleteGmail(ready.token.accessToken, id);
    else await inboxRules.deleteGraph(ready.token.accessToken, id);
    return ok({ id, deleted: true });
  } catch (error) {
    return failFrom(error);
  }
}

function answer(channel, args) {
  if (!handles(channel)) return undefined;
  const params = args && args.length ? args[0] : undefined;
  try {
    switch (channel) {
      case "mail:oauthStatus":
        return oauthStatus();
      case "calendar:status":
        return calendarStatus();
      case "mail:grantOrganize":
        return grantPurpose(params || {}, "organize");
      case "mail:grantVacation":
        return grantPurpose(params || {}, "vacation");
      case "mail:vacationGet":
        return vacationGet(params || {});
      case "mail:vacationPut":
        return vacationPut(params || {});
      case "mail:listProviderFolders":
        return listProviderFolders(params || {});
      case "mail:createProviderFolder":
        return createProviderFolder(params || {});
      case "mail:renameProviderFolder":
        return renameProviderFolder(params || {});
      case "mail:deleteProviderFolder":
        return deleteProviderFolder(params || {});
      case "mail:moveProviderFolder":
        return moveProviderFolder(params || {});
      case "mail:modifyMessageLabels":
        return modifyMessageLabels(params || {});
      case "mail:moveProviderMessage":
        return moveProviderMessage(params || {});
      case "mail:listInboxRules":
        return listInboxRules(params || {});
      case "mail:saveInboxRule":
        return saveInboxRule(params || {});
      case "mail:deleteInboxRule":
        return deleteInboxRule(params || {});
      case "calendar:connect":
        return grantPurpose(params || {}, "calendar");
      case "mail:grantRules":
        return grantPurpose(params || {}, "rules");
      case "calendar:list":
        return listCalendar(params || {});
      case "calendar:createEvent":
        return createCalendarEvent(params || {});
      default:
        return undefined;
    }
  } catch (error) {
    return failFrom(error);
  }
}

module.exports = {
  handles,
  answer,
  providerOf,
  gateAccount,
  monthWindow,
  organizeToken,
  gmailSendAsToken,
  rememberVacation,
  grantPurpose,
};
