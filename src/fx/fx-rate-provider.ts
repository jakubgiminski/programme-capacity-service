import { type CurrencyCode, type FxRate } from '../money';

export const FX_RATE_PROVIDER = Symbol('FX_RATE_PROVIDER');

export interface FxRateProvider {
  getRate(from: CurrencyCode, to: CurrencyCode): Promise<FxRate | null>;
}
