import { join } from 'node:path';
import { parseCurrency } from '../money';
import { loadFxRatesFile, parseFxRates, StaticFxRateProvider } from './static-fx-rate-provider';

const USD = parseCurrency('USD');
const EUR = parseCurrency('EUR');
const JPY = parseCurrency('JPY');

const entry = {
  from: 'EUR',
  to: 'USD',
  rate: '1.085',
  source: 'test-feed',
  asOf: '2026-11-02T00:00:00Z',
};

describe('StaticFxRateProvider', () => {
  const provider = new StaticFxRateProvider(parseFxRates({ rates: [entry] }), () => new Date(42));

  it('returns a configured rate with its source and timestamp', async () => {
    const rate = await provider.getRate(EUR, USD);

    expect(rate).toEqual({
      from: EUR,
      to: USD,
      scaled: 10_850_000_000n,
      source: 'test-feed',
      asOf: new Date('2026-11-02T00:00:00Z'),
    });
  });

  it('does not derive inverse or cross rates', async () => {
    await expect(provider.getRate(USD, EUR)).resolves.toBeNull();
    await expect(provider.getRate(JPY, USD)).resolves.toBeNull();
  });

  it('returns an identity rate for the same currency', async () => {
    const rate = await provider.getRate(USD, USD);

    expect(rate).toMatchObject({ from: USD, to: USD, scaled: 10_000_000_000n, source: 'identity' });
    expect(rate?.asOf).toEqual(new Date(42));
  });
});

describe('parseFxRates', () => {
  it('rejects unknown currencies, invalid rates and malformed timestamps', () => {
    expect(() => parseFxRates({ rates: [{ ...entry, from: 'EURO' }] })).toThrow();
    expect(() => parseFxRates({ rates: [{ ...entry, rate: '-1' }] })).toThrow();
    expect(() => parseFxRates({ rates: [{ ...entry, asOf: 'yesterday' }] })).toThrow();
    expect(() => parseFxRates({ rates: [{ ...entry, extra: true }] })).toThrow();
  });

  it('rejects duplicate pairs and self-referencing pairs', () => {
    expect(() => parseFxRates({ rates: [entry, entry] })).toThrow(/Duplicate/);
    expect(() => parseFxRates({ rates: [{ ...entry, to: 'EUR' }] })).toThrow(/itself/);
  });

  it('loads the bundled seed file', () => {
    const rates = loadFxRatesFile(join(__dirname, '../../config/fx-rates.json'));

    expect(rates.length).toBeGreaterThan(0);
    expect(rates.every((rate) => rate.scaled > 0n)).toBe(true);
  });
});
