// Isolated RFC 8058 transport. Called only after host verification and review.
// No Electron fetch/net, shared agent, proxy, cookie or provider credentials.
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const BODY = 'List-Unsubscribe=One-Click';
const bounded = (value, ceiling, minimum = 1) => Number.isFinite(value)
  ? Math.max(minimum, Math.min(ceiling, Math.floor(value))) : ceiling;

async function postUnsubscribe(value, options = {}) {
  // Lazy import prevents a cycle when list-unsubscribe owns this transport.
  const { safeUri, publicAddress } = require('./list-unsubscribe');
  const safe = safeUri(value);
  if (!safe || safe.kind !== 'web' || !safe.url.startsWith('https:')) {
    return { status: 'failed', issued: false, reason: 'unsafe-destination' };
  }
  const uri = new URL(safe.url);
  const hostname = uri.hostname.replace(/^\[|\]$/g, '');
  const lookup = options.lookup || dns.lookup.bind(dns);
  const request = options.request || https.request;
  const checkCurrent = options.checkCurrent || (() => true);
  const timeoutMs = bounded(options.timeoutMs, 15000);
  const dnsTimeoutMs = bounded(options.dnsTimeoutMs, 5000);
  const connectTimeoutMs = bounded(options.connectTimeoutMs, 5000);
  const maxResponseBytes = bounded(options.maxResponseBytes, 64 * 1024);

  return new Promise(resolve => {
    let settled = false, issued = false, req, response;
    let dnsTimer, connectTimer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer); clearTimeout(dnsTimer); clearTimeout(connectTimer);
      // No body, headers, opaque token or raw network error leaves this module.
      resolve(result);
      response?.destroy(); req?.destroy();
    };
    const networkFailure = reason => finish({ status: issued ? 'uncertain' : 'failed', issued, reason });
    const totalTimer = setTimeout(() => networkFailure('timeout'), timeoutMs);

    (async () => {
      let addresses;
      if (net.isIP(hostname)) addresses = [{ address: hostname, family: net.isIP(hostname) }];
      else {
        addresses = await Promise.race([
          Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })),
          new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('dns-timeout')), dnsTimeoutMs); }),
        ]);
        clearTimeout(dnsTimer);
      }
      if (settled) return;
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some(answer =>
        !answer || !publicAddress(answer.address) || ![4, 6].includes(answer.family) || net.isIP(answer.address) !== answer.family)) {
        finish({ status: 'failed', issued: false, reason: 'unsafe-dns' }); return;
      }
      // Copy one public address: no mutable answer or later DNS resolution can
      // redirect the socket to a private address. No alternate-address retry.
      const pinned = Object.freeze({ address: addresses[0].address, family: addresses[0].family });
      const current = await checkCurrent();
      if (settled) return;
      if (current !== true) { finish({ status: 'failed', issued: false, reason: 'stale' }); return; }
      const pinnedLookup = (host, lookupOptions, callback) => {
        if (typeof lookupOptions === 'function') { callback = lookupOptions; lookupOptions = {}; }
        if (host !== hostname) { callback(new Error('Unexpected destination')); return; }
        if (lookupOptions?.all) callback(null, [{ ...pinned }]);
        else callback(null, pinned.address, pinned.family);
      };
      // https.request never follows redirects. TLS checks the original host;
      // pinned lookup changes only its network address.
      // Mark issued before request construction: constructor errors cannot prove
      // that no side effect happened and must never permit automatic replay.
      issued = true;
      req = request({
        protocol: 'https:', hostname, port: 443,
        path: uri.pathname + uri.search, method: 'POST',
        agent: false, lookup: pinnedLookup, family: pinned.family,
        autoSelectFamily: false,
        servername: net.isIP(hostname) ? '' : hostname,
        rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(BODY),
          'Accept': '*/*',
          'Connection': 'close',
        },
      }, incoming => {
        if (settled) { incoming.destroy(); return; }
        response = incoming;
        clearTimeout(connectTimer);
        const httpStatus = incoming.statusCode;
        let bytes = 0;
        incoming.on('error', () => networkFailure('response-error'));
        incoming.on('aborted', () => networkFailure('response-aborted'));
        incoming.on('data', chunk => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > maxResponseBytes) networkFailure('response-too-large');
        });
        incoming.on('end', () => {
          if (incoming.complete === false) { networkFailure('response-incomplete'); return; }
          if (Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus < 300) {
            finish({ status: 'accepted', issued: true, reason: 'request-accepted', httpStatus });
          } else {
            finish({ status: 'failed', issued: true,
              reason: httpStatus >= 300 && httpStatus < 400 ? 'redirect-refused' : 'http-refused',
              ...(Number.isInteger(httpStatus) ? { httpStatus } : {}) });
          }
        });
      });
      if (settled) { req.destroy(); return; }
      req.on('error', () => networkFailure('request-error'));
      req.on('socket', socket => {
        socket.once('secureConnect', () => clearTimeout(connectTimer));
      });
      connectTimer = setTimeout(() => networkFailure('connect-timeout'), connectTimeoutMs);
      req.end(BODY);
    })().catch(() => networkFailure(issued ? 'request-error' : 'preflight-failed'));
  });
}

module.exports = { postUnsubscribe };
