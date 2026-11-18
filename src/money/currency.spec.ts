import { currencyExponent, isCurrencyCode, parseCurrency } from './currency';
import { UnknownCurrencyError } from './money-errors';

describe('currency', () => {
  it.each([
    ['USD', 2],
    ['EUR', 2],
    ['JPY', 0],
    ['KRW', 0],
    ['KWD', 3],
    ['BHD', 3],
    ['CLF', 4],
  ])('knows the ISO 4217 exponent of %s', (code, exponent) => {
    expect(currencyExponent(parseCurrency(code))).toBe(exponent);
  });

  it.each(['usd', 'XXX', 'US', 'USDT', ''])('rejects %p', (code) => {
    expect(isCurrencyCode(code)).toBe(false);
    expect(() => parseCurrency(code)).toThrow(UnknownCurrencyError);
  });
});
