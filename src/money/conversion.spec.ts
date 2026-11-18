import fc from 'fast-check';
import { convert } from './conversion';
import { type CurrencyCode, parseCurrency } from './currency';
import { type FxRate, identityRate, parseFxRate } from './fx-rate';
import { INT64_MAX, Money } from './money';
import { AmountOutOfRangeError, CurrencyMismatchError } from './money-errors';
import { proportionalShare } from './rounding';

const USD = parseCurrency('USD');
const EUR = parseCurrency('EUR');
const JPY = parseCurrency('JPY');
const KWD = parseCurrency('KWD');

function rate(from: CurrencyCode, to: CurrencyCode, value: string): FxRate {
  return { from, to, scaled: parseFxRate(value), source: 'test', asOf: new Date(0) };
}

describe('convert', () => {
  it('converts EUR to USD and rounds up', () => {
    const result = convert(Money.of(100_001n, EUR), rate(EUR, USD, '1.085'), 'UP');

    expect(result.currency).toBe(USD);
    expect(result.minor).toBe(108_502n);
  });

  it('rounds down when asked', () => {
    expect(convert(Money.of(100_001n, EUR), rate(EUR, USD, '1.085'), 'DOWN').minor).toBe(108_501n);
  });

  it('converts JPY (0 decimals) to KWD (3 decimals)', () => {
    const result = convert(Money.of(1_000_000n, JPY), rate(JPY, KWD, '0.0020445'), 'UP');

    expect(result.minor).toBe(2_044_500n);
  });

  it('converts KWD (3 decimals) to JPY (0 decimals) and rounds up fractional yen', () => {
    const result = convert(Money.of(1_001n, KWD), rate(KWD, JPY, '489.11'), 'UP');

    expect(result.minor).toBe(490n);
  });

  it('rounds a tiny positive amount up to one minor unit', () => {
    expect(convert(Money.of(1n, JPY), rate(JPY, USD, '0.00665'), 'UP').minor).toBe(1n);
    expect(convert(Money.of(1n, JPY), rate(JPY, USD, '0.00665'), 'DOWN').minor).toBe(0n);
  });

  it('handles very large amounts without precision loss', () => {
    const result = convert(
      Money.of(9_000_000_000_000_000_000n, USD),
      rate(USD, EUR, '0.9217'),
      'UP',
    );

    expect(result.minor).toBe(8_295_300_000_000_000_000n);
  });

  it('fails instead of overflowing BIGINT', () => {
    expect(() => convert(Money.of(INT64_MAX, USD), rate(USD, JPY, '150.38'), 'UP')).toThrow(
      AmountOutOfRangeError,
    );
  });

  it('is the identity for same-currency conversions', () => {
    expect(convert(Money.of(12_345n, USD), identityRate(USD, new Date()), 'UP').minor).toBe(
      12_345n,
    );
  });

  it('rejects an amount whose currency does not match the rate', () => {
    expect(() => convert(Money.of(1n, USD), rate(EUR, USD, '1.085'), 'UP')).toThrow(
      CurrencyMismatchError,
    );
  });

  it('round-up result is never below the exact value and at most one minor unit above it', () => {
    const currencies = [USD, EUR, JPY, KWD];
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.constantFrom(...currencies),
        fc.constantFrom(...currencies),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (minor, from, to, scaled) => {
          const fxRate: FxRate = { from, to, scaled, source: 'test', asOf: new Date(0) };
          const up = convert(Money.of(minor, from), fxRate, 'UP').minor;
          const down = convert(Money.of(minor, from), fxRate, 'DOWN').minor;
          expect(up >= down).toBe(true);
          expect(up - down <= 1n).toBe(true);
        },
      ),
    );
  });
});

describe('partial release allocation', () => {
  function releaseInSlices(booked: bigint, invoiceAmount: bigint, slices: bigint[]): bigint[] {
    let releasedInvoice = 0n;
    let releasedBooked = 0n;
    return slices.map((slice) => {
      releasedInvoice += slice;
      const cumulative =
        releasedInvoice === invoiceAmount
          ? booked
          : proportionalShare(booked, releasedInvoice, invoiceAmount, 'DOWN');
      const freed = cumulative - releasedBooked;
      releasedBooked = cumulative;
      return freed;
    });
  }

  it('frees exactly the booked amount once the whole invoice is released', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 18n }),
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 6n }), { minLength: 1, maxLength: 20 }),
        (booked, slices) => {
          const invoiceAmount = slices.reduce((sum, slice) => sum + slice, 0n);
          const freed = releaseInSlices(booked, invoiceAmount, slices);
          expect(freed.every((amount) => amount >= 0n)).toBe(true);
          expect(freed.reduce((sum, amount) => sum + amount, 0n)).toBe(booked);
        },
      ),
    );
  });

  it('never frees more than the proportional share before the final release', () => {
    const freed = releaseInSlices(1_000n, 3n, [1n, 1n, 1n]);

    expect(freed).toEqual([333n, 333n, 334n]);
  });
});
