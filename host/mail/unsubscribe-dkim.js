// A fresh, complete original message is required. Authentication-Results and
// cached/sender-provided "verified" flags never establish RFC 8058 authority.
const { Resolver } = require('node:dns').promises;
const { DkimVerifier } = require('mailauth/lib/dkim/dkim-verifier');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setImmediate: yieldTurn } = require('node:timers/promises');
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_TOTAL_MS = 60000;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_SIGNATURES = 8;
const MAX_DNS_MS = 5000;
const unverified = () => ({ verified: false, reason: 'One-click verification unavailable. Use a reviewed alternative.' });

function oneClickHeaders(source) {
  if (!Buffer.isBuffer(source) || !source.length || source.length > MAX_SOURCE_BYTES) return null;
  const end = source.indexOf('\r\n\r\n');
  if (end < 0 || end > MAX_HEADER_BYTES) return null;
  const raw = source.subarray(0, end).toString('latin1');
  if (/\0|\r(?!\n)|(?<!\r)\n/.test(raw)) return null;
  const fields = new Map();
  let current;
  for (const line of raw.split('\r\n')) {
    if (/^[ \t]/.test(line)) {
      if (!current) return null;
      current.value += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1 || !/^[!-9;-~]+$/.test(line.slice(0, colon))) return null;
    const key = line.slice(0, colon).toLowerCase();
    current = { value: line.slice(colon + 1).trim() };
    if (!fields.has(key)) fields.set(key, []);
    fields.get(key).push(current);
  }
  if (fields.get('from')?.length !== 1 || fields.get('list-unsubscribe')?.length !== 1 ||
      fields.get('list-unsubscribe-post')?.length !== 1 ||
      fields.get('list-unsubscribe-post')[0].value !== 'List-Unsubscribe=One-Click') return null;
  const signatures = fields.get('dkim-signature');
  if (!signatures?.length || signatures.length > MAX_SIGNATURES) return null;
  // Conservative RFC 2369 subset: one HTTPS URI and, optionally, one mailto URI.
  // Unsupported syntax keeps the existing manual fallback, never a guessed POST.
  const value = fields.get('list-unsubscribe')[0].value;
  const match = /^<([^<>]+)>(?:\s*,\s*<([^<>]+)>)?$/.exec(value);
  if (!match) return null;
  // Loaded only when invoked, avoiding a cycle with the action module.
  const { safeUri } = require('./list-unsubscribe');
  const uris = match.slice(1).filter(Boolean).map(uri => safeUri(uri));
  if (uris.some(uri => !uri)) return null;
  const https = uris.filter(uri => uri.kind === 'web' && uri.url.startsWith('https:'));
  if (https.length !== 1 || uris.some(uri => uri !== https[0] && uri.kind !== 'mailto')) return null;
  return { url: https[0].url };
}

// mailauth's relaxed body canonicalizer retains an unfinished line. Bound that
// line before feeding it, otherwise a single huge line defeats streaming memory
// limits. Header storage and each parser write are bounded independently.
async function verifyOneClick(source, { resolver, timeoutMs = MAX_TOTAL_MS, dnsTimeoutMs = MAX_DNS_MS,
  now = new Date(), signal } = {}) {
  if (!(Buffer.isBuffer(source) || source && typeof source[Symbol.asyncIterator] === 'function') ||
      Buffer.isBuffer(source) && (!source.length || source.length > MAX_SOURCE_BYTES) || signal?.aborted) return unverified();
  const curTime = new Date(now);
  if (!Number.isFinite(curTime.getTime())) return unverified();
  const duration = Number.isFinite(timeoutMs) ? Math.min(MAX_TOTAL_MS, Math.max(1, timeoutMs)) : MAX_TOTAL_MS;
  const dnsDuration = Number.isFinite(dnsTimeoutMs) ? Math.min(MAX_DNS_MS, Math.max(1, dnsTimeoutMs)) : MAX_DNS_MS;
  const native = resolver ? null : new Resolver({ timeout: dnsDuration, tries: 1 });
  const lookup = resolver || ((name, type) => native.resolve(name, type));
  const controller = new AbortController();
  let expired = false, calls = 0, headers, ended = false, total = 0, dnsDeadline;
  const dnsTimers = new Set();
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  const abort = () => {
    expired = true; controller.abort(); native?.cancel(); rejectAborted(new Error('DKIM deadline or cancellation'));
    // Stop the provider promptly, even when its async iterator is awaiting input.
    source?.destroy?.();
  };
  const timer = setTimeout(abort, duration);
  signal?.addEventListener('abort', abort, { once: true });
  const check = () => { if (expired || signal?.aborted) throw new Error('DKIM stream cancelled'); };
  const boundedResolver = async (name, type) => {
    check();
    if (++calls > MAX_SIGNATURES || type !== 'TXT' || typeof name !== 'string' || name.length > 253 ||
        !/^[a-z0-9_.-]+\._domainkey\.[a-z0-9.-]+$/i.test(name)) throw new Error('DKIM DNS limit');
    // All key queries share one budget, not eight serial five-second waits.
    dnsDeadline ??= Date.now() + dnsDuration;
    const remaining = dnsDeadline - Date.now();
    if (remaining <= 0) throw new Error('DKIM DNS deadline');
    let dnsTimer;
    try {
      const result = await Promise.race([Promise.resolve().then(() => lookup(name, type)),
        new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('DKIM DNS deadline')), remaining); dnsTimers.add(dnsTimer); })]);
      check();
      if (Date.now() >= dnsDeadline) throw new Error('DKIM DNS deadline');
      if (!Array.isArray(result) || !result.length || result.length > 32) throw new Error('DKIM DNS limit');
      let bytes = 0;
      for (const record of result) {
        if (!Array.isArray(record) || !record.length || record.length > 64) throw new Error('DKIM DNS limit');
        for (const part of record) {
          if (typeof part !== 'string' || (bytes += Buffer.byteLength(part)) > 16 * 1024) throw new Error('DKIM DNS limit');
        }
      }
      return result;
    } finally { clearTimeout(dnsTimer); dnsTimers.delete(dnsTimer); }
  };
  async function* boundedBytes() {
    const prefix = Buffer.alloc(MAX_HEADER_BYTES + 4);
    let prefixBytes = 0, lineBytes = 0, turns = 0, inputChunks = 0;
    const input = Buffer.isBuffer(source) ? (async function* () {
      for (let offset = 0; offset < source.length; offset += CHUNK_BYTES) yield source.subarray(offset, offset + CHUNK_BYTES);
    })() : source;
    for await (const incoming of input) {
      if (++inputChunks % 32 === 0) await yieldTurn();
      check();
      if (!(Buffer.isBuffer(incoming) || incoming instanceof Uint8Array)) throw new Error('DKIM requires original bytes');
      total += incoming.byteLength;
      if (total > MAX_SOURCE_BYTES) throw new Error('DKIM source limit');
      const bytes = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming.buffer, incoming.byteOffset, incoming.byteLength);
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        check();
        const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
        let cursor = 0, end;
        while ((end = chunk.indexOf(10, cursor)) !== -1) {
          if (lineBytes + end - cursor + 1 > MAX_LINE_BYTES) throw new Error('DKIM line limit');
          lineBytes = 0; cursor = end + 1;
        }
        lineBytes += chunk.length - cursor;
        if (lineBytes > MAX_LINE_BYTES) throw new Error('DKIM line limit');
        if (!headers) {
          const copied = Math.min(chunk.length, prefix.length - prefixBytes);
          chunk.copy(prefix, prefixBytes, 0, copied);
          const before = prefixBytes; prefixBytes += copied;
          const headerEnd = prefix.subarray(0, prefixBytes).indexOf('\r\n\r\n', Math.max(0, before - 3));
          if (headerEnd < 0) {
            if (prefixBytes === prefix.length) throw new Error('DKIM header limit');
          } else {
            headers = oneClickHeaders(prefix.subarray(0, headerEnd + 4));
            if (!headers) throw new Error('DKIM list headers unavailable');
            yield prefix.subarray(0, prefixBytes);
            if (copied < chunk.length) yield chunk.subarray(copied);
          }
        } else yield chunk;
        // Cooperative yield preserves deadline/abort delivery for sync-fast
        // iterables and avoids monopolizing the host while hashing large mail.
        if (++turns % 32 === 0) await yieldTurn();
      }
    }
    check();
    if (!headers || !total) throw new Error('DKIM incomplete headers');
    ended = true;
  }
  const input = Readable.from(boundedBytes(), { objectMode: false, highWaterMark: CHUNK_BYTES });
  const verifier = new DkimVerifier({ resolver: boundedResolver, strict: true, minBitLength: 1024,
    rejectRsaSha1: true, curTime });
  try {
    // The independent race also bounds a custom async iterator whose pending
    // next() cannot be cancelled by Readable.destroy(). Late chunks are retired.
    await Promise.race([pipeline(input, verifier, { signal: controller.signal }), aborted]);
    if (expired || !ended || !headers || verifier.fromFields !== 1 || !Array.isArray(verifier.results)) return unverified();
    for (const result of verifier.results) {
      const covered = new Set(String(result.signingHeaders?.keys || '').toLowerCase().split(':').map(key => key.trim()));
      if (result.status?.result !== 'pass' || result.status.testing || result.signatureTimeValid !== true ||
          result.canonBodyLengthLimited !== false || !['rsa-sha256', 'ed25519-sha256'].includes(result.algo) ||
          !covered.has('list-unsubscribe') || !covered.has('list-unsubscribe-post') || !covered.has('from') ||
          typeof result.signingDomain !== 'string' || !result.signingDomain) continue;
      return { verified: true, url: headers.url, domain: result.signingDomain };
    }
    return unverified();
  } catch { return unverified(); }
  finally {
    expired = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); native?.cancel();
    for (const pending of dnsTimers) clearTimeout(pending);
    input.destroy(); verifier.destroy(); source?.destroy?.();
  }
}

module.exports = { verifyOneClick, MAX_SOURCE_BYTES, MAX_LINE_BYTES };
