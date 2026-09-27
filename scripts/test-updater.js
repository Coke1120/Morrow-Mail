// Full install/restart acceptance against generated apps and temporary workspaces.
// Never launches Morrow with the owner's data or uses the release signing key.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { validatePackage } from '../server/update-installer.js';
const platform = process.platform === 'darwin' ? 'macos-arm64' : process.platform === 'win32' ? 'windows-x64' : null;
if (!platform) { console.log('Updater install checks run on macOS and Windows.'); process.exit(0); }
const directory = mkdtempSync(join(tmpdir(), 'morrow-updater-acceptance-'));
const root = platform === 'macos-arm64' ? 'Morrow Mail.app' : 'Morrow Mail-win32-x64';
const target = join(directory, 'installed', root), incoming = join(directory, 'incoming', root), workspace = join(directory, 'workspace');
const relativeBackend = platform === 'macos-arm64' ? 'Contents/Resources/backend' : 'resources/app/backend';
const relativeExecutable = platform === 'macos-arm64' ? 'Contents/MacOS/MorrowMail' : 'Morrow Mail.exe';
const marker = join(directory, 'restarted.txt'), archive = join(directory, 'update.zip');
const ps = command => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { stdio: 'pipe' });
const quote = value => "'" + value.replaceAll("'", "''") + "'";
try {
  mkdirSync(join(target, relativeBackend), { recursive: true });
  mkdirSync(join(incoming, relativeBackend), { recursive: true });
  mkdirSync(workspace); writeFileSync(join(workspace, 'do-not-change.txt'), 'existing workspace');
  const backend = join(target, relativeBackend);
  for (const item of ['server', 'shared']) cpSync(resolve(item), join(backend, item), { recursive: true });
  mkdirSync(join(backend, 'rust/resources'), { recursive: true });
  cpSync(resolve('rust/resources/catalog.json'), join(backend, 'rust/resources/catalog.json'));
  writeFileSync(join(backend, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.1' }));
  symlinkSync(resolve('node_modules'), join(backend, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(incoming, relativeBackend, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.2' }));
  const keys = generateKeyPairSync('ed25519');
  writeFileSync(join(backend, 'server/update-public-key.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  if (platform === 'macos-arm64') {
    mkdirSync(join(incoming, 'Contents/MacOS'), { recursive: true });
    const swift = join(directory, 'Restart.swift');
    writeFileSync(swift, `import Foundation\ntry! "restarted".write(toFile: ${JSON.stringify(marker)}, atomically: true, encoding: .utf8)\n`);
    execFileSync('swiftc', [swift, '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.5`, '-o', join(incoming, relativeExecutable)], { stdio: 'pipe' });
    writeFileSync(join(incoming, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.morrowmail.updater-check</string><key>CFBundleExecutable</key><string>MorrowMail</string><key>CFBundleVersion</key><string>0.0.2</string><key>LSMinimumSystemVersion</key><string>13.5</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', incoming], { stdio: 'pipe' });
    const plist = join(incoming, 'Contents/Info.plist'), supported = readFileSync(plist, 'utf8');
    writeFileSync(plist, supported.replace('<string>13.5</string>', '<string>99.0</string>'));
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', incoming], { stdio: 'pipe' });
    await assert.rejects(validatePackage(incoming, platform, '0.0.2'), /newer macOS/);
    writeFileSync(plist, supported);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', incoming], { stdio: 'pipe' });
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', incoming, archive]);
  } else {
    const code = `public class Restart { public static void Main() { System.IO.File.WriteAllText(${JSON.stringify(marker)}, "restarted"); } }`;
    ps(`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ${quote(code)} -OutputAssembly ${quote(join(incoming, relativeExecutable))} -OutputType WindowsApplication; Compress-Archive -Path ${quote(incoming)} -DestinationPath ${quote(archive)}`);
  }
  const bytes = readFileSync(archive), version = '0.0.2';
  const manifest = Buffer.from(JSON.stringify({ version, platforms: Object.fromEntries(['macos-arm64', 'windows-x64'].map(id => [id, { name: `Morrow-Mail-${version}-${id}.zip`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }])) }));
  writeFileSync(join(directory, 'update-manifest.json'), manifest);
  writeFileSync(join(directory, 'update-manifest.sig'), sign(null, manifest, keys.privateKey).toString('base64'));
  const loader = join(directory, 'fetch-fixture.mjs');
  writeFileSync(loader, `import {readFileSync} from 'node:fs';
globalThis.fetch = async url => {
  if (String(url).startsWith('https://api.github.com/repos/Coke1120/Morrow-Mail/releases?')) return new Response(JSON.stringify([{tag_name:'v0.0.2',draft:false,prerelease:false}]));
  const base='https://github.com/Coke1120/Morrow-Mail/releases/download/v0.0.2/';
  const files=${JSON.stringify({ 'update-manifest.json': join(directory, 'update-manifest.json'), 'update-manifest.sig': join(directory, 'update-manifest.sig'), [`Morrow-Mail-0.0.2-${platform}.zip`]: archive })};
  if (!String(url).startsWith(base) || !files[String(url).slice(base.length)]) throw Error('Unexpected provider access in fixture');
  return new Response(readFileSync(files[String(url).slice(base.length)]));
};`);
  const owner = join(directory, 'owner.mjs');
  writeFileSync(owner, `import {spawn} from 'node:child_process'; import {once} from 'node:events'; import {createInterface} from 'node:readline'; import {setTimeout as delay} from 'node:timers/promises'; import assert from 'node:assert/strict';
const token='a'.repeat(64), updateToken='b'.repeat(64);
const child=spawn(process.execPath,['--import',${JSON.stringify(pathToFileURL(loader).href)},${JSON.stringify(join(backend, 'server/native.js'))}],{stdio:['pipe','pipe','pipe']});
child.stderr.pipe(process.stderr); const exited=once(child,'exit');
try {
  const lines=createInterface({input:child.stdout}), ready=once(lines,'line');
  child.stdin.write(JSON.stringify({token,updateToken,parentPID:process.pid,dataDirectory:${JSON.stringify(workspace)}})+'\\n');
  const [line]=await Promise.race([ready,exited.then(([code])=>{throw Error('Fixture service exited before startup: '+code);})]), base='http://127.0.0.1:'+JSON.parse(line).port;
  const request=(path,body,extra={})=>fetch(base+'/api/updates/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await (await request('status')).json()).supported,true);
  assert.equal((await request('install',{})).status,403);
  for (let attempt=0;attempt<2;attempt++) {
    assert.equal((await request('download',{includePrereleases:true})).status,202);
    const deadline=Date.now()+30000;
    while(true) { const status=await (await request('status')).json(); if(status.phase==='error')throw Error(status.error); if(status.phase==='ready')break; if(Date.now()>deadline)throw Error('Download timed out'); await delay(50); }
    if(attempt===0) { assert.equal((await request('cancel',{})).status,200); assert.equal((await (await request('status')).json()).phase,'idle'); }
  }
  const installed=await request('install',{}, {'X-Morrow-Update':updateToken}); assert.equal(installed.status,200); assert.equal((await installed.json()).phase,'installing');
} finally { child.stdin.end(); await exited; }
`);
  execFileSync(process.execPath, [owner], { stdio: 'pipe', timeout: 90000 });
  const deadline = Date.now() + 30000;
  while (!existsSync(marker) || !existsSync(join(workspace, 'update-result.json'))) { if (Date.now() > deadline) throw new Error('Updated app did not restart.'); await delay(100); }
  if (JSON.parse(readFileSync(join(workspace, 'update-result.json'))).status !== 'installed' || readFileSync(marker, 'utf8') !== 'restarted' || readFileSync(join(workspace, 'do-not-change.txt'), 'utf8') !== 'existing workspace' || JSON.parse(readFileSync(join(target, relativeBackend, 'package.json'))).version !== '0.0.2') throw new Error('Update acceptance failed.');
  console.log('Updater acceptance passed: signed download, cancellation, protected install authorization, waiting for both processes, replacement, app restart and untouched workspace.');
} finally {
  if (process.env.MORROW_KEEP_UPDATE_TEST === '1') console.log(`Updater fixture retained: ${directory}`);
  else rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}
