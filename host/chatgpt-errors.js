const HELP = {
  subscription_sharing_usage_limit_exceeded: "ChatGPT usage limit reached. Open Manage usage in ChatGPT settings. New requests are paused until you explicitly retry there.",
  subscription_sharing_usage_unavailable: "ChatGPT usage availability is temporarily unavailable. Retry later.",
  subscription_sharing_user_unavailable: "ChatGPT account or workspace is temporarily unavailable. Retry later.",
  subscription_sharing_user_not_eligible: "This ChatGPT account or workspace is not eligible for plan usage. Check its plan and policy in ChatGPT settings.",
  subscription_sharing_unsupported_capability: "ChatGPT does not support this model or capability. Refresh the model list and choose an available model.",
  subscription_sharing_route_not_supported: "ChatGPT plan usage does not support this request route.",
  subscription_sharing_invalid_user: "ChatGPT could not validate this account. Check the connection and sign in again if it was revoked.",
  chatpass_v2_scope_not_authorized: "ChatGPT plan permission is missing. Enable plan usage by signing in again.",
  chatpass_v2_invalid_authorization_context: "ChatGPT plan authorization was not accepted. Check the connection and permissions.",
};
const safeCode = (value) => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : "";

function providerError(payload, status, requestId) {
  const source = payload && (payload.error || payload);
  const code = safeCode(typeof source === "string" ? source : source && source.code);
  const message = HELP[code] || ({
    401: "ChatGPT did not accept the credentials. Check the selected account and permissions; sign in again if revoked.",
    403: "ChatGPT policy or permission prevents this request. Check plan eligibility, workspace policy and region.",
    429: "ChatGPT is rate limited. Retry later or check Manage usage.",
    503: "ChatGPT routing is temporarily unavailable. Retry later.",
  })[status] || "ChatGPT could not complete the request. Retry or check the connection.";
  const error = new Error(`${message}${code ? ` (${code})` : ""}${status ? ` [HTTP ${status}]` : ""}${safeCode(requestId) ? ` Request ${requestId}.` : ""}`);
  error.code = code || "chatgpt_request_failed";
  error.status = status || null;
  error.requestId = safeCode(requestId);
  error.param = safeCode(source && source.param);
  // Preserve the response shape for diagnosis without retaining arbitrary
  // provider text, which may echo tokens or mail in upstream errors.
  error.bodyShape = payload && typeof payload === "object" ? Object.keys(payload).filter(safeCode).slice(0, 20) : typeof payload;
  return error;
}

module.exports = { providerError };
