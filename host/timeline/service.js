const crypto = require("node:crypto");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { failure } = require("./validate");
const { freezeSources, assertSources, hash, fingerprint, dedupeRows, messagePreview, messageIdentity } = require("./sources");
const { htmlToPlain } = require("../mail/text-encoding");
const { LIMITS, LANGUAGES, PROMPT_VERSION, preparePlan, extract } = require("./extract");
const { budget, budgetDetails } = require("./budget");

const CHANNELS = new Set(["timeline:search", "timeline:source", "timeline:check", "timeline:prepare", "timeline:download", "timeline:generate", "timeline:cancel", "timeline:list", "timeline:get", "timeline:delete", "timeline:export"]);
const codes = new Set(["timeline-validation", "timeline-consolidation", "timeline-version", "timeline-size", "timeline-depth", "timeline-selection-limit", "timeline-empty", "timeline-source-changed", "timeline-query", "timeline-budget", "timeline-not-found", "timeline-manifest", "timeline-partial", "timeline-busy", "timeline-cancelled", "ai-consent-required", "timeline-language", "timeline-timezone", "timeline-input", "timeline-revision"]);

function publicError(error) {
  const details = budgetDetails(error);
  return { code: codes.has(error?.code) ? error.code : "timeline-failed", ...(details ? { budget: details } : {}) };
}

function shape(value, keys, required = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw failure("timeline-input");
}
function token(value) {
  if (typeof value !== "string" || !value || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw failure("timeline-input");
  return value;
}
function selectionInput(value) {
  shape(value, ["messages", "search", "expandThreads"], ["expandThreads"]);
  if (typeof value.expandThreads !== "boolean" || (!value.search && !value.messages?.length)) throw failure("timeline-input");
  if (value.messages !== undefined) {
    if (!Array.isArray(value.messages) || value.messages.length > LIMITS.messages) throw failure("timeline-input");
    for (const reference of value.messages) {
      shape(reference, ["accountId", "messageId", "phase"], ["accountId", "messageId"]);
      token(reference.accountId); token(reference.messageId);
      if (reference.phase !== undefined && !["main", "background"].includes(reference.phase)) throw failure("timeline-input");
    }
  }
  if (value.search) {
    shape(value.search, ["query", "accountId"], ["query"]);
    if (typeof value.search.query !== "string" || !value.search.query.trim() || value.search.query.length > 1000) throw failure("timeline-query");
    if (value.search.accountId !== undefined) {
      if (typeof value.search.accountId !== "string") throw failure("timeline-input");
      if (value.search.accountId) token(value.search.accountId);
    }
  }
}
function optionsInput(value) {
  shape(value, ["title", "language", "displayTimezone", "keywords", "contactEmails", "mode"], ["title", "language", "displayTimezone"]);
  if (value.mode !== undefined && !["thread", "case"].includes(value.mode)) throw failure("timeline-input");
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 500 || /[\x00-\x1f\x7f\u2028\u2029]/.test(value.title)) throw failure("timeline-input");
  if (!Object.hasOwn(LANGUAGES, value.language)) throw failure("timeline-language");
  if (typeof value.displayTimezone !== "string" || value.displayTimezone.length > 64) throw failure("timeline-timezone");
  try { new Intl.DateTimeFormat("en", { timeZone: value.displayTimezone }).format(); } catch { throw failure("timeline-timezone"); }
  if (value.keywords !== undefined && (typeof value.keywords !== "string" || value.keywords.length > 1000 || /[\x00-\x1f\x7f]/.test(value.keywords))) throw failure("timeline-input");
  if (value.contactEmails !== undefined && (!Array.isArray(value.contactEmails) || value.contactEmails.length > 100
    || value.contactEmails.some(address => typeof address !== "string" || address.length > 254 || !/^[^\s@<>,;]+@[^\s@<>,;]+$/.test(address)))) throw failure("timeline-input");
}

function createService(dependencies) {
  const { db, consent, config, complete, stamp, identities, download, exportFile, version = "0.0.0", now = Date.now } = dependencies;
  const manifests = new Map(), jobs = new Map();
  const sourceDependencies = { db, stamp, identities };
  function live(entry) {
    if (entry.closed?.()) throw failure("timeline-cancelled");
    if (entry.rootAccountId && stamp(entry.rootAccountId) !== entry.rootAccountStamp) throw failure("timeline-source-changed");
    assertSources(sourceDependencies, entry.snapshot);
  }
  function manifest(owner, id) {
    const entry = manifests.get(id);
    if (!entry || entry.owner !== owner || entry.expires < now()) throw failure("timeline-manifest");
    live(entry);
    return entry;
  }
  function prepare(owner, input, closed = () => false) {
    shape(input, ["selection", "options", "manifestToken", "contextOnly"], ["selection", "options"]);
    // Re-preparing edited focus must not silently switch account incarnations.
    const previous = input.manifestToken !== undefined ? manifest(owner, token(input.manifestToken)) : null;
    selectionInput(input.selection); optionsInput(input.options);
    // A Case search context proves the opened message/account without capturing
    // its whole thread or treating any body as reviewed generation input.
    if (input.contextOnly !== undefined && (input.contextOnly !== true || input.manifestToken !== undefined
        || input.options.mode === "case" || input.selection.search || input.selection.expandThreads
        || input.selection.messages?.length !== 1)) throw failure("timeline-input");
    if (input.options.mode === "case" && (!previous?.rootAccountId || input.selection.search || input.selection.expandThreads
        || input.selection.messages.some(reference => reference.accountId !== previous.rootAccountId || !reference.phase)
        || new Set(input.selection.messages.map(reference => reference.messageId)).size !== input.selection.messages.length)) throw failure("timeline-input");
    const snapshot = db.transaction(() => freezeSources(sourceDependencies, input.selection, input.contextOnly ? "context" : input.options.mode));
    if (input.options.mode === "case") snapshot.caseScope = { local_only: true, account_count: 1,
      search_count: previous.searchStats.count, limited_search_count: previous.searchStats.limited, mailbox_complete: false, search_is_exhaustive: false };
    let plan, blocked;
    try { plan = preparePlan(snapshot.sources, { language: input.options.language, focus: { keywords: input.options.keywords || "", contact_emails: input.options.contactEmails || [] } }); }
    catch (error) {
      if (!budgetDetails(error)) throw error;
      blocked = budgetDetails(error);
    }
    // Keep the old source proof if options or source capture fail. A valid
    // capture can also retain its proof while focus exceeds a planning limit.
    for (const [id, entry] of manifests) if (entry.owner === owner || entry.expires < now()) manifests.delete(id);
    if (manifests.size >= 8) throw failure("timeline-busy");
    const status = consent.status();
    const id = crypto.randomUUID();
    const entry = { owner, snapshot, contextOnly: input.contextOnly === true, options: { ...input.options, ...(input.options.contactEmails ? { contactEmails: [...input.options.contactEmails] } : {}) }, expires: now() + 300000, consentToken: status.token, closed, blocked, consumed: false };
    entry.rootAccountId = previous?.rootAccountId || (snapshot.accounts.length === 1 ? snapshot.accounts[0].id : null);
    entry.rootAccountStamp = previous?.rootAccountStamp || snapshot.accounts.find(account => account.id === entry.rootAccountId)?.stamp;
    entry.searchStats = previous?.searchStats || { count: 0, limited: 0 };
    entry.optionsDigest = hash([snapshot.digest, snapshot.caseScope, entry.options, status.token]);
    manifests.set(id, entry);
    return { manifestToken: id, optionsDigest: entry.optionsDigest, expiresAt: entry.expires,
      accounts: snapshot.accounts.map(account => account.email), threads: snapshot.sourceThreads.length,
      coverage: snapshot.coverage, missingBodies: snapshot.missingBodies, invalidMetadata: snapshot.invalidMetadata, search: snapshot.search,
      messages: snapshot.records.map(record => ({ ...messagePreview(db.timelineMessage(record.id)), phase: record.phase || "main" })), caseScope: snapshot.caseScope,
      chunks: plan?.chunks.length || 0, estimatedInputTokens: plan?.estimatedInputTokens || 0, ...(blocked ? { budget: blocked } : {}),
      limits: LIMITS, destination: status.destination, provider: status.label, model: status.model, allowed: status.manual,
      locality: status.locality, providerTerms: status.providerTerms };
  }
  function cancel(owner, id) {
    const job = jobs.get(id);
    if (!job || job.owner !== owner) throw failure("timeline-not-found");
    job.controller.abort();
    return { cancelled: true };
  }
  async function generate(owner, input, publish) {
    shape(input, ["manifestToken", "optionsDigest", "acceptPartial", "reviewed"], ["manifestToken", "optionsDigest", "acceptPartial"]);
    if (typeof input.acceptPartial !== "boolean") throw failure("timeline-input");
    const entry = manifest(owner, token(input.manifestToken));
    if (entry.contextOnly) throw failure("timeline-input");
    if (entry.consumed || input.optionsDigest !== entry.optionsDigest) throw failure("timeline-manifest");
    if (entry.options.mode === "case" && input.reviewed !== true) throw failure("timeline-input");
    if (entry.blocked) throw budget(entry.blocked.kind, entry.blocked.actual, entry.blocked.limit);
    if (!entry.snapshot.sources.length || (entry.snapshot.coverage.omitted_message_count && !input.acceptPartial)) throw failure("timeline-partial");
    if (jobs.size) throw failure("timeline-busy");
    const controller = new AbortController();
    const lease = consent.acquire(config(), { signal: controller.signal, stamp: entry.consentToken, background: false });
    const jobId = crypto.randomUUID();
    const job = { owner, controller, accounts: entry.snapshot.accounts.map(account => account.id) };
    try { db.timeline.startJob(jobId, owner); }
    catch (error) { lease.release(); throw error; }
    jobs.set(jobId, job);
    // One-use generation authorization, but a retained owner-bound source proof
    // for checks and explicit re-preparation after failure/cancel/completion.
    entry.consumed = true;
    entry.expires = now() + LIMITS.jobMs + 300000;
    const send = value => { if (!entry.closed()) publish({ jobId, ...value }); };
    setImmediate(async () => {
      let state = "failed", calls = 0, terminal;
      const check = () => { controller.signal.throwIfAborted(); lease.check(); live(entry); };
      try {
        check();
        const schemaVersion = entry.options.mode === "case" ? "1.1.0" : "1.0.0";
        const result = await extract({ sources: entry.snapshot.sources, envelope: {
          $schema: `urn:morrow-mail:timeline:${schemaVersion}`, schema_version: schemaVersion, timeline_id: crypto.randomUUID(), source_namespace: db.timeline.namespace(),
          generator: { name: "Morrow Mail", version }, generated_at: new Date(now()).toISOString(), title: entry.options.title,
          display_timezone: entry.options.displayTimezone, time_basis: "mail_timestamp", coverage: entry.snapshot.coverage, source_threads: entry.snapshot.sourceThreads,
          ...(entry.snapshot.caseScope ? { case_scope: entry.snapshot.caseScope } : {}),
        }, language: entry.options.language, focus: { keywords: entry.options.keywords || "", contact_emails: entry.options.contactEmails || [] }, signal: lease.signal, check,
        complete: (messages, options) => complete(messages, { ...options, config: config(), background: false }),
        progress: value => { calls = value.calls; send(value); } });
        check();
        db.timeline.save(result.document, entry.snapshot.records, { digest: entry.snapshot.digest, promptVersion: PROMPT_VERSION, usage: result.usage });
        state = "completed";
        calls = result.usage.calls;
        terminal = { phase: state, timelineId: result.document.timeline_id, revision: 1, calls };
      } catch (error) {
        state = controller.signal.aborted || lease.signal.aborted ? "cancelled" : "failed";
        terminal = { ...publicError(error), phase: state, calls };
        if (state === "cancelled") terminal.code = "timeline-cancelled";
      } finally {
        jobs.delete(jobId);
        lease.release();
        try { db.timeline.finishJob(jobId, state, calls); } catch {}
        entry.expires = now() + 300000;
      }
      send(terminal);
    });
    return { jobId };
  }
  async function invoke(owner, channel, input = {}, publish = () => {}, closed = () => false) {
    if (Buffer.byteLength(JSON.stringify(input)) > 128000) throw failure("timeline-input");
    if (channel === "timeline:search") {
      shape(input, ["manifestToken", "query"], ["manifestToken", "query"]);
      const entry = manifest(owner, token(input.manifestToken));
      if (!entry.rootAccountId || typeof input.query !== "string" || !input.query.trim() || input.query.length > 1000) throw failure("timeline-query");
      const inspected = db.inspectSearchTokens(input.query);
      if (!inspected.tokens.length || inspected.tokens.length > 16 || inspected.overlong) throw failure("timeline-query");
      const found = db.timelineSearch({ query: input.query, accountId: entry.rootAccountId });
      // Retain the database query cap before provider-copy deduplication. Copies
      // can otherwise hide the fact that later results were never examined.
      const limited = found.length > 100;
      const rows = dedupeRows(found.filter(row => row.account_id === entry.rootAccountId));
      entry.searchStats.count++;
      if (limited) entry.searchStats.limited++;
      return { messages: rows.slice(0, 100).map(messagePreview), matched: found.length, limited,
        queryCapped: found.length > LIMITS.messages, localOnly: true, exhaustive: false };
    }
    if (channel === "timeline:source") {
      shape(input, ["id", "sourceMessageId", "manifestToken", "messageId"]);
      let row;
      if (input.manifestToken !== undefined) {
        if (input.id !== undefined || input.sourceMessageId !== undefined) throw failure("timeline-input");
        const entry = manifest(owner, token(input.manifestToken));
        row = db.messageById(token(input.messageId));
        if (!row || row.account_id !== entry.rootAccountId) throw failure("timeline-source-changed");
      } else {
        if (input.messageId !== undefined) throw failure("timeline-input");
        const stored = db.timeline.get(token(input.id)), sourceId = token(input.sourceMessageId);
        if (!stored.document.events.some(event => event.source_message_id === sourceId)) throw failure("timeline-not-found");
        for (const record of db.timeline.sourceRecords(input.id)) {
          const candidate = db.messageById(record.id), account = db.accountById(record.account_id);
          if (!candidate || !account || candidate.account_id !== record.account_id || fingerprint(candidate) !== record.fingerprint) continue;
          if (messageIdentity(candidate, account, db.timeline) === sourceId) { row = candidate; break; }
        }
        if (!row) throw failure("timeline-source-changed");
      }
      // Plain cached text only: no engine open, provider read, mark-read, remote
      // content, attachment bytes or model invocation belongs on this path.
      return { ...messagePreview(row), to: JSON.parse(row.to_json || "[]"), cc: JSON.parse(row.cc_json || "[]"),
        text: row.text_body || htmlToPlain(row.html_body || "") };
    }
    if (channel === "timeline:check") {
      shape(input, ["manifestToken"], ["manifestToken"]);
      manifest(owner, token(input.manifestToken));
      return { valid: true };
    }
    if (channel === "timeline:prepare") return prepare(owner, input, closed);
    if (channel === "timeline:generate") return generate(owner, input, publish);
    if (channel === "timeline:download") {
      shape(input, ["manifestToken"], ["manifestToken"]);
      const entry = manifest(owner, token(input.manifestToken));
      if (entry.contextOnly) throw failure("timeline-input");
      for (const reference of entry.snapshot.omitted) {
        live(entry);
        await download(reference.messageId, reference.accountId);
        if (closed()) throw failure("timeline-cancelled");
        for (const account of entry.snapshot.accounts) if (stamp(account.id) !== account.stamp) throw failure("timeline-source-changed");
        const row = db.messageById(reference.messageId);
        if (!row || row.account_id !== reference.accountId) throw failure("timeline-source-changed");
        entry.snapshot.records.find(record => record.id === row.id).fingerprint = fingerprint(row);
      }
      const frozenSelection = { messages: entry.snapshot.records.map(row => ({ accountId: row.account_id, messageId: row.id, ...(row.phase ? { phase: row.phase } : {}) })), expandThreads: false };
      return { ...prepare(owner, { selection: frozenSelection, options: entry.options, manifestToken: input.manifestToken }, closed), frozenSelection };
    }
    if (channel === "timeline:cancel") { shape(input, ["jobId"], ["jobId"]); return cancel(owner, token(input.jobId)); }
    if (channel === "timeline:list") { shape(input, []); return db.timeline.list(); }
    if (channel === "timeline:get" || channel === "timeline:delete") {
      shape(input, ["id"], ["id"]); token(input.id);
      if (channel === "timeline:get") return db.timeline.get(input.id);
      db.timeline.delete(input.id); return { deleted: true };
    }
    if (channel === "timeline:export") {
      shape(input, ["id", "revision", "format", "confirmed"], ["id", "revision", "format", "confirmed"]); token(input.id);
      if (!["json", "markdown", "html", "pdf"].includes(input.format) || input.confirmed !== true || !Number.isSafeInteger(input.revision)) throw failure("timeline-input");
      const stored = db.timeline.get(input.id);
      const check = () => { if (closed()) throw failure("timeline-cancelled"); if (db.timeline.get(input.id).revision !== input.revision) throw failure("timeline-revision"); };
      check();
      return exportFile(stored.document, input.format, { owner, check });
    }
    throw failure("timeline-input");
  }
  return { invoke,
    close(owner) {
      for (const [id, entry] of manifests) if (entry.owner === owner) manifests.delete(id);
      for (const job of jobs.values()) if (job.owner === owner) job.controller.abort();
    },
    invalidateAccount(id) {
      for (const [key, entry] of manifests) if (entry.snapshot.accounts.some(account => account.id === id)) manifests.delete(key);
      for (const job of jobs.values()) if (job.accounts.includes(id)) job.controller.abort();
    },
  };
}

function trustedSender(event) {
  const sender = event?.sender;
  if (!sender || sender.isDestroyed() || event.senderFrame !== sender.mainFrame) return false;
  try {
    const url = new URL(sender.getURL());
    return url.protocol === "file:" && fileURLToPath(url) === path.join(__dirname, "../../renderer/index.html");
  } catch { return false; }
}

let instance;
const owners = new Set();
function getService() {
  if (!instance) {
    const db = require("../mail/db"), engine = require("../mail/engine");
    instance = createService({ db, consent: require("../ai-consent").getConsent(), config: () => require("../ai-config").loadConfig(),
      complete: (...args) => require("../openai-client").completeDetailed(...args), stamp: engine.timelineAccountStamp,
      identities: account => require("../mail/compose-identity").accountIdentity(account).sendAs.map(identity => identity.email || identity.address).filter(Boolean).map(address => address.toLowerCase()),
      download: engine.timelineDownload, exportFile: (...args) => require("./export").exportFile(...args), version: require("../../package.json").version });
  }
  return instance;
}
function answer(channel, args, event) {
  if (!CHANNELS.has(channel)) return undefined;
  if (!trustedSender(event)) return { success: false, error: { code: "timeline-sender" } };
  const service = getService(), owner = event.sender.id;
  if (!owners.has(owner)) {
    owners.add(owner);
    event.sender.once("destroyed", () => { owners.delete(owner); service.close(owner); });
    event.sender.on("will-navigate", () => service.close(owner));
  }
  return service.invoke(owner, channel, args?.[0], value => { if (!event.sender.isDestroyed()) event.sender.send("timeline:progress", value); }, () => event.sender.isDestroyed())
    .then(data => ({ success: true, data }), error => ({ success: false, error: { ...publicError(error), ...(["timeline:prepare", "timeline:generate"].includes(channel) ? { calls: 0 } : {}) } }));
}

module.exports = { CHANNELS, createService, trustedSender, publicError, answer, invalidateAccount: id => instance?.invalidateAccount(id) };
