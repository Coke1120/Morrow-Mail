// A private backend owned by one native app process. Configuration arrives over
// stdin, never command-line arguments; EOF shuts it down if the app crashes.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { resolve, isAbsolute } from 'node:path';
import { createApp } from './app.js';
import { createStore } from './store.js';
import { createUpdater } from './updater.js';

const input = createInterface({ input: process.stdin });
const timeout = setTimeout(() => process.exit(1), 10_000);
let server, store, app, updater, stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  app?.locals.automation.stop();
  const scheduledStopped = app?.locals.scheduled.stop();
  const suggestionsStopped = app?.locals.replySuggestions.stop();
  const searchStopped = app?.locals.smartSearch.stop().catch(() => {});
  const updatesStopped = updater?.stop().catch(() => {});
  clearTimeout(timeout);
  if (!server) return process.exit(0);
  server.close(async () => { await Promise.all([updatesStopped, searchStopped, scheduledStopped, suggestionsStopped]); store?.close(); process.exit(0); });
  setTimeout(() => { server.closeAllConnections(); store?.close(); process.exit(0); }, 65_000).unref();
}
input.once('line', line => {
  try {
    if (line.length > 8192) throw new Error();
    const { token, dataDirectory, port = 0, parentPID, updateToken } = JSON.parse(line);
    if (!/^[a-f0-9]{64}$/.test(token) || typeof dataDirectory !== 'string' || !isAbsolute(dataDirectory) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error();
    store = createStore(resolve(dataDirectory));
    server = createServer();
    server.on('error', () => { console.error('Morrow could not start its private service.'); store.close(); process.exit(1); });
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      updater = createUpdater({ dataDirectory: resolve(dataDirectory), parentPID, updateToken });
      app = createApp({ store, port: actualPort, updater, updateToken, nativeToken: token });
      server.on('request', app);
      app.locals.automation.start();
      server.requestTimeout = 60_000;
      server.headersTimeout = 15_000;
      clearTimeout(timeout);
      process.stdout.write(JSON.stringify({ port: actualPort }) + '\n');
    });
  } catch { console.error('Morrow could not open its private workspace.'); store?.close(); process.exit(1); }
});
input.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
