const RATE_LIMIT_PAUSE_MS = 30 * 1000;
const RATE_LIMIT_CAP_MS = 15 * 60 * 1000;
const { errorJson } = require("./provider-error-body");
const CALENDAR_QUOTA_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"]);

function providerFailure(status) {
  if (status === 400) return "The provider rejected the request format (HTTP 400). Check for an app update.";
  if (status === 401) return "Authorization expired. Grant access again.";
  if (status === 403) return "The provider refused this request. Review provider access or organization policy.";
  if (status === 429) return "The provider is rate limiting requests. Try again shortly.";
  return "The provider rejected the request.";
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || headers.get(name.toLowerCase()) || "";
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
}

function retryAfterMs(source) {
  if (!source) return null;
  if (Number.isFinite(source.retryAfterMs) && source.retryAfterMs >= 0) {
    return Math.min(source.retryAfterMs, RATE_LIMIT_CAP_MS);
  }
  const header = source.headers ? headerValue(source.headers, "retry-after") : "";
  const raw = header || source.retryAfter || "";
  if (raw == null || String(raw).trim() === "") return null;
  const text = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.min(Number(text) * 1000, RATE_LIMIT_CAP_MS);
  const when = Date.parse(text);
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 0), RATE_LIMIT_CAP_MS);
  return null;
}

// First two quota hits stay a short blip. Later hits grow and still honor a
// longer Retry-After, but they do not jump straight to the 15 minute cap.
function quotaPauseMs(strikes, hinted) {
  const count = Math.max(1, Math.floor(Number(strikes) || 1));
  const hint = hinted == null || !Number.isFinite(Number(hinted)) ? null : Math.min(Math.max(0, Number(hinted)), RATE_LIMIT_CAP_MS);
  if (count < 3) return hint == null ? RATE_LIMIT_PAUSE_MS : hint;
  const step = Math.min(RATE_LIMIT_CAP_MS, RATE_LIMIT_PAUSE_MS * 2 ** Math.min(count - 1, 8));
  if (hint == null) return step;
  return Math.min(RATE_LIMIT_CAP_MS, Math.max(step, hint));
}

function isRateLimit(error) {
  if (!error) return false;
  // Parsed Gmail category wins over reason text such as rateLimitExceeded.
  const diagnostic = error.gmailDiagnostic;
  if (diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic)) return diagnostic.category === "quota";
  if (error.status === 429 || error.code === "rate_limit") return true;
  const code = String(error.serverResponseCode || error.responseCode || "");
  if (/^(LIMIT|OVERQUOTA|TOOMANY)$/i.test(code)) return true;
  const text = `${error.message || ""} ${error.responseText || ""} ${error.response || ""}`;
  return /rate.?limit|too many requests|throttl|bandwidth|try again later|\b429\b|OVERQUOTA/i.test(text);
}

function safeId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) return "";
  return id;
}

function cleanName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) return "";
  return name;
}

function idList(value, limit = 20) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    const id = safeId(item);
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length > limit) return null;
  }
  return ids;
}

function safeNext(link, host) {
  if (!link || typeof link !== "string") return "";
  let url;
  try {
    url = new URL(link);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password) return "";
  return url.toString();
}

async function apiJson(url, accessToken, options = {}) {
  if (!url || typeof url !== "string") {
    const error = new Error("The provider request was refused.");
    error.code = "invalid";
    throw error;
  }
  const fetcher = options.fetchImpl || fetch;
  const method = options.method || "GET";
  const supplier = typeof accessToken === "function" ? accessToken : null;
  const check = response => {
    try { supplier?.check?.(); }
    catch (error) {
      // Retain submission evidence if a reconnect arrived while awaiting HTTP.
      error.operationIssued = method !== "GET" && !!response && (response.ok || response.status >= 500 || response.status === 408);
      if (response) error.status = response.status;
      throw error;
    }
  };
  const token = async extra => {
    try {
      const value = supplier ? await supplier({ method, ...extra }) : accessToken;
      // Legacy adapters (including Gmail's guarded HTTP transport) supply their
      // own header through fetchImpl. Validate credentials owned by this path.
      if (supplier && (typeof value !== "string" || !value)) throw Object.assign(new Error("Provider authorization is unavailable."), { code: "oauth" });
      check();
      return value;
    } catch (error) { error.operationIssued = false; throw error; }
  };
  let credential = await token();
  // One rejected GET, not its caller/compound operation, may be replayed.
  for (let attempt = 0; ; attempt++) {
    check();
    const timeout = AbortSignal.timeout(30000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response;
    try {
      response = await fetcher(url, {
        method,
        redirect: options.redirect || "follow",
        signal,
        headers: {
          accept: "application/json",
          ...(options.headers || {}),
          authorization: `Bearer ${credential}`,
          ...(options.body ? { "content-type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch {
      throw Object.assign(new Error("The provider request could not be confirmed. Check your connection."), {
        code: "provider_network", operationIssued: method !== "GET",
      });
    }
    check(response);
    if (response.ok) {
      let text;
      try { text = typeof response.text === "function" ? await response.text() : ""; }
      catch { throw Object.assign(new Error("The provider response could not be confirmed. Check your connection."), { code: "provider_network", operationIssued: method !== "GET" }); }
      check(response);
      if (options.maxBytes && Buffer.byteLength(text) > options.maxBytes) {
        throw Object.assign(new Error("The provider returned an oversized response."), { code: "provider", operationIssued: method !== "GET" });
      }
      try { return text ? JSON.parse(text) : {}; } catch { return {}; }
    }
    const json = await errorJson(response, signal);
    check(response);
    if (supplier && method === "GET" && response.status === 401 && attempt === 0) {
      credential = await token({ forceRefresh: true, rejectedToken: credential });
      continue;
    }
    const calendar = /^https:\/\/www\.googleapis\.com\/calendar\/v3\//.test(url);
    const reasons = new Set(calendar && Array.isArray(json?.error?.errors) ? json.error.errors.map(item => item?.reason) : []);
    const quota = response.status === 429 || response.status === 403 && calendar
      && reasons.size > 0 && [...reasons].every(reason => CALENDAR_QUOTA_REASONS.has(reason));
    const permission = response.status === 403 && reasons.size === 1 && reasons.has("insufficientPermissions");
    const error = Object.assign(new Error(quota ? providerFailure(429) : permission ? "Calendar permission is missing. Review Calendar access." : providerFailure(response.status)), {
      code: quota ? "rate_limit" : response.status === 401 || permission ? "scope_missing" : "provider",
      status: response.status, retryable: quota,
      operationIssued: method !== "GET" && (response.status >= 500 || response.status === 408),
    });
    if (quota) {
      error.retryAfterMs = retryAfterMs(response) ?? RATE_LIMIT_PAUSE_MS;
      if (method === "GET") supplier?.rateLimited?.(error.retryAfterMs);
    }
    // Keep the existing Graph-search fallback without retaining arbitrary
    // provider descriptions/codes on errors exposed to callers.
    if (response.status === 400 && url.startsWith("https://graph.microsoft.com/")
        && /unsupported|InefficientFilter|ErrorInvalidUrl|too complex|not support/i.test(`${json?.error?.code || ""} ${json?.error?.message || ""}`)) {
      error.providerCode = "Request_UnsupportedQuery";
    }
    throw error;
  }
}

module.exports = {
  apiJson,
  providerFailure,
  retryAfterMs,
  quotaPauseMs,
  RATE_LIMIT_PAUSE_MS,
  RATE_LIMIT_CAP_MS,
  isRateLimit,
  safeId,
  cleanName,
  idList,
  safeNext,
};
