import fc from 'fast-check';
import { InvalidAmountError } from './money-errors';
import { divide, proportionalShare } from './rounding';

describe('divide', () => {
  it('rounds up or down only when there is a remainder', () => {
    expect(divide(10n, 5n, 'UP')).toBe(2n);
    expect(divide(10n, 5n, 'DOWN')).toBe(2n);
    expect(divide(11n, 5n, 'UP')).toBe(3n);
    expect(divide(11n, 5n, 'DOWN')).toBe(2n);
    expect(divide(0n, 7n, 'UP')).toBe(0n);
  });

  it('rejects negative numerators and non-positive denominators', () => {
    expect(() => divide(-1n, 5n, 'UP')).toThrow(InvalidAmountError);
    expect(() => divide(1n, 0n, 'UP')).toThrow(InvalidAmountError);
  });

  it('brackets the exact quotient', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n ** 80n }),
        fc.bigInt({ min: 1n, max: 2n ** 40n }),
        (numerator, denominator) => {
          const down = divide(numerator, denominator, 'DOWN');
          const up = divide(numerator, denominator, 'UP');
          expect(down * denominator <= numerator).toBe(true);
          expect(up * denominator >= numerator).toBe(true);
          expect(up - down).toBe(numerator % denominator === 0n ? 0n : 1n);
        },
      ),
    );
  });
});

describe('proportionalShare', () => {
  it('validates its inputs', () => {
    expect(() => proportionalShare(10n, 3n, 2n, 'DOWN')).toThrow(InvalidAmountError);
    expect(() => proportionalShare(-1n, 1n, 2n, 'DOWN')).toThrow(InvalidAmountError);
    expect(() => proportionalShare(10n, -1n, 2n, 'DOWN')).toThrow(InvalidAmountError);
  });

  it('never exceeds the total and reaches it exactly at the whole', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n ** 63n - 1n }),
        fc.bigInt({ min: 1n, max: 2n ** 63n - 1n }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (total, whole, fraction) => {
          const part = BigInt(Math.floor(Number(whole) * fraction)) % (whole + 1n);
          const share = proportionalShare(total, part, whole, 'DOWN');
          expect(share >= 0n && share <= total).toBe(true);
          expect(proportionalShare(total, whole, whole, 'DOWN')).toBe(total);
        },
      ),
    );
  });
});
