import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createStore } from '../server/store.js';
import { createHistory, importOptions, monthsAgo } from '../server/history.js';
import { createLearning, identity, ownText } from '../server/learning.js';
import { updatePolicy } from '../server/policy.js';

function fixture(t, runModel = async () => ({ text: 'Friendly, direct, short paragraphs.', usage: { total_tokens: 250 } })) {
  const directory = mkdtempSync(`${tmpdir()}/morrow-learning-`), store = createStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let now = Date.parse('2026-09-24T12:00:00Z');
  const accounts = ['a@example.com', 'b@example.com'];
  store.setSettings({ mailAccounts: Object.fromEntries(accounts.map(email => [email, { email, provider: 'imap', connectionId: email }])), ai: { baseUrl: 'http://localhost:11434/v1', model: 'fixture', maxTokens: 800 }, policy: updatePolicy({}, { folders: { sent: true }, content: { body: true, contacts: false, subject: false, sender: false }, maxMessages: 50 }) });
  const connection = account => store.getSettings().mailAccounts[account];
  const options = { store, connection, now: () => now, runModel };
  const learning = createLearning(options);
  const add = (account, id, patch = {}) => store.upsertMessage(account, { id, folder: 'sent', date: new Date(now - 3600000).toISOString(), fromEmail: account, to: 'recipient@example.com', subject: 'private subject', body: 'Hello, I would appreciate your thoughts on the proposed timetable. Thank you for your help.', ...patch });
  return { store, learning, options, connection, accounts, add, advance: ms => { now += ms; }, now: () => now };
}

test('import ranges clamp calendar months; pages checkpoint, pause, resume, and isolate reconnects', async t => {
  assert.equal(monthsAgo(1, Date.parse('2024-03-31T12:00:00Z')), '2024-02-29T12:00:00.000Z');
  for (const input of [null, [], { months: 2 }, { inbox: false, sent: false }, { sent: 1 }, { unknown: true }]) assert.throws(() => importOptions(input), { status: 400 });
  const f = fixture(t), calls = [];
  const dependencies = { ...f.options, lock: work => work(), currentMail: async account => f.connection(account), importMessages: (mail, rows) => { const ids = rows.filter(row => !f.store.getMessage(mail.email, row.id)).map(row => row.id); for (const row of rows) f.store.upsertMessage(mail.email, row); return ids; }, fetchPage: async (mail, input) => { calls.push(input); return { messages: [{ id: `${input.folder}:${input.cursor || 'first'}`, date: '2026-09-01T00:00:00.000Z', folder: input.folder }], nextCursor: input.cursor ? null : 'second' }; } };
  const history = createHistory(dependencies);
  history.start(f.accounts[0], { months: 3, inbox: true, sent: true });
  await history.tick();
  assert.equal(history.status(f.accounts[0]).imported, 1);
  history.control(f.accounts[0], 'pause'); await history.tick(); assert.equal(calls.length, 1);
  history.control(f.accounts[0], 'resume');
  const restarted = createHistory(dependencies);
  await restarted.tick(); await restarted.tick(); await restarted.tick();
  assert.deepEqual(calls.map(item => [item.folder, item.cursor]), [['inbox', null], ['inbox', 'second'], ['sent', null], ['sent', 'second']]);
  assert.equal(restarted.status(f.accounts[0]).status, 'complete');
  assert.equal(restarted.status(f.accounts[0]).imported, 4);
  assert.equal(f.store.listMessages(f.accounts[1]).length, 0);
  restarted.start(f.accounts[0], {});
  f.store.setSettings({ mailAccounts: { ...f.store.getSettings().mailAccounts, [f.accounts[0]]: { ...f.connection(f.accounts[0]), connectionId: 'new' } } });
  await restarted.tick(); assert.equal(restarted.status(f.accounts[0]).status, 'paused'); assert.equal(calls.length, 4);
  let index = 0;
  const looping = createHistory({ ...dependencies, fetchPage: async () => ({ messages: [], nextCursor: ['a', 'b', 'a'][index++] }) });
  looping.start(f.accounts[0], {});
  await looping.tick(); await looping.tick(); await looping.tick();
  assert.equal(looping.status(f.accounts[0]).status, 'failed');
});

test('style previews enforce dates, ownership, scopes, deduplication, context cap and budget before model use', async t => {
  const calls = [], f = fixture(t, async (...args) => { calls.push(args); return { text: 'Friendly and concise.', usage: { total_tokens: 100 } }; }), a = f.accounts[0];
  f.add(a, 'sample', { body: 'Hello, I would appreciate your thoughts on the proposed timetable. Thank you for your help.\n\nOn Monday Alice wrote:\nPRIVATE QUOTED CONTENT' });
  f.add(a, 'duplicate');
  f.add(a, 'inbox', { folder: 'inbox' }); f.add(a, 'foreign', { fromEmail: 'other@example.com' }); f.add(a, 'old', { date: '2025-01-01T00:00:00Z' }); f.add(a, 'auto', { automated: true });
  f.add(f.accounts[1], 'sample', { body: 'OTHER ACCOUNT SECRET '.repeat(5) });
  assert.throws(() => f.learning.prepare(a), { status: 403 });
  for (const settings of [{ maxSamples: 51 }, { tokenBudget: 3999 }, { weekly: true }, { months: 2 }, { enabled: 'yes' }]) assert.throws(() => f.learning.updateSettings(a, settings), { status: 400 });
  f.learning.updateSettings(a, { enabled: true, tokenBudget: 4000 });
  let preview = f.learning.prepare(a);
  assert.equal(preview.sampleCount, 1); assert.equal(preview.eligible, 1); assert.ok(preview.estimatedTokens <= 4000);
  assert.equal(calls.length, 0); assert.equal(f.learning.voice(a), '');
  assert.doesNotMatch(JSON.stringify(f.learning.state(a)), /PRIVATE QUOTED|OTHER ACCOUNT|private subject|recipient@example/);
  await assert.rejects(f.learning.generate(f.accounts[1], preview.id), { status: 409 });
  await f.learning.generate(a, preview.id);
  assert.deepEqual(Object.keys(calls[0][2][0]), ['body']);
  assert.doesNotMatch(JSON.stringify(calls), /PRIVATE QUOTED|OTHER ACCOUNT|private subject|recipient@example/);
  assert.equal(f.learning.voice(a), '');
  f.learning.apply(a, { previewId: preview.id, voice: 'Edited concise style.' });
  assert.equal(f.learning.voice(a), 'Edited concise style.');
  assert.throws(() => f.learning.apply(a, { previewId: preview.id, voice: 'Repeated' }), { status: 409 });
  f.store.setSettings({ policy: updatePolicy(f.store.getSettings().policy, { content: { body: false } }) });
  assert.equal(f.learning.voice(a), ''); assert.throws(() => f.learning.prepare(a), { status: 403 });
  f.store.setSettings({ policy: updatePolicy(f.store.getSettings().policy, { content: { body: true }, maxMessages: 1 }) });
  f.add(a, 'different', { body: 'Could you please confirm the next steps before we schedule the review? Many thanks for your time.' });
  preview = f.learning.prepare(a); assert.equal(preview.sampleCount, 1); assert.equal(preview.effectiveCap, 1);
  f.learning.clear(a); assert.equal(f.learning.state(a).profile, null); assert.equal(f.learning.state(a).settings.enabled, false);
});

test('pending style results cannot survive revoked permissions, changed sources or replay after restart', async t => {
  let release;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; })), a = f.accounts[0];
  f.add(a, 'sample'); f.learning.updateSettings(a, { enabled: true });
  let preview = f.learning.prepare(a);
  const pending = f.learning.generate(a, preview.id);
  await assert.rejects(f.learning.generate(a, preview.id), { status: 409 });
  f.store.setSettings({ policy: updatePolicy(f.store.getSettings().policy, { folders: { sent: false } }) });
  release({ text: 'Do not save me.' }); await assert.rejects(pending, { status: 502 });
  assert.equal(f.learning.state(a).preview, null); assert.equal(f.learning.voice(a), '');
  f.store.setSettings({ policy: updatePolicy(f.store.getSettings().policy, { folders: { sent: true } }) });
  preview = f.learning.prepare(a);
  f.store.updateMessage(a, 'sample', { body: 'Changed text after the preview '.repeat(3) });
  await assert.rejects(f.learning.generate(a, preview.id), { status: 409 });
  preview = f.learning.prepare(a);
  const data = f.store.getSettings().styleLearning;
  data[a].preview.status = 'running'; f.store.setSettings({ styleLearning: data });
  const restart = createLearning(f.options);
  assert.equal(restart.state(a).preview.status, 'interrupted');
  await assert.rejects(restart.generate(a, preview.id), { status: 409 });
});

test('weekly learning uses only newly sent mail, remains opt-in, and never overwrites approved style', async t => {
  const calls = [], f = fixture(t, async (ai, action, messages) => { calls.push(messages); return { text: 'New weekly style.' }; }), a = f.accounts[0];
  f.add(a, 'old'); f.learning.updateSettings(a, { enabled: true, weekly: true });
  await f.learning.tick(); assert.equal(calls.length, 0);
  f.advance(7 * 86400000); f.add(a, 'new', { body: 'NEW WEEKLY SAMPLE: Please review the attached discussion before we meet. Thank you for taking the time.' });
  await f.learning.tick(); assert.equal(calls.length, 1); assert.equal(calls[0].length, 1); assert.match(calls[0][0].body, /NEW WEEKLY SAMPLE/);
  assert.equal(f.learning.voice(a), ''); assert.equal(f.learning.state(a).preview.status, 'ready');
  f.advance(7 * 86400000); await f.learning.tick(); assert.equal(calls.length, 1);
  const preview = f.learning.state(a).preview; f.learning.apply(a, { previewId: preview.id, voice: preview.voice });
  await f.learning.tick(); assert.equal(calls.length, 1); // No new samples.
  assert.equal(ownText('Hello there, here is the answer.\n-- \nMy signature'), 'Hello there, here is the answer.');
});

test('re-enabled weekly learning starts at renewed consent and expired previews cannot block future runs', async t => {
  const calls = [], f = fixture(t, async (ai, action, messages) => { calls.push(messages); return { text: 'Concise weekly style.' }; }), a = f.accounts[0];
  f.add(a, 'initial'); f.learning.updateSettings(a, { enabled: true });
  const first = f.learning.prepare(a); await f.learning.generate(a, first.id);
  f.learning.apply(a, { previewId: first.id, voice: 'Approved initial style.' });
  f.advance(2 * 86400000); f.add(a, 'during-pause', { body: 'PAUSED PERIOD: This message predates weekly consent and must not be analyzed on the new schedule.' });
  f.learning.updateSettings(a, { weekly: true });
  f.advance(7 * 86400000); f.add(a, 'after-consent', { body: 'AFTER CONSENT: Please share the revised timetable when you have an opportunity. Thank you for your help.' });
  await f.learning.tick(); assert.equal(calls.length, 2); assert.equal(calls[1].length, 1); assert.match(calls[1][0].body, /AFTER CONSENT/);
  f.store.setSettings({ ai: { ...f.store.getSettings().ai, model: 'changed-model' } });
  assert.equal(f.learning.state(a).preview, null);
  f.advance(7 * 86400000); f.add(a, 'next-week', { body: 'NEXT WEEK: Thank you for the updated proposal. Please confirm your preferred schedule at your convenience.' });
  await f.learning.tick(); assert.equal(calls.length, 3); assert.match(calls[2][0].body, /NEXT WEEK/);
  assert.equal(f.learning.voice(a), 'Approved initial style.');
});

test('manual learning keeps approved style through preview cancellation and proposal replacement without changing Email Brain', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls += 1; return { text: 'Proposed updated style.' }; }), a = f.accounts[0];
  const workspaces = { [a]: { brain: { contacts: ['Existing contact'], notes: 'Existing notes', voice: 'Manually written voice' } }, [f.accounts[1]]: { brain: { notes: 'Other account' } } };
  f.store.setSettings({ workspaces });
  f.add(a, 'sample'); f.learning.updateSettings(a, { enabled: true });
  const first = f.learning.prepare(a); await f.learning.generate(a, first.id);
  f.learning.apply(a, { previewId: first.id, voice: 'Approved original style.' });
  const prepared = f.learning.prepare(a); // Cancel here: preview is retained without an AI call.
  assert.equal(calls, 1); assert.equal(f.learning.state(a).preview.status, 'prepared');
  assert.equal(f.learning.voice(a), 'Approved original style.');
  await f.learning.generate(a, prepared.id);
  assert.equal(f.learning.voice(a), 'Approved original style.');
  const replacement = f.learning.prepare(a); // Replacing a ready proposal still leaves approval intact.
  assert.notEqual(replacement.id, prepared.id); assert.equal(calls, 2);
  assert.equal(f.learning.voice(a), 'Approved original style.');
  await f.learning.generate(a, replacement.id);
  f.learning.apply(a, { previewId: replacement.id, voice: 'Explicitly approved update.' });
  assert.equal(f.learning.voice(a), 'Explicitly approved update.');
  assert.deepEqual(f.store.getSettings().workspaces, workspaces);
  assert.equal(f.learning.state(f.accounts[1]).profile, null);
});

test('account identity requires explicit confirmation, validates safe fields and never infers from signatures', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls += 1; throw new Error('Identity must not call AI'); }), a = f.accounts[0], b = f.accounts[1];
  const workspaces = { [a]: { brain: { notes: 'Keep notes', voice: 'Keep manual voice', contacts: ['Keep contact'] } } };
  f.store.setSettings({ workspaces, preferences: { displayName: 'Not confirmed', signature: 'Inferred name' } });
  f.add(a, 'signed', { body: 'Hello, this signature is not a confirmed identity. Kind regards, Inferred Name.' });
  assert.equal(identity(f.store.getSettings(), a), null);
  assert.deepEqual(f.learning.state(a).settings.identity, { displayName: '', aliases: [], confirmed: false });
  f.learning.updateSettings(a, { identity: { displayName: ' Leo Ho ', aliases: [' Leo ', 'leo', 'LEO HO', '何先生'], confirmed: false } });
  assert.equal(identity(f.store.getSettings(), a), null);
  f.learning.updateSettings(a, { identity: { displayName: ' Leo Ho ', aliases: [' Leo ', 'leo', 'LEO HO', '何先生'], confirmed: true } });
  assert.deepEqual(identity(f.store.getSettings(), a), { displayName: 'Leo Ho', aliases: ['Leo', '何先生'] });
  const generation = f.store.getSettings().aiGeneration;
  f.learning.updateSettings(a, { identity: { displayName: 'Leo Ho', aliases: ['Leo', '何先生'], confirmed: true } });
  assert.equal(f.store.getSettings().aiGeneration, generation);
  assert.equal(identity(f.store.getSettings(), b), null);
  assert.equal(identity(f.store.getSettings(), 'all'), null);
  assert.equal(f.learning.state(a).settings.enabled, false);
  assert.equal(f.learning.state(a).profile, null); assert.equal(f.learning.state(a).preview, null);
  assert.deepEqual(f.store.getSettings().workspaces, workspaces); assert.equal(calls, 0);
  const before = f.store.getSettings().styleLearning;
  const valid = { displayName: 'Leo', aliases: [], confirmed: true };
  for (const input of [null, [], { displayName: 'Implicit confirmation' }, { ...valid, extra: 'secret' }, { ...valid, confirmed: 'yes' }, { ...valid, displayName: '' }, { ...valid, displayName: 'a'.repeat(101) }, { ...valid, displayName: '😀'.repeat(51) }, { ...valid, displayName: '\ud800' }, { ...valid, displayName: 'Leo\nAnother' }, { ...valid, aliases: ['bad\u0085name'] }, { ...valid, aliases: [''] }, { ...valid, aliases: Array(11).fill('Alias') }]) {
    assert.throws(() => f.learning.updateSettings(a, { identity: input }), { status: 400 });
    assert.deepEqual(f.store.getSettings().styleLearning, before);
  }
  f.learning.updateSettings(a, { identity: { ...valid, confirmed: false } });
  assert.equal(identity(f.store.getSettings(), a), null);
  assert.equal(f.store.getSettings().aiGeneration, generation + 1);
  f.learning.updateSettings(a, { identity: { displayName: 'Leo Ho', aliases: ['Leo', '何先生'], confirmed: true } });
  assert.equal(f.store.getSettings().aiGeneration, generation + 2);
  const atomicBefore = f.store.getSettings();
  assert.throws(() => f.store.transaction(() => { f.learning.updateSettings(a, { identity: { ...valid, confirmed: false } }); throw new Error('Rollback fixture'); }), /Rollback fixture/);
  assert.deepEqual(f.store.getSettings(), atomicBefore);
  const bad = f.store.getSettings(); bad.styleLearning[a].settings.identity = { ...valid, aliases: [{ apiKey: 'must-not-be-projected' }] };
  f.store.setSettings({ styleLearning: bad.styleLearning });
  assert.equal(identity(f.store.getSettings(), a), null);
  assert.deepEqual(f.learning.state(a).settings.identity, { displayName: '', aliases: [], confirmed: false });
  f.learning.updateSettings(a, { identity: valid });
  f.store.setSettings({ mailAccounts: { [b]: f.connection(b) } });
  assert.equal(identity(f.store.getSettings(), a), null);
  assert.throws(() => f.learning.updateSettings(a, { identity: valid }), { status: 409 });
});

test('identity-only edits revoke pending results but retain approved style, schedule and learning consent', async t => {
  const f = fixture(t), a = f.accounts[0];
  f.add(a, 'sample'); f.learning.updateSettings(a, { enabled: true, weekly: true });
  const first = f.learning.prepare(a); await f.learning.generate(a, first.id);
  f.learning.apply(a, { previewId: first.id, voice: 'Explicitly approved writing style.' });
  const preview = f.learning.prepare(a), previous = f.store.getSettings().styleLearning[a];
  f.learning.updateSettings(a, { identity: { displayName: 'Leo', aliases: ['何先生'], confirmed: true } });
  assert.equal(f.learning.state(a).preview, null);
  await assert.rejects(f.learning.generate(a, preview.id), { status: 409 });
  assert.deepEqual(f.store.getSettings().styleLearning[a].profile, previous.profile);
  assert.equal(f.store.getSettings().styleLearning[a].lastWeeklyAt, previous.lastWeeklyAt);
  assert.equal(f.learning.voice(a), 'Explicitly approved writing style.');
  f.learning.clear(a);
  assert.equal(f.learning.state(a).profile, null); assert.equal(f.learning.state(a).settings.enabled, false);
  assert.deepEqual(identity(f.store.getSettings(), a), { displayName: 'Leo', aliases: ['何先生'] });
  assert.deepEqual(createLearning(f.options).state(a).settings.identity, { displayName: 'Leo', aliases: ['何先生'], confirmed: true });
});

test('Learning UI offers direct learning only with saved opt-in, permissions, model and idle state', async t => {
  const { createServer } = await import('vite');
  const { default: React } = await import('react');
  const { renderToString } = await import('react-dom/server');
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  t.after(() => vite.close());
  const { default: StyleLearning, learningOptions } = await vite.ssrLoadModule('/src/StyleLearning.jsx');
  const state = {
    account: { id: 'owner@example.invalid', email: 'owner@example.invalid', mode: 'live' },
    settings: { ai: { configured: true, model: 'fixture', baseUrl: 'http://localhost:11434/v1' }, policy: { maxMessages: 10 } },
    workspace: { styleLearning: { settings: { enabled: true, weekly: false, months: 3, maxSamples: 5, tokenBudget: 4000 }, permitted: true, preview: null, profile: { active: true, voice: 'Approved original style.' } } },
  };
  const preview = { id: 'prepared-fixture', status: 'prepared', sampleCount: 1, eligible: 4, effectiveCap: 5, estimatedTokens: 1500, tokenBudget: 4000, samples: [{ body: 'Full own Sent sample text for optional review.' }] };
  const render = (value, disabled = false, onOpenSettings) => renderToString(React.createElement(StyleLearning, { state: value, disabled, onOpenSettings, onUpdate() {}, onDirtyChange() {}, onBusyChange() {} }));
  const button = html => html.match(/<button\b[^>]*>Learn Now · Uses AI<\/button>/)[0];
  const html = render(state);
  assert.match(html, /Account: .*owner@example.invalid/);
  assert.match(html, /<strong>Approved style<\/strong>/);
  assert.ok(html.indexOf('Approved style') < html.indexOf('Learn Now · Uses AI'));
  for (const title of ['Learning configuration', 'Your identity for this account']) {
    assert.match(html, new RegExp(`<details class="settings-disclosure"><summary>${title}`));
    assert.ok(html.indexOf('Learn Now · Uses AI') < html.indexOf(`<summary>${title}`));
  }
  assert.match(button(html), /aria-describedby="[^"]+"/);
  assert.doesNotMatch(html, />Open (Model|Mail|AI Permissions)<\/button>/);
  const fresh = structuredClone(state); fresh.workspace.styleLearning.profile = null;
  assert.match(render(fresh), /<strong>Not learned<\/strong>/);
  assert.match(render(fresh), /Preview your saved sample selection/);
  const inactive = structuredClone(state); inactive.workspace.styleLearning.profile.active = false;
  assert.match(render(inactive), /<strong>Approved style · inactive<\/strong>/);
  assert.match(render(inactive), /Review learning permissions and source scope/);
  assert.match(button(html), /class="button primary"/); assert.doesNotMatch(button(html), /disabled/);
  assert.match(html, /Uses saved learning settings/); assert.match(html, /Save Approved Style activates it for writing and replies under Email Brain permission/);
  assert.match(html, /does not overwrite Email Brain contacts, notes, or voice/);
  assert.match(html, /Approved original style/); assert.doesNotMatch(html, />Save approved style<\/button>/);
  assert.match(html, /Save identity · no AI call/); assert.match(html, /No confirmed identity is active/);
  assert.match(html, /Names inferred from signatures or messages are not automatically verified/);
  const identified = structuredClone(state);
  identified.settings.policy.folders = { sent: false };
  identified.workspace.styleLearning.settings.identity = { displayName: 'Leo Ho', aliases: ['Leo', '何先生'], confirmed: true };
  identified.workspace.styleLearning.permitted = false;
  const identityUI = render(identified);
  assert.match(identityUI, /Saved identity confirmed/); assert.match(identityUI, /Sent access is off/);
  assert.match(identityUI, /value="Leo Ho"/); assert.match(identityUI, /何先生/);
  assert.deepEqual(Object.keys(learningOptions(identified.workspace.styleLearning.settings)).sort(), ['enabled', 'maxSamples', 'months', 'tokenBudget', 'weekly']);
  for (const [block, reason] of [
    [value => { value.workspace.styleLearning.settings.enabled = false; }, 'Learning is off. Enable and save it'],
    [value => { value.workspace.styleLearning.permitted = false; }, 'Requires saved learning opt-in plus AI Permissions'],
    [value => { value.settings.ai.configured = false; }, 'Configure and save an AI model in Model settings first'],
    [value => { value.workspace.styleLearning.preview = { ...preview, status: 'running' }; }, 'Analysis is already running'],
  ]) {
    const blocked = structuredClone(state); block(blocked);
    const blockedHTML = render(blocked);
    assert.match(button(blockedHTML), /disabled=""/);
    assert.ok(blockedHTML.indexOf(reason) > blockedHTML.indexOf('Learn Now · Uses AI'));
    assert.ok(blockedHTML.indexOf(reason) < blockedHTML.indexOf('<summary>Learning configuration'));
  }
  assert.match(render(state, true), /<fieldset[^>]*disabled=""/);
  assert.match(render(state, true), /Wait for the current operation to finish/);
  const combined = structuredClone(state); combined.account = { id: 'all', mode: 'combined' };
  assert.match(render(combined), /<fieldset[^>]*disabled=""/);
  assert.match(render(combined), /Choose an individual connected account/);
  const onboarding = render(combined, false, () => {});
  assert.match(onboarding, /<button class="button secondary">Connect a mailbox in Mail<\/button>/);
  assert.ok(onboarding.indexOf('Connect a mailbox in Mail') < onboarding.indexOf('<fieldset'));
  const missing = structuredClone(state); missing.settings.ai.configured = false; missing.workspace.styleLearning.permitted = false;
  let navigations = 0;
  const withLinks = render(missing, false, () => { navigations += 1; });
  for (const title of ['Model', 'AI Permissions', 'Mail']) assert.match(withLinks, new RegExp(`>Open ${title}</button>`));
  assert.equal(navigations, 0);
  for (const status of ['prepared', 'ready']) {
    const value = structuredClone(state); value.workspace.styleLearning.preview = { ...preview, status, ...(status === 'ready' ? { voice: 'Proposed updated style.' } : {}) };
    const proposal = render(value);
    assert.match(proposal, /Review text sent to the model/); assert.match(proposal, /Full own Sent sample text for optional review/);
    assert.doesNotMatch(button(proposal), /disabled/);
    assert.match(button(proposal), /class="button secondary"/);
    assert.equal((proposal.match(/class="button primary"/g) || []).length, 1);
    assert.match(proposal, /Your previously approved style is retained/);
    assert.ok(proposal.indexOf('Review text sent to the model') < proposal.indexOf('<summary>Learning configuration'));
    if (status === 'ready') {
      assert.match(proposal, /<strong>Proposal ready<\/strong>/);
      assert.match(proposal, /Generating a proposal does not apply it/);
      assert.match(proposal, />Save approved style<\/button>/);
      assert.ok(proposal.indexOf('>Save approved style</button>') < proposal.indexOf('Review text sent to the model'));
      assert.ok(proposal.indexOf('>Save approved style</button>') < proposal.indexOf('<summary>Learning configuration'));
      assert.ok(proposal.indexOf('>Save approved style</button>') < proposal.indexOf('<summary>Your identity'));
      assert.match(render(value, true), /<fieldset[^>]*disabled=""/);
      value.workspace.styleLearning.preview.voice = ' ';
      const emptyStyle = render(value);
      assert.match(emptyStyle, /<button[^>]*disabled=""[^>]*>Save approved style<\/button>/);
      assert.match(emptyStyle, /The approved style must contain 1–2,000 characters/);
    } else {
      assert.doesNotMatch(proposal, />Save approved style<\/button>/);
      assert.match(proposal, /Review the selected samples below/);
      assert.match(proposal, />Analyze these samples · uses AI<\/button>/);
    }
  }
  for (const status of ['failed', 'interrupted']) {
    const value = structuredClone(fresh); value.workspace.styleLearning.preview = { ...preview, status };
    const stopped = render(value);
    assert.match(stopped, /retry explicitly; tokens may have been used/);
    assert.doesNotMatch(stopped, />Analyze these samples · uses AI<\/button>|>Save approved style<\/button>/);
  }
});
