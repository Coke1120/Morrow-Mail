// Compatibility entry point; native build/test callers invoke morrow-resources directly.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync('cargo', ['run', '--manifest-path', 'rust/Cargo.toml', '--locked', '--quiet', '--bin', 'morrow-resources', '--', ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
