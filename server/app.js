import addressParser from 'nodemailer/lib/addressparser/index.js';
import { createOutOfOffice, capability as outOfOfficeCapability } from './out-of-office.js';
import { createReplySuggestions, registerReplySuggestionRoutes } from './reply-suggestions.js';
import { createScheduled } from './scheduled.js';
import { createHistory, importOptions } from './history.js';
import { createLearning } from './learning.js';
import { createActivity } from './activity.js';
import { registerSearchRoutes } from './search.js';
import { bundledGoogleOAuth, oauthCredentials } from './oauth-client.js';
import express from 'express';
import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as integrations from './integrations.js';
import * as providers from './providers.js';
import { normalizeFooter, preferencesFooter } from './footer.js';
import { recipients } from './recipients.js';
import { prepareDraft } from './message-draft.js';
import { AI_BEHAVIORS, DEFAULT_PREFERENCES, DEFAULT_SKILLS, matchesAITrigger } from '../shared/features.js';
import { checkUpdates } from './updates.js';
import { createAutomation } from './automation.js';
import { prioritySummary } from './summaries.js';
import { resolvePolicy, updatePolicy, updatePreferences, requireBehavior, permittedMessages, redactMessage } from './policy.js';
import { createWorkflowPlan } from './workflows.js';
import { registerCalendarRoutes, calendarState } from './calendar-routes.js';

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function text(value, name, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(`${name} is required and must be at most ${max} characters.`);
  return value;
}
function email(value) {
  const result = text(value, 'Email address', 254).trim();
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(result)) fail('Enter one valid email address.');
  return result;
}
function hostname(value, name) {
  const host = text(value, name, 253).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) fail(`${name} must be a hostname without a URL or port.`);
  return host;
}
function portNumber(value, fallback) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) fail('Enter a valid port number.');
  return number;
}
function apiBase(value) {
  let url;
  try { url = new URL(value); } catch { fail('Enter a valid AI API base URL.'); }
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) fail('Use an HTTP(S) base URL without credentials, query, or fragment.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail('Remote AI providers must use HTTPS. Local models may use HTTP on localhost.');
  return url.href.replace(/\/$/, '');
}
function isLoopbackHost(value) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(`http://${value}`).hostname); } catch { return false; }
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

const fingerprint = message => createHash('sha256').update(JSON.stringify({ to: message.to, subject: message.subject, body: message.body, replyToId: message.replyToId || '', ...(message.cc ? { cc: message.cc } : {}), ...(message.bcc ? { bcc: message.bcc } : {}), ...(message.footer?.text || message.footer?.html ? { footer: message.footer } : {}) })).digest('hex');

export function createApp({ store, port = 3001, appUrl = `http://localhost:${port}`, services = {}, nativeToken = '', googleOAuth = bundledGoogleOAuth(), updater = null, updateToken = '', searchEngine = nativeToken ? 'node' : process.env.MORROW_SEARCH_ENGINE || 'node' }) {
  let uiUrl;
  try { uiUrl = new URL(appUrl); } catch { throw new Error('APP_URL must be a localhost HTTP origin.'); }
  if (uiUrl.protocol !== 'http:' || !isLoopbackHost(uiUrl.host) || uiUrl.origin !== appUrl || uiUrl.username || uiUrl.password) throw new Error('APP_URL must be a localhost HTTP origin without a path.');
  const api = { ...integrations, ...providers, checkUpdates, ...services };
  const app = express();
  const trustedOrigins = new Set([appUrl, `http://localhost:${port}`, `http://127.0.0.1:${port}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
  const oauthPending = new Map();
  const sending = new Map();
  const sendingDrafts = new Set();
  const previews = new Map();
  const updateChecks = new Map();
  const automaticAI = new Map();
  // In-flight history replies must not survive revoke/restore within one process.
  let historyRevision = 0;
  let mailboxBusy = false;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
    if (!isLoopbackHost(req.headers.host)) return res.status(403).json({ error: 'Morrow Mail accepts localhost requests only.' });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const callback = req.method === 'GET' && /^\/(?:oauth|calendar-oauth)\/(google|microsoft)\/(callback|authorize)\/?$/i.test(req.path);
    if (nativeToken && !callback && !safeEqual(req.get('Authorization'), `Bearer ${nativeToken}`)) return res.status(401).json({ error: 'Open Morrow Mail to access this workspace.' });
    if (!callback && ((req.headers.origin && !trustedOrigins.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site')) return res.status(403).json({ error: 'This request did not come from Morrow Mail.' });
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'Use application/json.' });
    next();
  });
  app.use(express.json({ limit: '256kb' }));

  function settings() { return store.getSettings(); }
  // Legacy single-mailbox settings are read until the next connection change.
  function connections(config = settings()) { return config.mailAccounts ?? (config.mail?.email ? { [config.mail.email]: config.mail } : {}); }
  function validAccount(account) { return account === 'demo' || Object.hasOwn(connections(), account || ''); }
  function activeAccount() {
    const selected = settings().activeAccount;
    return selected === 'all' || validAccount(selected) ? selected : 'demo';
  }
  function saveConnection(mail, select = false) {
    if (select) { mail = { ...mail, connectionId: randomUUID() }; historyRevision++; }
    const config = settings();
    store.setSettings({ mailAccounts: { ...connections(config), [mail.email]: mail },
      ...(select || config.mail?.email === mail.email ? { mail } : {}), ...(select ? { activeAccount: mail.email, aiGeneration: (config.aiGeneration || 0) + 1 } : {}) });
  }
  function canonicalAddress(address) { return Object.keys(connections()).find(key => key.toLowerCase() === address.toLowerCase()) || address; }
  function ownedMessage(account, message) { return message && { ...message, accountId: account, viewId: JSON.stringify([account, message.id]) }; }
  app.use('/api', (req, res, next) => {
    const routePath = req.path.toLowerCase().replace(/\/+$/, '');
    const supplied = req.get('X-Genmail-Account');
    const bound = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && /^\/(send|drafts(?:\/prepare)?|ai|sync|messages\/[^/]+(?:\/organize)?|workflows\/.*|imports\/.*|style\/.*|skills(?:\/.*)?|workspace\/.*|scheduled(?:\/.*)?|reply-suggestions(?:\/.*)?|out-of-office(?:\/.*)?|account\/disconnect)$/.test(routePath);
    if (bound && !validAccount(supplied) && !(routePath === '/sync' && supplied === 'all')) {
      return res.status(409).json({ error: 'Choose a connected mailbox before continuing. This account may have been disconnected.' });
    }
    req.mailAccount = validAccount(supplied) || supplied === 'all' ? supplied : activeAccount();
    next();
  });
  function workspace(account = activeAccount()) {
    return { activity: [], reminders: [], events: [], unsubscribed: [], brain: null, skills: structuredClone(DEFAULT_SKILLS), ...settings().workspaces?.[account] };
  }
  function saveWorkspace(account, partial) {
    const previous = settings().workspaces || {};
    store.setSettings({ workspaces: { ...previous, [account]: { ...workspace(account), ...partial } } });
  }
  function safeMail(mail = {}) {
    return { configured: !!mail.email, provider: mail.provider || 'imap', email: mail.email || '', imapHost: mail.imapHost || '', imapPort: mail.imapPort || 993, smtpHost: mail.smtpHost || '', smtpPort: mail.smtpPort || 465, clientId: mail.clientId || '', canOrganize: providers.canOrganizeMail(mail) };
  }
  function state(selected = activeAccount(), req) {
    smartSearch.reconcile();
    const config = settings(), accounts = connections(config);
    const view = selected === 'all' || validAccount(selected) ? selected : activeAccount();
    const live = view !== 'all' && view !== 'demo';
    const mail = accounts[view] || config.mail || {};
    const ai = config.ai || {};
    const preferences = { ...DEFAULT_PREFERENCES, ...config.preferences };
    const reportCache = new Map();
    const reports = account => { if (!reportCache.has(account)) reportCache.set(account, automation.reports(account)); return reportCache.get(account); };
    const rows = account => {
      const summaries = reports(account).filter(report => report.kind === 'arrival' && report.status === 'completed');
      return store.listMessages(account).map(message => ownedMessage(account, { ...message, aiSummary: summaries.find(report => report.messageIds.includes(message.id)) || null }));
    };
    const stats = store.messageStats([...Object.keys(accounts), 'demo']);
    const metadata = Object.values(accounts).map(connection => ({
      id: connection.email, email: connection.email, mode: 'live', provider: connection.provider || 'imap', name: connection.email.split('@')[0],
      ...stats[connection.email], settings: safeMail(connection), import: history.status(connection.email),
    }));
    const page = req?.get('X-Morrow-View') === 'paged' ? store.messagePage(view === 'all' ? Object.keys(accounts) : [view]) : null;
    return {
      features: AI_BEHAVIORS,
      account: { id: view, email: live ? view : view === 'all' ? '' : 'alex@genmail.example', name: view === 'all' ? 'All accounts' : preferences.displayName || (live ? view.split('@')[0] : 'Alex Morgan'), mode: view === 'all' ? 'combined' : live ? 'live' : 'demo', provider: live ? mail.provider || 'imap' : view },
      accounts: metadata,
      syncErrors: config.backgroundSyncErrors || [],
      revision: store.revision(), demoStats: stats.demo, mailPage: page ? { ...page, messages: undefined } : undefined,
      messages: page ? page.messages : view === 'all' ? Object.keys(accounts).flatMap(rows).sort((a, b) => b.date.localeCompare(a.date) || a.viewId.localeCompare(b.viewId)) : rows(view),
      settings: {
        oauthClients: { google: { configured: !!googleOAuth }, microsoft: { configured: true } },
        mail: safeMail(mail),
        ai: { configured: !!(ai.baseUrl && ai.model), baseUrl: ai.baseUrl || 'http://127.0.0.1:11434/v1', model: ai.model || '', hasApiKey: !!ai.apiKey, temperature: ai.temperature ?? 0.3, maxTokens: ai.maxTokens ?? 1200 },
        policy: resolvePolicy(config.policy), preferences, footer: preferencesFooter(preferences), calendars: calendarState(config),
      },
      workspace: { ...workspace(view), styleLearning: learning.state(view), summaries: reports(view), summaryOverflow: automation.overflow(view) },
    };
  }
  function getMessage(account, id) {
    const message = typeof id === 'string' && store.getMessage(account, id);
    if (!message) fail('Message not found.', 404);
    return message;
  }
  // ponytail: one mailbox operation at a time; per-account locks if concurrent sync throughput matters.
  async function mailboxOperation(work) {
    if (mailboxBusy) fail('Another mailbox operation is running. Try again when it finishes.', 409);
    mailboxBusy = true;
    try { return await work(); } finally { mailboxBusy = false; }
  }
  function googleImportState(message, existing) {
    const fields = ['folder', 'read', 'starred', 'labels'];
    const snapshot = Object.fromEntries(fields.map(key => [key, message[key]]));
    const overrides = { ...(existing?.localOverrides || {}) };
    const previous = existing?.providerSnapshot;
    const raw = existing?.providerLabelIds;
    if (existing) {
      for (const key of fields) {
        let local = false;
        if (previous && Object.hasOwn(previous, key)) local = JSON.stringify(existing[key]) !== JSON.stringify(previous[key]);
        else if (key === 'labels') local = Array.isArray(existing.labels) && existing.labels.length > 0;
        else if (Array.isArray(raw)) {
          const before = key === 'folder' ? providers.googleFolder(raw) : key === 'read' ? !raw.includes('UNREAD') : raw.includes('STARRED');
          local = Object.hasOwn(existing, key) && existing[key] !== before && (key !== 'folder' || ['archive', 'trash'].includes(existing.folder));
        } else if (key === 'folder') local = ['archive', 'trash'].includes(existing.folder);
        if (local) overrides[key] = true;
      }
    }
    return { ...snapshot, providerSnapshot: snapshot, localOverrides: overrides,
      ...Object.fromEntries(['providerLabelIds', 'providerSent', 'providerDraft'].filter(key => Object.hasOwn(message, key)).map(key => [key, message[key]])),
      ...Object.fromEntries(fields.filter(key => overrides[key] === true && existing && Object.hasOwn(existing, key)).map(key => [key, existing[key]])) };
  }
  function importMessages(mail, messages) {
    const remoteKey = item => mail.provider === 'imap' ? JSON.stringify([item.providerFolderId || 'INBOX', item.remoteId || item.id]) : item.remoteId || item.id;
    const cached = store.listMessages(mail.email);
    const imported = new Map(cached.map(item => [remoteKey(item), item]));
    const localSent = new Map(cached.filter(item => item.id.startsWith('sent:') && !item.remoteId && item.messageId).map(item => [item.messageId, item]));
    const newIDs = [];
    store.transaction(() => { for (const message of messages) {
      const existing = imported.get(remoteKey(message)) || ((message.folder === 'sent' || (mail.provider === 'google' && message.providerSent === true)) && message.fromEmail?.toLowerCase() === mail.email.toLowerCase() && localSent.get(message.messageId));
      if (!existing && !store.getMessage(mail.email, message.id)) newIDs.push(message.id);
      // Keep the original delivery fingerprint on locally sent records when attaching the provider copy.
      const saved = store.upsertMessage(mail.email, { ...(existing?.id?.startsWith('sent:') ? { ...message, ...existing } : message), ...(existing ? { id: existing.id, remoteId: existing.remoteId || message.remoteId || message.id, providerFolderId: existing.providerFolderId || message.providerFolderId, providerFolderName: existing.providerFolderName || message.providerFolderName, folder: existing.folder, read: existing.read, starred: existing.starred, pending: existing.pending, labels: existing.labels } : {}), ...(mail.provider === 'google' ? googleImportState(message, existing) : {}) });
      imported.set(remoteKey(message), saved);
      if (existing) localSent.delete(message.messageId);
    } });
    return newIDs;
  }
  async function currentMail(account) {
    const mail = connections()[account];
    if (!mail) fail('Connect a mailbox first.', 409);
    if (!mail.provider || mail.provider === 'imap') return mail;
    let refreshed;
    try {
      refreshed = await api.refreshMail(mail);
    } catch (error) {
      const code = ['oauth_reconnect_required', 'oauth_configuration'].includes(error.code) ? error.code : 'oauth_refresh_failed';
      const [status, message, recoveryAction] = code === 'oauth_reconnect_required'
        ? [401, 'Mailbox authorization is no longer valid. Reconnect this account in Settings; cached mail is retained.', 'reconnect']
        : code === 'oauth_configuration' ? [502, "The provider rejected the OAuth app configuration. Check this account's OAuth client settings.", 'configure']
          : [502, 'Could not refresh mailbox authorization. Saved account credentials are retained. Check your connection and try again shortly.', 'retry'];
      throw Object.assign(new Error(message), { status, code, recoveryAction });
    }
    if (JSON.stringify(connections()[account]) !== JSON.stringify(mail)) fail('The mailbox connection changed. Try again.', 409);
    // Keep storage failures outside the OAuth catch; never describe an unsaved rotation as expired consent.
    if (JSON.stringify(refreshed) !== JSON.stringify(mail)) saveConnection({ ...refreshed, email: account });
    return refreshed;
  }
  async function fetchMessages(mail) {
    const finish = activity.start(mail.email, 'sync', 'Fetching mail', 'Inbox · up to 50 messages');
    try { const messages = await (mail.provider && mail.provider !== 'imap' ? api.fetchProviderMessages(mail) : api.fetchImapMessages(mail)); finish(true, messages.length); return messages; }
    catch (error) { finish(false); throw error; }
  }

  const fetchPage = async (mail, options) => {
    const finish = activity.start(mail.email, options?.before ? 'import' : 'sync', 'Fetching mail', `${options?.folder || 'inbox'} · up to 50 messages in this page`);
    try { const page = await (mail.provider && mail.provider !== 'imap' ? api.fetchProviderPage : api.fetchImapPage)(mail, options); finish(true, page.messages.length); return page; }
    catch (error) { finish(false); throw error; }
  };
  async function refreshMessages(mail, options = null, since) {
    // Keep legacy injected single-page providers usable; production Gmail refresh uses every scope.
    if (!options && (mail.provider !== 'google' || (services.fetchProviderMessages && !services.fetchProviderPage))) return fetchMessages(mail);
    const folders = mail.provider === 'google' ? ['inbox', 'sent', 'drafts', 'starred', 'all'] : ['inbox', 'sent'].filter(folder => options[folder]);
    const messages = [];
    for (const folder of folders) messages.push(...(await fetchPage(mail, { folder, ...(since ? { since } : {}) })).messages);
    return [...new Map(messages.map(message => [message.id, message])).values()];
  }
  const history = createHistory({ store, connection: account => connections()[account], currentMail, fetchPage, importMessages, lock: mailboxOperation, ...(services.now ? { now: services.now } : {}) });
  const activity = createActivity({ settings, connections, importStatus: account => history.status(account) });
  app.get('/api/activity', (_req, res) => res.json(activity.snapshot()));
  app.use('/api/ai', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const finish = activity.start(req.mailAccount, 'ai', 'AI assistance', 'Waiting for the configured model');
    res.once('finish', () => finish(res.statusCode < 400)); res.once('close', () => finish(null)); next();
  });
  const learning = createLearning({ store, connection: account => connections()[account], runModel: (...args) => api.runModel(...args), ...(services.now ? { now: services.now } : {}) });
  const smartSearch = registerSearchRoutes({ app, store, connections, apiBase, embed: services.embed, searchEngine });
  app.locals.smartSearch = smartSearch;
  const scheduled = createScheduled({ store, connection: account => connections()[account], fingerprint, outgoing, send: sendMessage, lock: mailboxOperation,
    prepare: (account, input) => ({ payload: { ...content(input, false), replyToId: input.replyToId || '' }, fromName: settings().preferences?.displayName || '', replyMessageId: input.replyToId ? getMessage(account, input.replyToId).messageId?.replace(/[\r\n]/g, '') || '' : '' }),
    ensureDraftIdle: (account, id) => { if (sendingDrafts.has(`${account}:${id}`)) fail('This draft is being sent. Wait for sending to finish.', 409); },
    ...(services.now ? { now: services.now } : {}),
  });
  scheduled.recover();
  app.locals.scheduled = scheduled;
  const suggestions = createReplySuggestions({ store, connections, contextFor, styleVoice: owner => learning.voice(owner), runModel: (...args) => api.runModel(...args), ...(services.now ? { now: services.now } : {}) });
  app.locals.replySuggestions = suggestions;
  registerReplySuggestionRoutes(app, suggestions);
  const outOfOffice = createOutOfOffice({ connections, currentMail, lock: mailboxOperation, request: api.providerRequest });
  app.get('/api/out-of-office', async (req, res) => res.json(await outOfOffice.get(req.get('X-Genmail-Account'))));
  app.put('/api/out-of-office', async (req, res) => res.json(await outOfOffice.put(req.get('X-Genmail-Account'), req.body)));
  const connectedOwner = req => { const account = req.get('X-Genmail-Account'); if (!connections()[account]) fail('Choose a connected mailbox.', 409); return account; };
  app.get('/api/scheduled', (req, res) => res.json(scheduled.list(connectedOwner(req))));
  app.post('/api/scheduled', async (req, res) => res.json(await mailboxOperation(() => scheduled.start(connectedOwner(req), req.body))));
  app.post('/api/scheduled/:id/cancel', async (req, res) => res.json(await mailboxOperation(() => scheduled.cancel(connectedOwner(req), req.params.id))));
  app.post('/api/imports/:action', (req, res) => {
    if (!connections()[req.mailAccount]) fail('Choose a connected mailbox.', 409);
    if (req.params.action === 'start') history.start(req.mailAccount, req.body);
    else history.control(req.mailAccount, req.params.action);
    res.json(state(req.mailAccount, req));
  });
  app.post('/api/style/settings', (req, res) => { learning.updateSettings(req.mailAccount, req.body); res.json(state(req.mailAccount, req)); });
  app.post('/api/style/preview', (req, res) => { learning.prepare(req.mailAccount); res.json(state(req.mailAccount, req)); });
  app.post('/api/style/generate', async (req, res) => { await learning.generate(req.mailAccount, req.body?.previewId); res.json(state(req.mailAccount, req)); });
  app.post('/api/style/apply', (req, res) => { learning.apply(req.mailAccount, req.body); res.json(state(req.mailAccount, req)); });
  app.delete('/api/style/profile', (req, res) => { learning.clear(req.mailAccount); res.json(state(req.mailAccount, req)); });

  app.get('/api/state', (req, res) => res.json(state(req.mailAccount, req)));
  app.get('/api/state/revision', (req, res) => res.json({ revision: store.revision(), accountId: req.mailAccount }));
  function readOwner(req) {
    const account = req.get('X-Genmail-Account');
    if (!account || (account !== 'all' && !validAccount(account))) fail('Choose a connected mailbox.', 409);
    return account;
  }
  app.post('/api/mail/page', (req, res) => {
    const account = readOwner(req);
    res.json(store.messagePage(account === 'all' ? Object.keys(connections()) : [account], req.body));
  });
  app.get('/api/messages/:id', (req, res) => {
    const account = readOwner(req);
    if (account === 'all') fail('Choose the message’s owning mailbox.', 409);
    const message = getMessage(account, req.params.id);
    const aiSummary = automation.reports(account).find(report => report.kind === 'arrival' && report.status === 'completed' && report.messageIds.includes(message.id)) || null;
    res.json({ message: ownedMessage(account, { ...message, aiSummary }) });
  });
  app.get('/api/updates/status', (req, res) => res.json(updater?.status() || { supported: false, phase: 'idle' }));
  app.post('/api/updates/download', (req, res) => {
    if (!updater) fail('Use the desktop app to install updates.', 409);
    res.status(202).json(updater.start(req.body?.includePrereleases));
  });
  app.post('/api/updates/cancel', (req, res) => {
    if (!updater) fail('No desktop update is running.', 409);
    res.json(updater.cancel());
  });
  app.post('/api/updates/install', async (req, res) => {
    if (!updater || !updateToken || !safeEqual(req.get('X-Morrow-Update'), updateToken)) fail('Install updates from the desktop app controls.', 403);
    res.json(await updater.prepare());
  });
  app.get('/api/updates', async (req, res) => {
    if (req.query.includePrereleases !== undefined && !['true', 'false'].includes(req.query.includePrereleases)) fail('Choose a valid release channel.');
    const includePrereleases = req.query.includePrereleases === 'true';
    let cached = updateChecks.get(includePrereleases);
    if (!cached || cached.expiresAt < Date.now()) {
      cached = { result: api.checkUpdates({ includePrereleases }), expiresAt: Date.now() + 60000 };
      updateChecks.set(includePrereleases, cached);
    }
    try { res.json(await cached.result); }
    catch (error) { if (updateChecks.get(includePrereleases) === cached) updateChecks.delete(includePrereleases); throw error; }
  });
  function selectAccount(account, req) {
    if (account !== 'all' && !validAccount(account)) fail('Choose a connected mailbox.', 409);
    store.setSettings({ activeAccount: account, ...(connections()[account] ? { mail: connections()[account] } : {}) });
    return state(account, req);
  }
  app.post('/api/account/select', (req, res) => res.json(selectAccount(req.body?.accountId, req)));
  app.post('/api/account/demo', (req, res) => res.json(selectAccount('demo', req)));
  app.post('/api/account/live', (req, res) => {
    const account = req.body?.accountId || settings().mail?.email || Object.keys(connections())[0];
    if (!account) fail('Connect a mailbox first.', 409);
    res.json(selectAccount(account, req));
  });
  app.post('/api/account/disconnect', async (req, res) => mailboxOperation(async () => {
    const accounts = { ...connections() }, account = req.mailAccount;
    if (!Object.hasOwn(accounts, account)) fail('Choose a connected mailbox.', 409);
    delete accounts[account];
    const fallback = Object.keys(accounts)[0] || 'demo';
    const selected = activeAccount() === account ? fallback : activeAccount();
    store.setSettings({ mailAccounts: accounts, mail: accounts[settings().mail?.email] || accounts[fallback] || null, activeAccount: selected, aiGeneration: (settings().aiGeneration || 0) + 1 });
    historyRevision++;
    for (const [id, preview] of previews) if (preview.account === account) previews.delete(id);
    res.json(state(selected, req));
  }));
  app.post('/api/settings/mail', async (req, res) => mailboxOperation(async () => {
    const input = req.body || {};
    const address = canonicalAddress(email(input.email));
    const existing = connections()[address];
    const hosts = { imapHost: hostname(input.imapHost, 'IMAP host'), imapPort: portNumber(input.imapPort, 993), smtpHost: hostname(input.smtpHost, 'SMTP host'), smtpPort: portNumber(input.smtpPort, 465) };
    const sameDestination = existing?.email === address && existing.provider === 'imap' && Object.entries(hosts).every(([key, value]) => existing[key] === value);
    const password = input.password || (sameDestination ? existing.password : '');
    const mail = { provider: 'imap', email: address, password: text(password, 'Mailbox password', 4096), ...hosts };
    const options = input.importOptions === undefined ? null : importOptions(input.importOptions);
    let messages;
    try { await api.verifySmtp(mail); messages = options ? (await fetchPage(mail, { folder: options.allMail ? 'all' : options.inbox ? 'inbox' : 'sent', since: new Date(Date.now() - 86400000).toISOString() })).messages : await fetchMessages(mail); }
    catch { fail('Mailbox connection failed. Check the hosts, ports, and app password. IMAP requires TLS; SMTP requires TLS or STARTTLS.', 502); }
    store.transaction(() => { if (!options) importMessages(mail, messages); saveConnection(mail, true); if (options) history.start(address, options); });
    res.json(state(address, req));
  }));
  function modelSettings(input) {
    const previous = settings().ai;
    const baseUrl = apiBase(text(input.baseUrl, 'AI API base URL', 2048));
    const model = text(input.model, 'Model', 200).trim();
    const key = input.clearApiKey ? '' : input.apiKey || (previous?.baseUrl === baseUrl ? previous.apiKey : '') || '';
    const apiKey = text(key, 'API key', 4096, true);
    if (/[\r\n]/.test(apiKey)) fail('API key cannot contain line breaks.');
    const temperature = input.temperature ?? previous?.temperature ?? 0.3;
    const maxTokens = input.maxTokens ?? previous?.maxTokens ?? 1200;
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) fail('Temperature must be between 0 and 2.');
    if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 4096) fail('Maximum response tokens must be between 128 and 4096.');
    return { baseUrl, model, apiKey, temperature, maxTokens };
  }
  app.post('/api/settings/ai', (req, res) => {
    store.setSettings({ ai: modelSettings(req.body || {}), aiGeneration: (settings().aiGeneration || 0) + 1 });
    historyRevision++;
    res.json(state(req.mailAccount, req));
  });
  app.post('/api/settings/ai/test', async (req, res) => {
    const ai = modelSettings(req.body || {});
    try {
      await api.runModel(ai, 'write', [], 'Reply with exactly: Morrow connection ready.');
      res.json({ ok: true, text: 'Connection succeeded. The selected model returned a response. No email content was shared.' });
    } catch { fail('The connection test failed. Check your base URL, model ID, and API key.', 502); }
  });
  app.post('/api/settings/policy', (req, res) => {
    const before = resolvePolicy(settings().policy), policy = updatePolicy(settings().policy, req.body);
    store.setSettings({ policy, aiGeneration: (settings().aiGeneration || 0) + 1 });
    historyRevision++;
    if (JSON.stringify(before.summarySchedule) !== JSON.stringify(policy.summarySchedule) || (!before.enabled && policy.enabled) || (!before.triggers.scheduledSummary && policy.triggers.scheduledSummary) || (!before.behaviors.briefing && policy.behaviors.briefing)) automation.resetSchedules();
    previews.clear();
    res.json(state(req.mailAccount, req));
  });
  app.post('/api/signature/preview', (req, res) => res.json({ footer: preferencesFooter(req.body || {}) }));
  app.post('/api/settings/preferences', (req, res) => {
    store.setSettings({ preferences: updatePreferences(settings().preferences, req.body), aiGeneration: (settings().aiGeneration || 0) + 1 });
    historyRevision++;
    res.json(state(req.mailAccount, req));
  });
  function syncFailure(accountId, error) {
    if (['oauth_reconnect_required', 'oauth_configuration', 'oauth_refresh_failed'].includes(error.code)) return { accountId, code: error.code, error: error.message, recoveryAction: error.recoveryAction };
    if (error.providerStatus === 401) return { accountId, code: 'oauth_reconnect_required', recoveryAction: 'reconnect', error: 'The provider rejected mailbox authorization. Reconnect this account in Settings; cached mail is retained.' };
    return { accountId, code: 'mail_sync_failed', recoveryAction: 'retry', error: 'Sync could not finish. Saved mail and account credentials are retained. Check your connection and try again.' };
  }
  async function syncAccounts(accounts) {
    const syncErrors = [];
    for (const account of accounts) {
      try {
        const mail = await currentMail(account);
        const options = history.options(account);
        const messages = await refreshMessages(mail, options, options ? history.status(account).since : undefined);
        store.transaction(() => automation.arrivals(account, importMessages(mail, messages).filter(id => store.getMessage(account, id)?.folder === 'inbox' && (!history.status(account) || store.getMessage(account, id)?.date >= history.status(account).before))));
      } catch (error) {
        syncErrors.push(syncFailure(account, error));
      }
    }
    store.setSettings({ backgroundSyncErrors: [...(settings().backgroundSyncErrors || []).filter(item => !accounts.includes(item.accountId)), ...syncErrors] });
    return syncErrors;
  }
  app.post('/api/sync', async (req, res) => mailboxOperation(async () => {
    const accounts = req.mailAccount === 'all' ? Object.keys(connections()) : req.mailAccount === 'demo' ? [] : [req.mailAccount];
    const syncErrors = await syncAccounts(accounts);
    if (syncErrors.length && req.mailAccount !== 'all') throw Object.assign(new Error(syncErrors[0].error), { status: 502, code: syncErrors[0].code, recoveryAction: syncErrors[0].recoveryAction });
    res.json({ ...state(req.mailAccount, req), syncErrors });
    setImmediate(() => { void automation.tick().catch(() => {}); });
  }));

  app.post('/api/oauth/:provider/start', (req, res) => {
    const provider = req.params.provider;
    if (!['google', 'microsoft'].includes(provider)) fail('Unknown mail provider.');
    const options = req.body?.importOptions === undefined ? null : importOptions(req.body.importOptions);
    if (req.body?.outOfOffice !== undefined && typeof req.body.outOfOffice !== 'boolean') fail('Choose a valid automatic-reply permission.');
    let upgrade = null;
    if (req.body?.forAccount !== undefined) {
      const owner = email(req.body.forAccount);
      if (req.get('X-Genmail-Account') !== owner || req.body.outOfOffice !== true || Object.keys(req.body).some(key => !['forAccount', 'outOfOffice'].includes(key))) fail('Authorize automatic replies for this mailbox only.');
      upgrade = connections()[owner];
      if (!upgrade || upgrade.provider !== provider) fail('Choose a connected mailbox for this provider.', 409);
    }
    const credentials = upgrade || oauthCredentials(provider, req.body, googleOAuth);
    const config = { clientId: text(credentials.clientId, 'OAuth client ID', 1024).trim(), organize: upgrade ? api.canOrganizeMail(upgrade) : req.body?.organize === true, outOfOffice: req.body?.outOfOffice === true };
    if (provider === 'google') config.clientSecret = text(credentials.clientSecret, 'Google client secret', 4096).trim();
    else if (upgrade?.clientSecret) config.clientSecret = upgrade.clientSecret;
    const redirectUri = `http://localhost:${port}/api/oauth/${provider}/callback`;
    const pending = api.oauthStart(provider, config, redirectUri);
    const browserToken = randomBytes(32).toString('hex');
    for (const [key, value] of oauthPending) if (value.expiresAt < Date.now()) oauthPending.delete(key);
    if (oauthPending.size >= 20) fail('Too many pending connections. Wait a few minutes and try again.', 429);
    oauthPending.set(pending.state, { ...pending, importOptions: options, upgrade, provider, redirectUri, browserToken, expiresAt: Date.now() + 10 * 60 * 1000 });
    res.json({ url: `http://localhost:${port}/api/oauth/${provider}/authorize?state=${encodeURIComponent(pending.state)}` });
  });
  app.get('/api/oauth/:provider/authorize', (req, res) => {
    const pending = typeof req.query.state === 'string' ? oauthPending.get(req.query.state) : null;
    if (!pending || pending.provider !== req.params.provider || pending.expiresAt < Date.now() || pending.started) fail('Connection expired. Start again from Settings.');
    pending.started = true;
    // Set the binding cookie on the callback host, even when the UI uses 127.0.0.1.
    res.cookie('genmail_oauth', pending.browserToken, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/api/oauth' });
    res.redirect(pending.url);
  });
  app.get('/api/oauth/:provider/callback', async (req, res) => {
    const redirect = new URL(appUrl);
    const pending = typeof req.query.state === 'string' ? oauthPending.get(req.query.state) : null;
    oauthPending.delete(req.query.state);
    const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('genmail_oauth='))?.slice('genmail_oauth='.length);
    res.clearCookie('genmail_oauth', { path: '/api/oauth' });
    try {
      if (!pending || !pending.started || pending.expiresAt < Date.now() || pending.provider !== req.params.provider || !safeEqual(cookie, pending.browserToken)) fail('Connection expired or could not be verified. Start again from Settings.');
      if (req.query.error) fail('Mailbox access was not granted. Try again from Settings.');
      const code = text(req.query.code, 'Authorization code', 8192);
      await mailboxOperation(async () => {
        let mail, messages;
        try {
          mail = await api.oauthFinish(pending.provider, { code, verifier: pending.verifier, config: pending.config, redirectUri: pending.redirectUri });
          messages = pending.importOptions || pending.upgrade ? [] : await refreshMessages(mail);
        } catch { fail('The provider connection failed. Check your app registration and permissions, then try again.'); }
        mail.email = canonicalAddress(email(mail.email));
        store.transaction(() => {
          if (pending.upgrade) {
            const previous = pending.upgrade, current = connections()[previous.email];
            if (mail.email.toLowerCase() !== previous.email.toLowerCase() || !current || current.connectionId !== previous.connectionId || current.authorizationId !== previous.authorizationId || current.provider !== previous.provider || current.clientId !== previous.clientId) fail('The mailbox changed. Authorize automatic replies again for the original account.', 409);
            if (!outOfOfficeCapability(mail, previous.email).canWrite || (api.canOrganizeMail(current) && !api.canOrganizeMail(mail))) fail('Automatic reply permissions were not fully granted. The existing mail connection was retained.', 403);
            // Retain import checkpoints while invalidating older authorization windows.
            saveConnection({ ...current, ...mail, authorizationId: randomUUID() }, false);
            store.setSettings({ aiGeneration: (settings().aiGeneration || 0) + 1 }); historyRevision++;
          } else { importMessages(mail, messages); saveConnection(mail, true); if (pending.importOptions) history.start(mail.email, pending.importOptions); }
        });
      });
      redirect.searchParams.set('connected', pending.provider);
    } catch (error) { redirect.searchParams.set('connectionError', error.status ? error.message : 'Connection failed. Try again from Settings.'); }
    res.redirect(redirect.href);
  });

  async function remoteFolders(mail) {
    return !mail.provider || mail.provider === 'imap' ? api.listImapFolders(mail) : api.listProviderFolders(mail);
  }
  app.get('/api/mail/folders', async (req, res) => mailboxOperation(async () => {
    const account = req.get('X-Genmail-Account');
    if (!validAccount(account) || account === 'demo') fail('Choose a connected mailbox.', 409);
    const mail = await currentMail(account);
    res.json({ folders: await remoteFolders(mail), provider: mail.provider || 'imap', accountId: account });
  }));
  app.post('/api/messages/:id/organize', async (req, res) => mailboxOperation(async () => {
    const account = req.mailAccount;
    const message = getMessage(account, req.params.id);
    const mail = await currentMail(account);
    const provider = mail.provider || 'imap';
    if (!(message.remoteId || message.id).startsWith(provider + ':')) fail('Only imported messages can be organized on the provider.');
    if (!['move', 'addLabel', 'removeLabel'].includes(req.body?.mode)) fail('Choose a supported organization action.');
    if (req.body.confirmed !== true) fail('Review and confirm this provider change first.');
    const destination = (await remoteFolders(mail)).find(folder => folder.id === req.body.destinationId);
    if (!destination) fail('Choose a current folder or label from this mailbox.');
    let patch;
    try {
      patch = await (provider === 'imap' ? api.organizeImapMessage : api.organizeProviderMessage)(mail, message, destination, req.body.mode);
    } catch {
      fail('The provider change could not be confirmed. Check the message in your provider before trying again. Your cached copy is retained.', 502);
    }
    if (provider === 'google') {
      const current = getMessage(account, message.id);
      const remoteFolder = providers.googleFolder(patch.providerLabelIds);
      patch.providerSnapshot = { ...current.providerSnapshot, folder: remoteFolder };
      if (req.body.mode === 'move') patch.localOverrides = { ...current.localOverrides, folder: false };
      patch.folder = req.body.mode !== 'move' && current.localOverrides?.folder === true ? current.folder : remoteFolder;
    }
    res.json({ message: ownedMessage(account, store.updateMessage(account, message.id, patch)) });
  }));
  app.patch('/api/messages/:id', (req, res) => {
    const patch = {};
    for (const key of ['read', 'starred', 'pending']) if (key in (req.body || {})) {
      if (typeof req.body[key] !== 'boolean') fail(`${key} must be true or false.`);
      patch[key] = req.body[key];
    }
    if ('folder' in (req.body || {})) {
      if (!['inbox', 'archive', 'trash'].includes(req.body.folder)) fail('Invalid folder.');
      patch.folder = req.body.folder;
    }
    if (!Object.keys(patch).length) fail('No supported changes were provided.');
    const account = req.mailAccount;
    if (sendingDrafts.has(`${account}:${req.params.id}`)) fail('This draft is being sent. Wait for sending to finish.', 409);
    const original = getMessage(account, req.params.id);
    scheduled.guardDraft(account, req.params.id);
    if (original.folder === 'drafts' && patch.folder && patch.folder !== 'trash') fail('Save or send this draft before moving it.');
    if (Array.isArray(original.providerLabelIds)) patch.localOverrides = { ...original.localOverrides, ...Object.fromEntries(Object.keys(patch).filter(key => key !== 'pending').map(key => [key, true])) };
    res.json({ message: ownedMessage(account, store.updateMessage(account, req.params.id, patch)) });
  });
  function content(input, draft) {
    const addresses = recipients(input, draft);
    const subject = text(input.subject ?? '', 'Subject', 500, true);
    if (/[\r\n]/.test(subject)) fail('Recipient and subject must be single lines.');
    const body = text(input.body ?? '', 'Message body', 100000, draft);
    return { ...addresses, subject: draft ? subject : subject || '(No subject)', body, ...(input.footer !== undefined ? { footer: normalizeFooter(input.footer) } : {}) };
  }
  function outgoing(account, value, extra = {}) {
    const address = account === 'demo' ? 'alex@genmail.example' : account;
    return { id: randomUUID(), fromName: settings().preferences?.displayName || (account === 'demo' ? 'Alex Morgan' : address), fromEmail: address, date: new Date().toISOString(), read: true, starred: false, category: 'primary', labels: [], ...value, preview: value.body.replace(/\s+/g, ' ').slice(0, 180), ...extra };
  }
  app.post('/api/drafts/prepare', (req, res) => {
    res.json(prepareDraft(req.mailAccount, req.body, id => ownedMessage(req.mailAccount, getMessage(req.mailAccount, id))));
  });
  app.post('/api/drafts', (req, res) => {
    const input = req.body || {};
    const value = content(input, true);
    const account = req.mailAccount;
    if (input.id) {
      scheduled.guardDraft(account, input.id);
      if (sendingDrafts.has(`${account}:${input.id}`)) fail('This draft is being sent. Wait for sending to finish.', 409);
      const existing = getMessage(account, input.id);
      if (existing.providerDraft === true) fail('This is a read-only provider draft. Copy it to a local draft before editing or sending.', 409);
      if (existing.folder !== 'drafts') fail('Only drafts can be edited.');
    }
    if (input.replyToId) getMessage(account, input.replyToId);
    const pendingDelivery = (settings().deliveryAttempts || []).find(item => item.account === account && item.draftId === input.id);
    if (pendingDelivery) fail('This draft has an unconfirmed delivery. Check your provider’s Sent folder before retrying it.', 409);
    const message = outgoing(account, value, { id: input.id || randomUUID(), folder: 'drafts', ...(input.replyToId ? { replyToId: input.replyToId } : {}) });
    res.json({ message: ownedMessage(account, store.upsertMessage(account, message)) });
  });
  async function sendMessage(account, input, options = {}) {
    const value = content(input, false);
    if (options.scheduledId && input.footer) value.footer = structuredClone(input.footer);
    if (options.fromName !== undefined) value.fromName = options.fromName;
    scheduled.guardSend(account, input, options.scheduledId);
    if (input.draftId && store.getMessage(account, input.draftId)?.providerDraft === true) fail('This is a read-only provider draft. Copy it to a local draft before editing or sending.', 409);
    const requestId = text(input.requestId, 'Send request ID', 100);
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(requestId)) fail('Invalid send request ID.');
    if (input.retryUnconfirmed !== undefined && typeof input.retryUnconfirmed !== 'boolean') fail('Delivery review must be true or false.');
    const payloadHash = fingerprint({ ...value, replyToId: input.replyToId });
    const sentId = `sent:${requestId}`;
    const sent = store.getMessage(account, sentId);
    if (sent) {
      if (fingerprint(sent) !== payloadHash) fail('This send request ID was already used for different text. Start a new draft.', 409);
      return { message: ownedMessage(account, sent), simulated: account === 'demo' };
    }
    const attempts = () => settings().deliveryAttempts || [];
    const previous = attempts().find(item => item.account === account && (item.requestId === requestId || (input.draftId && item.draftId === input.draftId)));
    const reviewRequired = (attempt, status = 409) => { const body = { error: 'Delivery could not be confirmed. This draft is saved. Check your provider’s Sent folder before explicitly retrying; retrying may send a duplicate.', requiresSendReview: true, draftId: attempt.draftId, deliveryRequestId: attempt.requestId, message: ownedMessage(account, store.getMessage(account, attempt.draftId)) }; throw Object.assign(new Error(body.error), { status, body }); };
    if (previous && (!input.retryUnconfirmed || previous.requestId !== requestId)) return reviewRequired(previous);
    if (previous && previous.payloadHash !== payloadHash) fail('This draft has an unconfirmed delivery with different text. Check your provider’s Sent folder and reopen the saved draft before retrying.', 409);
    const draftId = input.draftId || previous?.draftId || (account !== 'demo' ? `outbox:${requestId}` : null);
    const sendKey = `${account}:${requestId}`;
    const draftKey = draftId ? `${account}:${draftId}` : null;
    if (sending.has(sendKey) || (draftKey && sendingDrafts.has(draftKey))) fail('This draft is already being sent. Wait before retrying.', 409);
    if (input.draftId && getMessage(account, input.draftId).folder !== 'drafts') fail('Only saved drafts can be sent.');
    const original = input.replyToId ? getMessage(account, input.replyToId) : null;
    sending.set(sendKey, true);
    if (draftKey) sendingDrafts.add(draftKey);
    try {
      const operation = async () => {
        let messageId = '', attempt;
        if (account !== 'demo') {
          const mail = await currentMail(account);
          // Persist before delivery: a crash or lost response must never trigger an automatic resend.
          attempt = previous || { account, requestId, draftId, payloadHash, createdAt: new Date().toISOString() };
          if (!previous && attempts().length >= 1000) fail('Too many unconfirmed deliveries. Review your saved drafts before sending more.', 409);
          store.transaction(() => {
            store.upsertMessage(account, outgoing(account, value, { id: draftId, folder: 'drafts', deliveryStatus: 'unconfirmed', deliveryRequestId: requestId, ...(input.replyToId ? { replyToId: input.replyToId } : {}) }));
            if (!previous) store.setSettings({ deliveryAttempts: [...attempts(), attempt] });
          });
          const message = { ...value, fromName: options.fromName ?? settings().preferences?.displayName ?? '', replyMessageId: options.replyMessageId ?? original?.messageId?.replace(/[\r\n]/g, '') ?? undefined };
          try {
            const result = mail.provider === 'imap' ? await api.sendSmtpMessage(mail, message) : await api.sendProviderMessage(mail, message);
            messageId = typeof result === 'string' ? result : result?.messageId || '';
          } catch { return reviewRequired(attempt, 502); }
        }
        const message = outgoing(account, value, { id: sentId, folder: 'sent', messageId: typeof messageId === 'string' ? messageId : '', ...(input.replyToId ? { replyToId: input.replyToId } : {}) });
        try {
          store.transaction(() => {
            store.upsertMessage(account, message);
            if (draftId) store.deleteMessage(account, draftId);
            if (attempt) store.setSettings({ deliveryAttempts: attempts().filter(item => !(item.account === account && item.requestId === requestId)) });
          });
        } catch (error) {
          if (attempt) return reviewRequired(attempt, 502);
          throw error;
        }
        return { message: ownedMessage(account, message), simulated: account === 'demo' };
      };
      return await (options.mailboxLocked ? operation() : mailboxOperation(operation));
    } finally { sending.delete(sendKey); if (draftKey) sendingDrafts.delete(draftKey); }
  }
  app.post('/api/send', async (req, res) => res.json(await sendMessage(req.mailAccount, req.body || {})));
  function includeReplyHistory(input) {
    if (input.includeHistory !== undefined && typeof input.includeHistory !== 'boolean') fail('includeHistory must be true or false.');
    if (input.includeHistory === true && (input.action !== 'reply' || input.trigger !== undefined || input.draftText !== undefined)) fail('Sender history is available only for an explicit reply to a selected email.');
    return input.includeHistory === true;
  }
  function replyHistory(account, target, policy) {
    if (policy.content.sender !== true) fail('Enable sender access in AI permissions to suggest a reply with history.', 403);
    if (policy.folders[target.folder] !== true) fail('This folder is outside the permitted AI scope.', 403);
    const sender = email(target.fromEmail).replace(/[A-Z]/g, char => char.toLowerCase());
    const folders = Object.keys(policy.folders).filter(folder => policy.folders[folder] === true);
    const maxMessages = Math.max(1, Math.min(50, Number.isSafeInteger(policy.maxMessages) && policy.maxMessages >= 0 ? policy.maxMessages : 8));
    // ponytail: bounded metadata scan; index correspondents if measured mailbox size warrants it.
    const rows = store.search.query(`SELECT id,json_extract(data,'$.fromEmail') AS sender,json_extract(data,'$.folder') AS folder,json_extract(data,'$.to') AS recipients,json_extract(data,'$.cc') AS cc FROM messages WHERE account=? AND id<>? AND json_extract(data,'$.folder') IN (${folders.map(() => '?').join(',')}) ORDER BY COALESCE(json_extract(data,'$.date'),'') DESC,id`, [account, target.id, ...folders]);
    const fold = value => String(value || '').trim().replace(/[A-Z]/g, char => char.toLowerCase());
    const matches = rows.filter(row => {
      const from = fold(row.sender);
      if (from === sender) return true;
      if (row.folder !== 'sent' || from !== fold(account)) return false;
      const header = [row.recipients, row.cc].filter(Boolean).join(', ');
      if (header.length > 52000 || /[\r\n\0]/.test(header)) return false;
      return addressParser(header, { flatten: true }).some(address => fold(address.address) === sender);
    });
    const matchedMessages = 1 + matches.length, ids = matches.slice(0, maxMessages - 1);
    const messages = [target, ...ids.map(({ id }) => getMessage(account, id))].map(message => redactMessage(message, policy));
    return { messages, history: { matchedMessages, usedMessages: messages.length, maxMessages, scope: 'downloaded' } };
  }
  function contextFor(action, input, account) {
    const includeHistory = includeReplyHistory(input);
    const config = settings();
    const policy = resolvePolicy(config.policy);
    const feature = requireBehavior(policy, action);
    let messages = [], skill, history;
    if (action === 'skill') {
      skill = workspace(account).skills.find(item => item.id === input.skillId);
      if (!skill) fail('Choose a saved email skill.', 404);
      if (skill.enabled === false) fail('This email skill is disabled.', 403);
    }
    if (action === 'rewrite' || (action === 'translate' && input.draftText !== undefined)) {
      if (!policy.folders.drafts || !policy.content.body) fail('Enable draft and body access in AI permissions.', 403);
      messages = [{ id: 'unsaved-draft', body: text(input.draftText, 'Draft text', 100000), subject: '', fromName: '', fromEmail: '', date: new Date().toISOString(), folder: 'drafts' }];
    } else if (feature.context === 'selected') {
      const message = getMessage(account, input.messageId);
      if (!policy.folders[message.folder]) fail('This folder is outside the permitted AI scope.', 403);
      messages = [redactMessage(message, policy)];
      if (includeHistory) ({ messages, history } = replyHistory(account, message, policy));
    } else if (feature.context === 'mailbox') {
      messages = permittedMessages(store.listMessages(account), policy).filter(message => !skill?.folders || skill.folders[message.folder]);
      if (!messages.length) fail('No messages are available within the permitted folders.', 403);
      if (action === 'ask') messages = api.searchContext(messages, input.prompt || '', policy.maxMessages);
      messages = messages.slice(0, policy.maxMessages);
    }
    return { config, policy, feature, account, messages, skill, history };
  }
  async function assistance(input, owner, summaryIDs = null) {
    const { action, prompt = '' } = input;
    text(prompt, 'AI instructions', 2000, !['ask', 'write'].includes(action));
    const context = contextFor(action, input, owner);
    const { config, policy, feature, account, skill, history } = context;
    const revision = historyRevision;
    let messages = context.messages;
    if (summaryIDs) {
      if (!['summary', 'briefing'].includes(action) || summaryIDs.length > policy.maxMessages) fail('Invalid summary context.');
      messages = summaryIDs.map(id => getMessage(account, id));
      if (messages.some(message => !policy.folders[message.folder] || ['drafts', 'trash'].includes(message.folder))) fail('Summary context is no longer permitted.', 403);
      messages = messages.map(message => redactMessage(message, policy));
    }
    if (feature.mock) fail('Use the workflow preview for simulated behaviors.');
    const brain = workspace(account).brain;
    const useBrain = policy.behaviors.memory && policy.content.contacts && policy.content.sender && policy.content.body && policy.content.subject &&
      brain && (brain.sourceMessageIds || []).every(id => {
        const folder = store.getMessage(account, id)?.folder;
        return policy.folders[folder] && (!skill?.folders || skill.folders[folder]);
      });
    const options = { preferences: { ...DEFAULT_PREFERENCES, ...config.preferences }, brain: useBrain ? brain : null, styleVoice: ['reply', 'write', 'rewrite'].includes(action) && (!skill || skill.folders.sent) ? learning.voice(account) : '', structuredSummary: !!summaryIDs, timeZone: policy.summarySchedule.timeZone, ...(history ? { includeHistory: true } : {}) };
    const brainSnapshot = history && options.brain ? { value: JSON.stringify(options.brain), sources: (brain.sourceMessageIds || []).map(id => redactMessage(getMessage(account, id), policy)) } : null;
    const instructions = skill ? `${skill.instructions}\n\n${prompt}` : prompt;
    if (!config.ai?.model || !config.ai?.baseUrl) {
      if (account !== 'demo') fail('Choose an AI model in Settings to use assistance with your mailbox.', 409);
      const text = api.demoAssistance(action, messages, instructions, options);
      return { ...(summaryIDs ? prioritySummary(text, messages) : { text }), source: 'demo', ...(history ? { history } : {}) };
    }
    let result;
    try { result = await api.runModel(config.ai, action, messages, instructions, options); }
    catch (error) { fail(error.message?.startsWith('The AI provider returned') ? error.message : 'Could not reach the AI model or read its response. Check your endpoint and model, then try again.', 502); }
    if (options.styleVoice && options.styleVoice !== learning.voice(account)) fail('Writing style changed while this request was running. Its response was discarded.', 409);
    if (history && (revision !== historyRevision || config.aiGeneration !== settings().aiGeneration || (brainSnapshot && brainSnapshot.value !== JSON.stringify(workspace(account).brain)) || [...messages, ...(brainSnapshot?.sources || [])].some(previous => {
      const current = store.getMessage(account, previous.id);
      return !current || JSON.stringify(redactMessage(current, policy)) !== JSON.stringify(previous);
    }))) fail('The reply history or AI permissions changed while this request was running. Its response was discarded.', 409);
    if (!validAccount(account) || connections(config)[account]?.connectionId !== connections()[account]?.connectionId || JSON.stringify(config.ai) !== JSON.stringify(settings().ai) || JSON.stringify(config.preferences) !== JSON.stringify(settings().preferences) || JSON.stringify(policy) !== JSON.stringify(resolvePolicy(settings().policy)) || (input.trigger && !matchesAITrigger(policy, input.trigger, store.getMessage(account, input.messageId))) || (skill && JSON.stringify(skill) !== JSON.stringify(workspace(account).skills.find(item => item.id === skill.id)))) fail('The account, model or AI permissions changed while this request was running. Its response was discarded.', 409);
    return { ...(summaryIDs ? prioritySummary(result, messages) : { text: result }), source: 'model', ...(history ? { history } : {}) };
  }
  app.post('/api/ai', async (req, res) => {
    const input = req.body || {}, account = req.mailAccount;
    includeReplyHistory(input);
    if (input.trigger !== undefined) {
      const action = { onOpen: 'summary', onReply: 'reply' }[input.trigger];
      if (typeof input.trigger !== 'string' || !action || input.action !== action || input.prompt || input.draftText !== undefined) fail('Invalid automatic AI trigger.');
      const config = settings(), message = getMessage(account, input.messageId), policy = resolvePolicy(config.policy);
      if (!matchesAITrigger(policy, input.trigger, message)) return res.json({ skipped: true });
      // Coalesce overlapping UI requests; retain no automatic result after completion.
      const key = createHash('sha256').update(JSON.stringify([account, input.trigger, message.id, message.body, message.subject, message.starred, message.folder, config.ai, config.preferences, policy, connections(config)[account]?.connectionId])).digest('hex');
      let pending = automaticAI.get(key);
      if (!pending) {
        if (automaticAI.size >= 4) fail('AI is busy. Try again after the current requests finish.', 429);
        pending = assistance(input, account); automaticAI.set(key, pending);
      }
      try { return res.json(await pending); }
      finally { if (automaticAI.get(key) === pending) automaticAI.delete(key); }
    }
    res.json(await assistance(input, account));
  });

  app.post('/api/workflows/preview', (req, res) => {
    const input = req.body || {};
    const { policy, feature, account, messages } = contextFor(input.action, input, req.mailAccount);
    if (!feature.mock) fail('This behavior uses the AI assistant, not a mock workflow.');
    if (input.when !== undefined && (typeof input.when !== 'string' || !Number.isFinite(Date.parse(input.when)) || Date.parse(input.when) <= Date.now())) fail('Choose a future date and time.');
    for (const [id, preview] of previews) if (preview.expiresAt < Date.now()) previews.delete(id);
    if (previews.size >= 100) fail('Too many pending previews. Apply a preview or wait ten minutes.', 429);
    const plan = createWorkflowPlan(input.action, messages, { when: input.when });
    const id = randomUUID(), createdAt = new Date().toISOString();
    const preview = { id, action: input.action, title: plan.title, summary: plan.summary, items: plan.items, createdAt };
    previews.set(id, { ...preview, account, policy: JSON.stringify(policy), messages, plan, expiresAt: Date.now() + 10 * 60 * 1000 });
    res.json({ preview, simulated: true });
  });
  app.post('/api/workflows/apply', (req, res) => {
    const preview = previews.get(req.body?.previewId);
    if (!preview || preview.expiresAt < Date.now()) fail('This preview expired or was already applied. Generate a fresh preview.', 409);
    const account = req.mailAccount, policy = resolvePolicy(settings().policy);
    if (preview.account !== account || preview.policy !== JSON.stringify(policy)) fail('The account or permissions changed. Generate a fresh preview.', 409);
    requireBehavior(policy, preview.action);
    for (const previous of preview.messages) {
      const current = getMessage(account, previous.id);
      if (!policy.folders[current.folder] || JSON.stringify(redactMessage(current, policy)) !== JSON.stringify(previous)) fail('A source message changed after this preview. Generate a fresh preview.', 409);
      if (sendingDrafts.has(`${account}:${current.id}`)) fail('A source draft is being sent. Wait for sending to finish.', 409);
    }
    store.transaction(() => {
    const current = workspace(account), next = {};
    for (const { messageId, patch } of preview.plan.changes || []) {
      const current = getMessage(account, messageId);
      store.updateMessage(account, messageId, { ...patch, ...(patch.labels ? { labels: [...new Set([...(current.labels || []), ...patch.labels])] } : {}) });
    }
    const now = new Date().toISOString();
    for (const collection of ['reminders', 'events', 'unsubscribed']) {
      if (preview.plan.records[collection]) next[collection] = [...preview.plan.records[collection].map(record => ({ ...record, id: randomUUID(), createdAt: now, done: false, simulated: true })), ...current[collection]].slice(0, 100);
    }
    if (preview.plan.records.brain) next.brain = { ...preview.plan.records.brain, updatedAt: now, sourceMessageIds: preview.messages.map(message => message.id), simulated: true };
    for (const [index, draft] of (preview.plan.records.drafts || []).entries()) {
      const value = content({ ...draft, footer: preferencesFooter(settings().preferences || {}) }, true);
      store.upsertMessage(account, outgoing(account, value, { id: `mock-draft:${preview.id}:${index}`, folder: 'drafts', replyToId: draft.replyToId }));
    }
    next.activity = [{ id: preview.id, action: preview.action, title: preview.title, detail: preview.summary, createdAt: now, simulated: true }, ...current.activity].slice(0, 100);
    saveWorkspace(account, next);
    });
    previews.delete(preview.id);
    res.json({ ...state(req.mailAccount, req), simulated: true });
  });
  app.post('/api/skills', (req, res) => {
    const input = req.body || {}, account = req.mailAccount, current = workspace(account);
    const existing = input.id ? current.skills.find(skill => skill.id === input.id) : null;
    if (input.id && !existing) fail('Skill not found.', 404);
    if (!input.id && current.skills.length >= 20) fail('Keep at most 20 custom skills.');
    const name = text(input.name, 'Skill name', 80).trim(), instructions = text(input.instructions, 'Skill instructions', 4000).trim();
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('Skill enabled must be true or false.');
    const folders = input.folders ? updatePolicy({ folders: { inbox: true, sent: false, drafts: false, archive: false, trash: false } }, { folders: input.folders }).folders : existing?.folders || { inbox: true, sent: false, drafts: false, archive: false, trash: false };
    const skill = { id: existing?.id || randomUUID(), name, instructions, enabled: input.enabled ?? existing?.enabled ?? true, folders };
    saveWorkspace(account, { skills: existing ? current.skills.map(item => item.id === skill.id ? skill : item) : [...current.skills, skill] });
    res.json(state(req.mailAccount, req));
  });
  app.delete('/api/skills/:id', (req, res) => {
    const account = req.mailAccount, current = workspace(account);
    if (!current.skills.some(skill => skill.id === req.params.id)) fail('Skill not found.', 404);
    saveWorkspace(account, { skills: current.skills.filter(skill => skill.id !== req.params.id) });
    res.json(state(req.mailAccount, req));
  });
  app.post('/api/workspace/brain', (req, res) => {
    const account = req.mailAccount, current = workspace(account);
    const voice = text(req.body?.voice ?? '', 'Writing voice', 2000, true), notes = text(req.body?.notes ?? '', 'Brain notes', 4000, true);
    saveWorkspace(account, { brain: { ...current.brain, voice, notes, contacts: current.brain?.contacts || [], updatedAt: new Date().toISOString() } });
    res.json(state(req.mailAccount, req));
  });
  app.delete('/api/workspace/brain', (req, res) => { saveWorkspace(req.mailAccount, { brain: null }); res.json(state(req.mailAccount, req)); });
  app.patch('/api/workspace/:collection/:id', (req, res) => {
    const { collection, id } = req.params, account = req.mailAccount, current = workspace(account);
    if (!['reminders', 'events'].includes(collection)) fail('Unknown workspace collection.');
    const item = current[collection].find(record => record.id === id);
    if (!item) fail('Workspace item not found.', 404);
    const patch = {};
    if ('done' in (req.body || {})) {
      if (typeof req.body.done !== 'boolean') fail('Done must be true or false.');
      patch.done = req.body.done;
    }
    if (collection === 'events' && 'cancelled' in (req.body || {})) {
      if (typeof req.body.cancelled !== 'boolean') fail('Cancelled must be true or false.');
      patch.cancelled = req.body.cancelled;
    }
    if (!Object.keys(patch).length) fail('No supported workspace change was provided.');
    saveWorkspace(account, { [collection]: current[collection].map(record => record.id === id ? { ...record, ...patch } : record) });
    res.json(state(req.mailAccount, req));
  });
  const automation = createAutomation({ store, accounts: () => Object.keys(connections()), connection: account => connections()[account],
    generate: (account, kind, ids) => assistance({ action: kind === 'arrival' ? 'summary' : 'briefing', messageId: ids[0] }, account, ids),
    sync: () => mailboxOperation(() => syncAccounts(Object.keys(connections()))),
    maintenance: async isStopped => { if (!isStopped()) await scheduled.tick(); if (!isStopped()) await history.tick(); if (!isStopped()) await learning.tick(); if (!isStopped()) await suggestions.tick(); },
    ...(services.now ? { now: services.now } : {}),
  });
  app.locals.automation = automation;
  app.locals.history = history;
  app.locals.learning = learning;
  registerCalendarRoutes(app, { store, port, appUrl, services, googleOAuth });
  app.get('/api/health', (req, res) => {
    store.getSettings();
    res.json({ status: 'ok', service: 'morrow-mail' });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  if (nativeToken) {
    app.get('/', (req, res, next) => {
      if (safeEqual(req.get('Authorization'), `Bearer ${nativeToken}`)) return next();
      const failed = !!(req.query.connectionError || req.query.calendarError);
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
      res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Morrow Mail</title><style>body{font:18px system-ui;max-width:36rem;margin:15vh auto;padding:2rem;color:#193c34;background:#f5f4ec}h1{font-size:32px}</style><h1>${failed ? 'Connection was not completed.' : 'Return to Morrow Mail.'}</h1><p>${failed ? 'Check your provider app registration and permissions, then try connecting again in Settings.' : 'You can close this browser tab. Your connection status will refresh when you return to the app.'}</p></html>`);
    });
  }
  if (existsSync(dist)) {
    if (nativeToken) app.use((req, res, next) => safeEqual(req.get('Authorization'), `Bearer ${nativeToken}`) ? next() : res.status(401).end());
    app.use((req, res, next) => { res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"); next(); });
    app.use(express.static(dist));
    app.get('/{*path}', (req, res) => res.sendFile(resolve(dist, 'index.html')));
  } else app.get('/', (req, res) => res.type('text').send('Morrow Mail API is ready. Run npm run dev and open http://localhost:5173, or npm run build && npm start.'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    if (error.body?.requiresSendReview === true) return res.status(status).json(error.body);
    const oauth = ['oauth_reconnect_required', 'oauth_configuration', 'oauth_refresh_failed', 'mail_sync_failed'].includes(error.code);
    res.status(status).json({ error: status === 500 ? 'Something went wrong. Your saved messages are still on this device.' : (error.type === 'entity.parse.failed' ? 'Invalid JSON request.' : error.message), ...(oauth ? { code: error.code, recoveryAction: error.recoveryAction } : {}) });
  });
  return app;
}
