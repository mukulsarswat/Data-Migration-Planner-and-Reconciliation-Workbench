// Process entry: `node server/src/index.ts` (Node native type stripping; no build step).
import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { loadDataset } from './dataset/load.ts';
import { LogBuffer, createLogger } from './logger.ts';
import { openDb } from './db/connection.ts';
import { createApp } from './app.ts';
import { routeRegistrars } from './routes/index.ts';

const config = loadConfig();
const dataset = loadDataset();
const logBuffer = new LogBuffer(1000);
const logger = createLogger({ level: config.logLevel, buffer: logBuffer, stdout: config.logToStdout });
const now = () => new Date().toISOString();
if (!config.basicAuth) logger.warn('HTTP Basic auth is DISABLED (BASIC_AUTH_USER/PASS unset): every route, including paid agent runs, is public');
const db = openDb(config.dbPath, { dataset, now, logger });
const app = createApp({ db, config, logger, logBuffer, dataset, now }, routeRegistrars);

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  logger.info({ port: info.port, version: config.version, llmConfigured: config.anthropic.apiKey !== null }, 'listening');
});

let stopping = false;
function shutdown(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Keep-alive or slow in-flight requests must not block shutdown; boot recovery handles anything cut off.
  setTimeout(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
  }, 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
