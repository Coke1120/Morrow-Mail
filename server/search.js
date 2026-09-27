import { createRustSearch } from './rust-search.js';
import { messageSummary } from './mail-pages.js';
import { normalizeSearch, searchTokens } from './search-index.js';
import { createSmartSearch } from './smart-search.js';

export const searchFail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const fields = ['from', 'to', 'subject', 'after', 'before', 'is', 'label', 'in'];
const folders = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash', 'starred', 'pending'];
export function parseSearch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) searchFail('Enter valid search options.');
  const { query = '', scope = 'folder', folder = 'inbox', sort = 'relevance', page = 0, filters = {}, smart = false, cachedOnly = false } = input;
  if (typeof cachedOnly !== 'boolean') searchFail('Invalid search cache option.');
  if (typeof query !== 'string' || query.length > 500 || !['folder', 'account', 'all'].includes(scope) || !folders.includes(folder) || !['relevance', 'newest', 'oldest'].includes(sort) || !Number.isInteger(page) || page < 0 || page > 2000 || typeof smart !== 'boolean') searchFail('Invalid search query, scope, sorting or page.');
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(key => !fields.includes(key))) searchFail('Unknown search filter.');
  const terms = [], conditions = [], chips = [];
  const add = (key, value) => {
    if (typeof value !== 'string' || value.length > 254) searchFail('Search filter values must be text of at most 254 characters.');
    if (!value.trim()) return;
    if (['after', 'before'].includes(key) && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) searchFail('Use a valid date: YYYY-MM-DD.');
    if (key === 'is' && !['read', 'unread', 'starred', 'pending'].includes(value)) searchFail('Use is:read, is:unread, is:starred or is:pending.');
    if (key === 'in' && !folders.includes(value)) searchFail('Choose a valid mailbox folder.');
    conditions.push({ key, value: normalizeSearch(value) });
  };
  const pattern = /(?:([a-z]+):)?("[^"]*"|[^\s"]+)/gi;
  let end = 0;
  for (const match of query.matchAll(pattern)) {
    if (query.slice(end, match.index).trim()) searchFail('Close the quotation marks in your search.');
    end = match.index + match[0].length;
    const key = match[1]?.toLowerCase(), value = match[2].startsWith('"') ? match[2].slice(1, -1) : match[2];
    if (key) {
      if (!fields.includes(key)) searchFail(`Unknown search operator: ${key}.`);
      if (!value.trim()) searchFail(`Enter a value after ${key}:`);
      add(key, value);
      chips.push({ label: match[0], query: (query.slice(0, match.index) + query.slice(end)).trim() });
    } else if (/^[a-z]+:$/i.test(value)) searchFail('Enter a value after the search operator.');
    else if (value.trim()) terms.push(normalizeSearch(value));
  }
  if (query.slice(end).trim()) searchFail('Close the quotation marks in your search.');
  for (const [key, value] of Object.entries(filters)) add(key, value);
  if (terms.length + conditions.length > 24) searchFail('Use at most 24 search terms and filters.');
  return { query: query.trim(), terms, conditions, chips, filters, scope, folder, sort, page, smart, cachedOnly };
}
export function searchWhere(options, accounts) {
  const clauses = [`d.account IN (${accounts.map(() => '?').join(',') || 'NULL'})`], params = [...accounts];
  const folder = value => {
    if (value === 'starred') clauses.push("d.starred=1 AND d.folder NOT IN ('trash','spam')");
    else if (value === 'pending') clauses.push("json_extract(m.data,'$.pending')=1 AND d.folder NOT IN ('trash','spam')");
    else { clauses.push('d.folder=?'); params.push(value); }
  };
  if (options.scope === 'folder') folder(options.folder);
  else if (!options.conditions.some(item => item.key === 'in' && ['trash', 'spam'].includes(item.value))) clauses.push("d.folder NOT IN ('trash','spam')");
  for (const { key, value } of options.conditions) {
    if (key === 'in') folder(value);
    else if (key === 'is') clauses.push(value === 'pending' ? "json_extract(m.data,'$.pending')=1" : value === 'starred' ? 'd.starred=1' : `d.unread=${value === 'unread' ? 1 : 0}`);
    else if (key === 'after' || key === 'before') { clauses.push(`d.date${key === 'after' ? '>=' : '<'}?`); params.push(value + 'T00:00:00.000Z'); }
    else if (key === 'label') { clauses.push("EXISTS(SELECT 1 FROM json_each(json_extract(m.data,'$.labels')) WHERE mail_normalize(value)=?)"); params.push(value); }
    else { clauses.push(`instr(d.${{ from: 'sender', to: 'recipients', subject: 'subject' }[key]},?)>0`); params.push(value); }
  }
  return { clause: clauses.join(' AND '), params };
}
export function lexicalSearch(store, options, accounts, { candidates = false } = {}) {
  const where = searchWhere(options, accounts), params = [...where.params];
  const tokens = [...new Set(options.terms.flatMap(term => searchTokens(term).split(' ').filter(Boolean)))];
  let from = 'search_documents d JOIN messages m ON m.account=d.account AND m.id=d.id', clause = where.clause, rank = '0';
  if (tokens.length) {
    from += ' JOIN search_fts ON search_fts.rowid=d.rowid';
    clause += ' AND search_fts MATCH ?'; params.push(tokens.map(token => `"${token.replaceAll('"', '""')}"*`).join(' AND '));
    rank = 'bm25(search_fts,6,4,3,1,2)';
  }
  for (const term of options.terms) { clause += " AND (instr(d.subject,?)>0 OR instr(d.sender,?)>0 OR instr(d.recipients,?)>0 OR instr(d.body,?)>0 OR instr(d.labels,?)>0)"; params.push(term, term, term, term, term); }
  const order = options.sort === 'oldest' ? 'd.date ASC' : options.sort === 'newest' || !tokens.length ? 'd.date DESC' : `${rank},d.date DESC`;
  const total = Number(store.search.query(`SELECT count(*) AS n FROM ${from} WHERE ${clause}`, params)[0].n);
  const rows = store.search.query(`SELECT m.data,d.account,${rank} AS rank FROM ${from} WHERE ${clause} ORDER BY ${order},d.account,d.id LIMIT ? OFFSET ?`, [...params, candidates ? 200 : 30, candidates ? 0 : options.page * 30]);
  return { total, rows: rows.map(row => ({ message: JSON.parse(row.data), account: row.account, match: 'keyword' })) };
}
// Return text segments, never provider-supplied HTML. Both clients render them as text.
export function searchSegments(value, terms, limit = 180) {
  const chars = [...String(value || '').replace(/\s+/g, ' ')];
  const folded = chars.map(char => /\s/u.test(char) ? ' ' : normalizeSearch(char));
  const normalized = folded.join(''), needles = terms.filter(Boolean), offsets = [];
  let position = 0; folded.forEach((part, index) => { for (let j = 0; j < part.length; j++) offsets[position++] = index; });
  const hits = new Set();
  for (const needle of needles) { let at = normalized.indexOf(needle); while (at >= 0) { for (let i = at; i < at + needle.length; i++) if (offsets[i] !== undefined) hits.add(offsets[i]); at = normalized.indexOf(needle, at + Math.max(1, needle.length)); } }
  const first = hits.size ? [...hits].reduce((a, b) => Math.min(a, b)) : 0, start = Math.max(0, first - 45), end = Math.min(chars.length, start + limit), segments = [];
  if (start) segments.push({ text: '…', hit: false });
  for (let i = start; i < end; i++) { const hit = hits.has(i), last = segments.at(-1); if (last?.hit === hit) last.text += chars[i]; else segments.push({ text: chars[i], hit }); }
  if (end < chars.length) segments.push({ text: '…', hit: false });
  return segments;
}
export function registerSearchRoutes({ app, store, connections, apiBase, embed, searchEngine = 'node' }) {
  if (!['node', 'rust'].includes(searchEngine)) throw Error('Unknown development search engine.');
  const worker = searchEngine === 'rust' ? createRustSearch(store.databasePath) : null;
  async function lexical(options, accounts, flags = {}) {
    if (!worker) return lexicalSearch(store, options, accounts, flags);
    const revision = store.revision();
    try {
      const result = await worker.lexical(options, accounts, !!flags.candidates);
      if (revision !== store.revision() || !Number.isSafeInteger(result.total) || result.total < 0 || !Array.isArray(result.rows) || result.rows.length > (flags.candidates ? 200 : 30)) throw Error('Stale or invalid search result.');
      const seen = new Set();
      const rows = result.rows.map(row => {
        const key = JSON.stringify([row.account, row.id]);
        if (!accounts.includes(row.account) || typeof row.id !== 'string' || seen.has(key)) throw Error('Invalid result owner.');
        seen.add(key); const message = store.getMessage(row.account, row.id);
        if (!message) throw Error('Source message changed.');
        return { account: row.account, message, match: 'keyword' };
      });
      return { total: result.total, rows, engine: 'rust' };
    } catch { return { ...lexicalSearch(store, options, accounts, flags), engine: 'node', warning: 'Using Node keyword search; the Rust development worker could not handle this query.' }; }
  }
  const smartSearch = createSmartSearch({ store, connections, apiBase, embed, lexical, cosine: worker ? (query, rows) => worker.cosine(query, rows) : null });
  const stop = smartSearch.stop;
  smartSearch.stop = () => Promise.all([worker?.stop(), stop()]);
  smartSearch.worker = worker;
  const owner = req => { const value = req.get('X-Genmail-Account'); if (!value || (value !== 'all' && value !== 'demo' && !Object.hasOwn(connections(), value))) searchFail('Choose a connected search account.', 409); return value; };
  const accountsFor = (account, options) => options.scope === 'all' || account === 'all' ? Object.keys(connections()) : [account];
  app.post('/api/search', async (req, res) => {
    const account = owner(req), options = parseSearch(req.body), accounts = accountsFor(account, options);
    let result = options.smart && options.terms.length ? await smartSearch.search(options, accounts) : await lexical(options, accounts);
    // Account disconnection during a model request cannot expose its old results.
    if (accounts.some(id => id !== 'demo' && !connections()[id])) searchFail('Search accounts changed. Search again.', 409);
    const coverage = store.search.query(`SELECT account,count(*) AS count,min(date) AS oldest,max(date) AS newest FROM search_documents WHERE account IN (${accounts.map(() => '?').join(',') || 'NULL'}) GROUP BY account`, accounts);
    const rows = result.rows.map(({ message, account: id, match }) => ({ ...(req.get('X-Morrow-View') === 'paged' ? messageSummary(message) : message), accountId: id, viewId: JSON.stringify([id, message.id]), searchMatch: match,
      searchSubject: searchSegments(message.subject, options.terms, 140), searchSnippet: searchSegments(message.body || message.preview, options.terms) }));
    res.json({ messages: rows, total: result.total, page: options.page, pageSize: 30, chips: options.chips, coverage, warning: result.warning || '', mode: options.smart ? 'hybrid' : 'keyword', engine: result.engine || 'node' });
  });
  app.get('/api/search/preferences', (req, res) => { const account = owner(req); res.json(store.getSettings().searchHistory?.[account] || { recent: [], saved: [] }); });
  app.post('/api/search/preferences', (req, res) => {
    const account = owner(req), { action, value } = req.body || {}, previous = store.getSettings().searchHistory?.[account] || { recent: [], saved: [] };
    if (!['recent', 'save', 'remove', 'clear'].includes(action)) searchFail('Unknown search history action.');
    let next = { ...previous };
    if (action === 'clear') next.recent = [];
    else {
      const options = parseSearch(value), entry = { query: options.query, scope: options.scope, filters: options.filters, folder: options.folder, sort: options.sort, smart: options.smart };
      const key = JSON.stringify(entry), field = action === 'recent' ? 'recent' : 'saved';
      next[field] = previous[field].filter(item => JSON.stringify(item) !== key);
      if (action !== 'remove') next[field] = [entry, ...next[field]].slice(0, action === 'recent' ? 10 : 20);
    }
    store.setSettings({ searchHistory: { ...store.getSettings().searchHistory, [account]: next } }); res.json(next);
  });
  app.get('/api/search/settings', (_req, res) => res.json(smartSearch.state()));
  app.post('/api/search/settings', (req, res) => { smartSearch.update(req.body); res.json(smartSearch.state()); });
  app.post('/api/search/test', async (req, res) => res.json(await smartSearch.testConnection(req.body)));
  app.post('/api/search/index/preview', (_req, res) => res.json(smartSearch.preview()));
  app.post('/api/search/index/run', (req, res) => { smartSearch.start(req.body?.previewId); res.status(202).json(smartSearch.state()); });
  app.post('/api/search/index/clear', (_req, res) => { smartSearch.clear(); res.json(smartSearch.state()); });
  return smartSearch;
}
