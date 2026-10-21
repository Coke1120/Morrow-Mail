const crypto = require("node:crypto");
const http = require("./provider-http");

const ROOTS = {
  google: "https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation",
  microsoft: "https://graph.microsoft.com/v1.0/me/mailboxSettings",
};

const WRITE_FAILED = "The provider change could not be confirmed. Refresh provider settings before retrying. Morrow will not retry automatically.";

function fail(message, code = "invalid") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function revisionOf(raw) {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return crypto.createHash("sha256").update(text).digest("hex");
}

function plainText(value, limit, name) {
  if (typeof value !== "string" || [...value].length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail(`Enter a plain-text ${name} of at most ${limit} characters.`);
  }
  return value.replace(/\r\n?/g, "\n");
}

function utcDate(value) {
  if (value === "") return "";
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    fail("Use a valid date and time with a UTC timezone.");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) fail("Use a valid date and time.");
  return parsed.toISOString();
}

function htmlEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\n/g, "<br>");
}

function plainFromHtml(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .trim();
}

function bounded(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Buffer.byteLength(JSON.stringify(raw)) > 128 * 1024) {
    fail("The provider returned invalid or oversized automatic reply settings.", "provider");
  }
  return raw;
}

function googleDate(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 4102444800000 ? new Date(n).toISOString() : "";
}

function microsoftDate(value) {
  if (!value || !value.dateTime || !["UTC", "Etc/UTC", "Etc/GMT"].includes(value.timeZone)) return "";
  const input = `${String(value.dateTime).replace(/Z$/, "").replace(/(\.\d{3})\d+$/, "$1")}Z`;
  try {
    return utcDate(input);
  } catch {
    return "";
  }
}

function describe(provider, raw) {
  const current = bounded(raw);
  const google = provider === "google";
  const strings = google
    ? ["responseSubject", "responseBodyPlainText", "responseBodyHtml"]
    : ["status", "internalReplyMessage", "externalReplyMessage", "externalAudience"];
  if (strings.some((key) => current[key] !== undefined && typeof current[key] !== "string")) {
    fail("The provider returned incomplete automatic reply settings.", "provider");
  }
  if (google ? typeof current.enableAutoReply !== "boolean" : !["disabled", "alwaysenabled", "scheduled"].includes(String(current.status || "").toLowerCase())) {
    fail("The provider returned incomplete automatic reply settings.", "provider");
  }
  const start = google ? googleDate(current.startTime) : microsoftDate(current.scheduledStartDateTime);
  const end = google ? googleDate(current.endTime) : microsoftDate(current.scheduledEndDateTime);
  const mode = google
    ? (current.enableAutoReply ? ((current.startTime && current.startTime !== "0") || (current.endTime && current.endTime !== "0") ? "scheduled" : "always") : "disabled")
    : { disabled: "disabled", alwaysenabled: "always", scheduled: "scheduled" }[String(current.status).toLowerCase()];
  const scheduleWarning = mode === "scheduled" && (google ? !start && !end : !start || !end)
    ? "The provider has a schedule that cannot be edited safely here. Re-enter its dates before saving, or manage it in provider settings. Disable remains available."
    : "";
  return {
    revision: revisionOf(current),
    scheduleWarning,
    settings: {
      mode,
      start,
      end,
      subject: google ? current.responseSubject || "" : "",
      message: google
        ? (current.responseBodyHtml ? plainFromHtml(current.responseBodyHtml) : current.responseBodyPlainText || "")
        : plainFromHtml(current.internalReplyMessage),
      externalMessage: google ? "" : plainFromHtml(current.externalReplyMessage),
      audience: google
        ? (current.restrictToContacts ? "contacts" : "all")
        : ({ none: "none", contactsonly: "contacts", all: "all" }[String(current.externalAudience || "").toLowerCase()] || "none"),
      restrictToDomain: google && current.restrictToDomain === true,
    },
  };
}

function scheduleOf(body, requireBoth, now = Date.now()) {
  const start = utcDate(body && body.start ? body.start : "");
  const end = utcDate(body && body.end ? body.end : "");
  if (requireBoth ? !start || !end : !start && !end) {
    fail(requireBoth
      ? "Enter the automatic reply schedule. Outlook requires both start and end."
      : "Enter the automatic reply schedule.");
  }
  if (start && end && start >= end) fail("The end must be after the start.");
  if (end && Date.parse(end) <= now) fail("Choose an end time in the future.");
  return { start, end };
}

function buildPayload(provider, body, now = Date.now()) {
  if (!body || typeof body !== "object" || body.confirmed !== true || !["save", "disable"].includes(body.action)) {
    fail("Review and confirm Save or Disable before changing provider settings.");
  }
  if (body.action === "disable") {
    return provider === "google"
      ? { enableAutoReply: false }
      : { automaticRepliesSetting: { status: "disabled" } };
  }
  if (!["disabled", "always", "scheduled"].includes(body.mode)) fail("Choose Disabled, Always, or Scheduled.");
  const subject = plainText(body.subject || "", 200, "subject");
  const message = plainText(body.message || "", 10000, "reply");
  const externalMessage = plainText(body.externalMessage || "", 10000, "external reply");
  if (subject.includes("\n")) fail("The subject must fit on one line.");
  const audiences = ["all", "contacts"];
  if (provider === "microsoft") audiences.push("none");
  if (!audiences.includes(body.audience) || typeof body.restrictToDomain !== "boolean") fail("Choose a valid reply audience.");
  let start = "";
  let end = "";
  if (body.mode === "scheduled") {
    const schedule = scheduleOf(body, provider === "microsoft", now);
    start = schedule.start;
    end = schedule.end;
  }
  if (body.mode !== "disabled" && (!message.trim() || (provider === "microsoft" && body.audience !== "none" && !externalMessage.trim()))) {
    fail("Enter a reply message for each enabled audience.");
  }
  if (provider === "google") {
    return {
      enableAutoReply: body.mode !== "disabled",
      responseSubject: subject,
      responseBodyPlainText: message,
      restrictToContacts: body.audience === "contacts",
      restrictToDomain: body.restrictToDomain,
      ...(start ? { startTime: String(Date.parse(start)) } : {}),
      ...(end ? { endTime: String(Date.parse(end)) } : {}),
    };
  }
  return {
    automaticRepliesSetting: {
      status: { disabled: "disabled", always: "alwaysEnabled", scheduled: "scheduled" }[body.mode],
      internalReplyMessage: htmlEscape(message),
      externalReplyMessage: htmlEscape(externalMessage),
      externalAudience: { none: "none", contacts: "contactsOnly", all: "all" }[body.audience],
      ...(start ? {
        scheduledStartDateTime: { dateTime: start.slice(0, 19), timeZone: "UTC" },
        scheduledEndDateTime: { dateTime: end.slice(0, 19), timeZone: "UTC" },
      } : {}),
    },
  };
}

async function readRaw(provider, accessToken, fetchImpl) {
  const url = provider === "google" ? ROOTS.google : `${ROOTS.microsoft}/automaticRepliesSetting`;
  const json = await http.apiJson(url, accessToken, { fetchImpl, redirect: "error", maxBytes: 128 * 1024 });
  return bounded(json);
}

async function writeRaw(provider, accessToken, payload, fetchImpl) {
  if (provider === "google") {
    return bounded(await http.apiJson(ROOTS.google, accessToken, {
      method: "PUT",
      body: payload,
      fetchImpl,
      redirect: "error",
      maxBytes: 128 * 1024,
    }));
  }
  const json = await http.apiJson(ROOTS.microsoft, accessToken, {
    method: "PATCH",
    body: payload,
    fetchImpl,
    redirect: "error",
    maxBytes: 128 * 1024,
  });
  return bounded(json && json.automaticRepliesSetting ? json.automaticRepliesSetting : json);
}

async function read(provider, accessToken, fetchImpl) {
  return describe(provider, await readRaw(provider, accessToken, fetchImpl));
}

async function apply(provider, accessToken, body, fetchImpl) {
  if (typeof body.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision)) {
    fail("Refresh provider settings before saving.", "conflict");
  }
  const payload = buildPayload(provider, body);
  const first = await readRaw(provider, accessToken, fetchImpl);
  if (revisionOf(first) !== body.revision) {
    fail("Provider settings changed since you opened this page. Refresh and review them before saving.", "conflict");
  }
  const latest = await readRaw(provider, accessToken, fetchImpl);
  if (revisionOf(latest) !== revisionOf(first)) {
    fail("Provider settings changed while you were saving. Refresh and review them before trying again.", "conflict");
  }
  if (body.action === "disable" && provider === "google") {
    for (const key of ["responseSubject", "responseBodyPlainText", "responseBodyHtml", "restrictToContacts", "restrictToDomain", "startTime", "endTime"]) {
      if (latest[key] !== undefined) payload[key] = latest[key];
    }
  }
  let updated;
  try {
    updated = await writeRaw(provider, accessToken, payload, fetchImpl);
  } catch (error) {
    if (error && (error.code === "scope_missing" || error.code === "conflict")) throw error;
    fail(WRITE_FAILED, "provider");
  }
  return describe(provider, updated);
}

const CONSUMER_MAIL = /^(hotmail|outlook|live|msn)\./;

// Provider settings page for the exact signed-in mailbox. Gmail resolves the
// authuser address inside the browser profile, so several Google accounts can
// share one Morrow install without landing on the wrong mailbox.
function vacationUrl(provider, email) {
  const address = String(email || "").trim();
  if (provider === "google") {
    return address.includes("@")
      ? "https://mail.google.com/mail/u/?authuser=" + encodeURIComponent(address) + "#settings/general"
      : "";
  }
  if (provider === "microsoft") {
    if (!address.includes("@")) return "";
    const domain = String(address.split("@")[1] || "").toLowerCase();
    return CONSUMER_MAIL.test(domain)
      ? "https://outlook.live.com/mail/0/options/mail/automaticReplies"
      : "https://outlook.office.com/mail/options/mail/automaticReplies";
  }
  return "";
}

module.exports = {
  ROOTS,
  WRITE_FAILED,
  vacationUrl,
  revisionOf,
  describe,
  buildPayload,
  scheduleOf,
  plainFromHtml,
  read,
  apply,
};
