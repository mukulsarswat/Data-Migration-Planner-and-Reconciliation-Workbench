// Adversarial verification of the transform DSL runtime (server/src/engine/transforms.ts) against the module spec
// and the frozen contracts in shared/. Complements (does not repeat) the unit and property suites.
import fs from 'node:fs';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../shared/canonical.ts';
import { DATE_FORMATS, OP_NAMES } from '../../../shared/dsl.ts';
import type { DateFormat, OpName, Step } from '../../../shared/dsl.ts';
import type { MappingRunner } from '../../../shared/evidence.ts';
import { MigrationPlanSchema } from '../../../shared/plan.ts';
import type { FieldMapping } from '../../../shared/plan.ts';
import { TargetSchemaSchema } from '../../../shared/schemas.ts';
import type { SourceRecord, TargetSchema, Value } from '../../../shared/schemas.ts';
import {
  applyStep,
  normalizeUsPhone,
  parseCurrencyToCents,
  parseDate,
  runMapping,
  splitFullName,
  transformRecord,
} from '../../src/engine/transforms.ts';
import type { StepResult } from '../../src/engine/transforms.ts';

// Compile-time: runMapping must be usable wherever a MappingRunner is injected.
const runner: MappingRunner = runMapping;

const load = (name: string): unknown =>
  JSON.parse(fs.readFileSync(new URL(`../../src/dataset/${name}`, import.meta.url), 'utf8'));

const FAIL = 'TRANSFORM_FAILED' as const;
const AMBIG = 'AMBIGUOUS_DATE' as const;
type Expected = Value | typeof FAIL | typeof AMBIG;

/** Strict check: ok values compared with Object.is (catches -0), failures by code and non-empty message. */
function expectResult(result: StepResult, expected: Expected): void {
  if (expected === FAIL || expected === AMBIG) {
    expect(result).toMatchObject({ ok: false, code: expected });
    if (!result.ok) expect(result.message.trim().length).toBeGreaterThan(0);
    return;
  }
  expect(result).toEqual({ ok: true, value: expected });
  if (result.ok) expect(Object.is(result.value, expected)).toBe(true);
}

const S = {
  copy: { op: 'copy', params: {} },
  trim: { op: 'trim', params: {} },
  lowercase: { op: 'lowercase', params: {} },
  uppercase: { op: 'uppercase', params: {} },
  null_if_empty: { op: 'null_if_empty', params: {} },
  default: { op: 'default', params: { value: 'D' } },
  split_full_name: { op: 'split_full_name', params: { part: 'first' } },
  concat: { op: 'concat', params: { separator: '|' } },
  parse_date: { op: 'parse_date', params: { formats: ['yyyy-MM-dd'] } },
  parse_currency_to_cents: { op: 'parse_currency_to_cents', params: {} },
  to_integer: { op: 'to_integer', params: {} },
  to_boolean: { op: 'to_boolean', params: { true_values: ['Y'], false_values: ['N', ''] } },
  map_values: { op: 'map_values', params: { pairs: [{ from: 'A', to: 'active' }], fallback: 'FB' } },
  normalize_phone: { op: 'normalize_phone', params: { default_country: 'US' } },
} satisfies Record<OpName, Step>;

const mapping = (target: string, sources: string[], steps: Step[]): FieldMapping => ({
  target,
  sources,
  steps,
  origin: 'human',
  confidence: 'high',
  rationale: '',
});

// ---------------------------------------------------------------------------------------------------------------
describe('contract shape', () => {
  it('runMapping is a MappingRunner and failures carry exactly the MappingResult keys', () => {
    const r = runner({ a: 'x' }, { sources: ['a'], steps: [S.to_integer] });
    expect(r.ok).toBe(false);
    expect(Object.keys(r).sort()).toEqual(['code', 'message', 'ok', 'op', 'stepIndex']);
    expect(Object.keys(runner({ a: '1' }, { sources: ['a'], steps: [S.to_integer] })).sort()).toEqual(['ok', 'value']);
  });

  it('every op in the catalog is implemented (no "unknown op" for a valid step)', () => {
    const covered = Object.keys(S).sort();
    expect(covered).toEqual([...OP_NAMES].sort());
    for (const op of OP_NAMES) {
      const r = applyStep('x', S[op]);
      if (!r.ok) expect(r.message).not.toMatch(/unknown op/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("null vs '' semantics (spec: '' ≠ null until null_if_empty)", () => {
  it('map_values passes null through even with a non-null fallback (fallback is for misses only)', () => {
    expectResult(applyStep(null, S.map_values), null);
  });

  it("map_values uses the fallback for '' (a real value, not null)", () => {
    expectResult(applyStep('', S.map_values), 'FB');
  });

  it("to_boolean passes null through even when '' is a listed spelling", () => {
    expectResult(applyStep(null, S.to_boolean), null);
    expectResult(applyStep('', S.to_boolean), false);
  });

  it("default leaves '' and whitespace untouched; only null is replaced", () => {
    expectResult(applyStep('', S.default), '');
    expectResult(applyStep('\t', S.default), '\t');
    expectResult(applyStep(null, { op: 'default', params: { value: '' } }), '');
  });

  it("concat keeps '' elements (only nulls are dropped) and never yields null when any element is non-null", () => {
    expectResult(applyStep(['', null], S.concat), '');
    expectResult(applyStep(['', ''], S.concat), '|');
    expectResult(applyStep([null, ' a ', null, 'b'], S.concat), ' a |b');
    expectResult(applyStep([null], S.concat), null);
  });

  it('null_if_empty is null exactly when String#trim() is empty (property)', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.stringMatching(/^[ \t\n\r\u00a0\u2028\u3000\ufeff]*x?$/)), (s) => {
        const r = applyStep(s, S.null_if_empty);
        expect(r).toEqual({ ok: true, value: s.trim() === '' ? null : s });
      }),
    );
  });

  it('trim/lowercase/uppercase are the plain String methods (property, incl. non-BMP)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        expect(applyStep(s, S.trim)).toEqual({ ok: true, value: s.trim() });
        expect(applyStep(s, S.lowercase)).toEqual({ ok: true, value: s.toLowerCase() });
        expect(applyStep(s, S.uppercase)).toEqual({ ok: true, value: s.toUpperCase() });
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('split_full_name (spec edge cases)', () => {
  it.each([
    ['Jane\u00a0Doe', 'Jane', 'Doe'], // NBSP counts as whitespace
    ['Jane\u3000\u3000Doe', 'Jane', 'Doe'], // ideographic space
    ['Jane\nQ\tDoe', 'Jane', 'Doe'],
    ['Jane Doe,', null, 'Jane Doe'], // comma form: nothing after the comma ⇒ no first name
    ["O'Brien, Leah", 'Leah', "O'Brien"],
    ['Jean-Luc Picard', 'Jean-Luc', 'Picard'],
    ['José Núñez', 'José', 'Núñez'],
    ['𝓙ane 𝓓oe', '𝓙ane', '𝓓oe'],
    ['Doe,\u00a0Jane', 'Jane', 'Doe'],
  ] as [string, string | null, string | null][])('%j ⇒ first %j, last %j', (input, first, last) => {
    expect(splitFullName(input, 'first')).toBe(first);
    expect(splitFullName(input, 'last')).toBe(last);
  });

  it("never returns '' or a whitespace-padded part; first never contains whitespace (property)", () => {
    const nameish = fc.stringMatching(/^[A-Za-z ,\t\u00a0.'-]{0,20}$/);
    fc.assert(
      fc.property(fc.oneof(nameish, fc.string()), (s) => {
        for (const part of ['first', 'last'] as const) {
          const v = splitFullName(s, part);
          if (v === null) continue;
          expect(v).not.toBe('');
          expect(v).toBe(v.trim());
          expect(v).not.toMatch(/\s\s/);
        }
        const first = splitFullName(s, 'first');
        if (first !== null) expect(first).not.toMatch(/\s/);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
/** Independent calendar oracle (no Date involved). */
const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const daysIn = (y: number, m: number) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const iso = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateEdgeSuite(): void {
  it.each([
    // Century leap rules, incl. the years 0–99 that Date.UTC maps to 1900–1999.
    ['0000-02-29', 'yyyy-MM-dd', '0000-02-29'],
    ['0004-02-29', 'yyyy-MM-dd', '0004-02-29'],
    ['0001-02-29', 'yyyy-MM-dd', FAIL],
    ['0100-02-29', 'yyyy-MM-dd', FAIL],
    ['0400-02-29', 'yyyy-MM-dd', '0400-02-29'],
    ['1900-02-29', 'yyyy-MM-dd', FAIL],
    ['29-Feb-2100', 'dd-MMM-yyyy', FAIL],
    ['29-feb-2400', 'dd-MMM-yyyy', '2400-02-29'],
    ['20000229', 'yyyyMMdd', '2000-02-29'],
    ['00991231', 'yyyyMMdd', '0099-12-31'],
    ['31-Apr-2019', 'dd-MMM-yyyy', FAIL],
    ['31-dEc-1999', 'dd-MMM-yyyy', '1999-12-31'],
    // DST-transition and zone-skip days (a local-time implementation breaks on these).
    ['12/30/2011', 'MM/dd/yyyy', '2011-12-30'], // skipped entirely in Pacific/Apia
    ['11/04/2018', 'MM/dd/yyyy', '2018-11-04'], // midnight did not exist in America/Sao_Paulo
    ['03/10/2019', 'MM/dd/yyyy', '2019-03-10'],
    ['1/1/1900', 'MM/dd/yyyy', '1900-01-01'], // LMT offsets with seconds in many zones
    ['31/12/1969', 'dd/MM/yyyy', '1969-12-31'],
    // Whole-string match only: no trailing newline, no non-ASCII digits, no sign, no 2-letter/4-letter months.
    ['2019-03-14\n', 'yyyy-MM-dd', FAIL],
    ['\n2019-03-14', 'yyyy-MM-dd', FAIL],
    ['２０１９-03-14', 'yyyy-MM-dd', FAIL],
    ['٢٠١٩-03-14', 'yyyy-MM-dd', FAIL],
    ['+2019-03-14', 'yyyy-MM-dd', FAIL],
    ['2019-03-14\u0000', 'yyyy-MM-dd', FAIL],
    ['14-Ma-2019', 'dd-MMM-yyyy', FAIL],
    ['14-Sept-2019', 'dd-MMM-yyyy', FAIL],
    ['14-Mär-2019', 'dd-MMM-yyyy', FAIL],
    ['14 Mar 2019', 'dd-MMM-yyyy', FAIL],
    ['2019-03-14', 'yyyyMMdd', FAIL],
    ['201903140', 'yyyyMMdd', FAIL],
  ] as [string, DateFormat, Expected][])('%j as %s ⇒ %s', (input, format, expected) => {
    const r = parseDate(input, [format]);
    expectResult(r, expected);
    if (r.ok) expect(r.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('three formats: ambiguity is detected whichever order the formats are listed in', () => {
    const formats: DateFormat[] = ['yyyy-MM-dd', 'dd/MM/yyyy', 'MM/dd/yyyy'];
    for (const order of [formats, [...formats].reverse()]) {
      const r = parseDate('01/02/2019', order);
      expectResult(r, AMBIG);
      if (!r.ok) {
        expect(r.message).toContain('2019-01-02');
        expect(r.message).toContain('2019-02-01');
      }
    }
  });

  it('a successful parse does not depend on format order or duplicates', () => {
    const all = [...DATE_FORMATS];
    for (const input of ['12/31/2019', '31/12/2019', '2019-12-31', '31-Dec-2019', '20191231']) {
      const a = parseDate(input, all);
      const b = parseDate(input, [...all].reverse());
      const c = parseDate(input, [...all, ...all]);
      expectResult(a, '2019-12-31');
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    }
  });

  it('both slash readings impossible ⇒ TRANSFORM_FAILED mentioning the date does not exist', () => {
    const r = parseDate('02/30/2019', ['MM/dd/yyyy', 'dd/MM/yyyy']);
    expectResult(r, FAIL);
    if (!r.ok) expect(r.message).toMatch(/does not exist/);
  });
}

describe('parse_date edge cases are timezone independent (exotic zones)', () => {
  const original = process.env.TZ;
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  // [zone, getTimezoneOffset() on 2020-01-01T00:00Z] proves the switch took effect.
  describe.each([
    ['UTC', 0],
    ['Pacific/Kiritimati', -840],
    ['Pacific/Pago_Pago', 660],
    ['America/St_Johns', 210],
    ['Asia/Kathmandu', -345],
    ['Australia/Lord_Howe', -660],
    ['Pacific/Apia', -840],
    ['America/Sao_Paulo', 180],
  ])('TZ=%s', (zone, offset) => {
    beforeAll(() => {
      process.env.TZ = zone;
    });
    it('is active', () => {
      expect(new Date(Date.UTC(2020, 0, 1)).getTimezoneOffset()).toBe(offset);
    });
    dateEdgeSuite();
  });
});

describe('parse_date with the full format list (property)', () => {
  const realDate = fc
    .record({ y: fc.integer({ min: 0, max: 9999 }), m: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 31 }) })
    .filter(({ y, m, d }) => d <= daysIn(y, m));

  it('dates rendered in a self-describing format parse identically under every format list containing it', () => {
    const render: Record<'yyyy-MM-dd' | 'dd-MMM-yyyy' | 'yyyyMMdd', (y: number, m: number, d: number) => string> = {
      'yyyy-MM-dd': (y, m, d) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`,
      'dd-MMM-yyyy': (y, m, d) => `${d}-${MONTHS[m - 1]!.toUpperCase()}-${pad(y, 4)}`,
      yyyyMMdd: (y, m, d) => `${pad(y, 4)}${pad(m, 2)}${pad(d, 2)}`,
    };
    const fmt = fc.constantFrom('yyyy-MM-dd', 'dd-MMM-yyyy', 'yyyyMMdd') as fc.Arbitrary<keyof typeof render>;
    const others = fc.subarray([...DATE_FORMATS]);
    fc.assert(
      fc.property(realDate, fmt, others, fc.boolean(), ({ y, m, d }, f, rest, first) => {
        const formats = first ? [f, ...rest] : [...rest, f];
        expect(parseDate(render[f](y, m, d), formats)).toEqual({ ok: true, value: iso(y, m, d) });
      }),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('parse_currency_to_cents', () => {
  it.each([
    // Float traps: a float multiply gets these wrong (e.g. 4.35 * 100 = 434.99999999999994).
    ['0.07', 7],
    ['1.15', 115],
    ['4.35', 435],
    ['0.29', 29],
    ['-$19.99', -1999],
    ['(1,005.10)', -100510],
    ['$1,234.5', 123450],
    ['($1,234,567.8)', -123456780],
    ['$90,071,992,547,409.91', Number.MAX_SAFE_INTEGER],
    ['-$0', 0],
    ['($0)', 0],
    ['-0.0', 0],
    ['000', 0],
  ] as [string, number][])('%j = %d', (input, cents) => {
    expectResult(parseCurrencyToCents(input), cents);
  });

  it.each([
    '12.00\n',
    '\n12.00',
    '１２.00', // fullwidth digits
    '٤٥.00', // Arabic-Indic digits
    '−12.00', // U+2212 minus
    '$$12',
    '12$',
    '1_000',
    '1 000',
    "1'000",
    'Infinity',
    'NaN',
    '0b101',
    '((12))',
    '-(12)',
    '1,000.',
    '1,000,0000',
    '00,123',
    '$90,071,992,547,409.92',
    '-9007199254740991',
    "'; DROP TABLE accounts; --",
    '__proto__',
    '12.00e0',
    '1.000',
  ])('%j fails', (input) => {
    expectResult(parseCurrencyToCents(input), FAIL);
  });

  /** BigInt oracle over every sign/paren/$/grouping/decimals combination the spec allows. */
  it('agrees with a BigInt oracle on every allowed shape, failing exactly when unsafe (property)', () => {
    const group = (digits: string) => digits.replace(/\B(?=(\d{3})+$)/g, ',');
    const amount = fc.record({
      sign: fc.constantFrom('', '-', 'parens'),
      dollar: fc.boolean(),
      int: fc.bigInt({ min: 0n, max: 10n ** 17n }),
      grouped: fc.boolean(),
      frac: fc.constantFrom('', '5', '05', '50', '9', '99', '00', '0'),
    });
    fc.assert(
      fc.property(amount, ({ sign, dollar, int, grouped, frac }) => {
        const digits = grouped ? group(String(int)) : String(int);
        const body = `${dollar ? '$' : ''}${digits}${frac ? `.${frac}` : ''}`;
        const text = sign === 'parens' ? `(${body})` : `${sign}${body}`;
        const fracCents = frac === '' ? 0n : BigInt(frac.padEnd(2, '0'));
        const abs = int * 100n + fracCents;
        const r = parseCurrencyToCents(text);
        if (abs > BigInt(Number.MAX_SAFE_INTEGER)) {
          expect(r).toMatchObject({ ok: false, code: FAIL });
          return;
        }
        const expected = sign !== '' && abs !== 0n ? -Number(abs) : Number(abs);
        expect(r).toEqual({ ok: true, value: expected });
        if (r.ok) expect(Object.is(r.value, -0)).toBe(false);
      }),
      { numRuns: 2000 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('to_integer', () => {
  it('agrees with a BigInt oracle and never yields -0 (property)', () => {
    const intText = fc.tuple(fc.constantFrom('', '+', '-'), fc.stringMatching(/^\d{1,22}$/));
    fc.assert(
      fc.property(intText, ([sign, digits]) => {
        const r = applyStep(sign + digits, S.to_integer);
        const big = BigInt(digits) * (sign === '-' ? -1n : 1n);
        const safe = big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= -BigInt(Number.MAX_SAFE_INTEGER);
        if (!safe) expect(r).toMatchObject({ ok: false, code: FAIL });
        else {
          expect(r).toEqual({ ok: true, value: Number(big) });
          if (r.ok) expect(Object.is(r.value, -0)).toBe(false);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it.each(['+0', '-00', '000'])('%j = 0 (not -0)', (input) => {
    expectResult(applyStep(input, S.to_integer), 0);
  });

  it.each(['1\n', '\n1', '１', '1.0', '1,000', 'Infinity', '--1', '+-1', '1-'])('%j fails', (input) => {
    expectResult(applyStep(input, S.to_integer), FAIL);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('to_boolean', () => {
  it('trims Unicode whitespace on both sides of the comparison', () => {
    const step: Step = { op: 'to_boolean', params: { true_values: ['\u00a0Yes\t'], false_values: ['no'] } };
    expectResult(applyStep('\u3000YES\n', step), true);
    expectResult(applyStep(' No ', step), false);
  });

  it('a value that case-folds into both lists fails even if the raw spellings differ', () => {
    const step: Step = { op: 'to_boolean', params: { true_values: ['y'], false_values: [' Y '] } };
    expectResult(applyStep('Y', step), FAIL);
  });

  it.each(['constructor', '__proto__', 'toString', 'true', '1'])('unlisted %j fails', (input) => {
    expectResult(applyStep(input, S.to_boolean), FAIL);
  });

  it('non-ASCII letters compare case-insensitively', () => {
    const step: Step = { op: 'to_boolean', params: { true_values: ['ÉLITE'], false_values: ['standard'] } };
    expectResult(applyStep('élite', step), true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('map_values', () => {
  it('is exact: whitespace and case variants miss', () => {
    const strict: Step = { op: 'map_values', params: { pairs: [{ from: 'A', to: 'active' }], fallback: null } };
    expectResult(applyStep(' A', strict), FAIL);
    expectResult(applyStep('A ', strict), FAIL);
    expectResult(applyStep('a', strict), FAIL);
    expectResult(applyStep('\u0410', strict), FAIL); // Cyrillic \u0410 homoglyph
  });

  it('a duplicated `from` resolves deterministically (Map semantics: last pair wins)', () => {
    const dup: Step = { op: 'map_values', params: { pairs: [{ from: 'A', to: 'one' }, { from: 'A', to: 'two' }], fallback: null } };
    expectResult(applyStep('A', dup), 'two');
  });

  it("maps to '' when that is the configured target (a hit, not a miss)", () => {
    const step: Step = { op: 'map_values', params: { pairs: [{ from: 'X', to: '' }], fallback: 'FB' } };
    expectResult(applyStep('X', step), '');
  });

  it('injection-looking values are just unmapped strings', () => {
    for (const v of ["' OR 1=1 --", '${process.exit()}', '{{7*7}}', '<script>', '\u202eevil']) {
      const r = applyStep(v, { op: 'map_values', params: { pairs: [{ from: 'A', to: 'a' }], fallback: null } });
      expect(r).toEqual({ ok: false, code: FAIL, message: `value '${v}' has no mapping` });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('normalize_phone', () => {
  const E164 = /^\+[1-9][0-9]{7,14}$/; // target-schema phone_e164 pattern

  it.each([
    ['+1 (555) 123-4567', '+15551234567'],
    ['1-800-555-1234', '+18005551234'],
    ['+15551234567', '+15551234567'],
    ['(555)123-4567', '+15551234567'],
    ['555\u00a0123\u00a04567', '+15551234567'],
    [' 555 123 4567 ', '+15551234567'],
  ])('%j = %s', (input, e164) => {
    expectResult(normalizeUsPhone(input), e164);
  });

  it.each(['11234567890', '10234567890', '0123456789', '1555123456', '+1 555 123 456', '0015551234567', '5551234567\n1'])(
    '%j fails (area code / length rules)',
    (input) => {
      expectResult(normalizeUsPhone(input), FAIL);
    },
  );

  it('every success matches the target E.164 pattern (property)', () => {
    const phoneish = fc.stringMatching(/^[+]?[0-9 ().-]{0,18}$/);
    fc.assert(
      fc.property(fc.oneof(phoneish, fc.string()), (s) => {
        const r = normalizeUsPhone(s);
        if (r.ok) {
          expect(r.value).toMatch(E164);
          expect(r.value).toMatch(/^\+1[2-9]\d{9}$/);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('applyStep never throws on malformed (unvalidated) steps or inputs', () => {
  const badSteps: unknown[] = [
    null,
    undefined,
    {},
    { op: 'trim' },
    { op: 'parse_date', params: { formats: ['bogus'] } },
    { op: 'parse_date', params: { formats: ['__proto__'] } },
    { op: 'parse_date', params: { formats: 'yyyy-MM-dd' } },
    { op: 'parse_date', params: null },
    { op: 'to_boolean', params: { true_values: 'Y', false_values: 'N' } },
    { op: 'to_boolean', params: { true_values: [1], false_values: [null] } },
    { op: 'map_values', params: { pairs: null, fallback: null } },
    { op: 'map_values', params: { pairs: [null], fallback: null } },
    { op: 'split_full_name', params: { part: 'middle' } },
    { op: 'concat', params: null },
    { op: 'default', params: null },
    { op: 'toString', params: {} },
    { op: '__proto__', params: {} },
    { op: 42, params: {} },
    { op: Symbol('x'), params: {} },
  ];
  const inputs: unknown[] = ['Y', '', null, ['a', null], 0, true, undefined, Number.NaN];

  it.each(badSteps.map((s, i) => [i, s]))('bad step #%i', (_i, step) => {
    for (const input of inputs) {
      let r: StepResult | undefined;
      expect(() => {
        r = applyStep(input as Value, step as Step);
      }).not.toThrow();
      expect(r).toBeDefined();
      if (!r!.ok) {
        expect([FAIL, AMBIG]).toContain(r!.code);
        expect(typeof r!.message).toBe('string');
      }
    }
  });

  it('every valid op on undefined / NaN input returns a result instead of throwing', () => {
    for (const op of OP_NAMES) {
      for (const input of [undefined, Number.NaN, Symbol('s'), 10n]) {
        expect(() => applyStep(input as unknown as Value, S[op])).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('runMapping', () => {
  it('works with frozen and null-prototype inputs and never mutates them', () => {
    const values = Object.freeze(Object.assign(Object.create(null) as Record<string, string>, { a: ' x ', b: 'y' }));
    const steps = Object.freeze([S.concat, S.trim]) as readonly Step[];
    const sources = Object.freeze(['a', 'b']);
    expect(runMapping(values, { sources, steps })).toEqual({ ok: true, value: 'x |y' });
  });

  it('reads a JSON-parsed own "__proto__" source field like any other field', () => {
    const values = JSON.parse('{"__proto__":"C-00001","x":"1"}') as Record<string, string>;
    expect(runMapping(values, { sources: ['__proto__'], steps: [S.copy] })).toEqual({ ok: true, value: 'C-00001' });
  });

  it('a 0-source mapping whose first step is not default starts from null and stays null', () => {
    expect(runMapping({ a: 'x' }, { sources: [], steps: [S.trim, S.uppercase] })).toEqual({ ok: true, value: null });
  });

  it('stops at the first failure: later steps (even ones that would succeed or mask it) never run', () => {
    const steps: Step[] = [S.to_integer, S.copy, { op: 'default', params: { value: '0' } }];
    expect(runMapping({ a: 'abc' }, { sources: ['a'], steps })).toMatchObject({ ok: false, stepIndex: 0, op: 'to_integer' });
  });

  it('identical inputs give byte-identical results, including failure messages', () => {
    const values = { d: '03/04/2019', s: 'zz' };
    const m1 = { sources: ['d'], steps: [{ op: 'parse_date', params: { formats: ['MM/dd/yyyy', 'dd/MM/yyyy'] } } as Step] };
    const m2 = { sources: ['s'], steps: [S.trim, { op: 'map_values', params: { pairs: [{ from: 'A', to: 'a' }], fallback: null } } as Step] };
    for (const m of [m1, m2]) expect(canonicalJson(runMapping(values, m))).toBe(canonicalJson(runMapping({ ...values }, m)));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('transformRecord', () => {
  const field = (name: string, type: 'string' | 'integer' | 'boolean' | 'date' = 'string') => ({
    name,
    type,
    required: true,
    unique: false,
    description: '',
  });
  const target: TargetSchema = {
    name: 't',
    description: '',
    keyField: 'a',
    fields: [field('a'), field('b', 'integer'), field('c', 'date'), field('d', 'boolean')],
  };

  it('evidence has exactly the contract keys, raw values verbatim, and does not alias the mapping', () => {
    const m = mapping('b', ['amt'], [S.trim, S.parse_currency_to_cents]);
    const { errors } = transformRecord({ sourceKey: 'r9', values: { amt: '  12.3.4\t' } }, [m], target);
    expect(errors).toHaveLength(1);
    const e = errors[0]!;
    expect(Object.keys(e).sort()).toEqual(
      ['code', 'message', 'op', 'rawValues', 'sourceFields', 'sourceKey', 'stage', 'stepIndex', 'targetField'].sort(),
    );
    expect(e.rawValues).toEqual({ amt: '  12.3.4\t' });
    e.sourceFields.push('mutated');
    expect(m.sources).toEqual(['amt']);
  });

  it('errors come out in target-schema order regardless of mapping order; AMBIGUOUS_DATE is kept as its own code', () => {
    const mappings = [
      mapping('d', ['v'], [S.to_boolean]),
      mapping('c', ['dt'], [{ op: 'parse_date', params: { formats: ['MM/dd/yyyy', 'dd/MM/yyyy'] } }]),
      mapping('b', ['n'], [S.to_integer]),
      mapping('a', ['x'], [S.trim]),
    ];
    const { row, errors } = transformRecord({ sourceKey: 'r1', values: { v: '?', dt: '01/02/2020', n: 'x', x: ' ok ' } }, mappings, target);
    expect(errors.map((e) => [e.targetField, e.code])).toEqual([
      ['b', FAIL],
      ['c', AMBIG],
      ['d', FAIL],
    ]);
    expect(row).toEqual({ a: 'ok', b: null, c: null, d: null });
    expect(Object.keys(row)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('first matching mapping wins even when it fails and a later one would succeed', () => {
    const mappings = [mapping('b', ['n'], [S.to_integer]), mapping('b', ['n'], [{ op: 'default', params: { value: '1' } }])];
    const { row, errors } = transformRecord({ sourceKey: 'r1', values: { n: 'nope' } }, mappings, target);
    expect(row.b).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
    'a target field named %j is an own key of the row, null when unmapped or failed (row[field] = null)',
    (name) => {
      const t: TargetSchema = { name: 't', description: '', keyField: 'k', fields: [field('k'), field(name, 'integer')] };
      const unmapped = transformRecord({ sourceKey: 'r1', values: {} }, [], t).row;
      expect(Object.keys(unmapped)).toEqual(['k', name]);
      expect(Object.hasOwn(unmapped, name)).toBe(true);
      const failed = transformRecord({ sourceKey: 'r1', values: { s: 'x' } }, [mapping(name, ['s'], [S.to_integer])], t);
      expect(Object.keys(failed.row)).toEqual(['k', name]);
      expect(failed.errors.map((e) => e.targetField)).toEqual([name]);
      // The row must hash the same way it is stored: every business column present.
      expect(canonicalJson(failed.row)).toBe(canonicalJson({ k: null, [name]: null }));
    },
  );

  it('never throws and keeps the row shape for arbitrary record contents under the gold plan (property)', () => {
    const t = TargetSchemaSchema.parse(load('target-schema.json'));
    const gold = MigrationPlanSchema.parse(load('gold-plan.json'));
    const names = t.fields.map((f) => f.name);
    const anyText = fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.constantFrom('', ' ', '03/04/2019', '$1,23', 'A'));
    const values = fc.dictionary(
      fc.constantFrom('cust_id', 'full_name', 'email_addr', 'phone', 'status', 'signup_dt', 'bal', 'vip_flag'),
      anyText,
    );
    fc.assert(
      fc.property(values, (vals) => {
        const { row, errors } = transformRecord({ sourceKey: 'rX', values: vals }, gold.mappings, t);
        expect(Object.keys(row)).toEqual(names);
        const failed = errors.map((e) => e.targetField!);
        expect(failed).toEqual(names.filter((n) => failed.includes(n))); // schema order, no duplicates
        for (const e of errors) {
          expect(e.stage).toBe('transform');
          expect([FAIL, AMBIG]).toContain(e.code);
          expect(row[e.targetField!]).toBeNull();
        }
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('gold plan over the fixtures (stronger checks)', () => {
  const target = TargetSchemaSchema.parse(load('target-schema.json'));
  const gold = MigrationPlanSchema.parse(load('gold-plan.json'));
  const records = load('source-records.json') as SourceRecord[];
  const manifest = load('defect-manifest.json') as Record<string, string[]>;
  const run = (rs: readonly SourceRecord[]) => rs.map((r) => ({ sourceKey: r.sourceKey, ...transformRecord(r, gold.mappings, target) }));
  const results = run(records);
  const byKey = new Map(results.map((r) => [r.sourceKey, r]));
  const rec = new Map(records.map((r) => [r.sourceKey, r]));

  it.each([
    ['unparseable_date', 'created_on', 1, 'parse_date'],
    ['day_first_date', 'created_on', 1, 'parse_date'],
    ['unknown_status', 'status', 2, 'map_values'],
    ['empty_status', 'status', 2, 'map_values'],
    ['malformed_balance', 'balance_cents', 3, 'parse_currency_to_cents'],
    ['invalid_phone', 'phone_e164', 2, 'normalize_phone'],
    ['unknown_vip', 'is_vip', 1, 'to_boolean'],
  ] as [string, string, number, string][])('%s fails on %s at step %i (%s) with exact raw evidence', (category, field, stepIndex, op) => {
    const m = gold.mappings.find((x) => x.target === field)!;
    for (const key of manifest[category]!) {
      const errs = byKey.get(key)!.errors.filter((e) => e.targetField === field);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatchObject({ stage: 'transform', stepIndex, op, code: FAIL, sourceFields: m.sources });
      expect(errs[0]!.rawValues).toEqual({ [m.sources[0]!]: rec.get(key)!.values[m.sources[0]!] });
    }
  });

  it('empty balances become 0 cents; names without a last part are null without a transform error', () => {
    for (const key of manifest.empty_balance!) expect(byKey.get(key)!.row.balance_cents).toBe(0);
    for (const key of [...manifest.single_token_name!, ...manifest.empty_name!]) {
      const r = byKey.get(key)!;
      expect(r.row.last_name).toBeNull();
      expect(r.errors.filter((e) => e.targetField === 'last_name' || e.targetField === 'first_name')).toEqual([]);
    }
    for (const key of manifest.empty_name!) expect(byKey.get(key)!.row.first_name).toBeNull();
  });

  it('messy cust_ids are normalised to the target key shape', () => {
    for (const key of manifest.messy_cust_id!) expect(byKey.get(key)!.row.external_ref).toMatch(/^C-\d{5}$/);
  });

  it('every produced value satisfies the obvious target invariants', () => {
    const statuses = new Set(target.fields.find((f) => f.name === 'status')!.enum);
    for (const { row } of results) {
      if (row.phone_e164 !== null) expect(row.phone_e164).toMatch(/^\+1[2-9]\d{9}$/);
      if (row.status !== null) expect(statuses.has(row.status as string)).toBe(true);
      if (row.created_on !== null) {
        const [y, m, d] = (row.created_on as string).split('-').map(Number) as [number, number, number];
        expect(m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m)).toBe(true);
      }
      if (row.email !== null) expect(row.email).toBe((row.email as string).toLowerCase());
      expect(row.country).toBe('US');
    }
  });

  it('phone failure messages never echo the (PII) raw number', () => {
    for (const key of manifest.invalid_phone!) {
      const raw = rec.get(key)!.values.phone!;
      const e = byKey.get(key)!.errors.find((x) => x.targetField === 'phone_e164')!;
      expect(e.message).not.toContain(raw);
      expect(e.message).not.toContain(raw.replace(/\D/g, ''));
    }
  });

  it('is independent of record order and of repetition', () => {
    const reversed = run([...records].reverse()).reverse();
    expect(canonicalJson(reversed)).toBe(canonicalJson(results));
    expect(canonicalJson(run(records))).toBe(canonicalJson(results));
  });

  describe('is byte-identical under other process timezones', () => {
    const original = process.env.TZ;
    const baseline = canonicalJson(results);
    afterAll(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });
    it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/St_Johns', 'Asia/Kathmandu'])('TZ=%s', (zone) => {
      process.env.TZ = zone;
      expect(new Date(Date.UTC(2020, 0, 1)).getTimezoneOffset()).not.toBe(0);
      expect(canonicalJson(run(records))).toBe(baseline);
    });
  });
});
