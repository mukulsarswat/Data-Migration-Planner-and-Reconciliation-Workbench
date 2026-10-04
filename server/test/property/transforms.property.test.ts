import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DATE_FORMATS, StepSchema } from '../../../shared/dsl.ts';
import type { DateFormat, Step } from '../../../shared/dsl.ts';
import { applyStep, normalizeUsPhone, parseCurrencyToCents, parseDate, runMapping } from '../../src/engine/transforms.ts';

/** Strings biased towards the shapes the ops care about, plus arbitrary (incl. non-BMP) text. */
const text = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.constantFrom('', ' ', 'A', 'y', 'N', '03/04/2019', '14-Mar-2019', '$1,234.50', '(45.00)', '(555) 123-4567', 'Doe, Jane'),
  fc.constantFrom('constructor', 'toString', '__proto__', 'hasOwnProperty'),
);

/** Any step whose params satisfy the DSL schema. */
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.constantFrom<Step>(
    { op: 'copy', params: {} },
    { op: 'trim', params: {} },
    { op: 'lowercase', params: {} },
    { op: 'uppercase', params: {} },
    { op: 'null_if_empty', params: {} },
    { op: 'parse_currency_to_cents', params: {} },
    { op: 'to_integer', params: {} },
    { op: 'normalize_phone', params: { default_country: 'US' } },
  ),
  text.map((value): Step => ({ op: 'default', params: { value } })),
  fc.constantFrom('first', 'last').map((part): Step => ({ op: 'split_full_name', params: { part } })),
  text.map((separator): Step => ({ op: 'concat', params: { separator } })),
  fc
    .array(fc.constantFrom(...DATE_FORMATS), { minLength: 1, maxLength: 5 })
    .map((formats): Step => ({ op: 'parse_date', params: { formats } })),
  fc
    .record({ true_values: fc.array(text, { minLength: 1 }), false_values: fc.array(text, { minLength: 1 }) })
    .map((params): Step => ({ op: 'to_boolean', params })),
  fc
    .record({
      pairs: fc.array(fc.record({ from: text, to: text }), { minLength: 1 }),
      fallback: fc.option(text, { nil: null }),
    })
    .map((params): Step => ({ op: 'map_values', params })),
);

const inputArb = fc.oneof(
  fc.constant(null),
  text,
  fc.array(fc.option(text, { nil: null })),
  fc.integer(),
  fc.boolean(),
);

describe('applyStep', () => {
  it('never throws and always returns a well-formed result', () => {
    fc.assert(
      fc.property(inputArb, stepArb, (input, step) => {
        StepSchema.parse(step); // the generator only produces valid params
        const result = applyStep(input, step);
        if (result.ok) {
          const v = result.value;
          expect(v === null || ['string', 'boolean'].includes(typeof v) || Number.isSafeInteger(v)).toBe(true);
          expect(Object.is(v, -0)).toBe(false);
        } else {
          expect(['TRANSFORM_FAILED', 'AMBIGUOUS_DATE']).toContain(result.code);
          expect(result.message.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe('runMapping', () => {
  const values = fc.dictionary(fc.constantFrom('a', 'b', 'c', 'constructor'), text);
  const sources = fc.array(fc.constantFrom('a', 'b', 'c', 'missing', 'toString'), { maxLength: 3 });
  const steps = fc.array(stepArb, { maxLength: 5 });

  it('is deterministic and does not mutate its inputs', () => {
    fc.assert(
      fc.property(values, sources, steps, (vals, srcs, stps) => {
        const before = structuredClone({ vals, srcs, stps });
        const first = runMapping(vals, { sources: srcs, steps: stps });
        const second = runMapping(vals, { sources: srcs, steps: stps });
        expect(second).toEqual(first);
        expect({ vals, srcs, stps }).toEqual(before);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('parseCurrencyToCents', () => {
  const groupThousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+$)/g, ',');
  const split = (cents: number) => ({ dollars: Math.floor(cents / 100), rest: String(cents % 100).padStart(2, '0') });

  it("round-trips '$x,xxx.yy'", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (cents) => {
        const { dollars, rest } = split(cents);
        expect(parseCurrencyToCents(`$${groupThousands(dollars)}.${rest}`)).toEqual({ ok: true, value: cents });
      }),
    );
  });

  it("round-trips '-x.yy' (and never yields -0)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (cents) => {
        const { dollars, rest } = split(cents);
        const result = parseCurrencyToCents(`-${dollars}.${rest}`);
        expect(result).toEqual({ ok: true, value: cents === 0 ? 0 : -cents });
        if (result.ok) expect(Object.is(result.value, -0)).toBe(false);
      }),
    );
  });
});

describe('parseDate', () => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Independent calendar oracle (no Date involved).
  const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysIn = (y: number, m: number) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  const iso = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;

  const ymd = fc.record({
    y: fc.integer({ min: 0, max: 9999 }),
    m: fc.integer({ min: 1, max: 12 }),
    d: fc.integer({ min: 1, max: 31 }),
  });
  const realDate = ymd.filter(({ y, m, d }) => d <= daysIn(y, m));
  const unrealDate = ymd.filter(({ y, m, d }) => d > daysIn(y, m));
  /** Rendering choices: zero-pad 1–2 digit fields or not; month-name case. */
  const style = fc.record({ padded: fc.boolean(), monthCase: fc.constantFrom('title', 'lower', 'upper') });

  function render(format: DateFormat, y: number, m: number, d: number, s: { padded: boolean; monthCase: string }): string {
    const mm = s.padded ? pad(m, 2) : String(m);
    const dd = s.padded ? pad(d, 2) : String(d);
    const name = s.monthCase === 'lower' ? MONTHS[m - 1]!.toLowerCase() : s.monthCase === 'upper' ? MONTHS[m - 1]!.toUpperCase() : MONTHS[m - 1]!;
    switch (format) {
      case 'yyyy-MM-dd':
        return `${pad(y, 4)}-${mm}-${dd}`;
      case 'MM/dd/yyyy':
        return `${mm}/${dd}/${pad(y, 4)}`;
      case 'dd/MM/yyyy':
        return `${dd}/${mm}/${pad(y, 4)}`;
      case 'dd-MMM-yyyy':
        return `${dd}-${name}-${pad(y, 4)}`;
      case 'yyyyMMdd':
        return `${pad(y, 4)}${pad(m, 2)}${pad(d, 2)}`;
    }
  }

  it('round-trips every real date in every format', () => {
    fc.assert(
      fc.property(realDate, fc.constantFrom(...DATE_FORMATS), style, ({ y, m, d }, format, s) => {
        expect(parseDate(render(format, y, m, d, s), [format])).toEqual({ ok: true, value: iso(y, m, d) });
      }),
      { numRuns: 1000 },
    );
  });

  it('rejects every non-existent day in every format', () => {
    fc.assert(
      fc.property(unrealDate, fc.constantFrom(...DATE_FORMATS), style, ({ y, m, d }, format, s) => {
        expect(parseDate(render(format, y, m, d, s), [format])).toMatchObject({ ok: false, code: 'TRANSFORM_FAILED' });
      }),
    );
  });

  it('is ambiguous between MM/dd and dd/MM exactly when both readings are real and differ', () => {
    const slashDate = fc.record({ a: fc.integer({ min: 1, max: 31 }), b: fc.integer({ min: 1, max: 31 }), y: fc.integer({ min: 1900, max: 2100 }) });
    fc.assert(
      fc.property(slashDate, ({ a, b, y }) => {
        const result = parseDate(`${pad(a, 2)}/${pad(b, 2)}/${y}`, ['MM/dd/yyyy', 'dd/MM/yyyy']);
        const readings = new Set<string>();
        if (a <= 12 && b <= daysIn(y, a)) readings.add(iso(y, a, b));
        if (b <= 12 && a <= daysIn(y, b)) readings.add(iso(y, b, a));
        if (readings.size === 1) expect(result).toEqual({ ok: true, value: [...readings][0] });
        else expect(result).toMatchObject({ ok: false, code: readings.size === 0 ? 'TRANSFORM_FAILED' : 'AMBIGUOUS_DATE' });
      }),
    );
  });
});

describe('normalizeUsPhone', () => {
  it('normalizes any NANP number in every fixture style', () => {
    const nanp = fc.tuple(fc.integer({ min: 2, max: 9 }), fc.stringMatching(/^\d{9}$/)).map(([a, rest]) => `${a}${rest}`);
    const styles = [
      (n: string) => n,
      (n: string) => `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`,
      (n: string) => `${n.slice(0, 3)}.${n.slice(3, 6)}.${n.slice(6)}`,
      (n: string) => `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`,
      (n: string) => `+1 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`,
      (n: string) => `1${n}`,
    ];
    fc.assert(
      fc.property(nanp, fc.constantFrom(...styles), (digits, style) => {
        expect(normalizeUsPhone(style(digits))).toEqual({ ok: true, value: `+1${digits}` });
      }),
    );
  });
});
