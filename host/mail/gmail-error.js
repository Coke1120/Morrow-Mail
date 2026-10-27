// Only fixed diagnostics may escape this module. Never retain provider messages,
// metadata, URLs, request values or parser/stream exceptions on the thrown error.
const { retryAfterMs } = require("./provider-http");
const MAX_ERROR_BYTES = 16 * 1024;
const ERROR_READ_MS = 1500;
const OPERATIONS = new Set(["profile.get", "messages.list", "messages.get", "attachments.get", "messages.modify",
  "messages.trash", "messages.untrash", "messages.send", "history.list", "drafts.list", "drafts.get", "drafts.create",
  "drafts.update", "labels.get", "labels.list", "labels.create", "labels.update", "labels.delete"]);
const REASONS = new Map([
  ["rateLimitExceeded", "quota"], ["userRateLimitExceeded", "quota"], ["dailyLimitExceeded", "quota"], ["quotaExceeded", "quota"],
  ["RATE_LIMIT_EXCEEDED", "quota"], ["RESOURCE_QUOTA_EXCEEDED", "quota"],
  ["insufficientPermissions", "permission"], ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "permission"],
  ["accessNotConfigured", "api_disabled"], ["SERVICE_DISABLED", "api_disabled"], ["domainPolicy", "domain_policy"],
  ["authError", "auth"], ["ACCESS_TOKEN_EXPIRED", "auth"], ["CREDENTIALS_MISSING", "auth"],
  ["forbidden", "unknown"], ["badRequest", "unknown"], ["notFound", "unknown"], ["backendError", "unknown"],
]);
const STATUSES = new Set(["INVALID_ARGUMENT", "FAILED_PRECONDITION", "OUT_OF_RANGE", "UNAUTHENTICATED", "PERMISSION_DENIED",
  "NOT_FOUND", "ABORTED", "ALREADY_EXISTS", "RESOURCE_EXHAUSTED", "CANCELLED", "DATA_LOSS", "UNKNOWN", "INTERNAL",
  "UNIMPLEMENTED", "UNAVAILABLE", "DEADLINE_EXCEEDED"]);
const COPY = {
  quota: "quota or rate limit reached",
  permission: "mail permission is missing; review Gmail API access",
  api_disabled: "API is disabled; the app owner must review the Google project",
  domain_policy: "access is blocked by domain policy; contact the domain administrator",
  auth: "sign-in was rejected; review the account connection",
  unknown: "request was rejected; cause unknown",
};
const safeMessages = new WeakMap();

async function errorJson(response, signal) {
  let reader, timer, onAbort;
  try {
    // Fetch Responses stream. Do not use an unbounded text()/json() fallback.
    if (!response.body?.getReader) return null;
    reader = response.body.getReader();
    if (signal?.aborted || Number(response.headers?.get?.("content-length")) > MAX_ERROR_BYTES) return null;
    const stopped = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), ERROR_READ_MS);
      onAbort = () => resolve(null);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    const reading = (async () => {
      const chunks = [];
      let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || !value.byteLength || (length += value.byteLength) > MAX_ERROR_BYTES) return null;
        chunks.push(Buffer.from(value));
      }
      try { return JSON.parse(Buffer.concat(chunks, length).toString("utf8")); }
      catch { return null; }
    })();
    return await Promise.race([reading, stopped]);
  } catch { return null; }
  finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    // Cancellation must not stall reporting a known HTTP rejection.
    try { reader?.cancel().catch(() => {}); } catch { /* no provider exception escapes */ }
    try { reader?.releaseLock(); } catch { /* a cancelled read may still be settling */ }
  }
}

async function gmailError(response, operation, { method = "GET", signal } = {}) {
  const status = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? response.status : 0;
  const json = await errorJson(response, signal);
  const detail = json?.error && typeof json.error === "object" && !Array.isArray(json.error) ? json.error : {};
  const providerStatus = STATUSES.has(detail.status) ? detail.status : "unknown";
  const reasons = new Set();
  for (const item of Array.isArray(detail.errors) ? detail.errors : []) {
    if (REASONS.has(item?.reason)) reasons.add(item.reason);
  }
  for (const item of Array.isArray(detail.details) ? detail.details : []) {
    if (item?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo" && item.domain === "googleapis.com" && REASONS.has(item.reason)) reasons.add(item.reason);
  }
  const categories = new Set([...reasons].map(reason => REASONS.get(reason)).filter(value => value !== "unknown"));
  // Conflicting evidence and PERMISSION_DENIED alone cannot establish scope loss.
  let category = categories.size === 1 ? [...categories][0] : "unknown";
  if (status === 401) category = "auth";
  else if (status === 429) category = "quota";
  else if (status !== 403) category = "unknown";
  else if (!categories.size && providerStatus === "RESOURCE_EXHAUSTED") category = "quota";
  const reason = reasons.size === 1 ? [...reasons][0] : "unknown";
  const diagnostic = Object.freeze({ operation: OPERATIONS.has(operation) ? operation : "unknown", status, providerStatus, reason, category });
  const message = `Gmail ${COPY[category]} (HTTP ${status}; ${diagnostic.operation}; reason=${reason}; status=${providerStatus}).`;
  const error = Object.assign(new Error(message), {
    status, code: category === "quota" ? "rate_limit" : category === "permission" ? "scope_missing" : category === "auth" ? "auth"
      : category === "api_disabled" ? "gmail_api_disabled" : category === "domain_policy" ? "gmail_domain_policy" : "provider",
    operationIssued: method !== "GET" && (status >= 500 || status === 408),
    gmailDiagnostic: diagnostic,
  });
  const wait = retryAfterMs(response); if (wait != null) error.retryAfterMs = wait;
  safeMessages.set(error, message);
  return error;
}

// Use the original fixed message even if another error handler adds context.
function diagnosticMessage(error) { return safeMessages.get(error) || ""; }
module.exports = { gmailError, diagnosticMessage, MAX_ERROR_BYTES, ERROR_READ_MS };
