// Gmail API transport. All ordinary deletion uses Trash; no permanent-delete API.
const { gmailError } = require("./gmail-error");
const gmailPace = require("./gmail-pace");
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

function createGmailMailApi({ accessToken, refreshAccessToken, fetchImpl = (...args) => fetch(...args), check = () => {}, signal, accountKey } = {}) {
  if (typeof accessToken !== "function") throw invalid("A Gmail access-token supplier is required.");
  function alive() { signal?.throwIfAborted(); check(); }
  async function token() {
    alive();
    const value = await accessToken();
    alive();
    if (typeof value !== "string" || !value) throw invalid("Gmail authorization is unavailable.");
    return value;
  }
  // Retry the rejected HTTP read only, never its caller or a compound write.
  async function authorizedFetch(url, options, operation, readSignal, beforeSubmit) {
    let credential;
    try { credential = await token(); }
    catch (error) { error.operationIssued = false; throw error; }
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        const wait = gmailPace.reserve(accountKey, gmailPace.readUnits(operation));
        if (wait) await gmailPace.sleep(wait);
        // Pacing may yield while another read renews this session again.
        // Recheck the durable supplier immediately before the retry submission.
        try { credential = await token(); }
        catch (error) { error.operationIssued = false; throw error; }
      }
      try {
        alive();
        readSignal?.throwIfAborted();
        options.signal?.throwIfAborted();
        if ((options.method || "GET") !== "GET") beforeSubmit?.();
      } catch (error) { error.operationIssued = false; throw error; }
      let response;
      try {
        response = await fetchImpl(url, { ...options,
          headers: { ...options.headers, authorization: `Bearer ${credential}` } });
      } catch {
        throw Object.assign(new Error("Gmail request could not be confirmed. Refresh before retrying a write."), {
          code: options.signal?.aborted ? "aborted" : "provider_network", operationIssued: (options.method || "GET") !== "GET",
        });
      }
      try { alive(); readSignal?.throwIfAborted(); }
      catch (error) { error.operationIssued = (options.method || "GET") !== "GET"; throw error; }
      if (response.ok) return response;
      const error = await gmailError(response, operation, { method: options.method || "GET", signal: options.signal });
      try { alive(); readSignal?.throwIfAborted(); }
      catch (cause) {
        // Reading the error body can await a reconnect or cancellation. Keep
        // the HTTP result's write evidence when retiring the old connection.
        cause.operationIssued = error.operationIssued;
        throw cause;
      }
      if ((options.method || "GET") !== "GET" || response.status !== 401 || attempt !== 0 || typeof refreshAccessToken !== "function") throw error;
      try {
        credential = await refreshAccessToken(credential);
        alive();
        readSignal?.throwIfAborted();
        if (typeof credential !== "string" || !credential) throw invalid("Gmail authorization is unavailable.");
      } catch (cause) {
        // This recovery belongs only to a rejected GET. Preserve the typed
        // renewal error while recording that no write was submitted here.
        cause.operationIssued = false;
        throw cause;
      }
    }
  }
  async function request(path, { operation, method = "GET", body, query, signal: readSignal, beforeSubmit } = {}) {
    alive();
    readSignal?.throwIfAborted();
    if (method === "GET") {
      const wait = gmailPace.reserve(accountKey, gmailPace.readUnits(operation, query));
      if (wait) {
        await gmailPace.sleep(wait);
        alive();
        readSignal?.throwIfAborted();
      }
    }
    const url = new URL(`${ROOT}${path}`);
    for (const [name, value] of Object.entries(query || {})) {
      for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined && item !== "") url.searchParams.append(name, String(item));
    }
    const requestSignal = AbortSignal.any([signal, readSignal, AbortSignal.timeout(45000)].filter(Boolean));
    const response = await authorizedFetch(url.href, { method, redirect: "error", signal: requestSignal,
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }, operation, readSignal, beforeSubmit);
    if (response.status === 204) return {};
    let text;
    try { text = await response.text(); alive(); readSignal?.throwIfAborted(); }
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
    const payload = page(await request("/messages", { operation: "messages.list", query: { labelIds: labelIds(labels), q: query, pageToken,
      maxResults: Math.min(500, Math.max(1, Number(limit) || 100)), includeSpamTrash } }), "messages");
    payload.messages.forEach(message);
    return payload;
  }
  async function getMessage(messageId, { format = "full", signal: readSignal } = {}) {
    if (!["full", "metadata", "raw"].includes(format)) throw invalid("Choose a supported Gmail message format.");
    return message(await request(`/messages/${id(messageId)}`, { operation: "messages.get", query: { format }, signal: readSignal }));
  }
  async function raw(messageId) {
    const result = await getMessage(messageId, { format: "raw" });
    const source = decode(result.raw);
    if (!source.length) throw invalid("Gmail returned an empty MIME message.");
    return { ...result, source };
  }
  async function importMessage(source, labels, { beforeSubmit } = {}) {
    // Official mailbox import, never drafts.create or messages.send. Existing
    // gmail.modify covers this endpoint; no scope or delivery grant is added.
    return writeResult(await request("/messages/import", { operation: "messages.import", method: "POST",
      body: { ...rawMessage(source), labelIds: labelIds(labels) },
      query: { internalDateSource: "dateHeader", processForCalendar: false, neverMarkSpam: false, deleted: false }, beforeSubmit }));
  }
  async function attachment(messageId, attachmentId, { signal: readSignal } = {}) {
    const result = await request(`/messages/${id(messageId)}/attachments/${id(attachmentId)}`, { operation: "attachments.get", signal: readSignal });
    return decode(result.data);
  }
  async function modifyLabels(messageId, add = [], remove = [], options = {}) {
    const addLabelIds = labelIds(add), removeLabelIds = labelIds(remove);
    if (addLabelIds.some(value => removeLabelIds.includes(value))) throw invalid("A label cannot be both added and removed.");
    return writeResult(await request(`/messages/${id(messageId)}/modify`, { operation: "messages.modify", method: "POST", body: { addLabelIds, removeLabelIds }, beforeSubmit: options.beforeSubmit }));
  }
  async function trash(messageId, options = {}) {
    const prior = await getMessage(messageId, { format: "metadata" });
    const result = writeResult(await request(`/messages/${id(messageId)}/trash`, { operation: "messages.trash", method: "POST", beforeSubmit: options.beforeSubmit }));
    return { message: result, undo: { messageId, priorLabelIds: Array.isArray(prior.labelIds) ? prior.labelIds : [] } };
  }
  async function restoreTrash(undo) {
    const messageId = undo?.messageId;
    id(messageId);
    const prior = labelIds(undo?.priorLabelIds || []);
    const result = writeResult(await request(`/messages/${id(messageId)}/untrash`, { operation: "messages.untrash", method: "POST" }));
    // Restore folder membership without overwriting later read/star/label changes.
    const mutable = prior.filter(value => !["TRASH", "SENT", "DRAFT", "UNREAD", "STARRED", "IMPORTANT", "CHAT"].includes(value));
    const missing = mutable.filter(value => !(result.labelIds || []).includes(value));
    return missing.length ? modifyLabels(messageId, missing) : result;
  }
  async function history({ startHistoryId, pageToken = "", limit = 100 } = {}) {
    if (typeof startHistoryId !== "string" || !/^\d+$/.test(startHistoryId)) throw invalid("A Gmail history cursor is required.");
    try { return page(await request("/history", { operation: "history.list", query: { startHistoryId, pageToken, maxResults: Math.min(500, Math.max(1, Number(limit) || 100)) } }), "history"); }
    catch (error) { if (error.status === 404) error.code = "history_expired"; throw error; }
  }
  function draft(value) { if (!value || typeof value !== "object") throw invalid("Gmail returned an invalid draft."); id(value.id); message(value.message); return value; }
  async function listDrafts({ pageToken = "", limit = 100 } = {}) {
    const result = page(await request("/drafts", { operation: "drafts.list", query: { pageToken, maxResults: Math.min(500, Math.max(1, Number(limit) || 100)) } }), "drafts");
    result.drafts.forEach(draft); return result;
  }
  async function getDraft(draftId) { return draft(await request(`/drafts/${id(draftId)}`, { operation: "drafts.get", query: { format: "full" } })); }
  async function saveDraft({ draftId, raw: source, threadId } = {}) {
    const body = { message: rawMessage(source, threadId) };
    return writeResult(await request(draftId ? `/drafts/${id(draftId)}` : "/drafts", { operation: draftId ? "drafts.update" : "drafts.create", method: draftId ? "PUT" : "POST", body }), draft);
  }
  async function discardDraft(draftId) {
    const current = await getDraft(draftId);
    return trash(current.message.id); // never drafts.delete or messages.delete
  }
  async function send({ raw: source, threadId, confirmed = false } = {}) {
    if (confirmed !== true) throw invalid("Send requires an explicit reviewed send action.");
    return writeResult(await request("/messages/send", { operation: "messages.send", method: "POST", body: rawMessage(source, threadId) }));
  }
  // Reuse the existing provider label hierarchy implementation, with strict transport ownership.
  async function labelsCall(work) {
    const credential = ""; // Authorization is supplied per HTTP request below.
    let failure;
    const guardedFetch = async (url, options) => {
      alive();
      if (!String(url).startsWith(`${ROOT}/labels`)) throw invalid("Unexpected Gmail label destination.");
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
      const method = options.method || "GET";
      const operation = { GET: "labels.list", POST: "labels.create", PATCH: "labels.update", DELETE: "labels.delete" }[method];
      let result;
      try { result = await authorizedFetch(url, { ...options, redirect: "error", signal: combined }, operation); }
      catch (error) { failure = error; throw error; }
      return result;
    };
    try { return await work(credential, guardedFetch); }
    catch (error) {
      // apiJson wraps fetch errors. Keep safe HTTP evidence, and preserve the
      // hierarchy mover's partial-result receipt when some renames succeeded.
      if (failure && error.code !== "partial") throw failure;
      if (failure) error.message += " " + failure.message;
      throw error;
    }
  }
  return { profile: () => request("/profile", { operation: "profile.get" }), listMessages, getMessage, raw, importMessage, attachment, history, listDrafts, getDraft, saveDraft, discardDraft, send,
    getLabel: labelId => request(`/labels/${id(labelId)}`, { operation: "labels.get" }),
    modifyLabels, trash, restoreTrash,
    markRead: (messageId, read, options) => modifyLabels(messageId, read ? [] : ["UNREAD"], read ? ["UNREAD"] : [], options),
    star: (messageId, starred, options) => modifyLabels(messageId, starred ? ["STARRED"] : [], starred ? [] : ["STARRED"], options),
    archive: (messageId, options) => modifyLabels(messageId, [], ["INBOX"], options),
    labels: () => labelsCall((credential, fetcher) => provider.listLabels(credential, fetcher)),
    createLabel: name => labelsCall((credential, fetcher) => provider.createLabel(credential, name, fetcher)),
    renameLabel: (labelId, name) => labelsCall((credential, fetcher) => provider.renameLabel(credential, labelId, name, fetcher)),
    moveLabel: (labelId, destinationId) => labelsCall((credential, fetcher) => provider.moveLabel(credential, labelId, destinationId, fetcher)),
    deleteLabel: (labelId, options) => labelsCall((credential, fetcher) => provider.deleteLabel(credential, labelId, fetcher, options)),
  };
}

module.exports = { createGmailMailApi, decodePartData: decode, MAIL_SCOPES, CALENDAR_SCOPES };
