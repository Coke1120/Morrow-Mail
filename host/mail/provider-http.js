function providerFailure(status) {
  if (status === 401) return "Authorization expired. Grant access again.";
  if (status === 403) return "The provider refused this scope. Grant access again.";
  if (status === 429) return "The provider is rate limiting requests. Try again shortly.";
  return "The provider rejected the request.";
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
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
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
    error.code = response.status === 401 || response.status === 403 ? "scope_missing" : "provider";
    error.status = response.status;
    throw error;
  }
  return json;
}

module.exports = {
  apiJson,
  providerFailure,
  safeId,
  cleanName,
  idList,
  safeNext,
};
