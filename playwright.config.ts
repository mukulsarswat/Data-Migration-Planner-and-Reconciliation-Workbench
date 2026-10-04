import { defineConfig } from '@playwright/test';

const PORT = 8791;

// E2E runs against the real server + built web app with a fresh SQLite file and NO LLM key (heuristic path).
// Uses the system Chrome channel so no browser download is needed.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel: 'chrome', headless: true, viewport: { width: 1360, height: 900 }, trace: 'off' },
  webServer: {
    command: `rm -f data/e2e.db data/e2e.db-wal data/e2e.db-shm && npm run build --silent && PORT=${PORT} DB_PATH=data/e2e.db LOG_TO_STDOUT=false ANTHROPIC_API_KEY= TZ=UTC node server/src/index.ts`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
