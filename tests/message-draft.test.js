import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareDraft } from '../src/message-draft.js';

const message = { id: 'same-provider-id', viewId: 'owned-view-id', accountId: 'owner@example.invalid', folder: 'inbox', fromEmail: 'client-sender@example.invalid', to: 'client-recipient@example.invalid', subject: 'Client subject', body: 'Client body', bcc: 'client-private@example.invalid' };
const draft = { accountId: message.accountId, to: 'server-recipient@example.invalid', cc: '', bcc: '', subject: 'Server subject', body: 'Reviewed reply', replyToId: message.id };
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('prepare uses the captured mailbox and original ID, sends no client source fields, and returns server drafts', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    calls.push({ url, request });
    const { mode } = JSON.parse(request.body);
    const value = { ...draft, accountId: request.headers['X-Genmail-Account'] };
    if (!['reply', 'replyAll'].includes(mode)) { delete value.replyToId; value[mode === 'copy' ? 'sourceDraft' : 'forwarding'] = true; }
    return response({ draft: value });
  });
  for (const owner of [message.accountId, 'other@example.invalid']) {
    for (const mode of ['reply', 'replyAll', 'forward', 'copy']) {
      const controller = new AbortController();
      const body = ['reply', 'replyAll'].includes(mode) ? 'Reviewed reply' : undefined;
      const result = await prepareDraft({ ...message, accountId: owner }, mode, { body, signal: controller.signal });
      const { url, request } = calls.at(-1);
      assert.equal(url, '/api/drafts/prepare'); assert.equal(request.method, 'POST');
      assert.equal(request.headers['X-Genmail-Account'], owner); assert.equal(request.signal, controller.signal);
      assert.deepEqual(JSON.parse(request.body), { messageId: message.id, mode, ...(body === undefined ? {} : { body }) });
      assert.equal(result.accountId, owner); assert.equal(result.subject, 'Server subject');
      assert.equal(result.to, 'server-recipient@example.invalid');
      assert.doesNotMatch(request.body, /owned-view-id|client-|Client subject|Client body/);
    }
  }
  await prepareDraft(message, 'reply');
  assert.deepEqual(JSON.parse(calls.at(-1).request.body), { messageId: message.id, mode: 'reply' });
});

test('invalid requests, mismatched results, HTTP failures and cancelled responses cannot become editable drafts', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => response({ draft }));
  for (const accountId of [undefined, '', 'all']) await assert.rejects(prepareDraft({ ...message, accountId }, 'reply'), /original mailbox/);
  await assert.rejects(prepareDraft({ ...message, id: '' }, 'copy'), /original mailbox/);
  for (const [mode, body] of [['unknown', undefined], ['copy', 'text'], ['forward', 'text'], ['reply', null]]) await assert.rejects(prepareDraft(message, mode, { body }), /Invalid draft/);
  assert.equal(fetch.mock.callCount(), 0);
  for (const invalid of [null, { ...draft, accountId: 'other@example.invalid' }, { ...draft, replyToId: 'view-id' }, { ...draft, body: null }, { ...draft, id: 'provider-original' }, { ...draft, providerDraft: true }, { ...draft, deliveryRequestId: 'old-delivery' }]) {
    fetch.mock.mockImplementation(async () => response({ draft: invalid }));
    await assert.rejects(prepareDraft(message, 'reply'), /could not be verified/);
  }
  fetch.mock.mockImplementation(async () => response({ draft }));
  for (const mode of ['copy', 'forward']) await assert.rejects(prepareDraft(message, mode), /could not be verified/);
  fetch.mock.mockImplementation(async () => response({ error: 'Reconnect the original mailbox.' }, 409));
  await assert.rejects(prepareDraft(message, 'reply'), error => error.status === 409 && error.message === 'Reconnect the original mailbox.');
  const waiting = deferred(), controller = new AbortController();
  fetch.mock.mockImplementation(() => waiting.promise);
  const pending = prepareDraft(message, 'reply', { signal: controller.signal });
  controller.abort(); waiting.resolve(response({ draft }));
  await assert.rejects(pending, { name: 'AbortError' });
});

// Execute the actual component handlers with controlled closures; no browser or new test runtime.
async function handler(file, start, end, scope) {
  const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `${file} handler boundaries`);
  return Function(...Object.keys(scope), `return (${source.slice(first, last).trim()});`)(...Object.values(scope));
}

async function draftHandler(kind) {
  const waiting = deferred(), opened = [], errors = [], requests = [], busy = [], flags = { valid: true }, ref = current => ({ current });
  const scope = { prepareDraft: (...args) => { requests.push(args); return waiting.promise; }, setError: value => { if (value) errors.push(value); }, setBusy: value => busy.push(value), onCompose: value => opened.push(value) };
  let run, invalidate, cancel;
  if (kind === 'reader') {
    Object.assign(scope, { page: 'mail', selected: message, detailLoaded: true, composer: ref(null), draftRequest: ref(null), accountVersion: ref(1), draftContextKey: 'original', draftContext: ref('original'), setPreparingDraft: scope.setBusy, setCompose: scope.onCompose, notify: scope.setError });
    run = await handler('App.jsx', 'async function prepareSelectedDraft(', '\n  function openSelectedDraft', scope);
    invalidate = () => { scope.draftContext.current = 'changed-detail-or-owner'; };
    cancel = () => scope.draftRequest.current.abort();
  } else if (kind === 'popup') {
    Object.assign(scope, { result: { text: draft.body }, original: { message }, pending: ref(null), valid: () => flags.valid, onUse: scope.onCompose, close: () => { flags.valid = false; } });
    run = await handler('MessageAI.jsx', 'async function useDraft()', '\n  useEffect(', scope);
    invalidate = () => { flags.valid = false; };
    cancel = () => scope.pending.current.abort();
  } else if (kind === 'studio') {
    Object.assign(scope, { output: { action: 'reply', message, text: draft.body }, pending: ref(null), composeOpen: false, accountKey: message.accountId, state: {}, chosen: message, messageAIContext: (_state, source) => ({ key: JSON.stringify([source.accountId, source.id]) }), draftContextKey: 'original', draftContext: ref('original') });
    run = await handler('Studio.jsx', 'async function useDraft()', '\n  function saveSkill', scope);
    invalidate = () => { scope.draftContext.current = 'changed-source-policy-or-composer'; };
    cancel = () => scope.pending.current.controller.abort();
  } else {
    Object.assign(scope, { owner: message.accountId, inFlight: ref(false), disabled: false, revision: ref(0), currentOwner: ref(message.accountId), contextKey: 'original', currentContext: ref('original'), preparing: ref(null), api: async () => ({ message, text: draft.body }) });
    const action = await handler('ReplySuggestions.jsx', 'async function action(', '\n  const locked', scope);
    run = () => action('use', { id: 'proposal' });
    invalidate = () => { scope.currentContext.current = 'changed-owner-policy-or-composer'; };
    cancel = () => scope.preparing.current.abort();
  }
  return { run: () => run('reply', draft.body), invoke: run, waiting, opened, errors, requests, busy, invalidate, cancel, scope };
}

for (const kind of ['reader', 'popup', 'studio', 'suggestions']) {
  test(`${kind} waits for preparation, blocks duplicate interactions, drops stale/cancelled results and reports retryable errors`, async () => {
    for (const outcome of ['success', 'stale', 'cancel', 'error']) {
      const value = await draftHandler(kind);
      const first = value.run();
      await Promise.resolve();
      assert.equal(value.requests.length, 1);
      assert.equal(value.requests[0][0].accountId, message.accountId);
      assert.equal(value.requests[0][0].id, message.id);
      assert.equal(value.requests[0][1], 'reply');
      assert.equal(value.requests[0][2].body, draft.body);
      await value.run();
      assert.equal(value.requests.length, 1); assert.deepEqual(value.opened, []);
      if (outcome === 'stale') value.invalidate();
      if (outcome === 'cancel') value.cancel();
      if (outcome === 'error') value.waiting.reject(new Error('Preparation failed. Retry.'));
      else value.waiting.resolve(draft);
      await first;
      assert.deepEqual(value.opened, outcome === 'success' ? [draft] : []);
      assert.deepEqual(value.errors, outcome === 'error' ? ['Preparation failed. Retry.'] : []);
      assert.ok(!value.busy.at(-1));
    }
  });
}

test('reader discards late responses after owner, selection or composer changes independently', async () => {
  for (const change of [
    value => { value.scope.accountVersion.current++; },
    value => { value.scope.draftContext.current = 'other-selected-message'; },
    value => { value.scope.composer.current = { id: 'draft-already-being-edited' }; },
  ]) {
    const value = await draftHandler('reader'), pending = value.run();
    change(value); value.waiting.resolve(draft); await pending;
    assert.deepEqual(value.opened, []); assert.deepEqual(value.errors, []);
  }
  const value = await draftHandler('suggestions'), pending = value.run();
  await Promise.resolve();
  value.scope.currentOwner.current = 'other@example.invalid';
  value.waiting.resolve(draft); await pending;
  assert.deepEqual(value.opened, []);
});

test('reader copy finishes before Compose, local saved drafts retain their identifiers, and composer cannot be replaced', async () => {
  const value = await draftHandler('reader');
  const { scope, opened, waiting, requests } = value;
  scope.selected = { ...message, folder: 'drafts', providerDraft: true };
  scope.prepareSelectedDraft = value.invoke;
  const open = await handler('App.jsx', 'function openSelectedDraft()', '\n  function reply(', scope);
  const pending = open();
  assert.equal(requests.length, 1); assert.equal(requests[0][1], 'copy'); assert.equal(requests[0][2].body, undefined);
  open(); assert.equal(requests.length, 1); assert.deepEqual(opened, []);
  const { replyToId, ...unthreaded } = draft;
  const copy = { ...unthreaded, sourceDraft: true };
  waiting.resolve(copy); await pending; assert.deepEqual(opened, [copy]);
  opened.length = 0;
  scope.selected.providerDraft = false;
  scope.selected.deliveryRequestId = 'uncertain-request'; scope.selected.deliveryStatus = 'unconfirmed';
  open(); assert.deepEqual(opened, [scope.selected]); assert.equal(requests.length, 1);
  scope.composer.current = {}; open(); assert.equal(opened.length, 1);
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /if \(next && composer\.current\) return/);
  assert.match(source, /draftToOpen === messageKey\(selected\).*openSelectedDraft\(\)/);
  assert.doesNotMatch(source, /setCompose\(result\.message\)|copyProviderDraft|replyDraft|forwardDraft/);
});

test('Compose SSR accepts prepared drafts and saved local drafts, locks their owner, and never prepares during render', async t => {
  const { createServer } = await import('vite');
  const { default: React } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const { DEFAULT_POLICY, DEFAULT_PREFERENCES } = await import('../shared/features.js');
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  t.after(() => vite.close());
  const { Compose } = await vite.ssrLoadModule('/src/App.jsx');
  const accounts = [message.accountId, 'other@example.invalid'].map(id => ({ id, email: id, mode: 'live' }));
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Rendering must not prepare drafts.'); });
  const render = initial => renderToString(React.createElement(Compose, { initial, account: accounts[1], accounts, preferences: DEFAULT_PREFERENCES, policy: DEFAULT_POLICY, footer: {} }));
  const { replyToId, ...unthreaded } = draft;
  for (const initial of [{}, draft, { ...unthreaded, forwarding: true }, { ...unthreaded, sourceDraft: true }, { ...draft, id: 'local-draft', deliveryStatus: 'unconfirmed', deliveryRequestId: 'original-request' }]) {
    const html = render(initial), sender = html.match(/<select aria-label="Sending account"[^>]*>/)[0];
    assert.doesNotMatch(html, /Demo workspace|value="demo"/);
    if (initial.accountId) { assert.match(sender, /disabled/); assert.match(html, /<option value="owner@example.invalid" selected=""/); }
    else assert.doesNotMatch(sender, /disabled/);
    if (initial.forwarding) assert.match(html, /Forward message|Attachments are not included/);
    if (initial.sourceDraft) { assert.match(html, /Editing a local copy/); assert.doesNotMatch(html, /Delivery could not be confirmed/); }
    if (initial.id) assert.match(html, /I checked Sent and want to retry this delivery/);
  }
  assert.throws(() => render({ ...message, folder: 'drafts', providerDraft: true }), /Prepare a local copy/);
  assert.equal(fetch.mock.callCount(), 0);
});
