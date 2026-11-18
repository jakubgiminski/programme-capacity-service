import fc from 'fast-check';
import { formatFxRate, FX_RATE_SCALE, parseFxRate } from './fx-rate';
import { InvalidFxRateError } from './money-errors';

describe('FX rate parsing', () => {
  it.each([
    ['1', FX_RATE_SCALE],
    ['1.085', 10_850_000_000n],
    ['0.0000000001', 1n],
    ['150.38', 1_503_800_000_000n],
    ['0.0020445', 20_445_000n],
  ])('parses %p into a scaled integer', (input, expected) => {
    expect(parseFxRate(input)).toBe(expected);
  });

  it.each(['0', '0.0', '-1', '1.', '.5', '01.5', '1,5', '1e2', '0.00000000001', ''])(
    'rejects %p',
    (input) => {
      expect(() => parseFxRate(input)).toThrow(InvalidFxRateError);
    },
  );

  it('rejects rates that do not fit in BIGINT once scaled', () => {
    expect(() => parseFxRate('1000000000')).toThrow(InvalidFxRateError);
  });

  it('formats scaled rates without trailing zeros', () => {
    expect(formatFxRate(10_850_000_000n)).toBe('1.085');
    expect(formatFxRate(FX_RATE_SCALE * 3n)).toBe('3');
    expect(formatFxRate(1n)).toBe('0.0000000001');
  });

  it('round-trips any representable rate', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 9_000_000_000_000_000_000n }), (scaled) => {
        expect(parseFxRate(formatFxRate(scaled))).toBe(scaled);
      }),
    );
  });
});
