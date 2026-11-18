import { parseCurrency } from './currency';
import { INT64_MAX, INT64_MIN, Money, parseMinorUnits } from './money';
import { AmountOutOfRangeError, CurrencyMismatchError, InvalidAmountError } from './money-errors';

const USD = parseCurrency('USD');
const EUR = parseCurrency('EUR');

describe('Money', () => {
  it('adds and subtracts amounts in the same currency', () => {
    const a = Money.of(1_000n, USD);
    const b = Money.of(250n, USD);

    expect(a.add(b).minor).toBe(1_250n);
    expect(a.subtract(b).minor).toBe(750n);
    expect(b.subtract(a).minor).toBe(-750n);
    expect(b.subtract(a).isNegative()).toBe(true);
  });

  it('is immutable', () => {
    const a = Money.of(100n, USD);
    a.add(Money.of(1n, USD));

    expect(a.minor).toBe(100n);
  });

  it('refuses to mix currencies', () => {
    const usd = Money.of(1n, USD);
    const eur = Money.of(1n, EUR);

    expect(() => usd.add(eur)).toThrow(CurrencyMismatchError);
    expect(() => usd.subtract(eur)).toThrow(CurrencyMismatchError);
    expect(() => usd.compare(eur)).toThrow(CurrencyMismatchError);
    expect(usd.equals(eur)).toBe(false);
  });

  it('compares amounts', () => {
    expect(Money.of(1n, USD).compare(Money.of(2n, USD))).toBe(-1);
    expect(Money.of(2n, USD).compare(Money.of(2n, USD))).toBe(0);
    expect(Money.of(3n, USD).compare(Money.of(2n, USD))).toBe(1);
    expect(Money.zero(USD).isZero()).toBe(true);
    expect(Money.of(1n, USD).isPositive()).toBe(true);
  });

  it('enforces the Postgres BIGINT range, including on aggregates', () => {
    expect(Money.of(INT64_MAX, USD).minor).toBe(INT64_MAX);
    expect(Money.of(INT64_MIN, USD).minor).toBe(INT64_MIN);
    expect(() => Money.of(INT64_MAX + 1n, USD)).toThrow(AmountOutOfRangeError);
    expect(() => Money.of(INT64_MAX, USD).add(Money.of(1n, USD))).toThrow(AmountOutOfRangeError);
    expect(() => Money.of(INT64_MIN, USD).subtract(Money.of(1n, USD))).toThrow(
      AmountOutOfRangeError,
    );
  });

  it('serialises amounts as strings', () => {
    expect(JSON.stringify(Money.of(123_456_789_012_345_678n, USD))).toBe(
      '{"amount":"123456789012345678","currency":"USD"}',
    );
  });
});

describe('parseMinorUnits', () => {
  it.each([
    ['0', 0n],
    ['1', 1n],
    ['1000000000', 1_000_000_000n],
    ['9223372036854775807', INT64_MAX],
  ])('parses %p', (input, expected) => {
    expect(parseMinorUnits(input)).toBe(expected);
  });

  it.each(['', '-1', '01', '1.5', '1e3', ' 1', '0x10', 'abc'])('rejects %p', (input) => {
    expect(() => parseMinorUnits(input)).toThrow(InvalidAmountError);
  });

  it('rejects values beyond the BIGINT range', () => {
    expect(() => parseMinorUnits('9223372036854775808')).toThrow(AmountOutOfRangeError);
  });
});
