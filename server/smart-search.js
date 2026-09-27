import { createHash, randomUUID } from 'node:crypto';
import { resolvePolicy } from './policy.js';
import { monthsAgo } from './history.js';
import { lexicalSearch, searchWhere, searchFail } from './search.js';

const defaults = { enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: '', protocol: 'openai', accounts: [], months: 3, tokenBudget: 16000,
  folders: { inbox: true, sent: true, archive: true, drafts: false, trash: false }, content: { subject: true, body: true, sender: false } };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Only locally constructed messages may reach persisted/public job errors.
// A model response (or an injected transport error) can contain private mail.
class EmbeddingError extends Error {
  constructor(message) { super(message); this.status = 502; }
}
const embeddingFail = message => { throw new EmbeddingError(message); };
function httpFailure(status) {
  const reason = status === 401 || status === 403 ? 'Check the API key and model access.'
    : status === 404 ? 'Check the base URL, model name and protocol.'
    : status === 413 ? 'The service rejected the input size. Check the embedding model input limits.'
    : status === 400 || status === 422 ? 'Check the embedding model, protocol and input limits.'
    : status === 429 ? 'The service reported a rate limit. Check its quota and retry explicitly later.'
    : status >= 500 ? 'The embedding service failed. Check that the model service is available.'
    : 'Check the embedding endpoint and model settings.';
  return `Embedding request rejected (HTTP ${status}). ${reason}`;
}
function unitVector(value) {
  if (!Array.isArray(value) || !value.length || value.length > 4096 || value.some(x => typeof x !== 'number' || !Number.isFinite(x))) embeddingFail('The embedding model returned an invalid vector.');
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm === 0) embeddingFail('The embedding model returned an empty vector.');
  return value.map(x => x / norm);
}
export async function fetchEmbeddings(config, input, signal) {
  const ollama = config.protocol === 'ollama';
  const response = await fetch(config.baseUrl.replace(/\/$/, '') + (ollama ? '/api/embed' : '/embeddings'), {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]),
    headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify({ model: config.model, input, ...(ollama ? { truncate: false } : { encoding_format: 'float' }) }),
  });
  if (!response.ok) { await response.body?.cancel(); embeddingFail(httpFailure(response.status)); }
  const chunks = []; let size = 0;
  for await (const part of response.body) { size += part.length; if (size > 8 * 1024 * 1024) embeddingFail('Embedding response exceeds 8 MiB.'); chunks.push(part); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks)); } catch { embeddingFail('Embedding response is not valid JSON.'); }
  if (ollama) return result?.embeddings;
  if (!Array.isArray(result?.data) || result.data.length !== input.length || new Set(result.data.map(item => item?.index)).size !== input.length || result.data.some(item => !Number.isInteger(item?.index) || item.index < 0 || item.index >= input.length)) embeddingFail('Embedding response does not match its inputs.');
  return result.data.sort((a, b) => a.index - b.index).map(item => item.embedding);
}
export function createSmartSearch({ store, connections, apiBase, embed = fetchEmbeddings, now = Date.now, lexical = (options, accounts, flags) => lexicalSearch(store, options, accounts, flags), cosine = null }) {
  const config = () => ({ ...defaults, ...store.getSettings().searchAI, folders: { ...defaults.folders, ...store.getSettings().searchAI?.folders }, content: { ...defaults.content, ...store.getSettings().searchAI?.content } });
  const stamp = () => digest([config(), resolvePolicy(store.getSettings().policy), config().accounts.map(account => [account, connections()[account]?.connectionId || connections()[account] || null])]);
  let controller, running, dimension = 0;
  const queryCache = new Map();
  const reconcile = () => { const value = config(), policy = resolvePolicy(store.getSettings().policy); store.search.clearVectors(value.enabled && policy.enabled ? stamp() : ''); };
  const source = (account, message, value = config(), policy = resolvePolicy(store.getSettings().policy), live = connections()) => {
    if (!value.enabled || !policy.enabled || !live[account] || !value.accounts.includes(account) || !message || !value.folders[message.folder] || !policy.folders[message.folder] || message.date < monthsAgo(value.months, now())) return null;
    const fields = [];
    if (value.content.sender && policy.content.sender) fields.push([message.fromName, message.fromEmail, message.to, message.cc, message.bcc].filter(Boolean).join(' '));
    if (value.content.subject && policy.content.subject) fields.push(message.subject || '');
    if (value.content.body && policy.content.body) fields.push(message.body || '');
    const text = fields.join('\n').trim();
    return text ? { hash: digest(text), text } : null;
  };
  const chunks = text => { const chars = [...text], result = []; for (let i = 0; i < chars.length; i += 920) { result.push(chars.slice(i, i + 1000).join('')); if (i + 1000 >= chars.length) break; } return result; };
  function inventory() {
    reconcile();
    const value = config(), policy = resolvePolicy(store.getSettings().policy), live = connections(), indexed = new Map(store.search.query('SELECT account,id,hash FROM search_vectors GROUP BY account,id').map(row => [JSON.stringify([row.account, row.id]), row.hash]));
    const pending = []; let eligible = 0, ready = 0;
    for (const account of value.accounts) if (live[account]) for (const message of store.listMessages(account)) {
      const item = source(account, message, value, policy, live); if (!item) continue; eligible++;
      if (indexed.get(JSON.stringify([account, message.id])) === item.hash) ready++;
      else pending.push({ account, id: message.id, ...item });
    }
    return { pending, eligible, ready };
  }
  function state() {
    const value = config(), { pending, eligible, ready } = inventory();
    return { settings: { ...value, apiKey: undefined, hasApiKey: !!value.apiKey }, eligible, indexed: ready, pending: pending.length,
      job: (() => { const job = store.getSettings().searchIndex; if (!job || job.stamp !== stamp()) return null; const { stamp: privateStamp, sources, ...safe } = job; return { ...safe, sampleCount: sources.length }; })(), permitted: resolvePolicy(store.getSettings().policy).enabled,
      local: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value.baseUrl).hostname) };
  }
  function settingsInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => ![...Object.keys(defaults), 'apiKey', 'clearApiKey'].includes(key))) searchFail('Invalid smart search settings.');
    const previous = config(), next = { ...previous, ...input };
    if (typeof next.baseUrl !== 'string' || next.baseUrl.length > 2048) searchFail('Enter an embedding base URL of at most 2048 characters.');
    next.baseUrl = apiBase(next.baseUrl);
    if (typeof next.enabled !== 'boolean' || typeof next.model !== 'string' || next.model.length > 200 || (next.enabled && !next.model.trim()) || !['openai', 'ollama'].includes(next.protocol) || ![1, 3, 6, 12].includes(next.months) || !Number.isInteger(next.tokenBudget) || next.tokenBudget < 4000 || next.tokenBudget > 64000) searchFail('Choose a model, a 1/3/6/12-month range and a 4,000–64,000 token budget.');
    if (!Array.isArray(next.accounts) || next.accounts.length > 100 || next.accounts.some(id => typeof id !== 'string' || (!Object.hasOwn(connections(), id) && !previous.accounts.includes(id)))) searchFail('Select connected accounts for smart search.');
    next.accounts = [...new Set(next.accounts)].filter(id => Object.hasOwn(connections(), id));
    for (const group of ['folders', 'content']) {
      if (!next[group] || typeof next[group] !== 'object' || Array.isArray(next[group]) || Object.keys(next[group]).some(key => !Object.hasOwn(defaults[group], key) || typeof next[group][key] !== 'boolean')) searchFail('Use valid scope checkboxes.');
      next[group] = { ...defaults[group], ...next[group] };
    }
    if (next.enabled && (!next.accounts.length || !Object.values(next.folders).some(Boolean) || !Object.values(next.content).some(Boolean))) searchFail('Select at least one account, folder and content field.');
    if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') searchFail('Invalid clear-key option.');
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey))) searchFail('Invalid embedding API key.');
    next.apiKey = input.clearApiKey ? '' : input.apiKey || (previous.baseUrl === next.baseUrl ? previous.apiKey || '' : '');
    delete next.clearApiKey;
    return next;
  }
  function update(input) {
    const next = settingsInput(input);
    controller?.abort(); queryCache.clear(); dimension = 0;
    store.setSettings({ searchAI: next, searchIndex: null }); reconcile();
  }
  let testing = false;
  async function testConnection(input) {
    if (testing) searchFail('An embedding connection test is already running.', 409);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['baseUrl', 'model', 'protocol', 'apiKey', 'clearApiKey'].includes(key))) searchFail('Invalid embedding test settings.');
    // Connection checks do not depend on indexing scope or send any mail text.
    const value = settingsInput({ ...input, enabled: false });
    if (!value.model.trim()) searchFail('Choose an embedding model first.');
    testing = true;
    try {
      const result = await vectors(['Morrow Mail embedding connection test.'], value);
      return { ok: true, dimensions: result[0].length };
    } finally { testing = false; }
  }
  function preview() {
    if (running) searchFail('Wait for the current indexing batch.', 409);
    const value = config(), policy = resolvePolicy(store.getSettings().policy);
    if (!value.enabled || !policy.enabled) searchFail('Enable smart search and AI access first.', 403);
    const { pending, eligible, ready } = inventory(), sources = []; let estimatedTokens = 0, pieces = 0, oversized = 0;
    for (const item of pending) {
      const parts = chunks(item.text), estimate = parts.reduce((sum, text) => sum + Buffer.byteLength(text) + 128, 0);
      if (estimate > value.tokenBudget || parts.length > 50) { oversized++; continue; }
      if (sources.length >= policy.maxMessages || pieces + parts.length > 50 || estimatedTokens + estimate > value.tokenBudget) continue;
      sources.push({ account: item.account, id: item.id, hash: item.hash }); estimatedTokens += estimate; pieces += parts.length;
    }
    if (!sources.length) searchFail(oversized ? 'Remaining messages exceed this batch budget or 50 chunks per message. Keyword search still covers them; increase the budget where possible.' : 'No new permitted mail needs indexing. Check the selected scope and global AI permissions.', 409);
    const job = { id: randomUUID(), stamp: stamp(), status: 'prepared', sources, estimatedTokens, chunks: pieces, completed: 0, eligible, indexed: ready, oversized, createdAt: new Date(now()).toISOString() };
    store.setSettings({ searchIndex: job });
    return { ...state(), samples: sources.slice(0, 3).map(item => ({ account: item.account, text: source(item.account, store.getMessage(item.account, item.id)).text.slice(0, 1500) })) };
  }
  async function vectors(texts, value, signal) {
    let result;
    try { result = await embed(value, texts, signal); } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      embeddingFail('Embedding request failed or was cancelled. Check the connection and model service.');
    }
    if (!Array.isArray(result) || result.length !== texts.length) embeddingFail('Embedding response does not match its inputs.');
    const normalized = result.map(unitVector);
    if (normalized.some(vector => vector.length !== normalized[0].length)) embeddingFail('The model changed embedding dimensions.');
    return normalized;
  }
  async function index(id) {
    const job = store.getSettings().searchIndex;
    if (!job || job.id !== id || job.status !== 'prepared' || job.stamp !== stamp()) searchFail('Preview expired. Prepare a fresh indexing preview.', 409);
    store.setSettings({ searchIndex: { ...job, status: 'running' } });
    controller = new AbortController(); const signal = controller.signal, value = config();
    try {
      for (const item of job.sources) {
        const current = source(item.account, store.getMessage(item.account, item.id), value);
        if (signal.aborted || job.stamp !== stamp() || current?.hash !== item.hash) searchFail('Index scope or source changed.', 409);
        const parts = chunks(current.text), output = [];
        for (let i = 0; i < parts.length; i += 16) {
          if (signal.aborted || job.stamp !== stamp() || source(item.account, store.getMessage(item.account, item.id), value)?.hash !== item.hash) searchFail('Index scope or source changed.', 409);
          output.push(...await vectors(parts.slice(i, i + 16), value, signal));
        }
        if (signal.aborted || job.stamp !== stamp() || source(item.account, store.getMessage(item.account, item.id), value)?.hash !== item.hash) searchFail('Index scope or source changed.', 409);
        dimension ||= output[0].length;
        if (output.some(vector => vector.length !== dimension)) embeddingFail('Embedding dimensions changed. Clear the index and rebuild.');
        store.transaction(() => { store.search.saveVectors(item.account, item.id, job.stamp, item.hash, output); job.completed++; store.setSettings({ searchIndex: { ...job, status: 'running' } }); });
      }
      store.setSettings({ searchIndex: { ...job, status: 'complete' } });
    } catch (error) {
      const reason = error instanceof EmbeddingError ? error.message : 'Indexing stopped or its scope changed.';
      if (store.getSettings().searchIndex?.id === id) store.setSettings({ searchIndex: { ...job, status: 'failed', error: `${reason} Completed valid entries are retained. Tokens may have been used; preview a new batch to retry.` } });
    } finally { controller = undefined; reconcile(); }
  }
  async function search(options, accounts) {
    reconcile(); const value = config(), identity = stamp(), policy = resolvePolicy(store.getSettings().policy), live = connections();
    if (!value.enabled || !policy.enabled) searchFail('Smart search is disabled. Use keyword search or enable it in Settings.', 403);
    const permitted = accounts.filter(id => value.accounts.includes(id) && connections()[id]);
    const where = searchWhere(options, permitted);
    // ponytail: exact cosine scan of at most 12,000 scoped chunks. Add ANN only
    // when measured mailbox sizes need it; never silently omit a larger scope.
    const readEntries = () => store.search.query(`SELECT v.*,m.data FROM search_vectors v JOIN search_documents d ON d.account=v.account AND d.id=v.id JOIN messages m ON m.account=d.account AND m.id=d.id WHERE v.stamp=? AND ${where.clause} LIMIT 12001`, [identity, ...where.params]);
    const entries = readEntries(), snapshot = digest(entries);
    if (entries.length > 12000) searchFail('Narrow the account, date or folder filters to search fewer than 12,000 indexed chunks.', 409);
    const messages = new Map();
    const valid = entries.filter(row => {
      const key = JSON.stringify([row.account, row.id]);
      if (!messages.has(key)) { const message = JSON.parse(row.data); messages.set(key, { message, hash: source(row.account, message, value, policy, live)?.hash }); }
      return messages.get(key).hash === row.hash;
    });
    if (!valid.length) { const result = await lexical(options, accounts); return { ...result, warning: 'No current semantic index matches this scope. Showing keyword matches; index permitted mail in Settings → Search.' }; }
    const query = options.terms.join(' '), key = digest([identity, query]);
    let cached = queryCache.get(key);
    if (!cached || cached.until < now()) {
      if (options.cachedOnly) searchFail('Press Search again to refresh semantic results; the query cache expired.', 409);
      const [vector] = await vectors([query], value);
      cached = { vector, until: now() + 300000 }; queryCache.set(key, cached);
      if (queryCache.size > 20) queryCache.delete(queryCache.keys().next().value);
    }
    if (identity !== stamp()) { reconcile(); searchFail('AI permissions, model or accounts changed. Search again.', 409); }
    if (snapshot !== digest(readEntries())) searchFail('Mail changed during search. Search again for current results.', 409);
    let scores = null;
    if (cosine) { try { scores = await cosine(cached.vector, valid); } catch { /* Pure local read: retain the Node fallback, never regenerate embeddings. */ } }
    const semantic = new Map();
    for (const [index, row] of valid.entries()) {
      const vector = JSON.parse(row.vector);
      if (vector.length !== cached.vector.length) searchFail('Embedding dimensions changed. Clear the index and rebuild with one model.', 409);
      const score = scores ? scores[index] : vector.reduce((sum, x, i) => sum + x * cached.vector[i], 0), id = JSON.stringify([row.account, row.id]);
      if (score > 0 && (!semantic.has(id) || semantic.get(id).score < score)) semantic.set(id, { message: messages.get(id).message, account: row.account, score });
    }
    const keywords = await lexical({ ...options, sort: 'relevance' }, accounts, { candidates: true }), merged = new Map();
    if (identity !== stamp() || snapshot !== digest(readEntries())) searchFail('Search scope or source changed. Search again.', 409);
    const add = (row, i, match) => { const key = JSON.stringify([row.account, row.message.id]), previous = merged.get(key); merged.set(key, { ...row, score: (previous?.score || 0) + 1 / (60 + i + 1), match: previous ? 'keyword + semantic' : match }); };
    keywords.rows.forEach((row, i) => add(row, i, 'keyword'));
    [...semantic.values()].sort((a, b) => b.score - a.score).slice(0, 200).forEach((row, i) => add(row, i, 'semantic'));
    const ranked = [...merged.values()].sort((a, b) => (options.sort === 'relevance' ? b.score - a.score : options.sort === 'oldest' ? a.message.date.localeCompare(b.message.date) : b.message.date.localeCompare(a.message.date)) || JSON.stringify([a.account, a.message.id]).localeCompare(JSON.stringify([b.account, b.message.id])));
    return { engine: cosine && scores && keywords.engine === 'rust' ? 'rust' : 'node', total: ranked.length, rows: ranked.slice(options.page * 30, options.page * 30 + 30), warning: 'Ranked candidates: up to 200 keyword and 200 semantic matches. Semantic coverage is limited to your approved, indexed mail; use keyword mode for exhaustive results.' };
  }
  const previous = store.getSettings().searchIndex;
  if (previous?.status === 'running') store.setSettings({ searchIndex: { ...previous, status: 'interrupted', error: 'Indexing was interrupted. No automatic retry was made; preview another batch.' } });
  return { state, update, testConnection, preview, index, search,
    start(id) { if (running) searchFail('An indexing batch is already running.', 409); const job = store.getSettings().searchIndex; if (!job || job.id !== id || job.status !== 'prepared' || job.stamp !== stamp()) searchFail('Prepare a fresh indexing preview.', 409); running = index(id).finally(() => { running = null; }); },
    clear() { controller?.abort(); queryCache.clear(); dimension = 0; store.search.clearVectors(); store.setSettings({ searchIndex: null }); },
    stop() { controller?.abort(); return running || Promise.resolve(); }, reconcile,
  };
}
