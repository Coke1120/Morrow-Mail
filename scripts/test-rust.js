import { execFileSync } from 'node:child_process';
execFileSync('cargo', ['run', '--manifest-path', 'rust/Cargo.toml', '--locked', '--bin', 'morrow-resources', '--', '--check'], { stdio: 'inherit' });
for (const args of [
  ['fmt', '--check'], ['clippy', '--locked', '--all-targets', '--', '-D', 'warnings'],
  ['test', '--locked', '--no-fail-fast'], ['build', '--release', '--locked'], ['build', '--locked', '--example', 'storage_contract'], ['build', '--locked', '--bin', 'morrow-service'],
]) execFileSync('cargo', [args[0], '--manifest-path', 'rust/Cargo.toml', ...args.slice(1)], { stdio: 'inherit' });
execFileSync(process.execPath, ['--test', 'tests/rust-search.test.js', 'tests/rust-storage.test.js', 'tests/rust-service.test.js'], { stdio: 'inherit', env: { ...process.env, MORROW_TEST_RUST: '1' } });
