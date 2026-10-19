'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RELEASE_ROOT, ARCHIVE_LIMIT } = require('./update-manifest');

// No renderer-controlled origins, credentials, custom headers or executable URLs.
function allowedURL(input, redirect = false) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('Unsafe update download URL.');
  if (redirect && url.hostname === 'release-assets.githubusercontent.com' && url.pathname.startsWith('/github-production-release-asset/')) return url;
  const suffix = input.slice(RELEASE_ROOT.length);
  if (!input.startsWith(RELEASE_ROOT) || url.search || !/^(?:latest\/download|download\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\/(?:update-manifest-macos-(?:arm64|x64)\.json(?:\.sig)?|Morrow-Mail-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:arm64|x64)-mac\.zip)$/.test(suffix)) throw new Error('Update download origin or path rejected.');
  return url;
}
async function streamDownload(input, { maxBytes, signal, request = https.get, timeoutMs = 120000, onChunk }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ARCHIVE_LIMIT) throw new Error('Invalid download bound.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    let url = allowedURL(input), total = 0;
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (controller.signal.aborted) throw new Error('Update download cancelled or timed out.');
      const response = await new Promise((resolve, reject) => {
        const req = request(url, { signal: controller.signal, headers: { 'User-Agent': 'Morrow-Mail-signed-updater', 'Accept-Encoding': 'identity' } }, resolve);
        req.on('error', reject);
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects === 4 || !response.headers.location) throw new Error('Too many update redirects.');
        url = allowedURL(new URL(response.headers.location, url).href, true);
        continue;
      }
      if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) { response.destroy(); throw new Error('Update download failed.'); }
      const length = response.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > maxBytes)) { response.destroy(); throw new Error('Update download exceeds size limit.'); }
      try {
        for await (const chunk of response) {
          if (controller.signal.aborted) throw new Error('Update download cancelled or timed out.');
          total += chunk.length;
          if (total > maxBytes) throw new Error('Update download exceeds size limit.');
          await onChunk(chunk, total);
        }
        if (response.complete === false || (length !== undefined && total !== Number(length))) throw new Error('Update download interrupted.');
        return total;
      } finally { response.destroy(); }
    }
    throw new Error('Update download failed.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
async function fetchBytes(url, options = {}) {
  const chunks = [];
  await streamDownload(url, { ...options, onChunk: chunk => chunks.push(Buffer.from(chunk)) });
  return Buffer.concat(chunks);
}
async function downloadArtifact(manifest, { directory, onProgress, ...options }) {
  // Caller supplies a host-owned private directory; create a private child and never overwrite a path.
  const dir = await fs.promises.mkdtemp(path.join(directory, 'signed-update-'));
  await fs.promises.chmod(dir, 0o700);
  const file = path.join(dir, 'update.zip');
  let handle;
  try {
    handle = await fs.promises.open(file, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    const size = await streamDownload(manifest.url, { ...options, maxBytes: manifest.size, onChunk: async (chunk, received) => {
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset); if (!result.bytesWritten) throw new Error('Update write failed.'); offset += result.bytesWritten; }
      onProgress?.({ transferred: received, total: manifest.size, percent: received / manifest.size * 100 });
    } });
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('Update artifact checksum or size mismatch.');
    await handle.sync();
    await handle.close(); handle = null;
    return file;
  } catch (error) {
    if (handle) await handle.close();
    await fs.promises.rm(dir, { recursive: true, force: true });
    throw error;
  }
}
module.exports = { allowedURL, fetchBytes, downloadArtifact };
