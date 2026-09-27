import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeCompatModule, nodeCompatPackage } from './node-compat.js';

const { createStore } = await import(nodeCompatModule('server/store.js'));
const { normalizeSearch, searchTokens } = await import(nodeCompatModule('server/search-index.js'));
const { configs } = await import(nodeCompatPackage('opencc-js/preset/t2cn'));

const executable = fileURLToPath(new URL(`../rust/target/debug/examples/storage_contract${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const available = existsSync(executable);
if (process.env.MORROW_TEST_RUST && !available) throw Error('Build the Rust storage contract example before required checks.');
const options = { skip: !available && 'Run npm run rust:test.' };
const call = request => JSON.parse(execFileSync(executable, { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));

test('Abrupt Rust process death rolls back settings and draft writes together', options, t => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-crash-storage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = createStore(root);
  const attempts = [{ account: 'fixture@example.invalid', requestId: 'keep-request', draftId: 'pending-draft', payloadHash: 'keep-exact-review' }];
  const draft = { id: 'pending-draft', folder: 'drafts', body: 'Confirmed saved content', to: 'to@example.invalid', cc: 'cc@example.invalid', bcc: 'bcc@example.invalid', deliveryStatus: 'unconfirmed', deliveryRequestId: 'keep-request' };
  source.setSettings({ deliveryAttempts: attempts }); source.upsertMessage('fixture@example.invalid', draft); source.close();
  assert.throws(() => call({ directory: root, crash: true }), error => error.status === 77);
  assert(existsSync(join(root, 'genmail.sqlite-journal')), 'fixture must leave an on-disk rollback journal');
  const reopened = createStore(root);
  try {
    assert.deepEqual(reopened.getSettings().deliveryAttempts, attempts);
    assert.equal(reopened.getSettings().crashMarker, undefined);
    assert.deepEqual(reopened.getMessage('fixture@example.invalid', 'pending-draft'), draft);
    assert.equal(reopened.getMessage('fixture@example.invalid', 'uncommitted-new'), null);
  } finally { reopened.close(); }
});

test('Rust and Node share encrypted settings, index normalization, recovery files and backward-compatible writes', options, t => {
  const root = mkdtempSync(join(tmpdir(), 'morrow-cross-storage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = createStore(root);
  const settings = { mailAccounts: { 'fixture@example.invalid': { email: 'fixture@example.invalid', password: 'fixture-not-a-real-password' } }, calendarRequests: [{ requestId: 'same-request', payloadHash: 'same-payload' }], deliveryAttempts: [{ account: 'fixture@example.invalid', requestId: 'uncertain-request', draftId: 'unchanged-draft' }] };
  source.setSettings(settings);
  const message = { id: 'node-owned', subject: '財務報價', body: '零𠀀發票', folder: 'inbox', date: '2026-09-25T00:00:00.000Z' };
  source.upsertMessage('fixture@example.invalid', message); source.close();
  const retry = '{"requestId":"original-retry","payload":{"title":"unchanged"}}';
  writeFileSync(join(root, 'pending-calendar.json'), retry);
  const result = call({ directory: root });
  for (const [key, value] of Object.entries(settings)) assert.deepEqual(result.settings[key], value);
  assert.deepEqual(result.message, message);
  assert.equal(readFileSync(join(root, 'pending-calendar.json'), 'utf8'), retry);
  const backup = readdirSync(join(root, 'migration-backups')); assert.equal(backup.length, 1);
  assert.equal(readFileSync(join(root, 'migration-backups', backup[0], 'pending-calendar.json'), 'utf8'), retry);
  const restored = createStore(root);
  try {
    assert.equal(restored.getSettings().rustRoundTrip, true);
    assert.deepEqual(restored.getSettings().deliveryAttempts, settings.deliveryAttempts);
    assert.equal(restored.getMessage('fixture@example.invalid', 'rust-owned').subject, '發票');
    restored.updateMessage('fixture@example.invalid', 'rust-owned', { body: 'Node can still write after Rust.' });
    assert.equal(restored.search.query("SELECT subject FROM search_documents WHERE id='rust-owned'")[0].subject, '发票');
  } finally { restored.close(); }
});

test('Rust normalizer matches the complete pinned OpenCC dictionary corpus and Unicode token cases', options, () => {
  const texts = [...new Set([...configs.hk2s.normalizationChain.flat(), ...configs.hk2s.segmentation, ...configs.hk2s.conversionChain.flat()].flatMap(dictionary => typeof dictionary === 'string' ? dictionary.split('|').map(line => line.split(' ')[0]) : dictionary.map(([key]) => key)))];
  texts.push('ＡＢＣ café 中文123 email@example.invalid', '\ufeff\u0085 İ I ς ΣΟΣ σος\t\n\r', '  ⿰木發 ⿲𠀀發財 繁體香港詞  ', 'emoji🚀一𠀀二\u{1e4ec}');
  for (let i = 0; i < texts.length; i += 500) {
    const batch = texts.slice(i, i + 500), actual = call({ texts: batch });
    assert.deepEqual(actual, batch.map(text => [normalizeSearch(text), searchTokens(text)]));
  }
});
