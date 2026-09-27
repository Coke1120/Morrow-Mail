import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument } from 'htmlparser2';
import { createServer } from 'vite';
import { DEFAULT_POLICY, DEFAULT_PREFERENCES } from '../shared/features.js';

let vite, scheduled, Compose, Settings, mailImportOptions;
before(async () => {
  vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  scheduled = await vite.ssrLoadModule('/src/Scheduled.jsx');
  ({ Compose } = await vite.ssrLoadModule('/src/App.jsx'));
  ({ default: Settings, mailImportOptions } = await vite.ssrLoadModule('/src/Settings.jsx'));
});
after(async () => { await vite?.close(); });
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const text = node => node.data || (node.children || []).map(text).join('');
const elements = (node, predicate) => [...(node.name && predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => elements(child, predicate))];
const disabled = node => Object.hasOwn(node.attribs, 'disabled');
const owner = 'owner@example.invalid', other = 'other@example.invalid';
const accounts = [owner, other].map(id => ({ id, email: id, mode: 'live', provider: 'google' }));
const sendAt = '2099-12-15T11:30:00+08:00';
const draft = { id: 'local-draft', accountId: owner, replyToId: 'same-provider-id', to: 'to@example.invalid', cc: 'cc@example.invalid', bcc: 'hidden@example.invalid', subject: 'Reviewed subject', body: 'Reviewed body', footer: { text: 'Footer', html: '' } };
const compose = initial => parseDocument(render(Compose, { initial, account: accounts[1], accounts, preferences: DEFAULT_PREFERENCES, policy: DEFAULT_POLICY, footer: {} }));

test('scheduled review normalizes time and captures only the immutable reviewed payload and original owner', () => {
  assert.equal(scheduled.scheduledTime(sendAt, 0), '2099-12-15T03:30:00.000Z');
  for (const value of ['', 'invalid', '1970-01-01T00:00:00Z']) assert.throws(() => scheduled.scheduledTime(value, 0), /future date and time/);
  const editable = structuredClone(draft);
  const review = scheduled.scheduledReview(editable, owner, sendAt);
  assert.equal(review.owner, owner);
  assert.match(review.payload.requestId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  assert.deepEqual(review.payload, { requestId: review.payload.requestId, sendAt: '2099-12-15T03:30:00.000Z', to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, body: draft.body, footer: draft.footer, replyToId: draft.replyToId, draftId: draft.id });
  editable.to = other; editable.body = 'Edited later'; editable.footer.text = 'Changed footer';
  assert.equal(review.payload.to, draft.to); assert.equal(review.payload.body, draft.body); assert.equal(review.payload.footer.text, 'Footer');
  const next = scheduled.scheduledReview({ ...draft, id: undefined, replyToId: undefined }, owner, sendAt);
  assert.notEqual(next.payload.requestId, review.payload.requestId);
  assert.equal(Object.hasOwn(next.payload, 'draftId'), false); assert.equal(Object.hasOwn(next.payload, 'replyToId'), false);
  for (const invalidOwner of ['', 'all', 'demo']) assert.throws(() => scheduled.scheduledReview(draft, invalidOwner, sendAt), /connected mailbox/);
});

test('schedule review shows Bcc, owner, content, timezone and late-send policy; uncertain creation retains its review', () => {
  const review = scheduled.scheduledReview(draft, owner, sendAt);
  const normal = parseDocument(render(scheduled.ScheduledReview, { review }));
  for (const expected of [owner, draft.to, draft.cc, draft.bcc, draft.subject, draft.body, 'Footer', Intl.DateTimeFormat().resolvedOptions().timeZone, 'Morrow must be open', '15 minutes', 'marked missed and requires review', 'Cancel the schedule']) assert.ok(text(normal).includes(expected), expected);
  assert.ok(elements(normal, node => node.name === 'button').some(node => text(node) === 'Edit schedule'));
  const uncertain = parseDocument(render(scheduled.ScheduledReview, { review, uncertain: true }));
  assert.deepEqual(elements(uncertain, node => node.name === 'button').map(text), ['Retry this schedule request']);
  assert.ok(text(uncertain).includes(draft.bcc));
  for (const props of [{ busy: true }, { locked: true }]) {
    const confirm = elements(parseDocument(render(scheduled.ScheduledReview, { review, ...props })), node => node.name === 'button')[0];
    assert.equal(disabled(confirm), true);
  }
});

test('Scheduled exposes cancellation only before claim, and uncertain delivery routes to draft review', () => {
  const statuses = ['scheduled', 'sending', 'sent', 'cancelled', 'missed', 'blocked', 'uncertain'];
  const jobs = statuses.map(status => ({ id: status, accountId: owner, draftId: draft.id, status, sendAt, payload: draft, requiresSendReview: status === 'uncertain' }));
  const articles = elements(parseDocument(render(scheduled.ScheduledRows, { jobs })), node => node.name === 'article');
  for (let index = 0; index < statuses.length; index++) {
    const names = elements(articles[index], node => node.name === 'button').map(text);
    const canCancel = ['scheduled', 'missed', 'blocked'].includes(statuses[index]);
    assert.equal(scheduled.cancellableSchedule(jobs[index]), canCancel);
    assert.equal(names.includes('Cancel schedule'), canCancel, statuses[index]);
    assert.equal(names.includes('Review unconfirmed draft'), statuses[index] === 'uncertain');
    for (const recipient of [owner, draft.to, draft.cc, draft.bcc]) assert.ok(text(articles[index]).includes(recipient));
  }
  const busy = elements(parseDocument(render(scheduled.ScheduledRows, { jobs, busy: true })), node => node.name === 'button');
  assert.ok(busy.every(disabled));
  const flattened = render(scheduled.ScheduledRows, { jobs: [{ ...jobs[0], payload: undefined, ...draft, subject: '<unsafe subject>' }] });
  assert.match(flattened, /&lt;unsafe subject&gt;/);
  assert.doesNotMatch(flattened, /<unsafe subject>/);
});

test('scheduled and sending draft markers lock editing and manual delivery while keeping the original owner', () => {
  for (const status of ['scheduled', 'sending']) {
    const document = compose({ ...draft, scheduledSend: { id: 'job', sendAt, status } });
    const sender = elements(document, node => node.attribs['aria-label'] === 'Sending account')[0];
    assert.equal(disabled(sender), true);
    assert.equal(elements(sender, node => Object.hasOwn(node.attribs, 'selected'))[0].attribs.value, owner);
    const fields = elements(document, node => ['input', 'textarea'].includes(node.name));
    assert.ok(fields.length >= 6); assert.ok(fields.every(disabled));
    for (const label of ['Save draft', 'Send email']) assert.equal(disabled(elements(document, node => node.name === 'button' && text(node) === label)[0]), true);
    assert.ok(elements(document, node => node.name === 'button').some(node => text(node) === 'Open Scheduled'));
  }
  for (const status of ['cancelled', 'missed', 'blocked']) {
    const document = compose({ ...draft, scheduledSend: { id: 'job', sendAt, status } });
    assert.equal(disabled(elements(document, node => node.attribs['aria-label'] === 'Message body')[0]), false);
    for (const label of ['Save draft', 'Send email']) assert.equal(disabled(elements(document, node => node.name === 'button' && text(node) === label)[0]), false);
  }
});

test('uncertain scheduled delivery uses the existing explicit Send review guard and cannot be scheduled again', () => {
  const document = compose({ ...draft, deliveryStatus: 'unconfirmed', deliveryRequestId: 'original-delivery', scheduledSend: { id: 'job', sendAt, status: 'uncertain' } });
  assert.match(text(document), /Check your provider’s Sent folder before retrying/);
  assert.match(text(document), /I checked Sent and want to retry this delivery/);
  assert.doesNotMatch(text(document), /Schedule send|Open Scheduled/);
  for (const label of ['Save draft', 'Send email']) assert.equal(disabled(elements(document, node => node.name === 'button' && text(node) === label)[0]), true);
  assert.equal(disabled(elements(document, node => node.attribs['aria-label'] === 'Message body')[0]), true);
  const check = elements(document, node => node.name === 'input' && node.attribs.type === 'checkbox');
  assert.equal(check.length, 1); assert.equal(disabled(check[0]), false); assert.equal(Object.hasOwn(check[0].attribs, 'checked'), false);
});

test('unlimited history preserves months zero and supports all mail for Gmail, Outlook and IMAP', () => {
  const options = { months: 0, allMail: true, inbox: false, sent: true };
  for (const provider of ['google', 'microsoft', 'imap']) {
    assert.deepEqual(mailImportOptions(options, provider), options);
    assert.deepEqual(mailImportOptions({ ...options, allMail: false }, provider), { ...options, allMail: false });
  }
});

test('Mail settings show All mail for every provider and disclose IMAP special-use exclusions', () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    for (const provider of ['google', 'microsoft', 'imap']) {
      const state = { account: accounts[0], accounts: [{ ...accounts[0], provider, import: { status: 'complete', imported: 7, options: { months: 0 }, currentFolder: 'all' } }], workspace: { styleLearning: { settings: { enabled: false, weekly: false, months: 3, maxSamples: 50, tokenBudget: 16000 } } }, settings: { mail: { configured: true, provider }, ai: {}, preferences: DEFAULT_PREFERENCES, policy: DEFAULT_POLICY } };
      const document = parseDocument(render(Settings, { state, initialTab: 'mail' }));
      assert.ok(elements(document, node => node.name === 'option' && node.attribs.value === '0').some(node => text(node) === 'All available history'));
      assert.doesNotMatch(text(document), /0 months/);
      assert.match(text(document), /All mail \(normal folders\)/);
      assert.match(text(document), /Start all mail import/);
      assert.match(text(document), /Gmail \/ Outlook exclude Spam\/Junk and Trash\/Deleted Items/);
      assert.match(text(document), /special-use flags to exclude Junk and Trash; folders without those flags may be imported/);
      assert.match(text(document), /skips virtual All \/ Flagged views and folders that cannot be selected/);
      assert.doesNotMatch(text(document), /all-folder import is not available|With All mail off:/);
    }
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
