// Structured JSON logs (pino) fanned out to stdout and an in-memory ring buffer that backs GET /api/logs.
import pino from 'pino';
import type { Logger } from 'pino';

/** One parsed pino line. `level` is pino's number (10 trace … 60 fatal); `time` is epoch ms. */
export type LogEntry = { level: number; time: number; msg?: string; [k: string]: unknown };

/** Fixed-capacity ring buffer of recent log entries (newest last). */
export class LogBuffer {
  private readonly capacity: number;
  private readonly entries: LogEntry[];
  private next: number;
  private size: number;

  constructor(capacity = 1000) {
    this.capacity = capacity;
    this.entries = new Array<LogEntry>(capacity);
    this.next = 0;
    this.size = 0;
  }

  push(entry: LogEntry): void {
    this.entries[this.next] = entry;
    this.next = (this.next + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** Matching entries in arrival order; `limit` keeps the newest N. */
  query(q: { requestId?: string; minLevel?: number; limit?: number }): LogEntry[] {
    const out: LogEntry[] = [];
    const start = (this.next - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) {
      const e = this.entries[(start + i) % this.capacity]!;
      if (q.requestId !== undefined && e.requestId !== q.requestId) continue;
      if (q.minLevel !== undefined && e.level < q.minLevel) continue;
      out.push(e);
    }
    return q.limit !== undefined ? out.slice(Math.max(0, out.length - q.limit)) : out;
  }
}

/** Secret-bearing fields, at the first three nesting levels (e.g. `headers.authorization`, `config.anthropic.apiKey`). */
const REDACT_PATHS = [
  'authorization',
  '*.authorization',
  '*.*.authorization',
  '["x-api-key"]',
  '*["x-api-key"]',
  '*.*["x-api-key"]',
  'apiKey',
  '*.apiKey',
  '*.*.apiKey',
  'ANTHROPIC_API_KEY',
  '*.ANTHROPIC_API_KEY',
];

export function createLogger(opts: { level: string; buffer: LogBuffer; stdout: boolean }): Logger {
  const bufferStream = {
    write(line: string) {
      opts.buffer.push(JSON.parse(line) as LogEntry);
    },
  };
  const level = opts.level as pino.Level;
  const streams: pino.StreamEntry[] = [{ level, stream: bufferStream }];
  // Synchronous stdout so the last lines are not lost when the process exits on SIGTERM.
  if (opts.stdout) streams.push({ level, stream: pino.destination({ dest: 1, sync: true }) });
  return pino(
    { level: opts.level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    pino.multistream(streams),
  );
}
