function providerFailure(status) {
  if (status === 400) return "The provider rejected the request format (HTTP 400). Check for an app update.";
  if (status === 401) return "Authorization expired. Grant access again.";
  if (status === 403) return "The provider refused this scope. Grant access again.";
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
    return Math.min(source.retryAfterMs, 15 * 60 * 1000);
  }
  const header = source.headers ? headerValue(source.headers, "retry-after") : "";
  const raw = header || source.retryAfter || "";
  if (raw == null || String(raw).trim() === "") return null;
  const text = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.min(Number(text) * 1000, 15 * 60 * 1000);
  const when = Date.parse(text);
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 0), 15 * 60 * 1000);
  return null;
}

function isRateLimit(error) {
  if (!error) return false;
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
  let response;
  try {
    response = await fetcher(url, {
      method: options.method || "GET",
      redirect: options.redirect || "follow",
      headers: {
        accept: "application/json",
        ...(options.headers || {}),
        authorization: `Bearer ${accessToken}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    const error = new Error("The provider request could not be confirmed. Check your connection.");
    error.code = "provider_network";
    throw error;
  }
  const text = typeof response.text === "function" ? await response.text() : "";
  if (options.maxBytes && Buffer.byteLength(text) > options.maxBytes) {
    const error = new Error("The provider returned an oversized response.");
    error.code = "provider";
    throw error;
  }
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
  }
  if (!response.ok) {
    const error = new Error(providerFailure(response.status));
    error.code = response.status === 429 ? "rate_limit" : (response.status === 401 || response.status === 403 ? "scope_missing" : "provider");
    error.status = response.status;
    error.retryable = response.status === 429;
    const detail = json && json.error && typeof json.error === "object" ? json.error : null;
    if (detail && detail.code) error.providerCode = String(detail.code);
    if (detail && detail.message) error.providerDetail = String(detail.message);
    const wait = response.status === 429 ? retryAfterMs(response) : null;
    if (wait != null) error.retryAfterMs = wait;
    throw error;
  }
  return json;
}

module.exports = {
  apiJson,
  providerFailure,
  retryAfterMs,
  isRateLimit,
  safeId,
  cleanName,
  idList,
  safeNext,
};
