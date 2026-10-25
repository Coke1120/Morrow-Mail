// Gmail API transport primitives. Engine/cache migration is deliberately not enabled yet.
const { retryAfterMs } = require("./provider-http");
const provider = require("./provider-api");
const ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAIL_SCOPES = "openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic";
const CALENDAR_SCOPES = "openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events";
const MAX_BYTES = 35 * 1024 * 1024;
const invalid = message => Object.assign(new Error(message), { code: "invalid", operationIssued: false });
function id(value) {
  if (typeof value !== "string" || !value || value.length > 512 || /[\s\x00-\x1f\x7f]/.test(value)) throw invalid("A valid Gmail provider id is required.");
  return encodeURIComponent(value);
}
function decode(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(value) || value.length > Math.ceil(MAX_BYTES * 4 / 3) + 4) throw invalid("Gmail returned invalid or oversized base64url data.");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value.replace(/=+$/, "")) throw invalid("Gmail returned invalid base64url data.");
  if (bytes.length > MAX_BYTES) throw invalid("Gmail returned an oversized message or attachment.");
  return bytes;
}
function rawMessage(raw, threadId) {
  if (!(Buffer.isBuffer(raw) || raw instanceof Uint8Array) || !raw.length || raw.length > MAX_BYTES) throw invalid("A nonempty MIME message within the Gmail size limit is required.");
  if (threadId) id(threadId);
  return { raw: Buffer.from(raw).toString("base64url"), ...(threadId ? { threadId } : {}) };
}
function labelIds(values) {
  if (!Array.isArray(values) || values.length > 100) throw invalid("Choose at most 100 Gmail labels per operation.");
  return [...new Set(values.map(value => { id(value); return value; }))];
}
function message(value) {
  if (!value || typeof value !== "object") throw invalid("Gmail returned an invalid message.");
  id(value.id);
  return value;
}
function page(value, key) {
  if (!value || typeof value !== "object" || (value[key] !== undefined && !Array.isArray(value[key]))) throw invalid("Gmail returned an invalid page.");
  const nextPageToken = typeof value.nextPageToken === "string" ? value.nextPageToken : "";
  return { ...value, [key]: value[key] || [], nextPageToken };
}

function createGmailMailApi({ accessToken, fetchImpl = (...args) => fetch(...args), check = () => {}, signal } = {}) {
  if (typeof accessToken !== "function") throw invalid("A Gmail access-token supplier is required.");
  function alive() { signal?.throwIfAborted(); check(); }
  async function token() {
    alive();
    const value = await accessToken();
    alive();
    if (typeof value !== "string" || !value) throw invalid("Gmail authorization is unavailable.");
    return value;
  }
  async function request(path, { method = "GET", body, query } = {}) {
    alive();
    const url = new URL(`${ROOT}${path}`);
    for (const [name, value] of Object.entries(query || {})) {
      for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined && item !== "") url.searchParams.append(name, String(item));
    }
    const credential = await token();
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
    let response;
    let issued = false;
    try {
      alive();
      issued = true;
      response = await fetchImpl(url.href, { method, redirect: "error", signal: requestSignal,
        headers: { authorization: `Bearer ${credential}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      alive();
    } catch (cause) {
      throw Object.assign(new Error("Gmail request could not be confirmed. Refresh before retrying a write."), { code: requestSignal.aborted ? "aborted" : "provider_network", operationIssued: method !== "GET" && issued, cause });
    }
    if (!response.ok) {
      const error = Object.assign(new Error(`Gmail rejected the request (HTTP ${response.status}).`), {
        status: response.status, code: response.status === 429 ? "rate_limit" : [401, 403].includes(response.status) ? "scope_missing" : "provider",
        operationIssued: method !== "GET" && (response.status >= 500 || response.status === 408),
      });
      const wait = retryAfterMs(response); if (wait != null) error.retryAfterMs = wait;
      throw error;
    }
    if (response.status === 204) return {};
    let text;
    try { text = await response.text(); alive(); }
    catch (cause) { throw Object.assign(new Error("Gmail response could not be confirmed."), { code: "provider_network", operationIssued: method !== "GET", cause }); }
    if (Buffer.byteLength(text) > Math.ceil(MAX_BYTES * 4 / 3) + 1024 * 1024) throw Object.assign(new Error("Gmail returned an oversized response."), { code: "provider", operationIssued: method !== "GET" });
    try { return JSON.parse(text); }
    catch { throw Object.assign(new Error("Gmail returned an invalid response. Refresh before retrying a write."), { code: "provider", operationIssued: method !== "GET" }); }
  }
  function writeResult(value, parse = message) {
    try { return parse(value); }
    catch (error) { error.code = "provider"; error.operationIssued = true; throw error; }
  }
  async function listMessages({ labelIds: labels = [], query = "", pageToken = "", limit = 100, includeSpamTrash = false } = {}) {
    const payload = page(await request("/messages", { query: { labelIds: labelIds(labels), q: query, pageToken,
      maxResults: Math.min(500, Math.max(1, Number(limit) || 100)), includeSpamTrash } }), "messages");
    payload.messages.forEach(message);
    return payload;
  }
  async function getMessage(messageId, { format = "full" } = {}) {
    if (!["full", "metadata", "raw"].includes(format)) throw invalid("Choose a supported Gmail message format.");
    return message(await request(`/messages/${id(messageId)}`, { query: { format } }));
  }
  async function raw(messageId) {
    const result = await getMessage(messageId, { format: "raw" });
    const source = decode(result.raw);
    if (!source.length) throw invalid("Gmail returned an empty MIME message.");
    return { ...result, source };
  }
  async function attachment(messageId, attachmentId) {
    const result = await request(`/messages/${id(messageId)}/attachments/${id(attachmentId)}`);
    return decode(result.data);
  }
  async function modifyLabels(messageId, add = [], remove = []) {
    const addLabelIds = labelIds(add), removeLabelIds = labelIds(remove);
    if (addLabelIds.some(value => removeLabelIds.includes(value))) throw invalid("A label cannot be both added and removed.");
    return writeResult(await request(`/messages/${id(messageId)}/modify`, { method: "POST", body: { addLabelIds, removeLabelIds } }));
  }
  async function trash(messageId) {
    const prior = await getMessage(messageId, { format: "metadata" });
    const result = writeResult(await request(`/messages/${id(messageId)}/trash`, { method: "POST" }));
    return { message: result, undo: { messageId, priorLabelIds: Array.isArray(prior.labelIds) ? prior.labelIds : [] } };
  }
  async function restoreTrash(undo) {
    const messageId = undo?.messageId;
    id(messageId);
    const prior = labelIds(undo?.priorLabelIds || []);
    const result = writeResult(await request(`/messages/${id(messageId)}/untrash`, { method: "POST" }));
    // Restore folder membership without overwriting later read/star/label changes.
    const mutable = prior.filter(value => !["TRASH", "SENT", "DRAFT", "UNREAD", "STARRED", "IMPORTANT", "CHAT"].includes(value));
    const missing = mutable.filter(value => !(result.labelIds || []).includes(value));
    return missing.length ? modifyLabels(messageId, missing) : result;
  }
  async function history({ startHistoryId, pageToken = "", limit = 100 } = {}) {
    if (typeof startHistoryId !== "string" || !/^\d+$/.test(startHistoryId)) throw invalid("A Gmail history cursor is required.");
    try { return page(await request("/history", { query: { startHistoryId, pageToken, maxResults: Math.min(500, Math.max(1, Number(limit) || 100)) } }), "history"); }
    catch (error) { if (error.status === 404) error.code = "history_expired"; throw error; }
  }
  function draft(value) { if (!value || typeof value !== "object") throw invalid("Gmail returned an invalid draft."); id(value.id); message(value.message); return value; }
  async function listDrafts({ pageToken = "", limit = 100 } = {}) {
    const result = page(await request("/drafts", { query: { pageToken, maxResults: Math.min(500, Math.max(1, Number(limit) || 100)) } }), "drafts");
    result.drafts.forEach(draft); return result;
  }
  async function getDraft(draftId) { return draft(await request(`/drafts/${id(draftId)}`, { query: { format: "full" } })); }
  async function saveDraft({ draftId, raw: source, threadId } = {}) {
    const body = { message: rawMessage(source, threadId) };
    return writeResult(await request(draftId ? `/drafts/${id(draftId)}` : "/drafts", { method: draftId ? "PUT" : "POST", body }), draft);
  }
  async function discardDraft(draftId) {
    const current = await getDraft(draftId);
    return trash(current.message.id); // never drafts.delete or messages.delete
  }
  async function send({ raw: source, threadId, confirmed = false } = {}) {
    if (confirmed !== true) throw invalid("Send requires an explicit reviewed send action.");
    return writeResult(await request("/messages/send", { method: "POST", body: rawMessage(source, threadId) }));
  }
  // Reuse the existing provider label hierarchy implementation, with strict transport ownership.
  async function labelsCall(work) {
    const credential = await token();
    const guardedFetch = async (url, options) => {
      alive();
      if (!String(url).startsWith(`${ROOT}/labels`)) throw invalid("Unexpected Gmail label destination.");
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
      const result = await fetchImpl(url, { ...options, redirect: "error", signal: combined });
      alive(); return result;
    };
    return work(credential, guardedFetch);
  }
  return { profile: () => request("/profile"), listMessages, getMessage, raw, attachment, history, listDrafts, getDraft, saveDraft, discardDraft, send,
    modifyLabels, trash, restoreTrash,
    markRead: (messageId, read) => modifyLabels(messageId, read ? [] : ["UNREAD"], read ? ["UNREAD"] : []),
    star: (messageId, starred) => modifyLabels(messageId, starred ? ["STARRED"] : [], starred ? [] : ["STARRED"]),
    archive: messageId => modifyLabels(messageId, [], ["INBOX"]),
    labels: () => labelsCall((credential, fetcher) => provider.listLabels(credential, fetcher)),
    createLabel: name => labelsCall((credential, fetcher) => provider.createLabel(credential, name, fetcher)),
    renameLabel: (labelId, name) => labelsCall((credential, fetcher) => provider.renameLabel(credential, labelId, name, fetcher)),
    moveLabel: (labelId, destinationId) => labelsCall((credential, fetcher) => provider.moveLabel(credential, labelId, destinationId, fetcher)),
    deleteLabel: labelId => labelsCall((credential, fetcher) => provider.deleteLabel(credential, labelId, fetcher)),
  };
}

module.exports = { createGmailMailApi, MAIL_SCOPES, CALENDAR_SCOPES };
