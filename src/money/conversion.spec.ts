import fc from 'fast-check';
import { convert } from './conversion';
import { type CurrencyCode, currencyExponent, parseCurrency } from './currency';
import { type FxRate, identityRate, parseFxRate } from './fx-rate';
import { INT64_MAX, Money } from './money';
import { AmountOutOfRangeError, CurrencyMismatchError, InvalidFxRateError } from './money-errors';
import { proportionalShare } from './rounding';

const USD = parseCurrency('USD');
const EUR = parseCurrency('EUR');
const JPY = parseCurrency('JPY');
const KWD = parseCurrency('KWD');
const CLF = parseCurrency('CLF');

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

  it('rejects a zero or negative rate even if constructed directly', () => {
    const zero: FxRate = { from: EUR, to: USD, scaled: 0n, source: 'test', asOf: new Date(0) };

    expect(() => convert(Money.of(100n, EUR), zero, 'UP')).toThrow(InvalidFxRateError);
    expect(() => convert(Money.of(100n, EUR), { ...zero, scaled: -1n }, 'UP')).toThrow(
      InvalidFxRateError,
    );
  });

  it('rounds up to the smallest and down to the largest minor amount around the exact value', () => {
    const currencies = [USD, EUR, JPY, KWD, CLF];
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.constantFrom(...currencies),
        fc.constantFrom(...currencies),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (minor, from, to, scaled) => {
          const fxRate: FxRate = { from, to, scaled, source: 'test', asOf: new Date(0) };
          const numerator = minor * scaled * 10n ** BigInt(currencyExponent(to));
          const denominator = 10n ** 10n * 10n ** BigInt(currencyExponent(from));
          const up = convert(Money.of(minor, from), fxRate, 'UP').minor;
          const down = convert(Money.of(minor, from), fxRate, 'DOWN').minor;
          expect(up * denominator >= numerator).toBe(true);
          expect((up - 1n) * denominator < numerator || up === 0n).toBe(true);
          expect(down * denominator <= numerator).toBe(true);
          expect((down + 1n) * denominator > numerator).toBe(true);
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
          let cumulativeInvoice = 0n;
          let cumulativeFreed = 0n;
          freed.forEach((amount, index) => {
            cumulativeInvoice += slices[index]!;
            cumulativeFreed += amount;
            expect(amount >= 0n).toBe(true);
            expect(cumulativeFreed * invoiceAmount <= booked * cumulativeInvoice).toBe(true);
            expect((cumulativeFreed + 1n) * invoiceAmount > booked * cumulativeInvoice).toBe(true);
          });
          expect(cumulativeFreed).toBe(booked);
        },
      ),
    );
  });

  it('never frees more than the proportional share before the final release', () => {
    const freed = releaseInSlices(1_000n, 3n, [1n, 1n, 1n]);

    expect(freed).toEqual([333n, 333n, 334n]);
    expect(releaseInSlices(2n, 3n, [1n, 1n, 1n])).toEqual([0n, 1n, 1n]);
  });
});
