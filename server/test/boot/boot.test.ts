// Spawns the real `node server/src/index.ts` (Node native type stripping, not Vite's transform) and
// proves it boots, serves /api/health without credentials, guards other routes, and exits 0 on SIGTERM.
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs: number): Promise<Response> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(url);
      if (res.status === 200) return res;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`health not 200 within ${timeoutMs}ms`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => reject(new Error(`no exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-boot-'));
let child: ChildProcess | undefined;
afterAll(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('boot: real server under native type stripping', () => {
  it('serves health, enforces basic auth, and exits 0 on SIGTERM', async () => {
    const port = await freePort();
    const dbPath = path.join(tmp, 'data', 'workbench.db');
    child = spawn(process.execPath, ['server/src/index.ts'], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        PORT: String(port),
        DB_PATH: dbPath,
        STATIC_DIR: path.join(tmp, 'no-static'),
        LOG_TO_STDOUT: 'true',
        TZ: 'UTC',
        ANTHROPIC_API_KEY: '',
        BASIC_AUTH_USER: 'grader',
        BASIC_AUTH_PASS: 'boot-pass',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));

    const base = `http://127.0.0.1:${port}`;
    try {
      const health = await waitForHealth(`${base}/api/health`, child, 15_000);
      const body = (await health.json()) as { status: string; db: string; dataset: { records: number } };
      expect(body).toMatchObject({ status: 'ok', db: 'ok', dataset: { records: 200 } });
      expect(fs.existsSync(dbPath)).toBe(true);

      expect((await fetch(`${base}/api/logs`)).status).toBe(401);
      const authed = await fetch(`${base}/api/logs`, {
        headers: { authorization: `Basic ${Buffer.from('grader:boot-pass').toString('base64')}` },
      });
      expect(authed.status).toBe(200);
    } catch (err) {
      throw new Error(`${(err as Error).message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }

    child.kill('SIGTERM');
    expect(await waitForExit(child, 5_000)).toBe(0);
    expect(stdout).toContain('"msg":"listening"');
    expect(stdout).not.toContain('boot-pass');
  });
});
