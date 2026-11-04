const crypto = require("node:crypto");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { failure } = require("./validate");
const { freezeSources, assertSources, hash, fingerprint } = require("./sources");
const { LIMITS, LANGUAGES, PROMPT_VERSION, planChunks, extract } = require("./extract");

const CHANNELS = new Set(["timeline:prepare", "timeline:download", "timeline:generate", "timeline:cancel", "timeline:list", "timeline:get", "timeline:delete", "timeline:export"]);
const codes = new Set(["timeline-validation", "timeline-version", "timeline-size", "timeline-depth", "timeline-selection-limit", "timeline-empty", "timeline-source-changed", "timeline-query", "timeline-budget", "timeline-not-found", "timeline-manifest", "timeline-partial", "timeline-busy", "timeline-cancelled", "ai-consent-required", "timeline-language", "timeline-timezone", "timeline-input", "timeline-revision"]);

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
      shape(reference, ["accountId", "messageId"], ["accountId", "messageId"]);
      token(reference.accountId); token(reference.messageId);
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
  shape(value, ["title", "language", "displayTimezone", "keywords", "contactEmails"], ["title", "language", "displayTimezone"]);
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
    assertSources(sourceDependencies, entry.snapshot);
  }
  function manifest(owner, id) {
    const entry = manifests.get(id);
    if (!entry || entry.owner !== owner || entry.expires < now()) throw failure("timeline-manifest");
    live(entry);
    return entry;
  }
  function prepare(owner, input, closed = () => false) {
    shape(input, ["selection", "options"], ["selection", "options"]);
    selectionInput(input.selection); optionsInput(input.options);
    for (const [id, entry] of manifests) if (entry.owner === owner || entry.expires < now()) manifests.delete(id);
    if (manifests.size >= 8) throw failure("timeline-busy");
    const snapshot = db.transaction(() => freezeSources(sourceDependencies, input.selection));
    const chunks = snapshot.sources.length ? planChunks(snapshot.sources) : [];
    const estimatedInputTokens = chunks.reduce((total, chunk) => total + Buffer.byteLength(JSON.stringify(chunk)) + 1500, 0);
    if (estimatedInputTokens > LIMITS.inputTokens) throw failure("timeline-budget");
    const status = consent.status();
    const id = crypto.randomUUID();
    const entry = { owner, snapshot, options: { ...input.options, ...(input.options.contactEmails ? { contactEmails: [...input.options.contactEmails] } : {}) }, expires: now() + 300000, consentToken: status.token, closed };
    entry.optionsDigest = hash([snapshot.digest, entry.options, status.token]);
    manifests.set(id, entry);
    return { manifestToken: id, optionsDigest: entry.optionsDigest, expiresAt: entry.expires,
      accounts: snapshot.accounts.map(account => account.email), threads: snapshot.sourceThreads.length,
      coverage: snapshot.coverage, missingBodies: snapshot.missingBodies, invalidMetadata: snapshot.invalidMetadata, search: snapshot.search,
      chunks: chunks.length, estimatedInputTokens,
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
    shape(input, ["manifestToken", "optionsDigest", "acceptPartial"], ["manifestToken", "optionsDigest", "acceptPartial"]);
    if (typeof input.acceptPartial !== "boolean") throw failure("timeline-input");
    const entry = manifest(owner, token(input.manifestToken));
    if (input.optionsDigest !== entry.optionsDigest) throw failure("timeline-manifest");
    if (!entry.snapshot.sources.length || (entry.snapshot.coverage.omitted_message_count && !input.acceptPartial)) throw failure("timeline-partial");
    if (jobs.size) throw failure("timeline-busy");
    const controller = new AbortController();
    const lease = consent.acquire(config(), { signal: controller.signal, stamp: entry.consentToken, background: false });
    const jobId = crypto.randomUUID();
    const job = { owner, controller, accounts: entry.snapshot.accounts.map(account => account.id) };
    try { db.timeline.startJob(jobId, owner); }
    catch (error) { lease.release(); throw error; }
    jobs.set(jobId, job);
    manifests.delete(input.manifestToken);
    const send = value => { if (!entry.closed()) publish({ jobId, ...value }); };
    setImmediate(async () => {
      let state = "failed", calls = 0;
      const check = () => { controller.signal.throwIfAborted(); lease.check(); live(entry); };
      try {
        check();
        const result = await extract({ sources: entry.snapshot.sources, envelope: {
          $schema: "urn:morrow-mail:timeline:1.0.0", schema_version: "1.0.0", timeline_id: crypto.randomUUID(), source_namespace: db.timeline.namespace(),
          generator: { name: "Morrow Mail", version }, generated_at: new Date(now()).toISOString(), title: entry.options.title,
          display_timezone: entry.options.displayTimezone, time_basis: "mail_timestamp", coverage: entry.snapshot.coverage, source_threads: entry.snapshot.sourceThreads,
        }, language: entry.options.language, focus: { keywords: entry.options.keywords || "", contact_emails: entry.options.contactEmails || [] }, signal: lease.signal, check,
        complete: (messages, options) => complete(messages, { ...options, config: config(), background: false }),
        progress: value => { calls = value.calls; send(value); } });
        check();
        db.timeline.save(result.document, entry.snapshot.records, { digest: entry.snapshot.digest, promptVersion: PROMPT_VERSION, usage: result.usage });
        state = "completed";
        calls = result.usage.calls;
        send({ phase: state, timelineId: result.document.timeline_id, revision: 1, calls });
      } catch (error) {
        state = controller.signal.aborted || lease.signal.aborted ? "cancelled" : "failed";
        send({ phase: state, code: codes.has(error.code) ? error.code : state === "cancelled" ? "timeline-cancelled" : "timeline-failed" });
      } finally {
        jobs.delete(jobId);
        lease.release();
        try { db.timeline.finishJob(jobId, state, calls); } catch {}
      }
    });
    return { jobId };
  }
  async function invoke(owner, channel, input = {}, publish = () => {}, closed = () => false) {
    if (Buffer.byteLength(JSON.stringify(input)) > 128000) throw failure("timeline-input");
    if (channel === "timeline:prepare") return prepare(owner, input, closed);
    if (channel === "timeline:generate") return generate(owner, input, publish);
    if (channel === "timeline:download") {
      shape(input, ["manifestToken"], ["manifestToken"]);
      const entry = manifest(owner, token(input.manifestToken));
      for (const reference of entry.snapshot.omitted) {
        live(entry);
        await download(reference.messageId, reference.accountId);
        if (closed()) throw failure("timeline-cancelled");
        for (const account of entry.snapshot.accounts) if (stamp(account.id) !== account.stamp) throw failure("timeline-source-changed");
        const row = db.messageById(reference.messageId);
        if (!row || row.account_id !== reference.accountId) throw failure("timeline-source-changed");
        entry.snapshot.records.find(record => record.id === row.id).fingerprint = fingerprint(row);
      }
      const frozenSelection = { messages: entry.snapshot.records.map(row => ({ accountId: row.account_id, messageId: row.id })), expandThreads: false };
      return { ...prepare(owner, { selection: frozenSelection, options: entry.options }, closed), frozenSelection };
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
      if (!["json", "markdown", "pdf"].includes(input.format) || input.confirmed !== true || !Number.isSafeInteger(input.revision)) throw failure("timeline-input");
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
    .then(data => ({ success: true, data }), error => ({ success: false, error: { code: codes.has(error.code) ? error.code : "timeline-failed" } }));
}

module.exports = { CHANNELS, createService, trustedSender, answer, invalidateAccount: id => instance?.invalidateAccount(id) };
