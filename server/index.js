import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number.');
const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
if (process.env.NODE_ENV === 'production' && !existsSync(resolve(projectDirectory, 'dist/index.html'))) throw new Error('Build Morrow Mail before production startup: npm run build.');
const store = createStore(resolve(process.env.DATA_DIR || resolve(projectDirectory, 'data')));
const app = createApp({ store, port, appUrl: process.env.APP_URL || `http://localhost:${port}` });
const server = app.listen(port, '127.0.0.1', () => { app.locals.automation.start(); console.log(`Morrow Mail is running at http://localhost:${port}`); });
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Stop the other server or set PORT.` : 'Unable to start Morrow Mail.');
  store.close();
  process.exitCode = 1;
});
server.requestTimeout = 60_000;
server.headersTimeout = 15_000;
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  app.locals.automation.stop();
  const scheduledStopped = app.locals.scheduled.stop();
  const suggestionsStopped = app.locals.replySuggestions.stop();
  const searchStopped = app.locals.smartSearch.stop().catch(() => {});
  server.close(async () => { await Promise.all([searchStopped, scheduledStopped, suggestionsStopped]); store.close(); process.exit(0); });
  // Let in-flight provider requests finish; avoid hanging forever on an idle client.
  setTimeout(() => { server.closeAllConnections(); store.close(); process.exit(0); }, 65_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
