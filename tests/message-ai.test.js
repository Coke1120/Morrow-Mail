import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { DEFAULT_POLICY, DEFAULT_PREFERENCES } from '../shared/features.js';

test('Reader AI popup scope, guards and compact disclosures preserve the original mailbox', async t => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  t.after(() => vite.close());
  const { default: MessageAI, messageAIContext } = await vite.ssrLoadModule('/src/MessageAI.jsx');
  const { ReaderHeader, ReaderSummary } = await vite.ssrLoadModule('/src/App.jsx');
  const message = { id: 'collision', viewId: 'owned-fixture', accountId: 'one@example.invalid', folder: 'inbox', subject: 'A short subject', fromName: 'Sender', fromEmail: 'sender@example.invalid', to: 'one@example.invalid', cc: 'cc@example.invalid', bcc: 'private@example.invalid', date: '2026-09-27T10:15:00Z', body: 'A fixture message.', labels: ['Custom label'] };
  const state = { revision: 'fixture-1', account: { id: 'all', mode: 'combined' }, accounts: [{ id: message.accountId, settings: { configured: true, provider: 'google' } }, { id: 'two@example.invalid' }], settings: { policy: structuredClone(DEFAULT_POLICY), preferences: DEFAULT_PREFERENCES, ai: { configured: true, model: 'fixture-model' } }, workspace: {} };
  const render = (options = {}) => renderToStaticMarkup(React.createElement(MessageAI, { state, message, action: 'reply', includeHistory: true, loaded: true, onClose() {}, onUse() {}, ...options }));
  const context = (value = state, source = message, history = true, loaded = true) => messageAIContext(value, source, 'reply', history, loaded);
  assert.equal(context().reason, '');
  const html = render();
  assert.match(html, /<dialog[^>]*aria-labelledby="modal-title"/);
  assert.match(html, /Suggest with History/);
  assert.match(html, /downloaded mail from the same sender in this mailbox/);
  assert.match(html, /does not fetch or scan all mail on your provider/);
  assert.match(html, /Saved folders/); assert.match(html, /Email content/);
  assert.match(html, /Up to 8 messages, including this message/);
  assert.match(html, /Generate reply<\/button>/);
  assert.doesNotMatch(html, /Use in Draft|AI Studio/);
  assert.match(html, /Nothing is sent or saved automatically/);
  for (const [action, title] of [['summary', 'Summarize message'], ['reply', 'Suggest reply'], ['translate', 'Translate message']]) {
    const regular = render({ action, includeHistory: false });
    assert.match(regular, new RegExp(title));
    assert.doesNotMatch(regular, /History scope|Generate reply/);
    if (action === 'translate') assert.match(regular, /Translate to English/);
  }

  for (const mutate of [
    value => { value.settings.policy.enabled = false; },
    value => { value.settings.policy.behaviors.reply = false; },
    value => { value.settings.policy.folders.inbox = false; },
    value => { value.settings.policy.content.sender = false; },
    value => { value.settings.ai.configured = false; },
    value => { value.accounts[0].settings.configured = false; },
    value => { value.accounts = value.accounts.filter(account => account.id !== message.accountId); },
    value => { value.account.id = 'two@example.invalid'; },
  ]) {
    const changed = structuredClone(state); mutate(changed);
    assert.notEqual(context(changed).reason, '');
    const blocked = render({ state: changed });
    assert.match(blocked, /role="alert"/);
    assert.doesNotMatch(blocked, /Generate reply<\/button>|Use in Draft/);
  }
  assert.notEqual(context(state, message, true, false).reason, '');
  assert.notEqual(context(state, { ...message, fromEmail: '' }).reason, '');
  const noSender = structuredClone(state); noSender.settings.policy.content.sender = false;
  assert.equal(context(noSender, message, false).reason, '', 'ordinary reply does not require history matching permission');

  // These inputs revoke an existing result, even if the provider IDs collide.
  const original = context().key;
  for (const field of ['id', 'viewId', 'accountId', 'folder', 'body', 'subject', 'fromEmail', 'to', 'cc', 'bcc', 'date']) {
    assert.notEqual(context(state, { ...message, [field]: 'changed' }).key, original, field);
  }
  for (const mutate of [
    value => { value.settings.policy.maxMessages = 2; },
    value => { value.settings.preferences = { ...value.settings.preferences, language: '繁體中文' }; },
    value => { value.settings.ai.model = 'other'; },
    value => { value.accounts[0].settings.configured = false; },
    value => { value.workspace.brain = { voice: 'Changed writing style' }; },
  ]) { const changed = structuredClone(state); mutate(changed); assert.notEqual(context(changed).key, original); }
  assert.equal(context(state, { ...message, read: true, starred: true }).key, original, 'read/star updates are not a new source');

  const header = renderToStaticMarkup(React.createElement(ReaderHeader, { message }));
  assert.match(header, /<details class="reader-details"><summary>/);
  assert.doesNotMatch(header, /<details[^>]*open/);
  for (const value of [message.subject, message.accountId, message.cc, message.bcc, message.fromEmail, 'Custom label']) assert.ok(header.includes(value));
  assert.match(header, /<time dateTime="2026-09-27T10:15:00Z">/);
  const summary = renderToStaticMarkup(React.createElement(ReaderSummary, { title: 'AI summary', text: 'Stored result without a new model request.', metadata: 'Review before using.' }));
  assert.match(summary, /<details class="reader-summary"><summary>/);
  assert.doesNotMatch(summary, /<details[^>]*open|<button/);
  assert.match(summary, /<pre>Stored result without a new model request\.<\/pre>/);
});
