import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { microsoftClientId } from '../server/oauth-client.js';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';

async function workspace(t, services = {}, options = {}) {
  const directory = mkdtempSync(`${tmpdir()}/genmail-api-`);
  const store = createStore(directory);
  const server = createServer();
  let app;
  t.after(async () => {
    app?.locals.automation.stop();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const unexpected = () => { throw new Error('Unexpected external integration call'); };
  const application = () => createApp({ store, port, appUrl: origin, googleOAuth: options.googleOAuth || null, services: {
    verifySmtp: unexpected, fetchImapMessages: unexpected, sendSmtpMessage: unexpected,
    oauthFinish: unexpected, refreshMail: unexpected, fetchProviderMessages: unexpected,
    sendProviderMessage: unexpected, runModel: unexpected, ...services,
  } });
  app = application();
  server.on('request', app);
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(`${origin}${path}`, {
        method,
        headers: Object.fromEntries(Object.entries({ Origin: origin, 'X-Genmail-Account': store.getSettings().activeAccount, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(body)) }), ...headers }).filter(([, value]) => value !== undefined)),
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          const headers = new Headers(response.headers);
          resolve({ status: response.statusCode, headers, raw, data: headers.get('content-type')?.includes('application/json') ? JSON.parse(raw) : null });
        });
      });
      outgoing.on('error', reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const post = (path, body = {}) => request(path, { method: 'POST', body });
  return { store, request, post, port, origin, server, get automation() { return app.locals.automation; }, restart: () => { app.locals.automation.stop(); server.removeAllListeners('request'); app = application(); server.on('request', app); } };
}

const mailConfig = email => ({ email, password: 'private-mail-password', imapHost: 'imap.example.com', smtpHost: 'smtp.example.com' });
const content = { to: 'friend@example.com', subject: 'A good day', body: 'Hello from Genmail.' };

test('update endpoint validates channels, coalesces checks, and retries failures without claiming success', async t => {
  let calls = 0;
  const { request } = await workspace(t, { checkUpdates: async ({ includePrereleases }) => {
    calls++;
    if (!includePrereleases) throw Object.assign(Error('No stable release'), { status: 404 });
    return { currentVersion: '0.4.0-alpha.1', latestVersion: '0.4.0-alpha.2', updateAvailable: true };
  } });
  assert.equal((await request('/api/updates?includePrereleases=wrong')).status, 400);
  assert.equal(calls, 0);
  const results = await Promise.all([request('/api/updates?includePrereleases=true'), request('/api/updates?includePrereleases=true')]);
  assert.ok(results.every(result => result.status === 200 && result.data.updateAvailable));
  assert.equal(calls, 1);
  assert.equal((await request('/api/updates')).status, 404);
  assert.equal((await request('/api/updates')).status, 404);
  assert.equal(calls, 3);
  assert.equal((await request('/api/updates', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
});

test('automatic AI triggers are opt-in, filtered, redacted and owned by the selected message account', async t => {
  const seen = [];
  const { store, request, post } = await workspace(t, { runModel: async (config, action, messages) => { seen.push({ action, messages }); return 'Suggested text'; } });
  store.setSettings({ ai: { baseUrl: 'https://model.invalid/v1', model: 'fixture' }, mailAccounts: {
    'a@example.com': { email: 'a@example.com', connectionId: 'first' },
    'b@example.com': { email: 'b@example.com', connectionId: 'second' },
  }, activeAccount: 'all' });
  for (const account of ['a@example.com', 'b@example.com']) store.upsertMessage(account, { ...store.getMessage('demo', 'demo-1'), id: 'shared', body: account, subject: account, starred: false });
  const trigger = (account, extra = {}) => request('/api/ai', { method: 'POST', headers: { 'X-Genmail-Account': account }, body: { action: 'summary', trigger: 'onOpen', messageId: 'shared', ...extra } });
  assert.equal((await trigger('a@example.com')).data.skipped, true);
  assert.equal((await trigger('all')).status, 409);
  await post('/api/settings/policy', { triggers: { onOpen: true, onReply: true, starredOnly: true }, content: { body: false } });
  assert.equal((await trigger('a@example.com')).data.skipped, true);
  store.updateMessage('a@example.com', 'shared', { starred: true });
  assert.equal((await trigger('a@example.com')).data.text, 'Suggested text');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].messages[0].subject, 'a@example.com');
  assert.equal(seen[0].messages[0].body, '');
  assert.equal((await trigger('b@example.com')).data.skipped, true);
  assert.equal((await trigger('a@example.com', { action: 'reply', trigger: 'onReply' })).status, 200);
  assert.equal(seen[1].action, 'reply');
  for (const extra of [{ trigger: 'onSync' }, { trigger: ['onOpen'] }, { action: 'write' }, { prompt: 'bypass' }, { draftText: 'bypass' }]) assert.equal((await trigger('a@example.com', extra)).status, 400);
  store.updateMessage('a@example.com', 'shared', { folder: 'archive' });
  assert.equal((await trigger('a@example.com')).data.skipped, true);
  await post('/api/settings/policy', { triggers: { inboxOnly: false }, folders: { archive: true } });
  assert.equal((await trigger('a@example.com')).status, 200);
  for (const patch of [{ enabled: false }, { enabled: true, behaviors: { summary: false } }, { behaviors: { summary: true }, folders: { archive: false } }]) {
    await post('/api/settings/policy', patch);
    assert.equal((await trigger('a@example.com')).data.skipped, true);
  }
  for (const folder of ['drafts', 'trash']) {
    await post('/api/settings/policy', { folders: { [folder]: true } });
    store.updateMessage('a@example.com', 'shared', { folder });
    assert.equal((await trigger('a@example.com')).data.skipped, true);
  }
  assert.equal(seen.length, 3);
  assert.equal(store.listMessages('a@example.com').length, 1); // No draft or send side effects.
  const policy = store.getSettings().policy;
  assert.equal(policy.triggers.onReply, true);
});

test('overlapping automatic requests coalesce and discard results after permission or model changes', async t => {
  let complete, started, calls = 0;
  let ready = new Promise(resolve => { started = resolve; });
  const { store, post, server } = await workspace(t, { runModel: async () => { calls++; started(); return new Promise(resolve => { complete = resolve; }); } });
  const ai = { baseUrl: 'https://model.invalid/v1', model: 'fixture' };
  store.setSettings({ ai });
  await post('/api/settings/policy', { triggers: { onOpen: true } });
  const body = { action: 'summary', trigger: 'onOpen', messageId: 'demo-1' };
  const first = post('/api/ai', body);
  await ready;
  const arrived = new Promise(resolve => server.once('request', resolve));
  const duplicate = post('/api/ai', body);
  await arrived;
  await post('/api/settings/policy', { triggers: { onOpen: false } });
  complete('Must be discarded');
  assert.deepEqual((await Promise.all([first, duplicate])).map(result => result.status), [409, 409]);
  assert.equal(calls, 1);
  await post('/api/settings/policy', { triggers: { onOpen: true } });
  ready = new Promise(resolve => { started = resolve; });
  const changed = post('/api/ai', body);
  await ready;
  store.setSettings({ ai: { ...ai, model: 'replacement' } });
  complete('Old model output');
  assert.equal((await changed).status, 409);
});

test('demo draft lifecycle preserves failed drafts and makes send retries idempotent', async t => {
  const { store, request, post } = await workspace(t);
  const state = await request('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.data.account.mode, 'demo');
  assert.equal(state.headers.get('cache-control'), 'no-store');
  const summary = await post('/api/ai', { action: 'summary', messageId: 'demo-1' });
  assert.equal(summary.status, 200);
  assert.equal(summary.data.source, 'demo');
  assert.match(summary.data.text, /Northstar/);

  const draft = await post('/api/drafts', { ...content, to: '' });
  assert.equal(draft.status, 200);
  assert.equal(draft.data.message.folder, 'drafts');
  const id = draft.data.message.id;
  const edited = await post('/api/drafts', { ...content, id, replyToId: 'demo-1', body: 'The revised message.' });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.message.id, id);
  assert.equal(store.getMessage('demo', id).body, 'The revised message.');
  const send = { ...content, draftId: id, replyToId: 'demo-1', requestId: 'demo-send-1234' };
  assert.equal((await post('/api/send', { ...send, to: 'invalid-address' })).status, 400);
  assert.equal(store.getMessage('demo', id).folder, 'drafts');
  const before = store.listMessages('demo').filter(message => message.folder === 'sent').length;
  const sent = await post('/api/send', send);
  assert.equal(sent.status, 200);
  assert.equal(sent.data.simulated, true);
  assert.equal(sent.data.message.replyToId, 'demo-1');
  assert.equal(store.getMessage('demo', id), null);
  const retried = await post('/api/send', send);
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.data, sent.data);
  assert.equal(store.listMessages('demo').filter(message => message.folder === 'sent').length, before + 1);
});

test('settings redact credentials and requests reject hostile origins, hosts, and media types', async t => {
  const secret = 'sensitive-provider-error-token';
  const { store, request, post } = await workspace(t, {
    verifySmtp: () => { throw new Error(secret); },
    runModel: () => { throw new Error(secret); },
  });
  store.setSettings({ mail: { ...mailConfig('saved@example.com'), provider: 'google', accessToken: 'private-access-token', refreshToken: 'private-refresh-token', clientSecret: 'private-client-secret' } });
  const ai = { baseUrl: 'http://127.0.0.1:11434/v1', model: 'local-model', apiKey: 'private-api-key' };
  assert.equal((await post('/api/settings/ai', ai)).status, 200);
  const state = await request('/api/state');
  for (const value of ['private-mail-password', 'private-access-token', 'private-refresh-token', 'private-client-secret', 'private-api-key']) assert.equal(state.raw.includes(value), false);
  for (const field of ['password', 'accessToken', 'refreshToken', 'clientSecret', 'apiKey']) assert.equal(Object.hasOwn(state.data.settings.mail, field), false);
  assert.equal(state.data.settings.ai.hasApiKey, true);
  await post('/api/settings/ai', { ...ai, apiKey: '' });
  assert.equal(store.getSettings().ai.apiKey, ai.apiKey);
  await post('/api/settings/ai', { ...ai, apiKey: '', baseUrl: 'https://model.example.com/v1' });
  assert.equal(store.getSettings().ai.apiKey, '');
  const failedConnection = await post('/api/settings/mail', mailConfig('failed@example.com'));
  assert.equal(failedConnection.status, 502);
  assert.equal(failedConnection.raw.includes(secret), false);
  assert.equal(store.getSettings().mail.email, 'saved@example.com');
  const failedModel = await post('/api/ai', { action: 'summary', messageId: 'demo-1' });
  assert.equal(failedModel.status, 502);
  assert.equal(failedModel.raw.includes(secret), false);

  assert.equal((await request('/api/state', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/state', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await request('/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request('/api/account/live', { method: 'POST', body: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post('/api/settings/ai', { ...ai, baseUrl: 'http://remote.example/v1' })).status, 400);
});

test('mailbox sync preserves local organization, and every message action stays in the active account', async t => {
  let sentCount = 0;
  let sequence = 0;
  let store;
  const workspaceValue = await workspace(t, {
    verifySmtp: () => {},
    fetchImapMessages: mail => [{ ...store.getMessage('demo', 'demo-1'), id: 'imap:1:1', subject: `${mail.email} update ${++sequence}`, folder: 'inbox', read: false, starred: false }],
    sendSmtpMessage: () => { sentCount++; throw new Error('private-smtp-error'); },
  });
  ({ store } = workspaceValue);
  const { request, post } = workspaceValue;
  const connected = await post('/api/settings/mail', mailConfig('first@example.com'));
  assert.equal(connected.status, 200);
  assert.equal(connected.data.messages.length, 1);
  assert.equal(connected.data.account.email, 'first@example.com');
  assert.equal((await request('/api/messages/imap:1:1', { method: 'PATCH', body: { folder: 'archive', read: true, starred: true } })).status, 200);
  const synced = await post('/api/sync');
  assert.equal(synced.status, 200);
  assert.equal(synced.data.messages[0].folder, 'archive');
  assert.equal(synced.data.messages[0].read, true);
  assert.equal(synced.data.messages[0].starred, true);
  assert.match(synced.data.messages[0].subject, /update 2$/);

  assert.equal((await post('/api/ai', { action: 'summary', messageId: 'demo-1' })).status, 404);
  assert.equal((await request('/api/messages/demo-1', { method: 'PATCH', body: { read: true } })).status, 404);
  assert.equal((await post('/api/drafts', { ...content, id: 'demo-15' })).status, 404);
  assert.equal((await post('/api/drafts', { ...content, replyToId: 'demo-1' })).status, 404);
  assert.equal((await post('/api/send', { ...content, draftId: 'demo-15', requestId: 'foreign-draft-123' })).status, 404);
  assert.equal((await post('/api/send', { ...content, replyToId: 'demo-1', requestId: 'foreign-reply-123' })).status, 404);
  assert.equal(sentCount, 0);
  const draft = (await post('/api/drafts', content)).data.message;
  const failure = await post('/api/send', { ...content, draftId: draft.id, requestId: 'failed-send-123' });
  assert.equal(failure.status, 502);
  assert.equal(failure.raw.includes('private-smtp-error'), false);
  assert.equal(store.getMessage('first@example.com', draft.id).folder, 'drafts');
  assert.equal(sentCount, 1);

  const second = await post('/api/settings/mail', mailConfig('second@example.com'));
  assert.equal(second.status, 200);
  assert.equal(second.data.messages[0].folder, 'inbox');
  assert.equal(second.data.messages[0].read, false);
  assert.equal(second.data.messages[0].starred, false);
  assert.equal((await post('/api/drafts', { ...content, id: draft.id })).status, 404);
  assert.equal((await post('/api/send', { ...content, draftId: draft.id, requestId: 'foreign-live-123' })).status, 404);
  assert.equal(store.getMessage('first@example.com', 'imap:1:1').folder, 'archive');
  assert.equal((await post('/api/account/demo')).data.account.mode, 'demo');
  const restored = await post('/api/account/live');
  assert.equal(restored.data.account.email, 'second@example.com');
  assert.equal(restored.data.messages.some(message => message.id === draft.id), false);
});

test('explicit demo requests cannot send live mail and drafts cannot change during delivery', async t => {
  let begin, finish, delivered, calls = 0;
  const started = new Promise(resolve => { begin = resolve; });
  const sending = new Promise(resolve => { finish = resolve; });
  const { store, request, post } = await workspace(t, {
    sendSmtpMessage: async (mail, message) => {
      calls++;
      delivered = message;
      begin();
      await sending;
      return { messageId: '<sent@example.com>' };
    },
  });
  store.setSettings({ mail: { ...mailConfig('live@example.com'), provider: 'imap' }, activeAccount: 'live@example.com' });
  const send = { ...content, requestId: 'live-send-1234' };
  const simulated = await request('/api/send', { method: 'POST', body: send, headers: { 'X-Genmail-Account': 'demo' } });
  assert.equal(simulated.status, 200);
  assert.equal(simulated.data.simulated, true);
  assert.equal(simulated.data.message.accountId, 'demo');
  for (const owner of ['all', 'unknown@example.com']) assert.equal((await request('/api/send', { method: 'POST', body: send, headers: { 'X-Genmail-Account': owner } })).status, 409);
  assert.equal((await request('/api/send', { method: 'POST', body: send, headers: { 'X-Genmail-Account': undefined } })).status, 409);
  assert.equal(calls, 0);
  const draft = (await post('/api/drafts', content)).data.message;
  const delivery = post('/api/send', { ...send, draftId: draft.id });
  try {
    await started;
    assert.equal((await post('/api/drafts', { ...content, id: draft.id, body: 'Unsaved new work' })).status, 409);
    assert.equal((await request(`/api/messages/${draft.id}`, { method: 'PATCH', body: { folder: 'trash' } })).status, 409);
    assert.equal((await post('/api/send', { ...send, draftId: draft.id, requestId: 'second-send-5678' })).status, 409);
    assert.equal(store.getMessage('live@example.com', draft.id).body, content.body);
  } finally {
    finish();
  }
  const sent = await delivery;
  assert.equal(sent.status, 200);
  assert.equal(sent.data.simulated, false);
  assert.equal(sent.data.message.body, content.body);
  assert.equal(delivered.body, content.body);
  assert.equal(calls, 1);
  assert.equal(store.getMessage('live@example.com', draft.id), null);
});

test('built-in Google and Microsoft OAuth works for mail and calendar without exposing credentials or replacing custom clients', async t => {
  const googleOAuth = { clientId: 'bundled.apps.googleusercontent.com', clientSecret: 'fixture-bundled-private' };
  const exchanges = [];
  const { store, request, post, port } = await workspace(t, {
    oauthFinish: (provider, input) => {
      exchanges.push(input);
      return { provider, ...input.config, email: 'bundled@example.com', accessToken: 'fixture-user-token' };
    }, fetchProviderMessages: () => [], listCalendars: () => [], refreshMail: connection => connection,
  }, { googleOAuth });
  const state = await request('/api/state');
  assert.equal(state.data.settings.oauthClients.google.configured, true);
  assert.equal((await request('/api/calendars')).data.connections.find(item => item.provider === 'google').hasDefaultClient, true);
  assert.equal(state.data.settings.oauthClients.microsoft.configured, true);
  assert.equal((await request('/api/calendars')).data.connections.find(item => item.provider === 'microsoft').hasDefaultClient, true);
  for (const provider of ['google', 'microsoft']) {
    for (const [route, callbackKind, cookieName] of [[`/api/oauth/${provider}/start`, 'oauth', 'genmail_oauth'], [`/api/calendars/${provider}/connect`, 'calendar-oauth', `morrow_calendar_${provider}`]]) {
      if (provider === 'microsoft' && callbackKind === 'calendar-oauth') store.setSettings({ calendars: { ...store.getSettings().calendars, microsoft: { clientId: microsoftClientId, clientSecret: 'stale-private' } } });
      for (const body of [{ useDefaultClient: 'true' }, { useDefaultClient: true, clientId: 'custom' }, { useDefaultClient: true, clientSecret: 'custom' }]) assert.equal((await post(route, body)).status, 400);
      const start = await post(route, { useDefaultClient: true, organize: true });
      assert.equal(start.status, 200);
      const handoff = new URL(start.data.url);
      const authorize = await request(handoff.pathname + handoff.search, { headers: { Host: `localhost:${port}` } });
      assert.equal(authorize.status, 302);
      const authorizationURL = new URL(authorize.headers.get('location'));
      assert.equal(authorizationURL.searchParams.get('client_id'), provider === 'google' ? googleOAuth.clientId : microsoftClientId);
      assert.equal(authorizationURL.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorizationURL.searchParams.get('client_secret'), null);
      const cookie = authorize.headers.get('set-cookie').split(';')[0];
      assert.ok(cookie.startsWith(cookieName + '='));
      const callback = await request(`/api/${callbackKind}/${provider}/callback?state=${encodeURIComponent(handoff.searchParams.get('state'))}&code=fixture-code`, { headers: { Host: `localhost:${port}`, Cookie: cookie } });
      assert.equal(callback.status, 302);
      assert.equal(new URL(callback.headers.get('location')).searchParams.get(callbackKind === 'oauth' ? 'connected' : 'calendarConnected'), provider);
      assert.equal(exchanges.at(-1).config.clientSecret, provider === 'google' ? googleOAuth.clientSecret : undefined);
      const customStart = await post(route, { clientId: 'custom-client', clientSecret: 'custom-secret' });
      const customURL = new URL(customStart.data.url);
      const customRedirect = await request(customURL.pathname + customURL.search);
      assert.equal(new URL(customRedirect.headers.get('location')).searchParams.get('client_id'), 'custom-client');
      for (const response of [state, start, callback, await request('/api/state'), await request('/api/calendars')]) assert.doesNotMatch(response.raw, /fixture-bundled-private|fixture-user-token|custom-secret|stale-private/);
    }
  }
  const unconfigured = await workspace(t);
  assert.equal((await unconfigured.request('/api/state')).data.settings.oauthClients.google.configured, false);
  for (const route of ['/api/oauth/google/start', '/api/calendars/google/connect']) assert.equal((await unconfigured.post(route, { useDefaultClient: true })).status, 400);
});

test('OAuth binds the callback browser, rejects replay, and hands 127.0.0.1 clients to localhost', async t => {
  const exchanges = [];
  const { store, request, post, origin, port } = await workspace(t, {
    oauthFinish: (provider, input) => {
      exchanges.push({ provider, ...input });
      return { provider, ...input.config, email: `${provider}@example.com`, accessToken: 'private-oauth-access', refreshToken: 'private-oauth-refresh' };
    },
    fetchProviderMessages: () => [],
  });
  async function start(provider = 'google') {
    const result = await post(`/api/oauth/${provider}/start`, { clientId: 'public-client-id', clientSecret: 'private-google-secret' });
    assert.equal(result.status, 200);
    const url = new URL(result.data.url);
    assert.equal(url.hostname, 'localhost');
    assert.equal(url.port, String(port));
    assert.equal(url.pathname, `/api/oauth/${provider}/authorize`);
    assert.equal(result.raw.includes('private-google-secret'), false);
    return { provider, path: `${url.pathname}${url.search}`, state: url.searchParams.get('state') };
  }
  async function authorize(attempt) {
    const result = await request(attempt.path, { headers: { Host: `localhost:${port}` } });
    assert.equal(result.status, 302);
    const external = new URL(result.headers.get('location'));
    assert.equal(external.searchParams.get('redirect_uri'), `http://localhost:${port}/api/oauth/${attempt.provider}/callback`);
    assert.equal(external.searchParams.get('state'), attempt.state);
    assert.equal(external.searchParams.get('code_challenge_method'), 'S256');
    const setCookie = result.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\/api\/oauth/);
    return setCookie.split(';')[0];
  }
  const callback = (attempt, cookie, state = attempt.state, provider = attempt.provider) => request(`/api/oauth/${provider}/callback?state=${encodeURIComponent(state)}&code=test-code`, { headers: { Host: `localhost:${port}`, 'Sec-Fetch-Site': 'cross-site', ...(cookie ? { Cookie: cookie } : {}) } });
  const rejected = result => {
    assert.equal(result.status, 302);
    const location = new URL(result.headers.get('location'));
    assert.equal(location.origin, origin);
    assert.ok(location.searchParams.get('connectionError'));
  };

  const unbound = await start();
  const unboundCookie = await authorize(unbound);
  assert.equal((await request(unbound.path)).status, 400);
  rejected(await callback(unbound));
  rejected(await callback(unbound, unboundCookie));
  assert.equal(exchanges.length, 0);

  const wrongProvider = await start();
  const wrongProviderCookie = await authorize(wrongProvider);
  rejected(await callback(wrongProvider, wrongProviderCookie, wrongProvider.state, 'microsoft'));
  assert.equal(exchanges.length, 0);

  for (const provider of ['google', 'microsoft']) {
    const attempt = await start(provider);
    const cookie = await authorize(attempt);
    rejected(await callback(attempt, cookie, 'unknown-state'));
    const result = await callback(attempt, cookie);
    assert.equal(result.status, 302);
    assert.equal(new URL(result.headers.get('location')).searchParams.get('connected'), provider);
    const exchange = exchanges.at(-1);
    assert.equal(exchange.provider, provider);
    assert.equal(exchange.code, 'test-code');
    assert.match(exchange.verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(exchange.redirectUri, `http://localhost:${port}/api/oauth/${provider}/callback`);
    assert.equal(store.getSettings().activeAccount, `${provider}@example.com`);
    rejected(await callback(attempt, cookie));
    const publicState = await request('/api/state');
    assert.equal(publicState.raw.includes('private-oauth-access'), false);
    assert.equal(publicState.raw.includes('private-oauth-refresh'), false);
    assert.equal(publicState.raw.includes('private-google-secret'), false);
  }
  assert.equal(exchanges.length, 2);
  assert.deepEqual(Object.keys(store.getSettings().mailAccounts), ['google@example.com', 'microsoft@example.com']);
});

test('production mail reconnects never send saved credentials to changed servers and sync preserves labels', async t => {
  let connectionChecks = 0;
  const { store, post, request } = await workspace(t, {
    verifySmtp: async () => { connectionChecks += 1; },
    fetchImapMessages: async () => [{ id: 'imap:1:1', subject: 'Imported', body: 'Hello', date: new Date().toISOString(), folder: 'inbox', labels: [], read: false, starred: false }],
  });
  const config = mailConfig('production@example.com');
  assert.equal((await post('/api/settings/mail', config)).status, 200);
  assert.equal((await post('/api/settings/mail', { ...config, password: '' })).status, 200);
  assert.equal(connectionChecks, 2);
  for (const change of [{ imapHost: 'other.example.com' }, { smtpHost: 'other.example.com' }, { smtpPort: 587 }]) {
    assert.equal((await post('/api/settings/mail', { ...config, ...change, password: '' })).status, 400);
  }
  assert.equal(connectionChecks, 2);
  store.updateMessage(config.email, 'imap:1:1', { labels: ['Follow-up'], folder: 'archive', starred: true });
  assert.equal((await post('/api/sync')).status, 200);
  assert.deepEqual(store.getMessage(config.email, 'imap:1:1').labels, ['Follow-up']);
  assert.equal(store.getMessage(config.email, 'imap:1:1').folder, 'archive');
  const health = await request('/api/health');
  assert.deepEqual(health.data, { status: 'ok', service: 'morrow-mail' });
  assert.equal(health.headers.get('cache-control'), 'no-store');
});

test('unconfirmed deliveries survive restart, preserve unsaved drafts, and require explicit review before retry', async t => {
  let deliveries = 0;
  const { store, post, restart } = await workspace(t, {
    sendSmtpMessage: async () => { deliveries += 1; return '<accepted@example.com>'; },
  });
  const account = 'delivery@example.com';
  store.setSettings({ activeAccount: account, mail: { ...mailConfig(account), provider: 'imap' } });
  const upsert = store.upsertMessage;
  let failedCommit = true;
  store.upsertMessage = (account, message) => {
    if (failedCommit && message.folder === 'sent') throw new Error('Injected full disk after remote acceptance');
    return upsert(account, message);
  };
  const input = { ...content, requestId: 'durable-send-123' };
  const failed = await post('/api/send', input);
  assert.equal(failed.status, 502);
  assert.equal(failed.data.requiresSendReview, true);
  assert.equal(deliveries, 1);
  const draftId = failed.data.draftId;
  assert.equal(store.getMessage(account, draftId).body, content.body);
  assert.equal(store.getMessage(account, draftId).deliveryStatus, 'unconfirmed');
  assert.equal(store.getSettings().deliveryAttempts.length, 1);
  restart();
  assert.equal((await post('/api/send', input)).status, 409);
  assert.equal((await post('/api/send', { ...input, draftId, requestId: 'new-request-123' })).status, 409);
  assert.equal((await post('/api/drafts', { ...content, id: draftId, body: 'replace uncertain text' })).status, 409);
  assert.equal(deliveries, 1);
  failedCommit = false;
  const retried = await post('/api/send', { ...input, draftId, retryUnconfirmed: true });
  assert.equal(retried.status, 200);
  assert.equal(deliveries, 2);
  assert.equal(store.getMessage(account, draftId), null);
  assert.equal(store.getSettings().deliveryAttempts.length, 0);
  assert.equal((await post('/api/send', input)).status, 200);
  assert.equal((await post('/api/send', { ...input, body: 'changed content' })).status, 409);
  assert.equal(deliveries, 2);
});


test('multiple mailboxes migrate, combine duplicate IDs, route actions independently, and disconnect without losing mail', async t => {
  let broken = '', revision = 0;
  const deliveries = [], modelInputs = [];
  const { store, post, request, restart } = await workspace(t, {
    verifySmtp: async () => {},
    fetchImapMessages: async mail => {
      if (mail.email === broken) throw new Error('private-server-secret');
      return [{ id: 'shared-id', fromEmail: 'sender@example.com', fromName: 'Sender', to: mail.email, subject: mail.email, body: `${mail.email} revision ${++revision}`, date: mail.email.startsWith('second') ? '2026-09-23T12:00:00Z' : '2026-09-23T11:00:00Z', folder: 'inbox', read: false, starred: false, labels: [] }];
    },
    sendSmtpMessage: async mail => { deliveries.push(mail.email); return { messageId: '<fixture@example.com>' }; },
    runModel: async (_, action, messages) => { modelInputs.push(messages); return 'Account-specific response'; },
  });
  const first = 'first@example.com', second = 'second@example.com';
  // Upgrade an existing installation; it must not lose the legacy connection.
  store.setSettings({ mail: { ...mailConfig(first), provider: 'imap', imapPort: 993, smtpPort: 465 }, activeAccount: first });
  const scoped = (account, path, body = {}, method = 'POST') => request(path, { method, body, headers: { 'X-Genmail-Account': account } });
  assert.equal((await post('/api/sync')).status, 200);
  assert.equal((await post('/api/settings/mail', mailConfig(second))).status, 200);
  assert.deepEqual(Object.keys(store.getSettings().mailAccounts), [first, second]);
  let combined = await post('/api/account/select', { accountId: 'all' });
  assert.equal(combined.data.account.mode, 'combined');
  assert.deepEqual(combined.data.messages.map(message => message.accountId), [second, first]);
  assert.equal(new Set(combined.data.messages.map(message => message.viewId)).size, 2);
  assert.equal(combined.data.messages.every(message => message.id === 'shared-id'), true);
  assert.equal(combined.data.accounts.length, 2);
  assert.equal(combined.raw.includes('private-mail-password'), false);
  assert.equal(combined.data.messages.some(message => message.accountId === 'demo'), false);
  const patched = await scoped(first, '/api/messages/shared-id', { starred: true, read: true }, 'PATCH');
  assert.equal(patched.data.message.accountId, first);
  assert.equal(store.getMessage(first, 'shared-id').starred, true);
  assert.equal(store.getMessage(second, 'shared-id').starred, false);
  assert.equal((await post('/api/settings/mail', { ...mailConfig('FIRST@example.com'), password: '' })).status, 200);
  assert.deepEqual(Object.keys(store.getSettings().mailAccounts), [first, second]);
  assert.equal(store.getMessage(first, 'shared-id').starred, true);
  await post('/api/settings/ai', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture' });
  await post('/api/account/select', { accountId: 'all' });
  assert.equal((await scoped(second, '/api/ai', { action: 'summary', messageId: 'shared-id' })).status, 200);
  assert.equal(modelInputs.length, 1);
  assert.equal(modelInputs[0].length, 1);
  assert.equal(modelInputs[0][0].subject, second);
  assert.equal((await post('/api/ai', { action: 'summary', messageId: 'shared-id' })).status, 409);
  assert.equal((await post('/api/drafts', content)).status, 409);
  const firstDraft = (await scoped(first, '/api/drafts', { ...content, replyToId: 'shared-id' })).data.message;
  assert.equal(firstDraft.accountId, first);
  assert.equal((await scoped(second, '/api/drafts', { ...content, id: firstDraft.id })).status, 404);
  const send = { ...content, draftId: firstDraft.id, replyToId: 'shared-id', requestId: 'multi-account-send' };
  assert.equal((await scoped(first, '/api/send', send)).data.message.accountId, first);
  assert.equal((await scoped(first, '/api/send', send)).status, 200);
  assert.equal((await scoped(second, '/api/send', { ...content, requestId: send.requestId })).data.message.accountId, second);
  assert.deepEqual(deliveries, [first, second]);
  const preview = (await scoped(first, '/api/workflows/preview', { action: 'research', messageId: 'shared-id' })).data.preview;
  assert.equal((await scoped(second, '/api/workflows/apply', { previewId: preview.id })).status, 409);
  broken = second;
  const before = store.getMessage(second, 'shared-id');
  combined = await post('/api/sync');
  assert.equal(combined.status, 200);
  assert.equal(combined.data.account.id, 'all');
  assert.deepEqual(combined.data.syncErrors.map(error => error.accountId), [second]);
  assert.equal(combined.raw.includes('private-server-secret'), false);
  assert.deepEqual(store.getMessage(second, 'shared-id'), before);
  assert.equal(store.getMessage(first, 'shared-id').starred, true);
  const disconnected = await scoped(first, '/api/account/disconnect');
  assert.equal(disconnected.data.account.id, 'all');
  assert.deepEqual(disconnected.data.accounts.map(account => account.id), [second]);
  assert.equal(disconnected.data.messages.every(message => message.accountId === second), true);
  assert.ok(store.getMessage(first, 'shared-id'));
  assert.equal(store.getSettings().mailAccounts[first], undefined);
  assert.equal(store.getSettings().mail.email, second);
  assert.equal((await scoped(first, '/api/messages/shared-id', { read: false }, 'PATCH')).status, 409);
  restart();
  assert.deepEqual((await request('/api/state')).data.accounts.map(account => account.id), [second]);
  assert.equal((await scoped(second, '/api/account/disconnect')).data.messages.length, 0);
  assert.equal((await post('/api/account/select', { accountId: first })).status, 409);
  broken = '';
  const restored = await post('/api/settings/mail', mailConfig(first));
  assert.equal(restored.data.messages.find(message => message.id === 'shared-id').starred, true);
  assert.equal(restored.data.messages.some(message => message.id === 'sent:multi-account-send'), true);
});

test('an in-flight AI request stays with its owner across view changes and rejects replaced or disconnected connections', async t => {
  let begin, finish;
  const { store, post, request } = await workspace(t, { verifySmtp: async () => {}, fetchImapMessages: async () => [], runModel: async () => { begin(); await new Promise(resolve => { finish = resolve; }); return 'scoped output'; } });
  const owner = 'owner@example.com', other = 'other@example.com';
  store.setSettings({ mailAccounts: { [owner]: { email: owner, provider: 'imap' }, [other]: { email: other, provider: 'imap' } }, activeAccount: owner });
  store.upsertMessage(owner, { ...store.getMessage('demo', 'demo-1'), id: 'owned' });
  await post('/api/settings/ai', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture' });
  for (const change of ['view', 'reconnect', 'disconnect']) {
    const started = new Promise(resolve => { begin = resolve; });
    const pending = request('/api/ai', { method: 'POST', body: { action: 'summary', messageId: 'owned' }, headers: { 'X-Genmail-Account': owner } });
    await started;
    if (change === 'disconnect') await request('/api/account/disconnect', { method: 'POST', body: {}, headers: { 'X-Genmail-Account': owner } });
    else if (change === 'reconnect') await post('/api/settings/mail', mailConfig(owner));
    else await post('/api/account/select', { accountId: other });
    finish();
    const result = await pending;
    assert.equal(result.status, change === 'view' ? 200 : 409);
    assert.equal(result.raw.includes('scoped output'), change === 'view');
  }
});

test('multi-recipient drafts, Bcc-only sends, and delivery identity retain the complete recipient set', async t => {
  const { post } = await workspace(t);
  const draft = await post('/api/drafts', { ...content, to: 'first@example.com;second@example.com', cc: 'copy@example.com', bcc: 'hidden@example.com' });
  assert.equal(draft.status, 200);
  assert.equal(draft.data.message.bcc, 'hidden@example.com');
  const payload = { ...content, to: '', bcc: 'hidden@example.com', requestId: 'bcc-only-request' };
  const sent = await post('/api/send', payload);
  assert.equal(sent.status, 200);
  assert.equal(sent.data.message.to, '');
  assert.equal(sent.data.message.bcc, payload.bcc);
  assert.equal((await post('/api/send', payload)).status, 200);
  assert.equal((await post('/api/send', { ...payload, bcc: 'other@example.com' })).status, 409);
  assert.equal((await post('/api/send', { ...payload, cc: 'invalid', requestId: 'invalid-cc-request' })).status, 400);
  assert.equal((await post('/api/settings/preferences', { density: 'spacious', sort: 'unread' })).data.settings.preferences.sort, 'unread');
  assert.equal((await post('/api/settings/preferences', { sort: 'invalid' })).status, 400);
});

test('provider moves require explicit account and confirmation, isolate duplicate IDs, and reimport moved IMAP messages without duplicates', async t => {
  let remoteId = 'imap:55:7', writes = 0;
  const { store, post, request } = await workspace(t, {
    verifySmtp: async () => {},
    fetchImapMessages: async () => [{ id: remoteId, fromEmail: 'sender@example.com', fromName: 'Sender', to: 'me@example.com', subject: 'Move fixture', date: new Date().toISOString(), body: 'Fixture', folder: 'inbox', read: false, starred: false, labels: [] }],
    listImapFolders: async () => [{ id: 'Projects', name: 'Projects', kind: 'folder' }, { id: 'INBOX', name: 'Inbox', kind: 'inbox' }],
    organizeImapMessage: async (mail, message, folder) => {
      assert.equal(mail.email, 'first@example.com'); writes++;
      remoteId = folder.id === 'INBOX' ? 'imap:55:9' : 'imap:88:19';
      return { remoteId, providerFolderId: folder.id, providerFolderName: folder.name, folder: folder.kind === 'inbox' ? 'inbox' : 'archive' };
    },
  });
  for (const account of ['first@example.com', 'second@example.com']) assert.equal((await post('/api/settings/mail', mailConfig(account))).status, 200);
  const route = '/api/messages/imap%3A55%3A7/organize';
  const body = { destinationId: 'Projects', mode: 'move', confirmed: true };
  assert.equal((await request(route, { method: 'POST', body, headers: { 'X-Genmail-Account': undefined } })).status, 409);
  assert.equal((await request(route, { method: 'POST', body, headers: { 'X-Genmail-Account': 'all' } })).status, 409);
  const change = body => request(route, { method: 'POST', body, headers: { 'X-Genmail-Account': 'first@example.com' } });
  assert.equal((await change({ ...body, confirmed: false })).status, 400);
  assert.equal((await change({ ...body, destinationId: 'Unknown' })).status, 400);
  assert.equal(writes, 0);
  assert.equal((await change(body)).status, 200);
  assert.equal(store.getMessage('second@example.com', 'imap:55:7').folder, 'inbox');
  assert.equal(store.getMessage('first@example.com', 'imap:55:7').folder, 'archive');
  assert.equal((await change({ ...body, destinationId: 'INBOX' })).status, 200);
  assert.equal((await request('/api/sync', { method: 'POST', body: {}, headers: { 'X-Genmail-Account': 'first@example.com' } })).status, 200);
  assert.equal(store.listMessages('first@example.com').length, 1);
  assert.equal(store.getMessage('first@example.com', 'imap:55:7').remoteId, 'imap:55:9');
  assert.equal(writes, 2);
});

test('HTML footer snapshots survive saves and uncertain retries while the reply stays with its receiving mailbox', async t => {
  let calls = 0, delivered;
  const { store, request, post, restart } = await workspace(t, {
    sendSmtpMessage: async (mail, message) => {
      delivered = { mail, message }; calls++;
      if (calls === 1) throw new Error('Lost acknowledgement');
      return '<footer-fixture@example.com>';
    },
  });
  const owner = 'work@example.com', other = 'personal@example.com';
  store.setSettings({ activeAccount: 'all', mailAccounts: Object.fromEntries([owner, other].map(email => [email, { ...mailConfig(email), provider: 'imap' }])) });
  for (const account of [owner, other]) store.upsertMessage(account, { ...store.getMessage('demo', 'demo-1'), id: 'same-id', messageId: `<${account}>`, to: 'alias@example.com' });
  const saved = await post('/api/settings/preferences', { signatureFormat: 'html', signature: '<b>Leo</b><br><a href="https://example.com">Team</a><img src="https://track.invalid">' });
  assert.equal(saved.status, 200);
  const footer = saved.data.settings.footer;
  const preview = await post('/api/signature/preview', { signatureFormat: 'html', signature: '<b>Preview only</b>' });
  assert.equal(preview.data.footer.text, 'Preview only');
  assert.equal(store.getSettings().preferences.signature, footer.html);
  const payload = { ...content, replyToId: 'same-id', footer, requestId: 'footer-owned-reply' };
  const scoped = (path, body) => request(path, { method: 'POST', body, headers: { 'X-Genmail-Account': owner } });
  for (const footer of [null, false, '', 0]) assert.equal((await scoped('/api/drafts', { ...payload, footer })).status, 400);
  const draft = (await scoped('/api/drafts', payload)).data.message;
  assert.equal(draft.accountId, owner);
  assert.deepEqual(draft.footer, footer);
  payload.draftId = draft.id;
  const uncertain = await scoped('/api/send', payload);
  assert.equal(uncertain.status, 502);
  assert.equal(delivered.mail.email, owner);
  assert.equal(delivered.message.replyMessageId, `<${owner}>`);
  assert.deepEqual(uncertain.data.message.footer, footer);
  await post('/api/settings/preferences', { signature: '<i>New signature</i>' });
  restart();
  assert.equal((await scoped('/api/send', { ...payload, retryUnconfirmed: true, footer: { html: '<b>Changed</b>' } })).status, 409);
  const retried = await scoped('/api/send', { ...payload, retryUnconfirmed: true });
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.data.message.footer, footer);
  assert.deepEqual(delivered.message.footer, footer);
  assert.equal(calls, 2);
  assert.equal((await scoped('/api/send', payload)).status, 200);
  assert.equal(calls, 2);
  assert.equal(store.getMessage(other, 'sent:footer-owned-reply'), null);
});

test('new-mail summaries skip initial import, classify only newly synced mail, and persist per account', async t => {
  const seen = []; let arrivals = false, now = Date.parse('2026-09-24T02:00:00Z');
  const f = await workspace(t, {
    now: () => now, verifySmtp: async () => {},
    fetchImapMessages: async mail => ['existing', ...(arrivals ? ['new'] : [])].map(id => ({ id, subject: mail.email, body: 'Private body', fromEmail: 'private@example.com', date: '2026-09-24T00:00:00Z', folder: 'inbox', labels: [], starred: false })),
    runModel: async (ai, action, messages, prompt, options) => {
      seen.push({ action, messages, options });
      return JSON.stringify({ items: messages.map(message => ({ messageId: message.id, priority: 'P2', summary: message.subject })) });
    },
  });
  await f.post('/api/settings/ai', { baseUrl: 'https://model.invalid/v1', model: 'fixture' });
  await f.post('/api/settings/preferences', { language: '繁體中文', translationLanguage: '日本語' });
  await f.post('/api/settings/policy', { triggers: { onArrival: true }, content: { body: false, sender: false } });
  for (const account of ['a@example.com', 'b@example.com']) assert.equal((await f.post('/api/settings/mail', mailConfig(account))).status, 200);
  await f.automation.tick(); assert.equal(seen.length, 0);
  await f.post('/api/account/select', { accountId: 'all' });
  arrivals = true;
  await f.post('/api/sync'); await f.automation.tick();
  // The response is deliberately nonblocking; the queued tick may own the current run.
  for (let n = 0; n < 20 && f.automation.reports('b@example.com')[0]?.status !== 'completed'; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.length, 2);
  for (const call of seen) {
    assert.equal(call.messages.length, 1); assert.equal(call.messages[0].id, 'new');
    assert.equal(call.messages[0].body, ''); assert.equal(call.messages[0].fromEmail, '');
    assert.equal(call.options.structuredSummary, true);
    assert.equal(call.options.preferences.language, '繁體中文'); assert.equal(call.options.preferences.translationLanguage, '日本語');
  }
  const combined = (await f.request('/api/state')).data;
  assert.deepEqual(combined.workspace.summaries, []);
  for (const account of ['a@example.com', 'b@example.com']) {
    const messages = combined.messages.filter(message => message.accountId === account);
    assert.equal(messages.find(message => message.id === 'new').aiSummary.items[0].summary, account);
    assert.equal(messages.find(message => message.id === 'existing').aiSummary, null);
  }
  await f.post('/api/sync'); await f.automation.tick(); assert.equal(seen.length, 2);
  f.restart(); await f.automation.tick(); assert.equal(seen.length, 2);
  await f.post('/api/settings/policy', { triggers: { scheduledSummary: true }, maxMessages: 1, summarySchedule: { cadence: 'interval', everyHours: 1, timeZone: 'Asia/Hong_Kong' } });
  await f.automation.tick(); assert.equal(seen.length, 2);
  now += 3600000; await f.automation.tick(); assert.equal(seen.length, 4);
  assert.equal(seen[2].action, 'briefing'); assert.equal(seen[2].messages.length, 1);
  const scoped = (await f.request('/api/state', { headers: { 'X-Genmail-Account': 'a@example.com' } })).data;
  assert.equal(scoped.workspace.summaries[0].status, 'completed');
  await f.post('/api/settings/policy', { enabled: false });
  const hidden = (await f.request('/api/state')).data;
  assert.ok(hidden.messages.every(message => !message.aiSummary));
});

test('first import is account-bound, keeps folder IDs separate, resumes, and never triggers arrival AI for history', async t => {
  let calls = 0, lastFolder;
  const f = await workspace(t, { verifySmtp: async () => {}, fetchImapPage: async (mail, { folder }) => { calls++; lastFolder = folder; return { messages: [{ id: folder === 'sent' ? 'imap-folder:U2VudA:7:1' : 'imap:7:1', remoteId: 'imap:7:1', providerFolderId: folder === 'sent' ? 'Sent' : 'INBOX', messageId: folder === 'sent' ? '<already-sent@fixture>' : '', fromEmail: mail.email, to: 'friend@example.com', date: '2026-09-23T12:00:00.000Z', body: 'This is a sent or received history sample of useful length.', folder }], nextCursor: null }; }, now: () => Date.parse('2026-09-24T12:00:00Z') });
  const a = 'import@example.com';
  let result = await f.post('/api/settings/mail', { ...mailConfig(a), importOptions: { months: 3, inbox: true, sent: true } });
  assert.equal(result.status, 200); assert.equal(result.data.accounts[0].import.status, 'running'); assert.equal(result.data.messages.length, 0);
  f.store.upsertMessage(a, { id: 'sent:local', messageId: '<already-sent@fixture>', fromEmail: a, folder: 'sent', body: 'Original locally sent copy', date: '2026-09-23T12:00:00.000Z' });
  await f.post('/api/settings/policy', { triggers: { onArrival: true } });
  for (const path of ['/api/imports/start', '/api/imports/pause', '/api/style/settings', '/api/style/preview', '/api/style/generate']) {
    assert.equal((await f.request(path, { method: 'POST', body: {}, headers: { 'X-Genmail-Account': 'all' } })).status, 409);
    assert.equal((await f.request(path, { method: 'POST', body: {}, headers: { 'X-Genmail-Account': undefined } })).status, 409);
  }
  await f.automation.tick();
  await f.post('/api/imports/pause'); await f.automation.tick(); assert.equal(calls, 2);
  f.restart(); await f.post('/api/imports/resume'); await f.automation.tick();
  result = await f.request('/api/state');
  assert.equal(result.data.accounts[0].import.status, 'complete');
  assert.equal(result.data.messages.length, 2);
  assert.equal(new Set(result.data.messages.map(message => message.viewId)).size, 2);
  assert.equal(result.data.workspace.summaries.length, 0);
  assert.equal(f.store.getMessage(a, 'sent:local').body, 'Original locally sent copy');
  assert.equal(f.store.getMessage(a, 'sent:local').remoteId, 'imap:7:1');
  assert.equal(f.store.getMessage(a, 'sent:local').providerFolderId, 'Sent');
  await f.post('/api/imports/start', { months: 1, inbox: false, sent: true }); await f.automation.tick();
  assert.equal(f.store.listMessages(a).length, 2); // Shorter imports retain cache and do not duplicate Sent.
  assert.equal((await f.post('/api/imports/start', { months: 2 })).status, 400);
  result = await f.post('/api/settings/mail', { ...mailConfig('all-import@example.com'), importOptions: { months: 0, allMail: true, inbox: false, sent: false } });
  assert.equal(result.status, 200);
  assert.equal(lastFolder, 'all', 'All Mail connection verification must not require a special-use Sent folder');
  assert.equal(f.store.getSettings().imports['all-import@example.com'].since, '');
});

test('style API requires review, redacts to Sent bodies, honors account ownership and supplies only approved voice to replies', async t => {
  const calls = [], f = await workspace(t, { runModel: async (ai, action, messages, prompt, options) => { calls.push({ action, messages, options }); return action === 'style' ? { text: 'Use short paragraphs.', usage: { total_tokens: 90 } } : 'A draft.'; } });
  const a = 'writer@example.com';
  f.store.setSettings({ activeAccount: a, mailAccounts: { [a]: { email: a, connectionId: 'stable' } }, ai: { baseUrl: 'http://localhost:11434/v1', model: 'fixture' } });
  f.store.upsertMessage(a, { id: 'sent', fromEmail: a, to: 'private@example.com', subject: 'Private title', folder: 'sent', body: 'Please let me know your thoughts when you have a moment. Thank you for considering this request.', date: new Date(Date.now() - 3600000).toISOString() });
  await f.post('/api/settings/policy', { folders: { sent: true }, content: { body: true, contacts: false, sender: false, subject: false } });
  assert.equal((await f.post('/api/style/preview')).status, 403);
  await f.post('/api/style/settings', { enabled: true });
  let result = await f.post('/api/style/preview');
  const id = result.data.workspace.styleLearning.preview.id;
  assert.equal(calls.length, 0);
  assert.equal((await f.post('/api/style/apply', { previewId: id, voice: 'Unanalyzed' })).status, 409);
  result = await f.post('/api/style/generate', { previewId: id }); assert.equal(result.status, 200);
  assert.equal(result.data.workspace.styleLearning.preview.usage.total_tokens, 90);
  assert.deepEqual(Object.keys(calls[0].messages[0]), ['body']);
  await f.post('/api/style/apply', { previewId: id, voice: 'Reviewed short paragraphs.' });
  await f.post('/api/ai', { action: 'reply', messageId: 'sent' });
  assert.equal(calls.at(-1).options.styleVoice, 'Reviewed short paragraphs.'); assert.equal(calls.at(-1).options.brain, null);
  await f.request('/api/style/profile', { method: 'DELETE', body: {} });
  await f.post('/api/ai', { action: 'reply', messageId: 'sent' });
  assert.equal(calls.at(-1).options.styleVoice, '');
});

test('Out of Office OAuth upgrades are explicit, bound to the original account and preserve its workspace', async t => {
  let returnedEmail = 'owner@example.invalid', calls = 0, grantedScopes;
  const { store, request, post } = await workspace(t, { oauthFinish: (provider, { config }) => {
    calls++; return { provider, ...config, email: returnedEmail, accessToken: 'fixture-rotated', grantedScopes: grantedScopes ?? config.mailScope };
  } });
  for (const provider of ['google', 'microsoft']) {
    const owner = { provider, email: 'owner@example.invalid', connectionId: 'original', clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh', accessToken: 'fixture-access', grantedScopes: provider === 'google' ? 'https://www.googleapis.com/auth/gmail.modify' : 'Mail.ReadWrite Mail.Send' };
    const accounts = { [owner.email]: owner, 'other@example.invalid': { ...owner, email: 'other@example.invalid', connectionId: 'other' } };
    store.setSettings({ activeAccount: 'all', mailAccounts: accounts, imports: { [owner.email]: { retained: true } } });
    const input = { outOfOffice: true, forAccount: owner.email };
    assert.equal((await post(`/api/oauth/${provider}/start`, input)).status, 400);
    const begin = async () => {
      const start = await request(`/api/oauth/${provider}/start`, { method: 'POST', body: input, headers: { 'X-Genmail-Account': owner.email } });
      assert.equal(start.status, 200); assert.doesNotMatch(start.raw, /fixture-secret|fixture-refresh|fixture-access/);
      const url = new URL(start.data.url), auth = await request(url.pathname + url.search);
      const scopes = new URL(auth.headers.get('location')).searchParams.get('scope');
      assert.ok(scopes.includes(provider === 'google' ? 'gmail.settings.basic' : 'MailboxSettings.ReadWrite'));
      assert.ok(scopes.includes(provider === 'google' ? 'gmail.modify' : 'Mail.ReadWrite'));
      return () => request(`/api/oauth/${provider}/callback?state=${encodeURIComponent(url.searchParams.get('state'))}&code=fixture-code`, { headers: { Cookie: auth.headers.get('set-cookie').split(';')[0] } });
    };
    returnedEmail = 'wrong@example.invalid';
    let finish = await begin(); let result = await finish();
    assert.ok(new URL(result.headers.get('location')).searchParams.has('connectionError'));
    assert.deepEqual(store.getSettings().mailAccounts, accounts);
    returnedEmail = owner.email;
    finish = await begin(); store.setSettings({ mailAccounts: { ...accounts, [owner.email]: { ...owner, connectionId: 'replaced' } } });
    result = await finish(); assert.ok(new URL(result.headers.get('location')).searchParams.has('connectionError'));
    store.setSettings({ mailAccounts: accounts });
    for (const partial of [owner.grantedScopes, provider === 'google' ? 'https://www.googleapis.com/auth/gmail.settings.basic' : 'MailboxSettings.ReadWrite']) {
      grantedScopes = partial; finish = await begin(); result = await finish();
      assert.ok(new URL(result.headers.get('location')).searchParams.has('connectionError'));
      assert.deepEqual(store.getSettings().mailAccounts, accounts, 'Partial consent retains the original grant');
    }
    grantedScopes = undefined;
    const staleFinish = await begin(); finish = await begin(); result = await finish();
    assert.equal(new URL(result.headers.get('location')).searchParams.get('connected'), provider);
    const saved = store.getSettings(); assert.equal(saved.activeAccount, 'all'); assert.equal(saved.mailAccounts[owner.email].connectionId, 'original');
    assert.equal(saved.mailAccounts[owner.email].refreshToken, 'fixture-refresh'); assert.deepEqual(saved.mailAccounts['other@example.invalid'], accounts['other@example.invalid']);
    assert.deepEqual(saved.imports[owner.email], { retained: true });
    assert.ok(saved.mailAccounts[owner.email].authorizationId);
    result = await staleFinish(); assert.ok(new URL(result.headers.get('location')).searchParams.has('connectionError'));
    assert.deepEqual(store.getSettings().mailAccounts, saved.mailAccounts, 'An older consent window cannot overwrite the new grant');
    const exchanges = calls; await finish(); assert.equal(calls, exchanges, 'One-use callback cannot exchange again');
  }
});
