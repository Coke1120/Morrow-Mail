import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { packager } from '@electron/packager';
import { bundleOAuth } from './bundle-oauth.js';
import { serviceRuntime, buildRustService } from './build-rust.js';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Windows x64 app on Windows x64 using the official Node distribution.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'build/windows');
const stage = resolve(output, 'stage');
const { version, devDependencies } = JSON.parse(readFileSync(resolve(root, 'package.json')));
const node = realpathSync(process.execPath);
const license = [process.env.MORROW_NODE_LICENSE, resolve(dirname(node), 'LICENSE'), resolve(dirname(node), '../LICENSE')].find(path => path && existsSync(path));
if (serviceRuntime === 'node' && !license) throw new Error('The official Node LICENSE is required. Set MORROW_NODE_LICENSE if needed.');
if (!existsSync(resolve(root, 'dist/index.html'))) throw new Error('Run npm run build before packaging.');
rmSync(stage, { recursive: true, force: true });
mkdirSync(resolve(stage, 'runtime'), { recursive: true });
mkdirSync(resolve(stage, 'backend/scripts'), { recursive: true });
for (const name of ['main.cjs', 'preload.cjs', 'security.cjs', 'client-state.cjs', 'icon.ico']) cpSync(resolve(root, 'desktop', name), resolve(stage, name));
if (serviceRuntime === 'rust') {
  buildRustService(resolve(stage, 'runtime/morrow-service.exe'));
  for (const name of ['dist', 'package.json', 'LICENSE', 'README.md', 'FEATURE_COVERAGE.md', 'VERIFICATION.md']) cpSync(resolve(root, name), resolve(stage, 'backend', name), { recursive: true });
} else {
  cpSync(node, resolve(stage, 'runtime/node.exe'));
  cpSync(license, resolve(stage, 'NODE-LICENSE.txt'));
  for (const name of ['server', 'shared', 'dist', 'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'FEATURE_COVERAGE.md', 'VERIFICATION.md']) cpSync(resolve(root, name), resolve(stage, 'backend', name), { recursive: true });
  mkdirSync(resolve(stage, 'backend/rust/resources'), { recursive: true });
  cpSync(resolve(root, 'rust/resources/catalog.json'), resolve(stage, 'backend/rust/resources/catalog.json'));
  cpSync(resolve(root, 'scripts/backup.js'), resolve(stage, 'backend/scripts/backup.js'));
  if (!process.env.npm_execpath) throw new Error('Run this builder through npm run windows:build.');
  execFileSync(process.execPath, [process.env.npm_execpath, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: resolve(stage, 'backend'), stdio: 'inherit' });
}
bundleOAuth(resolve(stage, 'backend'));
writeFileSync(resolve(stage, 'package.json'), JSON.stringify({ name: 'morrow-mail-desktop', productName: 'Morrow Mail', version, serviceRuntime, main: 'main.cjs', license: 'MIT', private: true }));
const [application] = await packager({ dir: stage, out: output, name: 'Morrow Mail', executableName: 'Morrow Mail', platform: 'win32', arch: 'x64', electronVersion: devDependencies.electron, appVersion: version, buildVersion: version.split('-')[0], icon: resolve(stage, 'icon.ico'), overwrite: true, prune: false, asar: false, win32metadata: { CompanyName: 'Morrow Mail contributors', FileDescription: 'Morrow Mail', ProductName: 'Morrow Mail', InternalName: 'MorrowMail' } });
console.log(`Built ${application}. Unsigned build; extract the entire folder before running Morrow Mail.exe.`);
