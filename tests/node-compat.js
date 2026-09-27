import { realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const configured = process.env.MORROW_NODE_COMPAT_ROOT;
if (configured !== undefined && (!isAbsolute(configured) || !statSync(configured).isDirectory())) {
  throw Error('MORROW_NODE_COMPAT_ROOT must be an existing absolute checkout directory.');
}
const root = realpathSync(configured === undefined ? fileURLToPath(new URL('../', import.meta.url)) : configured);

function moduleURL(path) {
  const resolved = realpathSync(path);
  const within = relative(root, resolved);
  if (configured !== undefined && (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`))) {
    throw Error('Historical Node modules must resolve inside MORROW_NODE_COMPAT_ROOT.');
  }
  if (!statSync(resolved).isFile()) throw Error('Expected an existing Node compatibility module file.');
  return pathToFileURL(resolved).href;
}

export function nodeCompatModule(path) {
  return moduleURL(join(root, path));
}

export function nodeCompatPackage(specifier) {
  // Preserve ordinary ESM package resolution when no historical checkout is set.
  if (configured === undefined) return specifier;
  const require = createRequire(moduleURL(join(root, 'package.json')));
  // Node resolution can otherwise climb into the current checkout's dependencies.
  return moduleURL(require.resolve(specifier));
}
