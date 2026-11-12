// A fresh, complete original message is required. Authentication-Results and
// cached/sender-provided "verified" flags never establish RFC 8058 authority.
const { Resolver } = require('node:dns').promises;
const { dkimVerify } = require('mailauth/lib/dkim/verify');
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
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

async function verifyOneClick(source, { resolver, timeoutMs = MAX_DNS_MS, now = new Date() } = {}) {
  const headers = oneClickHeaders(source);
  if (!headers) return unverified();
  const curTime = new Date(now);
  if (!Number.isFinite(curTime.getTime())) return unverified();
  const duration = Number.isFinite(timeoutMs) ? Math.min(MAX_DNS_MS, Math.max(1, timeoutMs)) : MAX_DNS_MS;
  const native = resolver ? null : new Resolver({ timeout: duration, tries: 1 });
  const lookup = resolver || ((name, type) => native.resolve(name, type));
  let timer, expired = false, calls = 0;
  const boundedResolver = async (name, type) => {
    if (expired || ++calls > MAX_SIGNATURES || type !== 'TXT' || typeof name !== 'string' || name.length > 253 ||
        !/^[a-z0-9_.-]+\._domainkey\.[a-z0-9.-]+$/i.test(name)) throw new Error('DKIM DNS limit');
    const result = await lookup(name, type);
    if (expired || !Array.isArray(result) || !result.length || result.length > 32) throw new Error('DKIM DNS limit');
    let bytes = 0;
    for (const record of result) {
      if (!Array.isArray(record) || !record.length || record.length > 64) throw new Error('DKIM DNS limit');
      for (const part of record) {
        if (typeof part !== 'string' || (bytes += Buffer.byteLength(part)) > 16 * 1024) throw new Error('DKIM DNS limit');
      }
    }
    return result;
  };
  try {
    const outcome = await Promise.race([
      dkimVerify(source, { resolver: boundedResolver, strict: true, minBitLength: 1024, rejectRsaSha1: true, curTime }),
      new Promise((_, reject) => { timer = setTimeout(() => { expired = true; native?.cancel(); reject(new Error('DKIM deadline')); }, duration); })
    ]);
    if (expired || outcome.fromFields !== 1 || !Array.isArray(outcome.results)) return unverified();
    for (const result of outcome.results) {
      const covered = new Set(String(result.signingHeaders?.keys || '').toLowerCase().split(':').map(key => key.trim()));
      if (result.status?.result !== 'pass' || result.status.testing || result.signatureTimeValid !== true ||
          result.canonBodyLengthLimited !== false || !['rsa-sha256', 'ed25519-sha256'].includes(result.algo) ||
          !covered.has('list-unsubscribe') || !covered.has('list-unsubscribe-post') || !covered.has('from') ||
          typeof result.signingDomain !== 'string' || !result.signingDomain) continue;
      return { verified: true, url: headers.url, domain: result.signingDomain };
    }
    return unverified();
  } catch { return unverified(); }
  finally { expired = true; clearTimeout(timer); native?.cancel(); }
}

module.exports = { verifyOneClick, MAX_SOURCE_BYTES };
