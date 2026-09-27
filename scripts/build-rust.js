import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Rust is the approved desktop default; Node remains an explicit compatibility build.
export const serviceRuntime = process.env.MORROW_SERVICE_RUNTIME || 'rust';
if (!['node', 'rust'].includes(serviceRuntime)) throw new Error('MORROW_SERVICE_RUNTIME must be node or rust.');
// Compatibility wrapper; canonical collection and license validation live in Rust.
export function collectRustLicenses(target) {
  return execFileSync('cargo', ['run', '--quiet', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'morrow-notices', '--', '--target', target], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
export function buildRustService(destination) {
  if (!(process.platform === 'darwin' && process.arch === 'arm64') && !(process.platform === 'win32' && process.arch === 'x64')) throw new Error('Build Rust desktop services on macOS arm64 or Windows x64.');
  execFileSync('cargo', ['run', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'morrow-resources', '--', '--check'], { cwd: root, stdio: 'inherit' });
  const env = { ...process.env, ...(process.platform === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: '13.5' } : {}) };
  execFileSync('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--bin', 'morrow-service', '--release', '--locked'], { cwd: root, stdio: 'inherit', env });
  const target = resolve(root, process.env.CARGO_TARGET_DIR || 'rust/target', 'release', process.platform === 'win32' ? 'morrow-service.exe' : 'morrow-service');
  if (!existsSync(target)) throw new Error('The Rust service was not built for this host.');
  const { version } = JSON.parse(readFileSync(resolve(root, 'package.json')));
  if (execFileSync(target, ['--version'], { encoding: 'utf8' }).trim() !== `Morrow Mail ${version}`) throw new Error('The Rust service and package versions differ.');
  if (process.platform === 'darwin') {
    const libraries = execFileSync('/usr/bin/otool', ['-L', target], { encoding: 'utf8' }).split('\n').slice(1).filter(Boolean);
    if (libraries.some(line => !/^\s*\/(System\/Library|usr\/lib)\//.test(line))) throw new Error('The Rust service depends on libraries outside macOS.');
  }
  const notices = collectRustLicenses(process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-pc-windows-msvc');
  if (destination) { cpSync(target, destination); writeFileSync(resolve(dirname(destination), 'THIRD_PARTY_LICENSES.txt'), notices); }
  return target;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check-licenses')) { const text = collectRustLicenses(process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-pc-windows-msvc'); assert.ok(text.includes('MPL-2.0') && text.includes('Unicode-3.0') && text.includes('OpenCC')); console.log(`Rust production notice collection passed (${Buffer.byteLength(text)} bytes).`); }
  else buildRustService();
}
