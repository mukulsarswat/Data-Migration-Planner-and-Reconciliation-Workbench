// Opens the single SQLite file: pragmas, REGEXP, control-plane schema, generated target table, seed, boot recovery.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Dataset } from '../dataset/load.ts';
import { targetTableDdl } from './targetDdl.ts';
import { seed } from './seed.ts';
import { bootRecover } from './boot.ts';

export type Db = Database.Database;

const SCHEMA_SQL = path.join(import.meta.dirname, 'schema.sql');

/**
 * Deterministic `regexp` for `X REGEXP Y` (SQLite calls regexp(Y, X)): ECMAScript semantics, identical to the
 * JS validator. NULL value ⇒ NULL (so nullable CHECKs pass). Compiled patterns are cached.
 */
function registerRegexp(db: Db): void {
  const cache = new Map<string, RegExp>();
  db.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown) => {
    if (value === null || pattern === null) return null;
    const src = String(pattern);
    let re = cache.get(src);
    if (!re) {
      re = new RegExp(src);
      cache.set(src, re);
    }
    return re.test(String(value)) ? 1 : 0;
  });
}

export function openDb(file: string, opts: { dataset: Dataset; now: () => string; logger?: Logger }): Db {
  const inMemory = file === ':memory:';
  if (!inMemory) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  try {
    if (!inMemory) db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    registerRegexp(db);
    db.exec(fs.readFileSync(SCHEMA_SQL, 'utf8'));
    db.exec(targetTableDdl(opts.dataset.target));
    seed(db, opts.dataset, opts.now);
    const recovered = bootRecover(db, opts.now);
    if (recovered.runs + recovered.agentRuns > 0) opts.logger?.warn(recovered, 'interrupted runs recovered at boot');
    opts.logger?.info({ file: inMemory ? file : path.resolve(file) }, 'database ready');
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
