// Exercise the unchanged Node updater against a copy of the actual Rust desktop
// candidate. Only the copied old updater trusts the generated fixture signing key.
// The new service binary, including its production pinned key, is never patched.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const mac = process.platform === 'darwin' && process.arch === 'arm64';
const windows = process.platform === 'win32' && process.arch === 'x64';
if (!mac && !windows) throw new Error('Run Rust upgrade acceptance on macOS arm64 or Windows x64.');
const repository = fileURLToPath(new URL('../', import.meta.url));
const platform = mac ? 'macos-arm64' : 'windows-x64';
const rootName = mac ? 'Morrow Mail.app' : 'Morrow Mail-win32-x64';
const options = {};
for (const argument of process.argv.slice(2)) {
  const match = argument.match(/^--(candidate|compatibility-root)=(.+)$/);
  if (!match || options[match[1]]) throw new Error('Use optional --candidate=PATH and --compatibility-root=PATH exactly once.');
  options[match[1]] = resolve(match[2]);
}
const candidate = options.candidate || resolve(repository, 'build', mac ? 'macos' : 'windows', rootName);
const compatibility = options['compatibility-root'] || repository;
const { createStore } = await import(pathToFileURL(join(compatibility, 'server/store.js')).href);
const { validatePackage } = await import(pathToFileURL(join(compatibility, 'server/update-installer.js')).href);
const { createLearning, ownText } = await import(pathToFileURL(join(compatibility, 'server/learning.js')).href);
const { createReplySuggestions } = await import(pathToFileURL(join(compatibility, 'server/reply-suggestions.js')).href);
const { resolvePolicy, redactMessage } = await import(pathToFileURL(join(compatibility, 'server/policy.js')).href);
const relativeBackend = mac ? 'Contents/Resources/backend' : 'resources/app/backend';
const relativeUI = mac ? 'Contents/MacOS/MorrowMail' : 'Morrow Mail.exe';
const relativeService = mac ? 'Contents/Resources/morrow-service' : 'resources/app/runtime/morrow-service.exe';
const version = JSON.parse(readFileSync(resolve(repository, 'package.json'))).version;
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const jsonHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function seedNativeFeatures(store) {
  // Use the compatibility service's real synchronous review builders, including
  // source hashes, stamps and token estimates. Never call generate/run/tick/send.
  // Fictional model results below exercise persistence, not model acceptance.
  const owners = ['first@n4-upgrade.example.invalid', 'second@n4-upgrade.example.invalid'];
  const timestamp = Date.now(), date = new Date(timestamp).toISOString();
  const sentId = 'n4-sent-source', inboxId = 'n4-inbox-source';
  const reviewedPolicy = resolvePolicy({ enabled: true, maxMessages: 8,
    summarySchedule: { timeZone: 'UTC' }, folders: { inbox: true, sent: true },
    content: { sender: true, subject: true, body: true }, behaviors: { reply: true, memory: true },
    triggers: { onOpen: false, onReply: false, onArrival: false, scheduledSummary: false } });
  const connections = Object.fromEntries(owners.map(email => [email, { provider: 'google', email, connectionId: randomUUID() }]));
  const styleLearning = Object.fromEntries(owners.map((owner, index) => [owner, { settings: {
    enabled: true, weekly: false, months: 3, maxSamples: 1, tokenBudget: 64000,
    identity: { displayName: `Fixture Person ${index + 1}`, aliases: [`Fixture Alias ${index + 1}`], confirmed: true },
  } }]));
  const replySuggestions = Object.fromEntries(owners.map(owner => [owner, { settings: { enabled: true, maxMessages: 1, tokenBudget: 64000 }, job: null, proposals: [] }]));
  store.setSettings({ mailAccounts: connections, mail: null, aiGeneration: 7,
    ai: { baseUrl: 'https://model.example.invalid/v1', model: 'fictional-upgrade-model', apiKey: '', maxTokens: 256 },
    preferences: { syncInterval: 0, displayName: 'Upgrade Fixture', markReadOnOpen: false },
    policy: reviewedPolicy, styleLearning, replySuggestions });
  for (const [index, owner] of owners.entries()) {
    store.upsertMessage(owner, { id: sentId, folder: 'sent', fromEmail: owner, fromName: `Fixture Person ${index + 1}`,
      to: 'separate-learning-recipient@example.invalid', subject: 'Owned learning source',
      body: `This is fictional Sent correspondence owned only by ${owner}. Please use clear sentences and review each proposed action before proceeding.`,
      date: new Date(timestamp - 600000).toISOString(), read: true, starred: false, category: 'primary', labels: [] });
    store.upsertMessage(owner, { id: inboxId, folder: 'inbox', fromEmail: 'correspondent@example.invalid', fromName: 'Fixture Correspondent', to: owner,
      subject: 'Fictional follow-up review', body: `Hello Fixture Person ${index + 1}, could you review the fictional agenda? No real action is requested.`,
      preview: 'Fictional follow-up review', date: new Date(timestamp - 300000).toISOString(),
      read: false, starred: false, pending: index === 0, category: 'primary', labels: [] });
  }
  const noModel = () => { throw new Error('N4 fixture must never call a model.'); };
  const learning = createLearning({ store, connection: owner => connections[owner], runModel: noModel, now: () => timestamp });
  for (const [index, owner] of owners.entries()) {
    const preview = learning.prepare(owner);
    const voice = `Approved fictional style for Fixture Person ${index + 1}: concise, courteous and explicit about uncertainty.`;
    let value = store.getSettings().styleLearning[owner];
    store.setSettings({ styleLearning: { ...store.getSettings().styleLearning, [owner]: {
      ...value, analyzedThrough: preview.through, preview: { ...preview, status: 'ready', voice, usage: {} },
    } } });
    learning.apply(owner, { previewId: preview.id, voice });
    assert.equal(learning.voice(owner), voice, 'The approved fixture profile must have valid owned Sent sources.');
    const replacement = learning.prepare(owner);
    value = store.getSettings().styleLearning[owner];
    store.setSettings({ styleLearning: { ...store.getSettings().styleLearning, [owner]: { ...value,
      preview: index === 0
        ? { ...replacement, status: 'ready', voice: 'Unapplied fictional replacement: retain the original approved profile.', usage: {} }
        : { ...replacement, status: 'running' },
    } } });
  }
  const sourceHistory = { matchedMessages: 1, usedMessages: 1, maxMessages: 8, scope: 'downloaded' };
  const suggestions = createReplySuggestions({ store, connections: () => connections, styleVoice: owner => learning.voice(owner), runModel: noModel, now: () => timestamp,
    contextFor: (action, input, owner) => {
      assert.equal(action, 'reply');
      assert.equal(input.messageId, inboxId);
      assert.equal(input.includeHistory, true);
      // The Sent sample has a different correspondent; this owned Inbox message
      // is the entire available correspondence in this bounded fixture.
      return { messages: [redactMessage(store.getMessage(owner, inboxId), reviewedPolicy)], history: sourceHistory };
    },
  });
  for (const [index, owner] of owners.entries()) {
    suggestions.preview(owner, { messageIds: [inboxId] });
    let value = store.getSettings().replySuggestions[owner];
    const item = value.job.items[0];
    const proposal = { needsReply: true, reason: 'The fictional sender explicitly asks for review.', text: `Fictional reply from Fixture Person ${index + 1}; review before using.`,
      id: randomUUID(), messageId: item.messageId, stamp: item.stamp, sourceHash: item.sourceHash, sources: item.sources,
      history: value.job.samples[0].history, status: 'ready', createdAt: date };
    store.setSettings({ replySuggestions: { ...store.getSettings().replySuggestions, [owner]: { ...value,
      job: { ...value.job, status: 'complete', completed: 1, spentTokens: item.estimatedTokens }, proposals: [proposal],
    } } });
    assert.equal(suggestions.state(owner).proposals[0]?.id, proposal.id, 'The fixture proposal must be valid before disconnecting.');
    if (index === 1) {
      // Retain the previous ready proposal while a separately reviewed batch
      // was interrupted. Initialization must not replay its claimed work.
      suggestions.preview(owner, { messageIds: [inboxId] });
      value = store.getSettings().replySuggestions[owner];
      store.setSettings({ replySuggestions: { ...store.getSettings().replySuggestions, [owner]: { ...value,
        job: { ...value.job, status: 'running', inflight: true, spentTokens: value.job.items[0].estimatedTokens },
      } } });
    }
  }
  const id = randomUUID(), sendAt = new Date(timestamp + 5 * 365 * 86400000).toISOString();
  const payload = { to: 'future@example.invalid', cc: 'future-cc@example.invalid', bcc: 'future-bcc@example.invalid',
    subject: 'Distant-future fictional scheduled draft', body: 'Immutable fixture payload. No delivery is performed by upgrade acceptance.',
    footer: { text: 'Reviewed fixture footer', html: '' }, replyToId: inboxId };
  const payloadHash = jsonHash({ to: payload.to, subject: payload.subject, body: payload.body, replyToId: payload.replyToId, cc: payload.cc, bcc: payload.bcc, footer: payload.footer });
  const job = { id, accountId: owners[0], draftId: `outbox:scheduled:${id}`, sendAt, status: 'scheduled', createdAt: date, updatedAt: date,
    connectionId: connections[owners[0]].connectionId, payload, payloadHash, fromName: 'Upgrade Fixture', replyMessageId: '' };
  store.upsertMessage(owners[0], { id: job.draftId, fromName: job.fromName, fromEmail: owners[0], date, read: true, starred: false, category: 'primary', labels: [],
    ...payload, preview: payload.body, folder: 'drafts', scheduledSend: { id, sendAt, status: 'scheduled' } });
  // Disconnect after constructing genuine historical review snapshots. The old
  // and new services receive no mailbox credentials or model configuration.
  // Sync/weekly learning are off and the scheduled time is years away. Retained
  // disconnected history does NOT establish current eligibility after reconnect.
  store.setSettings({ scheduledSends: [job], mail: null, mailAccounts: {}, ai: null, aiGeneration: 8,
    policy: { ...reviewedPolicy, enabled: false } });
  const expected = structuredClone(store.getSettings());
  // Only these initialize/recover mutations are allowed. The distant-future
  // scheduled job is not claimed; its job, draft and marker must remain exact.
  expected.styleLearning[owners[1]].preview.status = 'interrupted';
  expected.styleLearning[owners[1]].preview.error = 'Interrupted by shutdown. Tokens may have been used. Prepare new samples to retry.';
  expected.replySuggestions[owners[1]].job.status = 'interrupted';
  expected.replySuggestions[owners[1]].job.error = 'Analysis failed or its approved context changed. No automatic retry was made; tokens may have been used. Review a new batch to retry.';
  const records = owners.flatMap(owner => store.listMessages(owner).map(message => ({ owner, message: structuredClone(message) })));
  return { owners, expected, records, reviewedPolicy, sourceHistory };
}

function verifyNativeFeatures(store, fixture) {
  const settings = store.getSettings();
  for (const key of ['scheduledSends', 'styleLearning', 'replySuggestions']) assert.deepEqual(settings[key], fixture.expected[key], `${key} changed beyond explicit interrupted-claim recovery.`);
  assert.deepEqual(settings.mailAccounts, {});
  assert.equal(settings.mail, null);
  assert.equal(settings.ai, null);
  assert.equal(settings.policy.enabled, false);
  assert.equal(settings.preferences.syncInterval, 0);
  assert.equal(settings.aiGeneration, fixture.expected.aiGeneration);
  for (const { owner, message } of fixture.records) {
    assert.deepEqual(store.getMessage(owner, message.id), message, 'N4 pending/source/scheduled draft records must survive exactly.');
    assert.equal(store.getMessage('demo', message.id), null, 'N4 mail must not migrate into Demo.');
  }
  for (const owner of fixture.owners) {
    assert.equal(store.listMessages(owner).length, fixture.records.filter(item => item.owner === owner).length, 'Upgrade must not create additional drafts, Sent records or other messages.');
    const learning = settings.styleLearning[owner];
    for (const source of [...learning.profile.sources, ...learning.preview.sources]) {
      const message = store.getMessage(owner, source.id);
      assert.equal(message.folder, 'sent');
      assert.equal(message.fromEmail, owner);
      assert.equal(source.hash, jsonHash(ownText(message.body)), 'The real owned Sent source hash must survive.');
    }
    const suggestions = settings.replySuggestions[owner];
    for (const item of [...suggestions.job.items, ...suggestions.proposals]) {
      const messages = item.sources.map(source => {
        const message = redactMessage(store.getMessage(owner, source.id), fixture.reviewedPolicy);
        assert.equal(source.hash, jsonHash(message), 'Reply context must retain its original owned source hash.');
        return message;
      });
      assert.equal(item.sourceHash, jsonHash([messages, fixture.sourceHistory]));
    }
  }
  for (const job of settings.scheduledSends) {
    const draft = store.getMessage(job.accountId, job.draftId);
    assert.deepEqual(draft.scheduledSend, { id: job.id, sendAt: job.sendAt, status: 'scheduled' });
    assert.equal(store.getMessage(job.accountId, `sent:${job.id}`), null, 'Upgrade must never execute the future scheduled send.');
  }
}

const exec = promisify(execFile);
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const powershell = command => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; " + command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 240000 });
assert.ok(existsSync(join(candidate, relativeService)), 'Build the explicit Rust candidate first.');
assert.equal(execFileSync(join(candidate, relativeService), ['--version'], { encoding: 'utf8' }).trim(), `Morrow Mail ${version}`);
assert.ok(readFileSync(join(dirname(join(candidate, relativeService)), 'THIRD_PARTY_LICENSES.txt'), 'utf8').includes('MPL-2.0'));
if (mac) assert.equal(execFileSync('/usr/bin/plutil', ['-extract', 'MorrowServiceRuntime', 'raw', '-o', '-', join(candidate, 'Contents/Info.plist')], { encoding: 'utf8' }).trim(), 'rust');
else assert.equal(JSON.parse(readFileSync(join(candidate, 'resources/app/package.json'))).serviceRuntime, 'rust');
await validatePackage(candidate, platform, version);

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'morrow-rust-upgrade-')));
const target = join(directory, 'installed', rootName), incoming = join(directory, 'incoming', rootName);
const workspace = join(directory, 'workspace'), archive = join(directory, 'update.zip');
const servicePath = join(target, relativeService), uiPath = join(target, relativeUI);
let restarted;
const samePath = (actual, expected) => {
  try { return realpathSync(actual) === realpathSync(expected); } catch { return false; }
};
function fixtureProcesses() {
  if (mac) {
    const rows = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
    const service = rows.find(row => row[3].endsWith('/morrow-service') && samePath(row[3], servicePath));
    const ui = rows.find(row => row[3].endsWith('/MorrowMail') && samePath(row[3], uiPath) && (!service || row[1] === service[2]));
    return ui ? { ui: Number(ui[1]), service: service ? Number(service[1]) : 0 } : null;
  }
  const output = powershell(`$all=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${quote(servicePath)} -or $_.ExecutablePath -eq ${quote(uiPath)} }); $s=$all | Where-Object { $_.ExecutablePath -eq ${quote(servicePath)} } | Select-Object -First 1; $u=$all | Where-Object { $_.ExecutablePath -eq ${quote(uiPath)} -and (($s -and $_.ProcessId -eq $s.ParentProcessId) -or (!$s -and $_.ParentProcessId -notin $all.ProcessId)) } | Select-Object -First 1; if ($u) { @{ui=[int]$u.ProcessId;service=[int]$s.ProcessId} | ConvertTo-Json -Compress }`).trim();
  return output ? JSON.parse(output) : null;
}
const alive = pid => { if (!Number.isSafeInteger(pid) || pid <= 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
async function closeFixture() {
  const owned = fixtureProcesses() || restarted;
  if (!owned) return;
  // These PIDs were identified by the exact temporary executable and its parent.
  if (alive(owned.ui)) {
    if (mac) process.kill(owned.ui, 'SIGTERM');
    else powershell(`$p=Get-Process -Id ${owned.ui} -ErrorAction SilentlyContinue; if ($p) { $null=$p.CloseMainWindow() }`);
  }
  const deadline = Date.now() + 75000;
  while (alive(owned.ui) || alive(owned.service)) {
    if (Date.now() > deadline) {
      for (const pid of [owned.ui, owned.service]) if (alive(pid)) process.kill(pid, 'SIGKILL');
      throw new Error('The fixture desktop did not stop its Rust service cleanly.');
    }
    await delay(100);
  }
  restarted = null;
}
try {
  const backend = join(target, relativeBackend);
  mkdirSync(backend, { recursive: true });
  for (const name of ['server', 'shared']) cpSync(resolve(compatibility, name), join(backend, name), { recursive: true });
  mkdirSync(join(backend, 'rust/resources'), { recursive: true });
  cpSync(resolve(repository, 'rust/resources/catalog.json'), join(backend, 'rust/resources/catalog.json'));
  writeFileSync(join(backend, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.1' }));
  symlinkSync(resolve(compatibility, 'node_modules'), join(backend, 'node_modules'), windows ? 'junction' : 'dir');
  const keys = generateKeyPairSync('ed25519');
  writeFileSync(join(backend, 'server/update-public-key.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  for (const file of ['updater.js', 'update-installer.js', 'update-trust.js', 'updates.js']) assert.equal(digest(join(backend, 'server', file)), digest(resolve(compatibility, 'server', file)));

  const store = createStore(workspace);
  const draftOwner = 'disconnected-upgrade@example.invalid', requestId = randomUUID();
  // A disconnected mailbox retains a real unconfirmed outbox record without
  // introducing credentials or any opportunity for an external provider write.
  const draft = { ...store.getMessage('demo', 'demo-1'), id: `outbox:${requestId}`, fromEmail: draftOwner, folder: 'drafts', subject: 'Isolated uncertain draft', body: 'Preserve the original draft and explicit retry review.', deliveryStatus: 'unconfirmed', deliveryRequestId: requestId, to: 'fixture@example.invalid', cc: 'cc@example.invalid', bcc: 'bcc@example.invalid', footer: { text: 'Fixture signature', html: '<p>Fixture signature</p>' } };
  const payloadHash = createHash('sha256').update(JSON.stringify({ to: draft.to, subject: draft.subject, body: draft.body, replyToId: draft.replyToId || '', cc: draft.cc, bcc: draft.bcc, footer: draft.footer })).digest('hex');
  const deliveryAttempts = [{ account: draftOwner, requestId, draftId: draft.id, payloadHash, createdAt: new Date().toISOString() }];
  store.setSettings({ upgradeFixture: 'preserve-settings', mail: null, mailAccounts: {}, activeAccount: 'demo', deliveryAttempts });
  store.upsertMessage(draftOwner, draft);
  const nativeFeatures = seedNativeFeatures(store);
  store.close();
  // Swift Codable uses seconds since 2001 for Date. These contain no credentials
  // or connected calendar, so neither client can issue a provider write.
  const pending = { id: randomUUID(), provider: 'google', calendarID: 'fixture', calendarName: 'Fixture', email: 'fixture@example.invalid', title: 'Preserve calendar retry', location: '', description: '', start: 900000000, end: 900003600, attempted: true };
  const calendarReview = { provider: pending.provider, calendarName: pending.calendarName, calendarId: pending.calendarID, connectionEmail: pending.email, title: pending.title, description: pending.description, location: pending.location, start: new Date(Date.UTC(2001, 0, 1) + pending.start * 1000).toISOString(), end: new Date(Date.UTC(2001, 0, 1) + pending.end * 1000).toISOString() };
  const recovery = { 'pending-calendar.json': JSON.stringify(pending), 'client-state.json': JSON.stringify({ 'morrow.pendingCalendar': JSON.stringify({ review: calendarReview, requestId: pending.id }) }), 'do-not-change.txt': 'existing isolated workspace' };
  for (const [file, content] of Object.entries(recovery)) writeFileSync(join(workspace, file), content, { mode: 0o600 });
  const keyDigest = digest(join(workspace, 'encryption.key'));

  cpSync(candidate, incoming, { recursive: true });
  if (mac) {
    const plist = join(incoming, 'Contents/Info.plist');
    // LaunchServices does not promise to inherit the installer's environment.
    // Fix the temporary workspace in this fixture's own bundle and use a unique
    // identity so an owner's running app can never receive this launch.
    execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', `org.morrowmail.upgrade-fixture.${randomUUID()}`, plist]);
    execFileSync('/usr/bin/plutil', ['-insert', 'LSEnvironment', '-json', JSON.stringify({ MORROW_DATA_DIR: workspace }), plist]);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', incoming], { stdio: 'pipe' });
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', incoming, archive]);
  } else powershell(`Compress-Archive -LiteralPath ${quote(incoming)} -DestinationPath ${quote(archive)}`);
  await validatePackage(incoming, platform, version);
  assert.equal(digest(join(incoming, relativeService)), digest(join(candidate, relativeService)), 'The production Rust service must remain unmodified.');
  const bytes = readFileSync(archive);
  const manifest = Buffer.from(JSON.stringify({ version, platforms: Object.fromEntries(['macos-arm64', 'windows-x64'].map(id => [id, { name: `Morrow-Mail-${version}-${id}.zip`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }])) }));
  writeFileSync(join(directory, 'update-manifest.json'), manifest);
  writeFileSync(join(directory, 'update-manifest.sig'), sign(null, manifest, keys.privateKey).toString('base64'));
  const loader = join(directory, 'fetch-fixture.mjs');
  writeFileSync(loader, `import {readFileSync} from 'node:fs';
globalThis.fetch = async url => {
  if (String(url).startsWith('https://api.github.com/repos/Coke1120/Morrow-Mail/releases?')) return new Response(JSON.stringify([{tag_name:${JSON.stringify('v' + version)},draft:false,prerelease:true}]));
  const base=${JSON.stringify(`https://github.com/Coke1120/Morrow-Mail/releases/download/v${version}/`)};
  const files=${JSON.stringify({ 'update-manifest.json': join(directory, 'update-manifest.json'), 'update-manifest.sig': join(directory, 'update-manifest.sig'), [`Morrow-Mail-${version}-${platform}.zip`]: archive })};
  if (!String(url).startsWith(base) || !files[String(url).slice(base.length)]) throw Error('Unexpected external access in upgrade fixture');
  return new Response(readFileSync(files[String(url).slice(base.length)]));
};`);
  const owner = join(directory, 'owner.mjs');
  writeFileSync(owner, `import {spawn} from 'node:child_process'; import {once} from 'node:events'; import {readFileSync} from 'node:fs'; import {createInterface} from 'node:readline'; import {setTimeout as delay} from 'node:timers/promises'; import assert from 'node:assert/strict';
const token='a'.repeat(64), updateToken='b'.repeat(64);
const child=spawn(process.execPath,['--import',${JSON.stringify(pathToFileURL(loader).href)},${JSON.stringify(join(backend, 'server/native.js'))}],{stdio:['pipe','pipe','pipe']});
child.stderr.pipe(process.stderr); const exited=once(child,'exit');
try {
  const lines=createInterface({input:child.stdout}), ready=once(lines,'line');
  child.stdin.write(JSON.stringify({token,updateToken,parentPID:process.pid,dataDirectory:${JSON.stringify(workspace)}})+'\\n');
  const [line]=await Promise.race([ready,exited.then(([code])=>{throw Error('Old service exited before readiness: '+code);})]), base='http://127.0.0.1:'+JSON.parse(line).port;
  const request=(path,body,extra={})=>fetch(base+'/api/updates/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await (await request('status')).json()).supported,true);
  assert.equal((await request('install',{})).status,403);
  assert.equal((await request('download',{includePrereleases:true})).status,202);
  const deadline=Date.now()+240000;
  while(true) { const status=await (await request('status')).json(); if(status.phase==='error')throw Error(status.error); if(status.phase==='ready')break; if(Date.now()>deadline)throw Error('Download timed out'); await delay(100); }
  const installed=await request('install',{}, {'X-Morrow-Update':updateToken}); assert.equal(installed.status,200); assert.equal((await installed.json()).phase,'installing');
  await delay(300); assert.equal(JSON.parse(readFileSync(${JSON.stringify(join(backend, 'package.json'))})).version,'0.0.1');
} finally { child.stdin.end(); await exited; }
await delay(300); assert.equal(JSON.parse(readFileSync(${JSON.stringify(join(backend, 'package.json'))})).version,'0.0.1');
`);
  const environment = { ...process.env, MORROW_DATA_DIR: workspace };
  delete environment.NODE_OPTIONS; delete environment.NODE_PATH; delete environment.ELECTRON_RUN_AS_NODE;
  console.log('Upgrade fixture: old Node updater is verifying the actual signed Rust candidate.');
  await exec(process.execPath, [owner], { env: environment, timeout: 300000, windowsHide: true });
  const deadline = Date.now() + 90000;
  while (true) {
    if (existsSync(join(workspace, 'update-result.json'))) {
      const result = JSON.parse(readFileSync(join(workspace, 'update-result.json')));
      assert.equal(result.status, 'installed', result.reason);
      assert.equal(result.version, version);
      restarted = fixtureProcesses();
      if (restarted?.service) break;
    }
    if (Date.now() > deadline) throw new Error('The installed production UI did not start its Rust service.');
    await delay(300);
  }
  // The old owner and Node child have exited. An exclusive read lock here proves
  // that the restarted Rust service owns this exact temporary SQLite workspace.
  const probe = new DatabaseSync(join(workspace, 'genmail.sqlite'));
  try {
    probe.exec('PRAGMA busy_timeout=100');
    const readyDeadline = Date.now() + 20000;
    while (true) {
      try { probe.prepare('SELECT count(*) FROM messages').get(); }
      catch (error) { if (error.errcode === 5 || /database is locked/.test(error.message)) break; throw error; }
      if (Date.now() > readyDeadline) throw new Error('The restarted service did not acquire its fixture workspace.');
      await delay(100);
    }
  } finally { probe.close(); }
  let port;
  const listenDeadline = Date.now() + 20000;
  while (!(port > 0 && port < 65536)) {
    try {
      port = mac
        ? Number(execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(restarted.service), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/n127\.0\.0\.1:(\d+)/)?.[1])
        : Number(powershell(`Get-NetTCPConnection -OwningProcess ${restarted.service} -State Listen | Where-Object LocalAddress -eq '127.0.0.1' | Select-Object -First 1 -ExpandProperty LocalPort`).trim());
    } catch { /* The socket may not be listening yet, after acquiring SQLite. */ }
    if (Date.now() > listenDeadline) throw new Error('The restarted service did not listen on loopback.');
    if (!port) await delay(100);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(5000) })).status, 401, 'The restarted service must retain bearer protection.');
  assert.equal(digest(servicePath), digest(join(candidate, relativeService)));
  await closeFixture();
  const previous = readdirSync(join(directory, 'installed')).filter(name => name.startsWith('.morrow-update-')).map(name => join(directory, 'installed', name, 'previous', relativeBackend, 'package.json'));
  assert.equal(previous.length, 1);
  assert.equal(JSON.parse(readFileSync(previous[0])).version, '0.0.1');
  for (const [file, content] of Object.entries(recovery)) {
    const actual = readFileSync(join(workspace, file), 'utf8');
    if (file === 'client-state.json') {
      // The real UI may persist new preferences on launch. Every pre-existing
      // value, including the serialized calendar request/payload, must be exact.
      const state = JSON.parse(actual);
      for (const [key, value] of Object.entries(JSON.parse(content))) assert.equal(state[key], value, `${key} was changed by the upgrade.`);
    } else assert.equal(actual, content, `${file} was changed by the upgrade.`);
  }
  const clientStateAfterRestart = readFileSync(join(workspace, 'client-state.json'), 'utf8');
  assert.equal(digest(join(workspace, 'encryption.key')), keyDigest);
  const verifyRecords = directory => {
    const restored = createStore(directory);
    try {
      const settings = restored.getSettings();
      assert.equal(settings.upgradeFixture, 'preserve-settings');
      assert.deepEqual(settings.deliveryAttempts, deliveryAttempts, 'The original owner, retry ID, payload hash and creation time must survive.');
      assert.deepEqual(restored.getMessage(draftOwner, draft.id), draft, 'The unconfirmed draft, delivery ID, To/Cc/Bcc, body and footer must survive.');
      assert.equal(restored.getMessage('demo', draft.id), null, 'The retained outbox must not migrate to another account.');
      verifyNativeFeatures(restored, nativeFeatures);
    } finally { restored.close(); }
    for (const file of ['pending-calendar.json', 'client-state.json']) assert.equal(readFileSync(join(directory, file), 'utf8'), file === 'client-state.json' ? clientStateAfterRestart : recovery[file], `${file} recovery ID and full reviewed payload must survive.`);
    assert.equal(digest(join(directory, 'encryption.key')), keyDigest);
  };
  verifyRecords(workspace);
  const backup = join(directory, 'verified-backup');
  execFileSync(servicePath, ['--backup', workspace, backup], { stdio: 'pipe', timeout: 30000 });
  verifyRecords(backup);
  console.log('Rust upgrade acceptance passed: original Node signature/install paths, both owner PIDs exited before replacement, real production UI/Rust restart, private API, previous app retained, settings/key/uncertain draft/calendar retry and N4 scheduled/pending/learning/reply records preserved, interrupted model claims not replayed, bundled backup restored.');
} finally {
  await closeFixture();
  if (process.env.MORROW_KEEP_UPDATE_TEST === '1') console.log(`Rust upgrade fixture retained: ${directory}`);
  else rmSync(directory, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 });
}
