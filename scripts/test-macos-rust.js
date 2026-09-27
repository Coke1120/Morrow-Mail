import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.js';
import { bundleOAuth } from './bundle-oauth.js';

if (process.platform !== 'darwin') throw new Error('Native Rust acceptance requires macOS and the Swift command-line tools.');
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
// Build the unmodified production service; the updater acceptance owns the release app output.
run(process.execPath, ['scripts/rust-resources.js', '--check']);
run('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--bin', 'morrow-service', '--locked']);
const binary = resolve(root, process.env.CARGO_TARGET_DIR || 'rust/target', 'debug/morrow-service');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), `Morrow Mail ${version}`);
const directory = mkdtempSync(join(tmpdir(), 'morrow-swift-rust-check-'));
try {
  const contents = join(directory, 'Checks.app/Contents');
  const resources = join(contents, 'Resources');
  const backend = join(resources, 'backend');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(backend, { recursive: true });
  cpSync(binary, join(resources, 'morrow-service'));
  cpSync(join(root, 'package.json'), join(backend, 'package.json'));
  bundleOAuth(backend, { MORROW_GOOGLE_OAUTH_JSON: JSON.stringify({ installed: { client_id: 'fixture.apps.googleusercontent.com', client_secret: 'fixture-native-rust-desktop-secret' } }) });
  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.morrowmail.rustchecks</string>
<key>CFBundleExecutable</key><string>checks</string>
<key>CFBundleVersion</key><string>${version.split('-')[0]}</string>
<key>MorrowReleaseVersion</key><string>${version}</string>
<key>MorrowServiceRuntime</key><string>rust</string>
</dict></plist>`);
  const dataDirectory = join(directory, 'data');
  const accounts = ['first@native-rust.invalid', 'second@native-rust.invalid'];
  const store = createStore(dataDirectory);
  try {
    const connections = Object.fromEntries(accounts.map(email => [email, {
      provider: 'google', email, connectionId: `fixture-${email}`, clientId: 'fixture-client',
      accessToken: 'fixture-native-rust-access', refreshToken: 'fixture-native-rust-refresh', expiresAt: 4_102_444_800_000,
    }]));
    store.transaction(() => {
      store.setSettings({ mailAccounts: connections, mail: connections[accounts[0]], activeAccount: 'demo',
        preferences: { syncInterval: 0, markReadOnOpen: true, sort: 'newest' },
        ai: null, policy: { enabled: false }, calendars: {}, imports: {}, smartSearch: { enabled: false } });
      for (const email of accounts) {
        for (let index = 0; index < 65; index++) {
          store.upsertMessage(email, {
            id: index === 0 ? 'google:shared' : `google:fixture-${String(index).padStart(3, '0')}`,
            fromName: `Sender ${index % 7}`, fromEmail: `sender${index % 7}@example.invalid`, to: email,
            subject: `Thread ${64 - index}`, preview: `Cached fixture ${index}`, body: `Owned by ${email}: fixture ${index}. `.repeat(100),
            date: new Date(Date.UTC(2026, 8, 25) - index * 60000).toISOString(), folder: 'inbox', category: 'primary',
            read: index % 3 !== 0, starred: index > 0 && index % 9 === 0, labels: [],
            footer: { text: 'Fixture footer excluded from list metadata', html: '' },
          });
        }
      }
      store.upsertMessage(accounts[0], { id: 'google:provider-draft', folder: 'drafts', providerDraft: true,
        to: '"Fixture, Recipient" <to@example.invalid>', cc: 'cc@example.invalid', bcc: 'hidden@example.invalid',
        subject: 'Provider draft fixture', body: 'Original provider draft; never sent.', date: '2026-09-25T00:00:00.000Z' });
    });
  } finally { store.close(); }
  const client = join(contents, 'MacOS/checks');
  run('swiftc', ['-parse-as-library', 'macos/Sources/MorrowMail/Models.swift', 'macos/Sources/MorrowMail/AppModel.swift', 'macos/Checks/RustIntegration.swift', '-o', client]);
  run(client, [], { timeout: 120000, env: { ...process.env, MORROW_DATA_DIR: dataDirectory } });
  // Node reads the Rust-written encrypted settings only after the native client and service exit.
  const reopened = createStore(dataDirectory);
  try {
    const settings = reopened.getSettings();
    assert.deepEqual(Object.keys(settings.mailAccounts), [accounts[1]]);
    assert.equal(settings.mailAccounts[accounts[1]].accessToken, 'fixture-native-rust-access');
    assert.equal(settings.preferences.syncInterval, 0);
    assert.equal(settings.policy.enabled, false);
    assert.equal(settings.ai, null);
    assert.ok(!settings.calendars || Object.values(settings.calendars).every(value => !value));
    assert.equal(reopened.listMessages(accounts[0]).filter(message => message.folder === 'inbox').length, 65);
    assert.equal(reopened.listMessages(accounts[1]).filter(message => message.folder === 'inbox').length, 65);
    const draft = reopened.listMessages(accounts[0]).find(message => message.subject === 'Native Rust owned draft');
    assert.ok(draft && draft.folder === 'drafts');
    assert.equal(draft.bcc, 'hidden@example.invalid');
    assert.ok(!reopened.getMessage(accounts[1], draft.id));
    assert.deepEqual(settings.backgroundSyncErrors || [], []);
  } finally { reopened.close(); }
  // The online snapshot predates disconnect; reopen only once the Rust service has stopped.
  const backup = createStore(join(directory, 'native-backup'));
  try {
    const settings = backup.getSettings();
    assert.deepEqual(Object.keys(settings.mailAccounts).sort(), accounts);
    assert.equal(settings.activeAccount, accounts[1]);
    for (const account of accounts) {
      assert.equal(settings.mailAccounts[account].accessToken, 'fixture-native-rust-access');
      assert.equal(backup.listMessages(account).filter(message => message.folder === 'inbox').length, 65);
      assert.ok(backup.getMessage(account, 'google:shared').body.includes(`Owned by ${account}`));
    }
    assert.equal(settings.preferences.language, '繁體中文');
    assert.equal(settings.preferences.translationLanguage, '日本語');
    assert.equal(settings.preferences.syncInterval, 0);
    assert.equal(settings.policy.enabled, false);
    const draft = backup.listMessages(accounts[0]).find(message => message.subject === 'Native Rust owned draft');
    assert.ok(draft && draft.folder === 'drafts');
    assert.equal(draft.body, 'Saved fixture draft; no provider delivery is performed.');
    assert.equal(draft.bcc, 'hidden@example.invalid');
    assert.ok(!backup.getMessage(accounts[1], draft.id));
    assert.equal(backup.getMessage(accounts[0], 'google:shared').starred, true);
    assert.equal(backup.getMessage(accounts[1], 'google:shared').starred, false);
  } finally { backup.close(); }
  console.log('Native Rust acceptance passed: production binary, Node↔Rust persistence and online backup, Swift client lifecycle and account isolation; fixture data only.');
} finally { rmSync(directory, { recursive: true, force: true }); }
