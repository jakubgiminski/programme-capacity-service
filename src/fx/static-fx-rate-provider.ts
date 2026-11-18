import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  type CurrencyCode,
  currencySchema,
  type FxRate,
  identityRate,
  parseFxRate,
} from '../money';
import { type FxRateProvider } from './fx-rate-provider';

const rateFileSchema = z.strictObject({
  rates: z.array(
    z.strictObject({
      from: currencySchema,
      to: currencySchema,
      rate: z.string(),
      source: z.string().min(1).max(100),
      asOf: z.iso.datetime({ offset: true }),
    }),
  ),
});

function pairKey(from: CurrencyCode, to: CurrencyCode): string {
  return `${from}/${to}`;
}

export function parseFxRates(input: unknown): FxRate[] {
  const file = rateFileSchema.parse(input);
  const seen = new Set<string>();
  return file.rates.map((entry) => {
    const key = pairKey(entry.from, entry.to);
    if (entry.from === entry.to) {
      throw new Error(`FX rate ${key} must not map a currency to itself`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate FX rate for ${key}`);
    }
    seen.add(key);
    return {
      from: entry.from,
      to: entry.to,
      scaled: parseFxRate(entry.rate),
      source: entry.source,
      asOf: new Date(entry.asOf),
    };
  });
}

export function loadFxRatesFile(path: string): FxRate[] {
  return parseFxRates(JSON.parse(readFileSync(path, 'utf8')));
}

export class StaticFxRateProvider implements FxRateProvider {
  private readonly rates: ReadonlyMap<string, FxRate>;

  constructor(
    rates: readonly FxRate[],
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.rates = new Map(rates.map((rate) => [pairKey(rate.from, rate.to), copyRate(rate)]));
  }

  getRate(from: CurrencyCode, to: CurrencyCode): Promise<FxRate | null> {
    if (from === to) {
      return Promise.resolve(identityRate(from, this.clock()));
    }
    const rate = this.rates.get(pairKey(from, to));
    return Promise.resolve(rate === undefined ? null : copyRate(rate));
  }
}

function copyRate(rate: FxRate): FxRate {
  return Object.freeze({ ...rate, asOf: new Date(rate.asOf.getTime()) });
}
