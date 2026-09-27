import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUpdates, currentVersion } from '../server/updates.js';
import { checkForUpdates as checkClientUpdates } from '../src/useUpdates.js';

const release = (tag_name, extra = {}) => ({ tag_name, draft: false, prerelease: tag_name.includes('-'), html_url: 'https://untrusted.invalid', ...extra });
const response = releases => async (url, options) => {
  assert.equal(url, 'https://api.github.com/repos/Coke1120/Morrow-Mail/releases?per_page=100');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, undefined);
  assert.ok(options.signal instanceof AbortSignal);
  return { ok: true, status: 200, json: async () => releases };
};

test('client checks hourly, coalesce manual checks, retain known updates offline and never install', async t => {
  const state = { includePrereleases: true, controller: new AbortController(), result: null };
  let calls = 0, fail = false, available = true, releaseRequest;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.match(url, /^\/api\/updates\?includePrereleases=(true|false)$/);
    assert.equal(options.method, undefined, 'Automatic checks only use GET, never download or install.');
    assert.equal(options.headers, undefined, 'Checks do not depend on the selected mailbox.');
    if (fail) throw Error('offline');
    if (releaseRequest) await releaseRequest.promise;
    return { ok: true, json: async () => ({ updateAvailable: available, latestVersion: '1.0.0', checkedAt: new Date().toISOString() }) };
  });
  await checkClientUpdates(state, { now: 0 });
  assert.equal(calls, 1); assert.equal(state.result.updateAvailable, true);
  await checkClientUpdates(state, { now: 3_599_999 });
  assert.equal(calls, 1);
  await checkClientUpdates(state, { now: 3_600_000 });
  assert.equal(calls, 2);
  fail = true;
  await checkClientUpdates(state, { now: 7_200_000 });
  assert.equal(state.error, 'offline'); assert.equal(state.result.updateAvailable, true);
  await checkClientUpdates(state, { now: 7_260_000 });
  assert.equal(calls, 3, 'Failure must not cause a rapid retry loop.');
  fail = false; available = false;
  await checkClientUpdates(state, { force: true, now: 7_260_000 });
  assert.equal(calls, 4); assert.equal(state.error, ''); assert.equal(state.result.updateAvailable, false);
  releaseRequest = Promise.withResolvers();
  const pending = checkClientUpdates(state, { force: true, now: 7_260_001 });
  assert.equal(state.checking, true);
  await checkClientUpdates(state, { force: true, now: 7_260_002 });
  assert.equal(calls, 5);
  // Navigation/channel teardown discards a late response even if transport ignores abort.
  const previous = state.result;
  state.controller.abort(); releaseRequest.resolve(); await pending;
  assert.equal(state.result, previous); assert.equal(state.checking, false);
  await checkClientUpdates(state, { force: true }); assert.equal(calls, 5);
  const stable = { includePrereleases: false, controller: new AbortController(), result: null };
  await checkClientUpdates(stable, { now: 9_000_000 });
  await checkClientUpdates(stable, { now: 8_000_000 });
  assert.equal(calls, 7, 'A backward clock adjustment must not suppress checks indefinitely.');
});

test('GitHub release checks compare semantic versions and filter drafts and release channels', async () => {
  const releases = [release('v0.4.0-alpha.2'), release('v0.3.0'), release('v0.4.0-alpha.10'), release('v9.0.0', { draft: true }), release('not-a-version')];
  const options = { installed: '0.4.0-alpha.2', fetchImpl: response(releases) };
  const alpha = await checkUpdates({ ...options, includePrereleases: true });
  assert.equal(alpha.latestVersion, '0.4.0-alpha.10');
  assert.equal(alpha.updateAvailable, true);
  assert.equal(alpha.prerelease, true);
  assert.equal(alpha.url, 'https://github.com/Coke1120/Morrow-Mail/releases/tag/v0.4.0-alpha.10');
  assert.ok(Number.isFinite(Date.parse(alpha.checkedAt)));
  const stable = await checkUpdates(options);
  assert.equal(stable.latestVersion, '0.3.0');
  assert.equal(stable.updateAvailable, false);
  for (const [installed, tag, expected] of [
    ['1.0.0-alpha.9', 'v1.0.0-alpha.10', true], ['1.0.0-alpha', '1.0.0-alpha.1', true],
    ['1.0.0-beta', '1.0.0', true], ['1.0.0', '1.0.0-beta', false],
    ['0.5.0-alpha.1', 'v0.5.0-beta.1', true], ['0.5.0-beta.1', 'v0.5.0-alpha.1', false],
    ['1.0.0-2', '1.0.0-alpha', true], ['1.9.0', '1.10.0', true],
    ['2.0.0', '1.99.0', false], ['1.0.0+local', 'v1.0.0+release', false],
    [currentVersion, 'v' + currentVersion, false],
  ]) assert.equal((await checkUpdates({ installed, includePrereleases: true, fetchImpl: response([release(tag)]) })).updateAvailable, expected, `${installed} -> ${tag}`);
});

test('failed, malformed and empty update checks never report up-to-date', async () => {
  for (const fetchImpl of [async () => { throw Error('offline'); }, async () => ({ ok: false, status: 500 }), async () => ({ ok: false, status: 301 }), response({}), async () => ({ ok: true, json: async () => { throw Error('bad JSON'); } })]) {
    await assert.rejects(checkUpdates({ fetchImpl }), { status: 502 });
  }
  for (const status of [403, 429]) await assert.rejects(checkUpdates({ fetchImpl: async () => ({ ok: false, status }) }), { status: 503 });
  for (const releases of [[], [release('v1.0.0-alpha.1')], [release('v1.0.0-01')], [release('v01.0.0')], [release('v2.0.0', { draft: true })]]) {
    await assert.rejects(checkUpdates({ fetchImpl: response(releases) }), { status: 404 });
  }
});
