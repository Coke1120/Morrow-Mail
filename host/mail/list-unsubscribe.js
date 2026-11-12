// List-Unsubscribe is sender-controlled input, not proof of sender identity.
// RFC 8058 sections 3.1/4 require verified DKIM covering both list headers.
// Our transports do not provide that proof: even advertised one-click messages
// use a reviewed mailto draft or the manual website flow. Never POST here.
const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_HEADERS = 64 * 1024;
const MAX_URL = 4096;
const MAX_URLS = 8;
const DNS_TIMEOUT = 5000;
const pending = new Set(); // Host-process-wide, including separate reader windows.
const empty = () => ({ version: 1, urls: [], oneClick: false });

function publicAddress(address) {
  if (typeof address !== 'string') return false;
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 && (c === 0 || c === 2) || b === 168 || b === 88 && c === 99)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('.') || address.includes('%')) return false;
  // Allow only global unicast. Exclude mapped/translated addresses, special-use
  // protocol ranges, documentation and 6to4 (which can embed a private IPv4).
  const [first, second = '0'] = address.split(':');
  const a = parseInt(first, 16), b = parseInt(second || '0', 16);
  return a >= 0x2000 && a <= 0x3fff &&
    !(a === 0x2001 && (b <= 0x1ff || b === 0xdb8)) && a !== 0x2002 &&
    !(a === 0x3fff && b <= 0x0fff);
}

function publicHost(value) {
  const host = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return publicAddress(host);
  if (!host || host.length > 253 || host.endsWith('.') || !host.includes('.')) return false;
  if (/(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|corp|test|invalid|example|onion|alt|arpa)$/.test(host)) return false;
  const labels = host.split('.');
  return labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    /^[a-z][a-z0-9-]*[a-z0-9]$/.test(labels.at(-1));
}

function safeText(value, maximum) {
  return typeof value === 'string' && value.length <= maximum &&
    !/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ud800-\udfff\ufeff]/u.test(value);
}

function parseMailto(raw) {
  const value = raw.slice(7);
  const queryAt = value.indexOf('?');
  let to, query;
  try {
    to = decodeURIComponent(queryAt < 0 ? value : value.slice(0, queryAt));
    query = queryAt < 0 ? '' : value.slice(queryAt + 1);
  } catch { return null; }
  if (to.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/i.test(to)) return null;
  const [local, domain] = to.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !publicHost(domain)) return null;
  const fields = {};
  for (const field of query ? query.split('&') : []) {
    const separator = field.indexOf('=');
    if (separator < 0) return null;
    let key, content;
    try {
      key = decodeURIComponent(field.slice(0, separator)).toLowerCase();
      // RFC 6068 uses percent encoding. A literal plus is not a space.
      content = decodeURIComponent(field.slice(separator + 1));
    } catch { return null; }
    if (!['subject', 'body'].includes(key) || Object.hasOwn(fields, key) ||
      !safeText(content, key === 'subject' ? 512 : 2048)) return null;
    fields[key] = content;
  }
  const recipient = `${local}@${domain.toLowerCase()}`;
  const parameters = ['subject', 'body'].filter(key => Object.hasOwn(fields, key))
    .map(key => `${key}=${encodeURIComponent(fields[key])}`).join('&');
  const url = `mailto:${encodeURIComponent(local)}@${domain.toLowerCase()}${parameters ? '?' + parameters : ''}`;
  if (url.length > MAX_URL) return null;
  return { url,
    kind: 'mailto', destination: recipient, to: recipient,
    subject: fields.subject || 'Unsubscribe', text: fields.body || '' };
}

function safeUri(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_URL ||
    !safeText(raw, MAX_URL) || /[\s\\<>#]/u.test(raw) ||
    /%(?![a-f0-9]{2})/i.test(raw) || /%(?:25)*(?:0[a-f0-9]|1[a-f0-9]|7f|5c)/i.test(raw)) return null;
  if (/^mailto:/i.test(raw)) return parseMailto(raw);
  if (!/^https?:\/\//i.test(raw)) return null;
  // Reject userinfo even when empty, and percent-encoded host ambiguities.
  const authority = raw.slice(raw.indexOf('//') + 2).split(/[/?]/, 1)[0];
  if (authority.includes('@') || authority.includes('%')) return null;
  let uri;
  try { uri = new URL(raw); } catch { return null; }
  if (!['https:', 'http:'].includes(uri.protocol) || uri.username || uri.password || uri.hash ||
    uri.port || !publicHost(uri.hostname) || uri.href.length > MAX_URL) return null;
  return { url: uri.href, kind: 'web', destination: uri.hostname };
}

function headerValues(source) {
  if (!(typeof source === 'string' || Buffer.isBuffer(source))) return null;
  // Bound decoding to the header section, not a potentially very large message.
  const prefix = Buffer.isBuffer(source) ? source.subarray(0, MAX_HEADERS + 4).toString('utf8') : source.slice(0, MAX_HEADERS + 4);
  const end = prefix.search(/\r?\n\r?\n/);
  // Providers supply a complete MIME header block; refuse a truncated block.
  if (end < 0) return null;
  const header = prefix.slice(0, end);
  if (Buffer.byteLength(header) > MAX_HEADERS || /\r(?!\n)/.test(header)) return null;
  const result = { unsubscribe: [], post: [] };
  let field = null;
  for (const line of header.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (field) field.array[field.index] += ' ' + line.trim();
      continue;
    }
    field = null;
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).toLowerCase();
    const array = name === 'list-unsubscribe' ? result.unsubscribe : name === 'list-unsubscribe-post' ? result.post : null;
    if (array) { array.push(line.slice(colon + 1).trim()); field = { array, index: array.length - 1 }; }
  }
  return result;
}

function listUris(value) {
  // Comments may appear around angle-bracketed entries, never inside a URI.
  let clean = '', depth = 0, angle = false, escaped = false;
  for (const character of value) {
    if (depth) {
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '(' && ++depth > 5) return null;
      if (character === ')') depth--;
    } else if (!angle && character === '(') { depth = 1; }
    else {
      if (character === '<') { if (angle) return null; angle = true; }
      if (character === '>') { if (!angle) return null; angle = false; }
      clean += character;
    }
  }
  if (depth || angle) return null;
  // Do not split on commas inside a bracketed URI (e.g. a query token).
  const matches = [];
  const expression = /\s*<([^<>]*)>\s*(,|$)/y;
  while (expression.lastIndex < clean.length) {
    const match = expression.exec(clean);
    if (!match || matches.length >= MAX_URLS || match[2] && expression.lastIndex === clean.length) return null;
    matches.push(match[1]);
    if (!match[2]) break;
  }
  return matches;
}

function parseHeaders(source) {
  const result = empty(), fields = headerValues(source);
  // Duplicate list fields have ambiguous semantics. Do not choose one for a
  // later effect, even if a provider or DKIM parser would choose differently.
  if (!fields || fields.unsubscribe.length !== 1) return result;
  const candidates = listUris(fields.unsubscribe[0]);
  if (!candidates) return result;
  result.urls = [...new Set(candidates.map(safeUri).filter(Boolean).map(uri => uri.url))];
  result.oneClick = fields.post.length === 1 && fields.post[0] === 'List-Unsubscribe=One-Click' &&
    candidates.filter(value => /^https:/i.test(value)).length === 1 &&
    !candidates.some(value => /^http:/i.test(value)) && result.urls.some(value => value.startsWith('https:'));
  return result;
}

function normalizedMetadata(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.urls) || value.urls.length > MAX_URLS) return empty();
  return { version: 1, urls: [...new Set(value.urls.map(safeUri).filter(Boolean).map(uri => uri.url))], oneClick: value.oneClick === true };
}

function selected(metadata) {
  const data = normalizedMetadata(metadata);
  const uris = data.urls.map(safeUri).filter(Boolean);
  // An unauthenticated one-click endpoint may not implement a manual GET flow.
  // Prefer the sender's mailto alternative, which always needs compose review.
  return (data.oneClick && uris.find(uri => uri.kind === 'mailto')) || uris[0] || null;
}

function descriptor(metadata) {
  const choice = selected(metadata);
  return choice ? { kind: choice.kind, destination: choice.destination } : null;
}

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && safeText(value, 512);
}

function snapshot(value, request) {
  if (!value || value.accountId !== request.accountId || value.emailId !== request.emailId ||
    !validId(value.accountId) || !validId(value.emailId) ||
    typeof value.identity !== 'string' || !value.identity || value.identity.length > 16384 ||
    !safeText(value.accountEmail, 320) || !value.accountEmail || !safeText(value.sender, 1024)) return null;
  const metadata = normalizedMetadata(value.metadata);
  return { accountId: value.accountId, emailId: value.emailId, accountEmail: value.accountEmail,
    sender: value.sender, identity: value.identity, metadata };
}

async function checkPublicDns(uri, lookup, timeoutMs) {
  if (safeUri(uri)?.kind !== 'web') throw new Error('Unsafe unsubscribe destination.');
  const host = new URL(uri).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!publicAddress(host)) throw new Error('Unsafe unsubscribe destination.');
    return;
  }
  let timer;
  try {
    const answers = await Promise.race([
      Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS lookup timed out.')), timeoutMs); })
    ]);
    if (!Array.isArray(answers) || !answers.length || answers.length > 64 ||
      answers.some(answer => !answer || !publicAddress(answer.address) || ![4, 6].includes(answer.family) || net.isIP(answer.address) !== answer.family)) {
      throw new Error('Unsafe unsubscribe destination.');
    }
  } finally { clearTimeout(timer); }
}

function createUnsubscriber({ resolve, confirm, openExternal, lookup = dns.lookup.bind(dns), dnsTimeoutMs = DNS_TIMEOUT } = {}) {
  if (typeof resolve !== 'function' || typeof confirm !== 'function' || typeof openExternal !== 'function') {
    throw new TypeError('Unsubscribe requires host resolution, confirmation and browser callbacks.');
  }
  const timeoutMs = Number.isFinite(dnsTimeoutMs) ? Math.min(DNS_TIMEOUT, Math.max(1, dnsTimeoutMs)) : DNS_TIMEOUT;
  return async function unsubscribe(input, context) {
    // Do not accept URL, metadata, sender or authentication assertions from IPC.
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['accountId', 'emailId'].includes(key)) ||
      !validId(input.accountId) || !validId(input.emailId)) {
      return { status: 'unavailable', message: 'Select a message in its owning mailbox.' };
    }
    const request = Object.freeze({ accountId: input.accountId, emailId: input.emailId });
    const key = JSON.stringify([request.accountId, request.emailId]);
    if (pending.has(key)) return { status: 'busy', message: 'An unsubscribe review for this message is already open.' };
    pending.add(key);
    try {
      const initial = snapshot(await resolve(request), request);
      const choice = initial && selected(initial.metadata);
      if (!choice) return { status: 'unavailable', message: 'This message has no supported unsubscribe option.' };
      const stamp = JSON.stringify(initial);
      const current = async () => JSON.stringify(snapshot(await resolve(request), request)) === stamp;
      const accepted = await confirm({ accountId: initial.accountId, emailId: initial.emailId,
        accountEmail: initial.accountEmail, sender: initial.sender, kind: choice.kind, destination: choice.destination,
        ...(choice.kind === 'web' ? { secure: choice.url.startsWith('https:') } : {}) }, context);
      if (accepted !== true) return { status: 'cancelled' };
      if (!await current()) return { status: 'stale', message: 'The mailbox or message changed. Reopen it before trying again.' };
      if (choice.kind === 'mailto') {
        return { status: 'draft', draft: { accountId: initial.accountId, sourceMessageId: initial.emailId, to: choice.to, subject: choice.subject, text: choice.text },
          message: 'Review the unsubscribe draft, then choose Send if you want to send it.' };
      }
      await checkPublicDns(choice.url, lookup, timeoutMs);
      if (!await current()) return { status: 'stale', message: 'The mailbox or message changed. Reopen it before trying again.' };
      // This is a manual handoff, not an in-app fetch. DNS is a best-effort
      // preflight only: the external browser owns later DNS, cookies, redirects
      // and its own security checks. We do not promise network pinning here.
      try { await openExternal(choice.url); }
      catch { return { status: 'uncertain', message: 'The browser may have opened. Check it before trying again; unsubscribe completion is not confirmed.' }; }
      return { status: 'opened', message: 'Opened the unsubscribe website. It may require more steps or may not support manual unsubscribe. Completion is not confirmed.' };
    } catch {
      // Do not echo network errors or opaque unsubscribe tokens to the renderer.
      return { status: 'error', message: 'Could not safely open this unsubscribe option. Nothing was sent by Morrow.' };
    } finally { pending.delete(key); }
  };
}

module.exports = { parseHeaders, descriptor, createUnsubscriber, safeUri, publicAddress, checkPublicDns };
