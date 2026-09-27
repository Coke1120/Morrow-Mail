import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

let component;
before(async () => {
  const source = readFileSync(new URL('../src/SearchSettings.jsx', import.meta.url), 'utf8')
    .replace("import { useEffect, useRef, useState } from 'react';", 'const { useEffect, useRef, useState } = hooks;')
    .replace('export default function', 'function').replace('export function', 'function');
  const { code } = await transformWithOxc(source, 'SearchSettings.jsx', { jsx: { runtime: 'classic' } });
  component = new Function('React', 'hooks', 'fetch', 'window', 'setInterval', 'clearInterval', code + '\nreturn { SearchSettings, editableSearchSettings };');
});

const account = 'owner@example.invalid';
const fixture = () => ({
  settings: { protocol: 'openai', baseUrl: 'https://embedding.example.invalid/v1', model: 'embedding-fixture', hasApiKey: true, enabled: true, accounts: [account], months: 3, tokenBudget: 16000, folders: { inbox: true, sent: false }, content: { subject: true, body: true, sender: false } },
  permitted: true, local: false, indexed: 1, eligible: 3, pending: 2, job: null, indexVersion: 2,
});
const batch = status => ({ id: 'reviewed-owner-batch', status, completed: 1, sampleCount: 3, chunks: 3, estimatedTokens: 3000, oversized: 0, spentTokens: 1000, budget: 16000 });
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children);
function elements(node, predicate, disabled = false) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate, disabled));
  const blocked = disabled || !!node.props?.disabled;
  return [...(predicate(node) ? [{ ...node, blocked }] : []), ...elements(node.props?.children, predicate, blocked)];
}

// Exercise the component's handlers/effects without adding a DOM or test framework.
function mount(initial = fixture(), extra = {}) {
  let stored = structuredClone(initial), cursor = 0, changed = true, effects = [], tree;
  const slots = [], calls = [], confirmations = [], timers = new Set();
  const ui = { confirm: true, calls, confirmations, timers, dirty: false, busy: false };
  const hooks = {
    useState(initialValue) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initialValue;
      return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; changed = true; } }];
    },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useEffect(effect, deps) {
      const i = cursor++, old = slots[i];
      if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
    },
  };
  ui.props = { state: { accounts: [{ id: account, email: account }], settings: { policy: { enabled: true, folders: { inbox: true, sent: false }, content: { subject: true, body: true, sender: true } } } }, onDirtyChange: value => { ui.dirty = value; }, onBusyChange: value => { ui.busy = value; }, ...extra };
  const fetch = async (url, request) => {
    const path = url.replace('/api/search/', ''), body = request.body && JSON.parse(request.body);
    calls.push({ path, body });
    if (ui.respond) { const response = await ui.respond(path, body); if (response) return response; }
    if (path === 'settings' && body) stored.settings = { ...stored.settings, ...body, apiKey: undefined };
    if (path === 'index/preview') stored = { ...stored, job: batch('prepared'), samples: [{ account, text: 'Fictional approved excerpt.' }] };
    if (['index/run', 'index/pause', 'index/resume', 'index/cancel'].includes(path)) stored.job = { ...stored.job, status: { 'index/run': 'running', 'index/pause': 'paused', 'index/resume': 'running', 'index/cancel': 'cancelled' }[path] };
    if (path === 'index/clear') stored = { ...stored, indexed: 0, job: null };
    return { ok: true, json: async () => structuredClone(path === 'test' ? { dimensions: 3 } : stored) };
  };
  const { SearchSettings, editableSearchSettings } = component(React, hooks, fetch, { confirm: message => { confirmations.push(message); return ui.confirm; } }, fn => { timers.add(fn); return fn; }, fn => timers.delete(fn));
  ui.editable = editableSearchSettings;
  ui.flush = async (props = {}) => {
    Object.assign(ui.props, props); changed = true;
    for (let n = 0; n < 20; n++) {
      if (changed) { changed = false; cursor = 0; effects = []; tree = SearchSettings(ui.props); effects.forEach(run => run()); }
      await new Promise(resolve => setImmediate(resolve));
      if (!changed) return;
    }
    assert.fail('Component did not settle');
  };
  ui.find = predicate => elements(tree, predicate);
  ui.button = label => ui.find(node => node.type === 'button' && text(node) === label)[0];
  ui.click = async label => { const button = ui.button(label); assert.ok(button, label); assert.equal(button.blocked, false, label); await button.props.onClick(); await ui.flush(); };
  ui.html = () => renderToStaticMarkup(tree);
  ui.unmount = () => slots.forEach(slot => slot?.cleanup?.());
  return ui;
}

test('one review CTA previews without AI and requires confirmation before running the captured batch', async t => {
  const ui = mount(); t.after(ui.unmount); await ui.flush();
  assert.ok(ui.button('Review & Index…'));
  assert.doesNotMatch(ui.html(), /Index now|Preview next batch|Index reviewed batch|Clear semantic index \/ cancel/);
  ui.confirm = false; await ui.click('Review & Index…');
  assert.deepEqual(ui.calls.map(call => call.path), ['settings', 'index/preview']);
  assert.match(ui.confirmations[0], new RegExp(`Accounts: ${account}`));
  assert.match(ui.confirmations[0], /Folders: inbox · Fields: subject, body · Last 3 months/);
  assert.match(ui.confirmations[0], /Budget: 16000 tokens/);
  assert.equal(ui.busy, false); assert.equal(ui.dirty, false);
  assert.match(ui.html(), /Fictional approved excerpt/);
  ui.confirm = true; await ui.click('Review & Index…');
  assert.deepEqual(ui.calls.at(-1), { path: 'index/run', body: { previewId: 'reviewed-owner-batch' } });
  assert.match(ui.html(), /continues in the background/);
  const before = ui.calls.length; await ui.flush({ active: false }); ui.unmount();
  assert.equal(ui.calls.length, before, 'Hiding/unmounting must never stop the service batch');
});

test('Rust batch controls carry the reviewed ID, retain valid vectors and keep destructive clear separate', async t => {
  const ui = mount({ ...fixture(), job: batch('running') }); t.after(ui.unmount); await ui.flush();
  await ui.click('Pause batch');
  assert.deepEqual(ui.calls.at(-1), { path: 'index/pause', body: { previewId: 'reviewed-owner-batch' } });
  assert.equal(ui.button('Review & Index…').blocked, true);
  ui.confirm = false; const before = ui.calls.length; await ui.click('Resume batch…'); assert.equal(ui.calls.length, before);
  ui.confirm = true; await ui.click('Resume batch…');
  assert.deepEqual(ui.calls.at(-1), { path: 'index/resume', body: { previewId: 'reviewed-owner-batch' } });
  assert.match(ui.confirmations.at(-1), /resuming may charge again/);
  await ui.click('Cancel batch…');
  assert.deepEqual(ui.calls.at(-1), { path: 'index/cancel', body: { previewId: 'reviewed-owner-batch' } });
  assert.match(ui.html(), /1 \/ 3 eligible messages indexed/);
  assert.ok(ui.find(node => node.type === 'details' && text(node).startsWith('Clear index…')).length);
  ui.confirm = false; await ui.click('Clear semantic index…'); assert.equal(ui.calls.at(-1).path, 'index/cancel');
  ui.confirm = true; await ui.click('Clear semantic index…'); assert.equal(ui.calls.at(-1).path, 'index/clear');
  assert.match(ui.confirmations.at(-1), /all semantic vectors across indexed accounts/);
});

test('resume respects status and reviewed budget; Node never exposes unsupported controls', async t => {
  for (const status of ['prepared', 'paused', 'interrupted', 'failed', 'complete', 'cancelled']) {
    const ui = mount({ ...fixture(), job: batch(status) }); t.after(ui.unmount); await ui.flush();
    assert.equal(!!ui.button('Resume batch…'), ['paused', 'interrupted', 'failed'].includes(status));
    assert.equal(!!ui.button('Cancel batch…'), ['prepared', 'paused', 'interrupted', 'failed'].includes(status));
  }
  const exhausted = mount({ ...fixture(), job: { ...batch('paused'), spentTokens: 16000 } }); t.after(exhausted.unmount); await exhausted.flush();
  assert.equal(exhausted.button('Resume batch…').blocked, true); assert.match(exhausted.html(), /Budget exhausted/);
  for (const status of ['running', 'interrupted', 'failed']) {
    const value = { ...fixture(), job: batch(status) }; delete value.indexVersion;
    const ui = mount(value); t.after(ui.unmount); await ui.flush();
    assert.equal(ui.button('Pause batch'), undefined); assert.equal(ui.button('Resume batch…'), undefined); assert.equal(ui.button('Cancel batch…'), undefined);
    assert.match(ui.html(), /compatibility service does not support/);
  }
});

test('prerequisite reasons and navigation are visible; dirty scope cannot start a batch', async t => {
  let permissions = 0, model = 0;
  const value = fixture(); Object.assign(value.settings, { enabled: false, model: '', accounts: [] }); value.permitted = false;
  const ui = mount(value, { onConfigurePermissions: () => permissions++, onConfigureModel: () => model++ }); t.after(ui.unmount); await ui.flush();
  assert.equal(ui.button('Review & Index…').blocked, true);
  for (const reason of ['Enable Smart Search', 'Save an embedding model', 'Enable AI access', 'Choose at least one connected account']) assert.ok(ui.html().includes(reason), reason);
  await ui.click('Open AI Permissions…'); await ui.click('Edit in Model…'); assert.equal(permissions, 1); assert.equal(model, 1);
  const ready = mount(); t.after(ready.unmount); await ready.flush();
  ready.find(node => node.type === 'input' && node.props.type === 'number')[0].props.onChange({ target: { value: '32000' } }); await ready.flush();
  assert.equal(ready.dirty, true); assert.equal(ready.button('Review & Index…').blocked, true);
  assert.match(ready.html(), /Save your changes before indexing/);
  await ready.click('Save search settings');
  assert.deepEqual(Object.keys(ready.calls.at(-1).body).sort(), ['accounts', 'content', 'enabled', 'folders', 'months', 'tokenBudget']);
  assert.equal(ready.dirty, false);
  ready.props.state.settings.policy.content = { subject: false, body: false, sender: false }; await ready.flush();
  assert.match(ready.html(), /Allow at least one selected content field in AI Permissions/);
  assert.equal(ready.button('Review & Index…').blocked, true);
});

test('Embedding is independent, preserves hidden drafts and key semantics, and tests without saving', async t => {
  const ui = mount(fixture(), { presentation: 'model' }); t.after(ui.unmount); await ui.flush();
  assert.doesNotMatch(ui.html(), /<button[^>]*>Review|Clear semantic index|Accounts to index/);
  assert.match(ui.html(), /Changing the base URL requires entering the key again/);
  assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'password')[0].props.value, '');
  assert.deepEqual(Object.keys(ui.editable(fixture(), 'model')).sort(), ['apiKey', 'baseUrl', 'clearApiKey', 'model', 'protocol']);
  ui.find(node => node.type === 'input' && node.props.type === 'password')[0].props.onChange({ target: { value: 'fictional-key' } }); await ui.flush();
  await ui.flush({ active: false }); await ui.flush({ active: true });
  assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'password')[0].props.value, 'fictional-key');
  assert.equal(ui.dirty, true);
  await ui.click('Test embedding connection'); assert.equal(ui.calls.at(-1).path, 'test'); assert.equal(ui.calls.at(-1).body.apiKey, 'fictional-key'); assert.equal(ui.dirty, true);
  assert.match(ui.html(), /Settings were not changed/);
  ui.find(node => node.type === 'input' && node.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } }); await ui.flush();
  await ui.click('Save embedding model');
  assert.equal(ui.calls.at(-1).body.clearApiKey, true);
  assert.equal(ui.calls.at(-1).body.accounts, undefined); assert.equal(ui.calls.at(-1).body.enabled, undefined);
  assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'password')[0].props.value, ''); assert.equal(ui.dirty, false);
});

test('a stale status poll cannot overwrite a pause response', async t => {
  const initial = { ...fixture(), job: batch('running') }, ui = mount(initial); t.after(ui.unmount); await ui.flush();
  const pending = Promise.withResolvers();
  ui.respond = (path, body) => path === 'settings' && !body ? pending.promise : null;
  const poll = [...ui.timers][0]; assert.ok(poll); poll();
  await ui.click('Pause batch');
  pending.resolve({ ok: true, json: async () => initial }); await ui.flush();
  assert.ok(ui.button('Resume batch…')); assert.equal(ui.button('Pause batch'), undefined);
});

test('edits during activation refresh and failed saves stay dirty and recoverable', async t => {
  const ui = mount(fixture(), { presentation: 'model' }); t.after(ui.unmount); await ui.flush();
  await ui.flush({ active: false });
  const pending = Promise.withResolvers();
  ui.respond = (path, body) => path === 'settings' && !body ? pending.promise : null;
  await ui.flush({ active: true });
  ui.find(node => node.type === 'input' && node.props.type === 'password')[0].props.onChange({ target: { value: 'new-fictional-key' } }); await ui.flush();
  pending.resolve({ ok: true, json: async () => fixture() }); await ui.flush();
  assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'password')[0].props.value, 'new-fictional-key'); assert.equal(ui.dirty, true);
  ui.respond = () => ({ ok: false, json: async () => ({ error: 'Fixture save failed.' }) });
  await ui.click('Save embedding model');
  assert.match(ui.html(), /Fixture save failed/); assert.equal(ui.dirty, true); assert.equal(ui.busy, false);
  assert.equal(ui.find(node => node.type === 'input' && node.props.type === 'password')[0].props.value, 'new-fictional-key');
  ui.respond = null; await ui.click('Save embedding model'); assert.equal(ui.dirty, false);
});

test('native uses the same review, capability, batch ID and mounted-view guards', () => {
  const swift = readFileSync(new URL('../macos/Sources/MorrowMail/SearchSettingsView.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(swift, /Clear Semantic Index \/ Cancel Batch|Preview Next Batch|Index Reviewed Batch/);
  assert.match(swift, /var onConfigurePermissions: \(\(\) -> Void\)\?/);
  assert.match(swift, /\.task\(id: indexing && active\)/);
  assert.match(swift, /guard batchControls/);
  assert.match(swift, /body = \.object\(\["previewId": \.string\(value\["job"\]\.id\)\]\)/);
  assert.match(swift, /model\.confirm\("Start this indexing batch\?/);
  assert.match(swift, /model\.confirm\("Resume this reviewed batch\?/);
});
