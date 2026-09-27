import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import assert from 'node:assert/strict';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Rust is the approved desktop default; Node remains an explicit compatibility build.
export const serviceRuntime = process.env.MORROW_SERVICE_RUNTIME || 'rust';
if (!['node', 'rust'].includes(serviceRuntime)) throw new Error('MORROW_SERVICE_RUNTIME must be node or rust.');
// Explicitly supported redistribution choices. OR alternatives such as GPL are
// never selected; new required license terms stop packaging for review.
const licenses = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Unicode-3.0', '0BSD', 'Zlib', 'MPL-2.0', 'MIT-0', 'CC0-1.0', 'BSL-1.0', 'Unlicense']);
export function licenseChoice(expression) {
  const tokens = String(expression || '').replaceAll('/', ' OR ').match(/\(|\)|[A-Za-z0-9.+-]+/g) || [];
  if (tokens.join('') !== String(expression || '').replaceAll('/', ' OR ').replaceAll(/\s/g, '')) throw new Error(`Invalid license expression: ${expression}`);
  let cursor = 0;
  const atom = () => {
    if (tokens[cursor] === '(') { cursor++; const value = or(); if (tokens[cursor++] !== ')') throw new Error(`Invalid license expression: ${expression}`); return value; }
    const id = tokens[cursor++];
    if (tokens[cursor] === 'WITH') { cursor += 2; return null; }
    return licenses.has(id) ? [id] : null;
  };
  const and = () => { let value = atom(); while (tokens[cursor] === 'AND') { cursor++; const next = atom(); value = value && next ? [...new Set([...value, ...next])] : null; } return value; };
  const or = () => { let value = and(); while (tokens[cursor] === 'OR') { cursor++; const next = and(); value = next?.length === 1 && next[0] === 'Apache-2.0' ? next : value || next; } return value; };
  const selected = or();
  if (cursor !== tokens.length || !selected?.length) throw new Error(`Unreviewed required license: ${expression}`);
  return selected;
}
function noticeFiles(directory) {
  const files = [];
  const visit = (path, licenseDirectory = false) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) visit(child, licenseDirectory || /^licenses?$/i.test(entry.name));
      else if (entry.isFile() && (licenseDirectory || /^(?:licen[sc]e|copying|notice|copyright)(?:[._-]|$)/i.test(entry.name) || /^THIRD[_-]PARTY[_-](?:LICENSES|NOTICES)/i.test(entry.name))) {
        if (statSync(child).size > 2 * 1024 * 1024) throw new Error(`Oversized license notice: ${child}`);
        const content = readFileSync(child, 'utf8');
        if (!content.trim() || content.includes('\0') || content.includes('\ufffd')) throw new Error(`Unreadable license notice: ${child}`);
        files.push({ name: relative(directory, child).split(sep).join('/'), content });
      }
    }
  };
  visit(directory); return files.sort((a, b) => a.name.localeCompare(b.name));
}
export function collectRustLicenses(target) {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', 'rust/Cargo.toml', '--locked', '--format-version', '1', '--filter-platform', target], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const packages = new Map(metadata.packages.map(item => [item.id, item]));
  const visited = new Set(), pending = [metadata.resolve.root];
  while (pending.length) {
    const id = pending.pop(); if (visited.has(id)) continue; visited.add(id);
    if (!nodes.has(id)) throw new Error('Cargo returned an incomplete dependency graph.');
    for (const dependency of nodes.get(id).deps) if (dependency.dep_kinds.some(kind => kind.kind === null || kind.kind === 'build')) pending.push(dependency.pkg);
  }
  const dependencies = [...visited].filter(id => id !== metadata.resolve.root).map(id => packages.get(id)).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  if (!dependencies.length) throw new Error('The Rust dependency license list is empty.');
  const apache = dependencies.map(item => resolve(dirname(item.manifest_path), 'LICENSE-APACHE')).find(path => existsSync(path) && /Apache License[\s\S]*Version 2.0/.test(readFileSync(path, 'utf8')));
  const omittedUpstreamFiles = new Set(['hashify@0.2.9', 'imap-proto@0.16.7', 'stop-token@0.7.0']);
  const sections = [`Morrow Mail third-party notices (${target})\nProduction normal/build dependency graph; dev-only dependencies excluded.\nUpstream dependency sources are unmodified. For MPL-2.0 covered packages, the exact corresponding source is available without charge at each package's source-archive URL below. The complete license texts and supplied attribution notices follow.`];
  for (const item of dependencies) {
    if (!item.source?.startsWith('registry+')) throw new Error(`Review the source distribution for ${item.name}@${item.version}.`);
    const selected = licenseChoice(item.license), directory = dirname(item.manifest_path);
    // Read the package manifest as well as metadata, so missing/unreadable source packages fail closed.
    const manifest = readFileSync(item.manifest_path, 'utf8');
    if (!manifest.trim()) throw new Error(`Empty manifest for ${item.name}.`);
    const notices = noticeFiles(directory);
    if (item.license_file) {
      const path = resolve(directory, item.license_file);
      if (!path.startsWith(directory + sep)) throw new Error(`License escapes ${item.name}'s source package.`);
      if (!notices.some(file => file.name === item.license_file)) notices.push({ name: item.license_file, content: readFileSync(path, 'utf8') });
    }
    if (!notices.length) {
      if (!omittedUpstreamFiles.has(`${item.name}@${item.version}`) || selected.join() !== 'Apache-2.0' || !apache) throw new Error(`Missing redistribution license text for ${item.name}@${item.version}.`);
      notices.push({ name: 'Apache-2.0 (standard text; upstream archive omitted its linked license files)', content: readFileSync(apache, 'utf8') });
      notices.push({ name: 'Upstream README attribution', content: readFileSync(resolve(directory, 'README.md'), 'utf8') });
    }
    sections.push(`Package: ${item.name} ${item.version}\nDeclared license: ${item.license}\nDistribution choice: ${selected.join(' AND ')}\nAuthors: ${item.authors.join(', ') || 'See upstream attribution below.'}\nSource archive: https://crates.io/api/v1/crates/${encodeURIComponent(item.name)}/${encodeURIComponent(item.version)}/download\nRepository: ${item.repository || item.homepage || 'See source archive.'}\n\n` + notices.map(file => `--- ${file.name} ---\n${file.content.trim()}\n`).join('\n'));
  }
  const opencc = resolve(root, 'node_modules/opencc-js'), packageInfo = JSON.parse(readFileSync(resolve(opencc, 'package.json')));
  licenseChoice(packageInfo.license);
  const openccNotices = noticeFiles(opencc);
  if (!openccNotices.some(file => file.name === 'THIRD_PARTY_LICENSES.md') || !openccNotices.some(file => file.name === 'LICENSE')) throw new Error('OpenCC dictionary redistribution notices are missing.');
  sections.push(`OpenCC generated dictionary resource: opencc-js ${packageInfo.version}\nSource archive: https://registry.npmjs.org/opencc-js/-/opencc-js-${packageInfo.version}.tgz\nThe bundled rust/resources/opencc.json is generated by scripts/rust-resources.js from opencc-js presets and opencc-data dictionaries; see the upstream data notices below.\n\n` + openccNotices.map(file => `--- ${file.name} ---\n${file.content.trim()}\n`).join('\n'));
  return sections.join('\n' + '='.repeat(80) + '\n\n') + '\n';
}
function checkLicenseParser() {
  assert.deepEqual(licenseChoice('(MIT OR Apache-2.0) AND Unicode-3.0'), ['Apache-2.0', 'Unicode-3.0']);
  assert.deepEqual(licenseChoice('Apache-2.0 OR GPL-2.0-only'), ['Apache-2.0']);
  assert.deepEqual(licenseChoice('Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT'), ['Apache-2.0']);
  assert.throws(() => licenseChoice('MIT AND Unknown-License'));
  assert.throws(() => licenseChoice('GPL-2.0-only'));
  assert.throws(() => licenseChoice('(MIT OR Apache-2.0'));
  assert.throws(() => licenseChoice('MIT + nonsense'));
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
  if (process.argv.includes('--check-licenses')) { checkLicenseParser(); const text = collectRustLicenses(process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-pc-windows-msvc'); assert.ok(text.includes('MPL-2.0') && text.includes('Unicode-3.0') && text.includes('OpenCC')); console.log(`License parser and production notice collection passed (${Buffer.byteLength(text)} bytes).`); }
  else buildRustService();
}
