const db = require("./db");
const secrets = require("./secrets");
const oauth = require("./oauth");
const config = require("./oauth-config");
const gmail = require("./provider-api");
const calendar = require("./calendar-api");

const CHANNELS = new Set([
  "mail:oauthStatus",
  "mail:grantOrganize",
  "mail:listProviderFolders",
  "mail:createProviderFolder",
  "mail:renameProviderFolder",
  "mail:deleteProviderFolder",
  "mail:moveProviderFolder",
  "mail:modifyMessageLabels",
  "mail:moveProviderMessage",
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
  if (code === "oauth_not_ready" || code === "scope_missing" || code === "needs_auth" || code === "invalid" || code === "not-found" || code === "too_many" || code === "account_mismatch" || code === "oauth" || code === "imap_only" || code === "no_account" || code === "collision" || code === "partial") {
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

function scopeText(account, purpose) {
  if (!account) return "";
  if (purpose === "calendar") {
    const blob = readJson(`${account.id}:calendar`);
    return (blob && blob.grantedScopes) || "";
  }
  const primary = readJson(account.id);
  if (purpose === "organize") {
    const provider = providerOf(account);
    const dedicated = readJson(`${account.id}:organize`);
    if (dedicated && config.hasMarker(dedicated.grantedScopes, provider, "organize")) return dedicated.grantedScopes;
    if (primary && config.hasMarker(primary.grantedScopes, provider, "organize")) return primary.grantedScopes;
    if (dedicated && dedicated.grantedScopes) return dedicated.grantedScopes;
  }
  return (primary && primary.grantedScopes) || "";
}

function secretKey(account, purpose) {
  const provider = providerOf(account);
  if (purpose === "calendar") return `${account.id}:calendar`;
  if (purpose === "organize") {
    const dedicated = readJson(`${account.id}:organize`);
    if (dedicated && config.hasMarker(dedicated.grantedScopes, provider, "organize")) {
      return `${account.id}:organize`;
    }
    const primary = readJson(account.id);
    if (primary && config.hasMarker(primary.grantedScopes, provider, "organize")) return account.id;
    return `${account.id}:organize`;
  }
  return account.id;
}

function gateMessage(reason, provider, purpose) {
  if (reason === "oauth_not_ready") return "Google Desktop OAuth is not configured.";
  if (reason === "imap_only") {
    return purpose === "calendar"
      ? "Calendar needs a Google or Microsoft account."
      : "Labels stay on IMAP for this account.";
  }
  if (reason === "needs_auth") return "Calendar needs a calendar grant.";
  if (purpose === "calendar") return "Calendar needs a calendar grant.";
  if (provider === "microsoft") return "Outlook folders need the Mail.ReadWrite grant. This mailbox stays on IMAP until then.";
  return "Gmail labels need the gmail.modify grant. This mailbox stays on IMAP until then.";
}

function gateAccount(account, purpose) {
  const provider = providerOf(account);
  const scopes = scopeText(account, purpose);
  if (provider !== "google" && provider !== "microsoft") {
    return { ok: false, reason: "imap_only", provider, scopes, message: gateMessage("imap_only", provider, purpose) };
  }
  if (!config.hasMarker(scopes, provider, purpose)) {
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

async function tokenFor(account, purpose) {
  const key = secretKey(account, purpose);
  const raw = secrets.getPassword(key);
  const parsed = readJson(key);
  if (!raw || !parsed || !parsed.refreshToken) {
    const error = new Error(purpose === "calendar" ? "Calendar needs a calendar grant." : "That mail API grant is not saved.");
    error.code = purpose === "calendar" ? "needs_auth" : "scope_missing";
    throw error;
  }
  const result = await oauth.accessTokenFor(account, raw);
  if (typeof result === "string") return { accessToken: result, grantedScopes: parsed.grantedScopes || "" };
  if (result && result.token) {
    if (result.store) {
      try { secrets.setPassword(key, result.store); } catch { /* this call can still use the token */ }
    }
    let granted = parsed.grantedScopes || "";
    if (result.store) {
      try { granted = JSON.parse(result.store).grantedScopes || granted; } catch { /* keep the previous scopes */ }
    }
    return { accessToken: result.token, grantedScopes: granted };
  }
  const error = new Error("Could not refresh OAuth access token.");
  error.code = "oauth";
  throw error;
}

function accountGrants() {
  return db.listAccountRows().map((row) => {
    const organize = gateAccount(row, "organize");
    const calendarGate = gateAccount(row, "calendar");
    return {
      id: row.id,
      email: row.email,
      provider: providerOf(row),
      authKind: row.auth_kind || "password",
      organize: organize.ok,
      calendar: calendarGate.ok,
      organizeReason: organize.reason,
      calendarReason: calendarGate.reason,
      grantedScopes: {
        imap: scopeText(row, "imap"),
        organize: scopeText(row, "organize"),
        calendar: scopeText(row, "calendar"),
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
      imap: { google: config.SCOPES.google, microsoft: config.SCOPES.microsoft },
      organize: { google: config.ORGANIZE_SCOPES.google, microsoft: config.ORGANIZE_SCOPES.microsoft },
      calendar: { google: config.CALENDAR_SCOPES.google, microsoft: config.CALENDAR_SCOPES.microsoft },
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

async function saveGrant(account, signed, purpose) {
  if (!signed.refreshToken) {
    const existing = readJson(account.id);
    if (purpose === "organize" && existing && existing.refreshToken) signed.refreshToken = existing.refreshToken;
  }
  if (!signed.refreshToken) {
    return fail("oauth", "Provider did not return a refresh token. Approve offline access and try again.");
  }
  const blob = tokenBlob(signed);
  try {
    secrets.setPassword(`${account.id}:${purpose}`, JSON.stringify(blob));
    if (purpose === "organize" && config.hasMarker(blob.grantedScopes, signed.provider, "imap")) {
      secrets.setPassword(account.id, JSON.stringify({ ...blob, purpose: "imap" }));
    }
  } catch (error) {
    return fail("keychain", error instanceof Error ? error.message : "Could not save OAuth tokens.");
  }
  const api = config.hasMarker(blob.grantedScopes, signed.provider, purpose);
  return ok({
    accountId: account.id,
    email: account.email,
    provider: signed.provider,
    purpose,
    api,
    reason: api ? "" : (purpose === "calendar" ? "needs_auth" : "scope_missing"),
    grantedScopes: blob.grantedScopes,
  });
}

async function grantPurpose(params, purpose) {
  const account = accountFrom(params);
  if (!account) return fail("no_account", "Connect the mailbox first.");
  const provider = providerOf(account);
  if (provider !== "google" && provider !== "microsoft") {
    return fail("imap_only", purpose === "calendar"
      ? "Calendar needs a Google or Microsoft account."
      : "Labels need a Google or Microsoft account.");
  }
  if (provider === "google" && !oauth.oauthReady().google) {
    return fail("oauth_not_ready", "Google Desktop OAuth is not configured.");
  }
  let signed;
  try {
    signed = await oauth.signIn(provider, purpose);
  } catch (error) {
    return failFrom(error);
  }
  let saved;
  try {
    if (!sameEmail(signed.email, account.email)) {
      saved = fail("account_mismatch", `That browser signed in ${signed.email}. This mailbox is ${account.email}.`);
    } else {
      saved = await saveGrant(account, signed, purpose);
    }
  } catch (error) {
    saved = failFrom(error);
  }
  if (signed.complete) {
    const okGrant = saved && saved.success === true;
    const message = okGrant ? "" : (saved && saved.error && saved.error.message) || "Sign-in not finished.";
    try { signed.complete({ ok: okGrant, message }); } catch { /* the browser already left */ }
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
      case "calendar:connect":
        return grantPurpose(params || {}, "calendar");
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
};
