import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { bundleOAuth } from './bundle-oauth.js';
import { serviceRuntime, buildRustService } from './build-rust.js';

if (process.platform !== 'darwin') throw new Error('Build the native application on macOS with the Swift command-line tools installed.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'build/macos');
const application = resolve(output, 'Morrow Mail.app');
const identity = process.env.MORROW_SIGNING_IDENTITY || '-';
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: root, stdio: 'inherit', ...options });
const node = realpathSync(process.execPath);
const nodeLicense = [process.env.MORROW_NODE_LICENSE, resolve(dirname(node), '../LICENSE'), resolve(dirname(node), '../share/doc/node/LICENSE')].find(path => path && existsSync(path));
if (serviceRuntime === 'node' && !nodeLicense) throw new Error('Use the full official Node distribution with its LICENSE, or set MORROW_NODE_LICENSE to that license file.');
const libraries = run('/usr/bin/otool', ['-L', node], { encoding: 'utf8', stdio: 'pipe' }).split('\n').slice(1).filter(Boolean);
if (serviceRuntime === 'node' && libraries.some(line => !/^\s*\/(System\/Library|usr\/lib)\//.test(line))) throw new Error('Use a self-contained official Node distribution. This Node depends on libraries outside macOS and cannot be bundled portably.');
const buildInfo = run('/usr/bin/otool', ['-l', node], { encoding: 'utf8', stdio: 'pipe' });
const runtimeMinimum = buildInfo.match(/minos\s+([\d.]+)/)?.[1] || '13.5';
const minimum = serviceRuntime === 'rust' ? '13.5' : Number(runtimeMinimum.split('.')[0]) >= 13 ? runtimeMinimum : '13.0';
run('swift', ['build', '--package-path', 'macos', '-c', 'release']);
const bin = run('swift', ['build', '--package-path', 'macos', '-c', 'release', '--show-bin-path'], { encoding: 'utf8', stdio: 'pipe' }).trim();
// Only replace this generated build, never the user's installed app or data.
rmSync(application, { recursive: true, force: true });
const contents = resolve(application, 'Contents');
const resources = resolve(contents, 'Resources');
const backend = resolve(resources, 'backend');
mkdirSync(resolve(contents, 'MacOS'), { recursive: true });
mkdirSync(backend, { recursive: true });
cpSync(resolve(bin, 'MorrowMail'), resolve(contents, 'MacOS/MorrowMail'));
if (serviceRuntime === 'rust') {
  buildRustService(resolve(resources, 'morrow-service'));
  // Keep this exact metadata path readable by already-installed Node updaters.
  for (const path of ['package.json', 'LICENSE', 'README.md', 'FEATURE_COVERAGE.md', 'VERIFICATION.md']) cpSync(resolve(root, path), resolve(backend, path));
} else {
  cpSync(node, resolve(resources, 'node'));
  for (const path of ['server', 'shared', 'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'FEATURE_COVERAGE.md', 'VERIFICATION.md']) cpSync(resolve(root, path), resolve(backend, path), { recursive: true });
  mkdirSync(resolve(backend, 'rust/resources'), { recursive: true });
  cpSync(resolve(root, 'rust/resources/catalog.json'), resolve(backend, 'rust/resources/catalog.json'));
  cpSync(nodeLicense, resolve(resources, 'NODE-LICENSE.txt'));
  mkdirSync(resolve(backend, 'scripts'));
  cpSync(resolve(root, 'scripts/backup.js'), resolve(backend, 'scripts/backup.js'));
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: backend });
}
bundleOAuth(backend);
const iconset = resolve(output, 'Morrow.iconset');
run('swift', ['scripts/render-macos-icon.swift', 'src/assets/brand/morrow-icon.svg', iconset]);
run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', resolve(resources, 'Morrow.icns')]);
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json')));
writeFileSync(resolve(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Morrow Mail</string>
<key>CFBundleDisplayName</key><string>Morrow Mail</string>
<key>CFBundleIdentifier</key><string>org.morrowmail.desktop</string>
<key>CFBundleExecutable</key><string>MorrowMail</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version.split("-")[0]}</string>
<key>CFBundleVersion</key><string>${version.split("-")[0]}</string>
<key>MorrowReleaseVersion</key><string>${version}</string>
<key>MorrowServiceRuntime</key><string>${serviceRuntime}</string>
<key>CFBundleIconFile</key><string>Morrow</string>
<key>LSMinimumSystemVersion</key><string>${minimum}</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSMultipleInstancesProhibited</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
<key>NSHumanReadableCopyright</key><string>© 2026 Morrow Mail contributors. MIT License.</string>
</dict></plist>`);
const signing = identity === '-' ? [] : ['--options', 'runtime', '--timestamp'];
const entitlements = resolve(output, 'node-entitlements.plist');
writeFileSync(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>');
run('/usr/bin/codesign', ['--force', '--sign', identity, ...signing, ...(serviceRuntime === 'node' && identity !== '-' ? ['--entitlements', entitlements] : []), resolve(resources, serviceRuntime === 'rust' ? 'morrow-service' : 'node')]);
run('/usr/bin/codesign', ['--force', '--sign', identity, ...signing, application]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
if (!existsSync(resolve(resources, 'Morrow.icns'))) throw new Error('App icon was not generated.');
console.log(`Built ${application}\nMinimum macOS: ${minimum}. Architecture: ${process.arch}. ${identity === '-' ? 'Locally signed build; public distribution requires Developer ID signing and notarization.' : 'Signed build; notarize before public distribution.'}`);
