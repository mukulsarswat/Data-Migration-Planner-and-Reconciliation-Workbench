// DDL for the mock target table, generated from target-schema.json (the same source as the JS validator),
// so database constraints and validation rules cannot drift apart.
import type { TargetField, TargetSchema, ValueType } from '../../../shared/schemas.ts';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** SQL string literal with single quotes doubled. */
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsupported identifier in target schema: ${JSON.stringify(name)}`);
  return name;
}

const SQL_TYPE: Record<ValueType, 'TEXT' | 'INTEGER'> = { string: 'TEXT', date: 'TEXT', integer: 'INTEGER', boolean: 'INTEGER' };
const TYPEOF: Record<ValueType, 'text' | 'integer'> = { string: 'text', date: 'text', integer: 'integer', boolean: 'integer' };

export function targetTableName(target: TargetSchema): string {
  return ident(`tgt_${target.name}`);
}

/** CHECK predicates for one column; joined with AND and, for nullable columns, guarded by `col IS NULL OR (...)`. */
function checks(f: TargetField): string[] {
  const col = f.name;
  const out = [`typeof(${col}) = '${TYPEOF[f.type]}'`];
  if (f.type === 'boolean') out.push(`${col} IN (0, 1)`);
  if (f.type === 'date') out.push(`${col} REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`, `date(${col}) IS ${col}`);
  if (f.enum) out.push(`${col} IN (${f.enum.map(literal).join(', ')})`);
  if (f.maxLength !== undefined) out.push(`length(${col}) <= ${f.maxLength}`);
  if (f.pattern !== undefined) out.push(`${col} REGEXP ${literal(f.pattern)}`);
  return out;
}

function columnDef(f: TargetField): string {
  const preds = checks(f).join(' AND ');
  const check = f.required ? preds : `${f.name} IS NULL OR (${preds})`;
  const parts = [ident(f.name), SQL_TYPE[f.type]];
  if (f.required) parts.push('NOT NULL');
  if (f.unique) parts.push('UNIQUE');
  parts.push(`CHECK (${check})`);
  return parts.join(' ');
}

/**
 * CREATE TABLE (idempotent) for the target: surrogate `id`, business columns in schema order,
 * and the `_load_run_id` lineage column (NULL = pre-existing row not loaded by any run).
 */
export function targetTableDdl(target: TargetSchema): string {
  const table = targetTableName(target);
  const columns = ['id INTEGER PRIMARY KEY', ...target.fields.map(columnDef), '_load_run_id INTEGER'];
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (\n  ${columns.join(',\n  ')}\n);`,
    `CREATE INDEX IF NOT EXISTS ix_${table}_load_run ON ${table} (_load_run_id);`,
  ].join('\n');
}
